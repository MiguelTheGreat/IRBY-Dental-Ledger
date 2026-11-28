"""
PDA Dental Chart - Patient Information Record: turn paired labels / answers and ink marks into
the web app's fields and medical history.

Nothing here depends on fixed page coordinates. Every position comes from the printed words
the OCR found on this page (question text, the Yes / No words, checklist items, section
headings), so photos at an angle, crops and other printings of the form still line up.
"""
import difflib
import os
import re
import sys

import cv2
import numpy as np

from lexicon import strip_checkbox
from textnorm import (clean_value, fold, is_na, looks_like_date, norm, normalise_blood_pressure,
                      normalise_blood_type, normalise_email, normalise_phone, normalise_sex,
                      parse_name, title_case, to_iso_date)

PDA_MARKERS = [
    "philippine dental association", "patient information record", "dental chart",
    "dental history", "medical history", "previous dentist", "last dental visit",
    "name of physician", "bleeding time", "for women only", "whom may we thank",
    "reason for dental consultation", "are you in good health", "blood pressure",
]

QUESTIONS = [
    ("goodHealth", ["are you in good health", "in good health"]),
    ("underMedicalTreatment", ["are you under medical treatment now", "under medical treatment"]),
    ("seriousIllness", ["have you ever had serious illness or surgical operation", "serious illness",
                        "surgical operation"]),
    ("hospitalized", ["have you ever been hospitalized", "been hospitalized"]),
    ("takingMedication", ["are you taking any prescription non prescription medication",
                          "prescription non prescription medication", "prescription", "medication"]),
    ("usesTobacco", ["do you use tobacco products", "tobacco products", "tobacco"]),
    ("usesAlcoholDrugs", ["do you use alcohol cocaine or other dangerous drugs", "alcohol cocaine",
                          "dangerous drugs"]),
    ("allergic", ["are you allergic to any of the following", "allergic to any"]),
    ("pregnant", ["are you pregnant", "pregnant"]),
    ("nursing", ["are you nursing", "nursing"]),
    ("birthControl", ["are you taking birth control pills", "birth control"]),
]
DETAILS = [
    ("medicalTreatmentCondition", ["if so what is the condition being treated", "condition being treated"]),
    ("seriousIllnessDetails", ["if so what illness or operation", "what illness or operation"]),
    ("hospitalizedDetails", ["if so when and why", "when and why"]),
    ("medicationDetails", ["if so please specify", "please specify"]),
]

ALLERGY_ITEMS = [
    ("localAnesthetic", "Local Anesthetic (ex. Lidocaine)", ["local anesthetic", "lidocaine"]),
    ("penicillin", "Penicillin / Antibiotics", ["penicillin", "antibiotics"]),
    ("sulfaDrugs", "Sulfa drugs", ["sulfa drugs", "sulfa"]),
    ("aspirin", "Aspirin", ["aspirin"]),
    ("latex", "Latex", ["latex"]),
    ("other", "Other", ["other", "others"]),
]
MEDICAL_CONDITIONS = [
    ("highBloodPressure", ["high blood pressure"]), ("lowBloodPressure", ["low blood pressure"]),
    ("epilepsy", ["epilepsy convulsions", "epilepsy", "convulsions"]),
    ("hivAids", ["aids or hiv infection", "hiv infection"]),
    ("std", ["sexually transmitted disease", "sexually transmitted"]),
    ("stomachUlcers", ["stomach troubles ulcers", "stomach troubles"]),
    ("faintingSeizure", ["fainting seizure", "fainting"]), ("rapidWeightLoss", ["rapid weight loss"]),
    ("radiationTherapy", ["radiation therapy"]),
    ("jointReplacement", ["joint replacement implant", "joint replacement"]),
    ("heartSurgery", ["heart surgery"]), ("heartAttack", ["heart attack"]),
    ("thyroidProblem", ["thyroid problem", "thyroid"]), ("heartDisease", ["heart disease"]),
    ("heartMurmur", ["heart murmur"]), ("hepatitisLiver", ["hepatitis liver disease", "liver disease"]),
    ("rheumaticFever", ["rheumatic fever"]), ("hayFeverAllergies", ["hay fever allergies", "hay fever"]),
    ("respiratoryProblems", ["respiratory problems"]), ("hepatitisJaundice", ["hepatitis jaundice", "jaundice"]),
    ("tuberculosis", ["tuberculosis"]), ("swollenAnkles", ["swollen ankles"]),
    ("kidneyDisease", ["kidney disease"]), ("diabetes", ["diabetes"]), ("chestPain", ["chest pain"]),
    ("stroke", ["stroke"]), ("cancerTumors", ["cancer tumors", "cancer"]), ("anemia", ["anemia"]),
    ("angina", ["angina"]), ("asthma", ["asthma"]), ("emphysema", ["emphysema"]),
    ("bleedingProblems", ["bleeding problems"]), ("bloodDiseases", ["blood diseases"]),
    ("headInjuries", ["head injuries"]), ("arthritis", ["arthritis rheumatism", "arthritis"]),
    ("otherCondition", ["other", "others"]),
]

RELIGIONS = ["Roman Catholic", "Catholic", "Christian", "Born Again Christian", "Iglesia ni Cristo",
             "Islam", "Muslim", "Protestant", "Baptist", "Seventh-day Adventist", "Aglipayan",
             "Buddhist", "Methodist", "Evangelical", "Jehovah's Witness", "Mormon", "None"]
NATIONALITIES = ["Filipino", "American", "Chinese", "Japanese", "Korean", "Indian", "British",
                 "Australian", "Canadian", "Spanish", "Indonesian", "Malaysian", "Vietnamese", "Thai"]

EXPLICIT_MARK = re.compile(r"^\s*[\(\[\{]\s*[xXvV/\\✓✔√]+\s*[\)\]\}]")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def is_pda_form(tokens_text):
    joined = " | ".join(norm(t) for t in tokens_text)
    hits = sum(1 for m in PDA_MARKERS if m in joined)
    return hits >= 3, hits


def _box(t):
    return (t["x1"], t["y1"], t["x2"], t["y2"])


def _find_phrase(tokens, phrases, used_ids=(), y_min=None, y_max=None):
    """Best printed token for a question / heading phrase -> (token, score) or (None, 0)."""
    best, best_s = None, 0.0
    for t in tokens:
        if t.get("layer") == "hand" or id(t) in used_ids:
            continue
        if (y_min is not None and t["cy"] < y_min) or (y_max is not None and t["cy"] > y_max):
            continue
        n = norm(re.sub(r"^\s*\d{1,2}\s*[.)]\s*", "", t["text"]))
        if not n:
            continue
        for k, p in enumerate(phrases):
            s = 0.0
            if p in n:
                s = 1.0 - 0.05 * k
            elif len(n) >= 8:
                r = difflib.SequenceMatcher(None, n, p).ratio()
                if r >= 0.75:
                    s = r - 0.05 * k - 0.1
            if s > best_s:
                best, best_s = t, s
    return best, best_s


def _locate_items(tokens, items, y_min, y_max, med_h):
    """Checklist items -> {key: (x_start, y1, y2, cx_end, token, explicit)}; one token may hold
    several items ('( ) Aspirin   ( ) Latex')."""
    found = {}
    for t in tokens:
        if t.get("layer") == "hand" or not (y_min <= t["cy"] <= y_max):
            continue
        raw = t["text"]
        low = fold(raw)
        unit = (t["x2"] - t["x1"]) / max(len(raw), 1)
        for key, pats in items:
            if key in found:
                continue
            for p in pats:
                rx = r"\b" + r"[\W_]*".join(re.escape(w) for w in p.split()) + r"\b"
                m = re.search(rx, low)
                if not m:
                    continue
                # 'other' also appears inside 'other dangerous drugs': only accept a short token
                if p in ("other", "others") and len(norm(strip_checkbox(raw))) > 12:
                    continue
                start = m.start()
                prefix = raw[max(0, start - 5):start]
                explicit = bool(EXPLICIT_MARK.search(prefix + " ")) or bool(
                    re.search(r"[\(\[][xXvV/\\✓✔√][\)\]]\s*$", prefix))
                x_start = t["x1"] + unit * start
                found[key] = {"x": x_start, "y1": t["y1"], "y2": t["y2"], "cy": t["cy"],
                              "x_end": t["x1"] + unit * m.end(), "tok": t, "explicit": explicit,
                              "h": max(t["height"], 0.6 * med_h)}
                break
    # fuzzy fallback for OCR slips ('Thyrold Problem', 'Aspinn')
    for t in tokens:
        if t.get("layer") == "hand" or not (y_min <= t["cy"] <= y_max):
            continue
        n = norm(strip_checkbox(t["text"]))
        if len(n) < 5:
            continue
        for key, pats in items:
            if key in found:
                continue
            if difflib.SequenceMatcher(None, n, pats[0]).ratio() >= 0.8:
                found[key] = {"x": t["x1"], "y1": t["y1"], "y2": t["y2"], "cy": t["cy"], "x_end": t["x2"],
                              "tok": t, "explicit": bool(EXPLICIT_MARK.search(t["text"])),
                              "h": max(t["height"], 0.6 * med_h)}
    return found


def _region_ink(mask, x1, y1, x2, y2, exclude=None):
    H, W = mask.shape[:2]
    ix1, iy1 = max(int(x1), 0), max(int(y1), 0)
    ix2, iy2 = min(int(x2), W), min(int(y2), H)
    if ix2 - ix1 < 2 or iy2 - iy1 < 2:
        return 0.0, 0
    sub = mask[iy1:iy2, ix1:ix2].astype(bool).copy()
    valid = np.ones_like(sub)
    boxes = exclude if isinstance(exclude, list) else ([exclude] if exclude is not None else [])
    for ex in boxes:
        ex1, ey1, ex2, ey2 = [int(v) for v in ex]
        a1, b1 = max(ex1 - ix1, 0), max(ey1 - iy1, 0)
        a2, b2 = min(ex2 - ix1, sub.shape[1]), min(ey2 - iy1, sub.shape[0])
        if a2 > a1 and b2 > b1:
            valid[b1:b2, a1:a2] = False
    px = int((sub & valid).sum())
    return px / float(max(int(valid.sum()), 1)), px


class InkMarks:
    """Ink measurements on the rule-free page: pen-only when the page has a coloured-ink layer."""

    def __init__(self, doc):
        self.layered = doc["layered"]
        if self.layered:
            g = cv2.cvtColor(doc["hand"], cv2.COLOR_BGR2GRAY)
            self.mask = (g < 215).astype(np.uint8)
        else:
            g = cv2.cvtColor(doc["clean"], cv2.COLOR_BGR2GRAY)
            g = cv2.GaussianBlur(g, (3, 3), 0)
            bs = max(25, (g.shape[1] // 70) | 1)
            self.mask = (cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                               cv2.THRESH_BINARY_INV, bs, 14) > 0).astype(np.uint8)
        self.binv = (self.mask * 255).astype(np.uint8)
        gc = cv2.cvtColor(doc["clean"], cv2.COLOR_BGR2GRAY)
        bs = max(25, (gc.shape[1] // 70) | 1)
        self.full = (cv2.adaptiveThreshold(cv2.GaussianBlur(gc, (3, 3), 0), 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                           cv2.THRESH_BINARY_INV, bs, 14) > 0).astype(np.uint8)
        if self.layered:
            gp = cv2.cvtColor(doc["print"], cv2.COLOR_BGR2GRAY)
            self.print_mask = (gp < 160).astype(np.uint8)
        else:
            self.print_mask = self.mask

    def word_start(self, it):
        """Real left edge of a checklist item's first word: the end of the last blank gap
        between the '( )' and the word (the OCR's character positions are only proportional)."""
        h = it["h"]
        x_lo = int(max(it["tok"]["x1"], it["x"] - 2.5 * h))
        x_hi = int(it["x"] + 1.2 * h)
        y1, y2 = int(it["y1"] + 0.15 * h), int(it["y2"] - 0.1 * h)
        if x_hi - x_lo < 4 or y2 - y1 < 3:
            return it["x"]
        col = self.print_mask[y1:y2, x_lo:x_hi].sum(axis=0)
        blank = col == 0
        best = None
        i = 0
        while i < len(blank):
            if blank[i]:
                j = i
                while j < len(blank) and blank[j]:
                    j += 1
                if (j - i) >= max(3, 0.12 * h) and j < len(blank):
                    best = x_lo + j                      # gap end = next glyph starts
                i = j
            else:
                i += 1
        return float(best) if best is not None and abs(best - it["x"]) <= 1.5 * h else it["x"]

    def around(self, box, h, clip_left=None, clip_right=None, keep_core=False, others=()):
        """Ink in a halo around a printed word (circles, ticks, crosses), word itself excluded."""
        x1, y1, x2, y2 = box
        pad_x, pad_y = 0.9 * h, 0.55 * h
        rx1, rx2 = x1 - pad_x, x2 + pad_x
        if clip_left is not None:
            rx1 = max(rx1, clip_left)
        if clip_right is not None:
            rx2 = min(rx2, clip_right)
        # the printed word is excluded on both layers: a circle that touches a letter pulls
        # that letter into the pen layer with it
        ex = [] if keep_core else [(x1 - 0.08 * h, y1 - 0.05 * h, x2 + 0.08 * h, y2 + 0.05 * h)]
        if not self.layered:                # neighbouring printed words are not marks
            ex += [tuple(o) for o in others]
        return _region_ink(self.mask, rx1, y1 - pad_y, rx2, y2 + pad_y, exclude=ex)

    def letters(self, x_lo, x_hi, cy, h, printed=False):
        """Letter-sized glyph boxes in a strip (for the 'M/F' of 'Sex: M/F'), '/' included."""
        src = self.print_mask if (printed and self.layered) else self.full
        H, W = src.shape[:2]
        xa, xb = int(max(x_lo, 0)), int(min(x_hi, W))
        ya, yb = int(max(cy - 0.9 * h, 0)), int(min(cy + 0.9 * h, H))
        if xb - xa < 4 or yb - ya < 4:
            return []
        n, _, stats, _ = cv2.connectedComponentsWithStats(src[ya:yb, xa:xb], connectivity=8)
        out = []
        for i in range(1, n):
            x, y, bw, bh, area = [int(v) for v in stats[i]]
            if 0.45 * h <= bh <= 1.25 * h and 0.15 * h <= bw <= 1.3 * h and area >= 0.08 * bw * bh:
                out.append((xa + x, ya + y, xa + x + bw, ya + y + bh))
        return sorted(out)

    def ring_centre(self, x_lo, x_hi, cy, h, exclude=()):
        """x-centre of a hand-drawn ring (circle / ellipse) in a strip, or None."""
        H, W = self.mask.shape[:2]
        xa, xb = int(max(x_lo, 0)), int(min(x_hi, W))
        ya, yb = int(max(cy - 1.6 * h, 0)), int(min(cy + 1.6 * h, H))
        if xb - xa < 4 or yb - ya < 4:
            return None
        sub = self.mask[ya:yb, xa:xb].astype(np.uint8)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(sub, connectivity=8)
        best = None
        for i in range(1, n):
            x, y, bw, bh, area = [int(v) for v in stats[i]]
            if not ((bh >= 1.15 * h or bw >= 1.5 * h) and bh >= 0.8 * h and area <= 0.5 * bw * bh):
                continue
            if best is None or area > best[1]:
                best = (i, area)
        if best is None:
            return None
        ys, xs = np.nonzero(lab == best[0])
        xs = xs + xa
        ys = ys + ya
        keep = np.ones(xs.size, bool)
        for ex in exclude:                   # letters the ring touches would pull the centre over
            keep &= ~((xs >= ex[0]) & (xs <= ex[2]) & (ys >= ex[1]) & (ys <= ex[3]))
        if keep.sum() < 10:
            return None
        return float((xs[keep].min() + xs[keep].max()) / 2.0)

    def left_box(self, x_start, cy, h, left_limit=None):
        """Ink in the '( )' / box area just left of a checklist item (on the pen layer the
        window may run into the printed word: printed ink is not on that layer)."""
        x1 = x_start - 2.6 * h
        if left_limit is not None:
            x1 = max(x1, left_limit)
        x2 = x_start + (0.35 * h if self.layered else -0.08 * h)
        return _region_ink(self.mask, x1, cy - 0.75 * h, x2, cy + 0.75 * h)


def _decide(score_a, px_a, score_b, px_b, min_px):
    """Which of two options carries the mark? 'a' / 'b' / None."""
    hi, lo = (score_a, score_b) if score_a >= score_b else (score_b, score_a)
    px = max(px_a, px_b)
    if px < min_px or hi < 0.02:
        return None
    if hi >= 1.7 * lo + 0.01:
        return "a" if score_a >= score_b else "b"
    return None


# ---------------------------------------------------------------------------
# Field assembly
# ---------------------------------------------------------------------------
def _section_marks(tokens, med_h):
    def y_of(phrases):
        t, s = _find_phrase(tokens, phrases)
        return t["cy"] if (t is not None and s >= 0.9) else None
    return {
        "minors": y_of(["for minors", "parents guardians name", "parent guardian name"]),
        "dental": y_of(["dental history"]),
        "medical": y_of(["medical history", "name of physician"]),
    }


_PARTICLES = {"de", "dela", "del", "la", "los", "las", "delos", "van", "von", "y"}


def _name_case(v):
    """'MARIA CLARA' / 'maria Clara' -> 'Maria Clara'; keeps 'dela Cruz', 'McArthur'."""
    if v.isupper() or v.islower():
        return title_case(v)
    words = v.split()
    return " ".join(w if (not w.islower() or (i > 0 and w in _PARTICLES)) else w[:1].upper() + w[1:]
                    for i, w in enumerate(words))


FREE_TEXT = {"address", "occupation", "religion", "nationality", "dentalInsurance", "referredBy",
             "consultationReason", "lastDentalVisit", "physicianSpecialty", "physicianAddress", "bleedingTime"}


def respace(v):
    """The PP-OCR recogniser often drops spaces in English: 'SoftwareEngineer', 'March2025',
    '123Mabini', 'Brgy.San Roque,Marikina'. Put them back where the case / digit change shows it."""
    v = re.sub(r"(?<=[a-z]{2})(?=[A-Z][a-z])", " ", v)
    v = re.sub(r"(?<=[A-Za-z]{3})(?=(19|20)\d{2}\b)", " ", v)
    v = re.sub(r"(?<=\d)(?=[A-Z][a-z]{2,})", " ", v)
    v = re.sub(r"(?<=[a-z]{2}[.,])(?=[A-Za-z]{2})", " ", v)
    return re.sub(r"\s{2,}", " ", v).strip()


def _normalise(key, value):
    """App key + raw OCR value -> (clean value, confidence factor)."""
    v = clean_value(value)
    if not v or is_na(v):
        return "", 0.0
    if key in FREE_TEXT:
        v = respace(v)
    if key not in ("bloodType", "bloodPressure", "email"):
        v = re.sub(r"\b([A-Za-z])\+(?=[\s.,]|$)", r"\1t", v)     # 'S+ Luke's' -> 'St Luke's'
    if key in ("lastName", "firstName", "middleName", "nickname", "guardianName"):
        v = re.sub(r"[^A-Za-zÀ-ɏ .'\-]", "", v).strip(" .-")
        if key == "middleName" and re.fullmatch(r"[A-Za-z]\.?", v):
            v = v.rstrip(".").upper()
        return _name_case(v), 1.0
    if key in ("physicianName", "previousDentist"):
        v = re.sub(r"^(?:dr|dra)\b\.?\s*", "", v, flags=re.I).strip()
        if not re.search(r"[A-Za-z]{2,}", v):
            return "", 0.0                    # only the printed 'Dr.' of the label
        return _name_case(v), 1.0
    if key in ("dateOfBirth", "registrationDate"):
        iso = to_iso_date(v, past_only=True)
        return (iso, 1.0) if iso else ("", 0.0)
    if key == "effectiveDate":
        iso = to_iso_date(v, past_only=False)
        return (iso, 1.0) if iso else ("", 0.0)
    if key == "sex":
        s = normalise_sex(v)
        return (s, 1.0) if s else ("", 0.0)
    if key in ("homeNo", "officeNo", "faxNo", "contactNumber", "physicianPhone"):
        p = normalise_phone(v)
        return (p, 1.0) if p else ("", 0.0)
    if key == "email":
        repaired = []
        e = normalise_email(v, repaired)
        return (e, 0.7 if repaired else 1.0) if e else ("", 0.0)
    if key == "bloodType":
        b = normalise_blood_type(v)
        return (b, 1.0) if b else ("", 0.0)
    if key == "bloodPressure":
        b = normalise_blood_pressure(v)
        return (b, 1.0) if b else (v, 0.6)
    if key == "bleedingTime":
        return re.sub(r"(\d)\s*(mins?|minutes?)\b", r"\1 mins", v, flags=re.I), 1.0
    if key == "religion":
        hit = difflib.get_close_matches(v.title(), RELIGIONS, n=1, cutoff=0.8)
        return (hit[0], 1.0) if hit else (title_case(v) if v.isupper() else v, 0.95)
    if key == "nationality":
        hit = difflib.get_close_matches(v.title(), NATIONALITIES, n=1, cutoff=0.7)
        return (hit[0], 1.0) if hit else (title_case(v) if v.isupper() else v, 0.95)
    return v, 1.0


def _app_key(canon, y, marks, med_h):
    minors, dental, medical = marks["minors"], marks["dental"], marks["medical"]
    in_minors = minors is not None and y >= minors - 0.6 * med_h and (dental is None or y < dental)
    in_medical = medical is not None and y >= medical - 0.6 * med_h
    if canon == "occupation":
        return "guardianOccupation" if in_minors else "occupation"
    if canon == "officeAddress":
        return "physicianAddress" if in_medical else None
    if canon in ("officeNumber", "officeNo"):
        return "physicianPhone" if in_medical else "officeNo"
    if canon == "address" and in_medical:
        return "physicianAddress"
    if canon == "guardianName":
        return "guardianName"
    if canon in ("age", "fullName"):
        return canon
    return canon


def extract(doc, parsed, today=None):
    """doc = scan.ocr_document(...) output, parsed = FormParser.parse(...) output.
    -> fields {appKey: value}, confidence {appKey: 0..1}, medicalHistory {...}, review [keys]."""
    tokens = parsed["tokens"]
    med_h = parsed["med_h"]
    H, W = doc["clean"].shape[:2]
    marks = _section_marks(tokens, med_h)
    ink = InkMarks(doc)
    min_px = max(12, int(0.06 * med_h * med_h))

    fields, conf, review = {}, {}, []

    def put(key, value, c, needs_review=False):
        if not key or not value:
            return
        c = round(max(0.0, min(1.0, float(c))), 3)
        if key in fields and conf.get(key, 0) >= c:
            return
        fields[key] = value
        conf[key] = c
        if needs_review or c < 0.6:
            if key not in review:
                review.append(key)
        elif key in review:
            review.remove(key)

    # ---- questions, detail rows, Yes / No columns
    q_found = {}
    used = set()
    for key, phrases in QUESTIONS:
        t, s = _find_phrase(tokens, phrases, used)
        if t is not None and s >= 0.7:
            q_found[key] = t
            used.add(id(t))
    d_found = {}
    for key, phrases in DETAILS:
        t, s = _find_phrase(tokens, phrases, used)
        if t is not None and s >= 0.7:
            d_found[key] = t
            used.add(id(t))
    question_rows = [(t["y1"] - 0.3 * med_h, t["y2"] + 0.3 * med_h) for t in list(q_found.values()) + list(d_found.values())]

    def on_question_row(tok):
        return any(a <= tok["cy"] <= b for a, b in question_rows)

    # ---- text fields from label / answer pairs
    for p in parsed["pairs"]:
        A = p.get("A")
        if A is not None and on_question_row(A) and p["source"] != "paired_right":
            continue
        key = _app_key(p["canon"], p["y"], marks, med_h)
        if key is None:
            continue
        if key == "fullName":
            last, first, mid, _ = parse_name(p["value"])
            for k2, v2 in (("lastName", last), ("firstName", first), ("middleName", mid)):
                if v2 and k2 not in fields:
                    nv, f = _normalise(k2, v2)
                    put(k2, nv, p["conf"] * 0.8 * f, needs_review=True)
            continue
        if key == "age":
            continue
        nv, f = _normalise(key, p["value"])
        if nv:
            put(key, nv, p["conf"] * f, needs_review=(p["source"] == "rescued" or f < 1.0))

    # ---- choice words (printed Yes / No) for the circle detector
    choices = [t for t in tokens if t.get("layer") != "hand" and norm(t["text"]) in ("yes", "no")]
    yes_t = [t for t in choices if norm(t["text"]) == "yes"]
    no_t = [t for t in choices if norm(t["text"]) == "no"]
    # with black ink the circle is boxed together with the printed word and read as brackets:
    # '(Yes)', '(NO', 'Yes)'. A boxed word that is also clearly taller than the others = circled.
    ch_h = float(np.median([t["height"] for t in choices])) if choices else med_h
    for t in choices:
        bracket = bool(re.search(r"[\(\)\[\]\{\}]|^[0OC]|[0OD]$", t["text"].strip()))
        t["circled"] = (not doc["layered"] or bracket) and (
            (bracket and t["height"] >= 1.2 * ch_h) or t["height"] >= 1.45 * ch_h)
    col_yes = float(np.median([t["cx"] for t in yes_t])) if yes_t else None
    col_no = float(np.median([t["cx"] for t in no_t])) if no_t else None
    word_w = {"yes": float(np.median([t["x2"] - t["x1"] for t in yes_t])) if yes_t else 1.6 * med_h,
              "no": float(np.median([t["x2"] - t["x1"] for t in no_t])) if no_t else 1.1 * med_h}
    if col_yes is not None and col_no is None:
        col_no = col_yes + 3.2 * med_h
    if col_no is not None and col_yes is None:
        col_yes = col_no - 3.2 * med_h

    hand_answers = [t for t in parsed["answers"]]
    questions = {}
    for key, q in q_found.items():
        band = (q["y1"] - 0.7 * med_h, q["y2"] + 1.6 * med_h)

        def pick(cands, word):
            row = [t for t in cands if band[0] <= t["cy"] <= band[1] and t["x1"] > q["x1"]]
            if row:
                return min(row, key=lambda t: abs(t["cy"] - q["cy"]))
            col = col_yes if word == "yes" else col_no
            if col is None:
                return None
            ww = word_w[word]
            return {"x1": col - ww / 2, "x2": col + ww / 2, "y1": q["cy"] - 0.5 * med_h,
                    "y2": q["cy"] + 0.5 * med_h, "cx": col, "cy": q["cy"], "height": med_h, "synthetic": True}

        y_box, n_box = pick(yes_t, "yes"), pick(no_t, "no")
        answer = None
        # a written answer on the row ('No', 'Yes', 'none') - not the printed Yes / No columns
        choice_ids = {id(t) for t in choices}
        for A in hand_answers:
            if id(A) in choice_ids or abs(A["cy"] - q["cy"]) > 0.8 * med_h or A["x1"] < q["x2"] - med_h:
                continue
            if col_yes is not None and abs(A["cx"] - col_yes) < 1.5 * med_h and not doc["layered"]:
                continue
            n = norm(A["text"])
            if n in ("yes", "y", "oo", "opo"):
                answer = True
            elif n in ("no", "n", "none", "wala", "hindi"):
                answer = False
        if answer is None and y_box is not None and n_box is not None:
            yc, nc = bool(y_box.get("circled")), bool(n_box.get("circled"))
            if yc != nc:
                answer = yc
        if answer is None and y_box is not None and n_box is not None:
            mid = (y_box["x2"] + n_box["x1"]) / 2.0 if y_box["cx"] < n_box["cx"] else None
            h = min(max(y_box["height"], n_box["height"], 0.8 * med_h), 1.3 * ch_h)
            sy, py = ink.around(_box(y_box), h, clip_right=mid)
            sn, pn = ink.around(_box(n_box), h, clip_left=mid)
            d = _decide(sy, py, sn, pn, min_px)
            if d is not None:
                answer = (d == "a")
        if answer is not None:
            questions[key] = answer

    # detail answers: handwriting right of 'If so, ...' up to the Yes column
    stop_x = (col_yes - 1.2 * med_h) if col_yes is not None else W
    detail_phrases = dict(DETAILS)
    printed_q = {id(t) for t in list(q_found.values()) + list(d_found.values())}

    def answer_like(A):
        # not the form's own numbered question ('3. Have you ever ...') read as an answer
        return id(A) not in printed_q and not re.match(r"^\s*\d{1,2}\s*[.)]\s*[A-Za-z]", A["text"])

    for key, t in d_found.items():
        row = [A for A in hand_answers if A is not t and answer_like(A) and A["x1"] >= t["x2"] - 0.5 * med_h
               and A["x2"] <= stop_x + 2 * med_h and abs(A["cy"] - t["cy"]) <= 0.8 * med_h]
        if not row:
            row = [A for A in hand_answers if A is not t and answer_like(A) and 0 <= A["y1"] - t["y2"] <= 1.2 * med_h
                   and abs(A["x1"] - t["x1"]) <= 4 * med_h and not A.get("used")]
        row.sort(key=lambda a: a["x1"])
        parts = [a["text"] for a in row]
        # black ink: the answer may be boxed together with the printed question
        tail = re.split(r"\?|:", t["text"], maxsplit=1)
        if len(tail) == 2 and any(c.isalnum() for c in tail[1]):
            parts.insert(0, tail[1])
        elif len(tail) == 1:
            low = fold(t["text"])
            for p in detail_phrases[key]:
                m = re.search(r"[\W_]*".join(re.escape(w) for w in p.split()), low)
                if m and any(c.isalnum() for c in t["text"][m.end():]):
                    parts.insert(0, t["text"][m.end():])
                    break
        txt = clean_value(" ".join(parts))
        if txt and not is_na(txt) and norm(txt) not in ("yes", "no"):
            questions[key] = txt

    # ---- Q8 allergy checklist and Q13 conditions
    def y_after(tok, default):
        return tok["y1"] - 0.5 * med_h if tok is not None else default

    q8 = q_found.get("allergic")
    q9, _ = _find_phrase(tokens, ["bleeding time"])
    q13, _ = _find_phrase(tokens, ["do you have or have you had any of the following", "check which apply",
                                   "have you had any of the following"])
    al_lo = y_after(q8, 0.58 * H)
    al_hi = (q9["y1"] if q9 is not None else (q8["y2"] + 6 * med_h if q8 is not None else 0.72 * H))
    co_lo = (q13["y2"] - 0.2 * med_h) if q13 is not None else 0.74 * H
    co_hi = H

    allergy_hits = _locate_items(tokens, [(k, p) for k, _, p in ALLERGY_ITEMS], al_lo, al_hi, med_h)
    cond_hits = _locate_items(tokens, MEDICAL_CONDITIONS, co_lo, co_hi, med_h)

    def score_items(hits):
        rows = []
        all_items = list(hits.items())
        for key, it in all_items:
            # do not reach into the previous item on the same row
            left_limit = max([o["x_end"] + 0.1 * it["h"] for k2, o in all_items
                              if k2 != key and abs(o["cy"] - it["cy"]) < 0.6 * med_h and o["x_end"] <= it["x"]],
                             default=None)
            it["x"] = ink.word_start(it)
            s, px = ink.left_box(it["x"], it["cy"], it["h"], left_limit)
            sq = FormParserCheckbox.find(ink.binv, it)
            rows.append((key, s, px, sq, it["explicit"]))
        return rows

    def checked(rows):
        if not rows:
            return []
        base = float(np.percentile([s for _, s, _, _, _ in rows], 30))
        if os.environ.get("OCR_DEBUG"):
            print(f"[pda] checklist base={base:.3f} " + " ".join(
                f"{k}={s:.3f}/{px}{'/sq%.2f' % sq if sq is not None else ''}{'/x' if e else ''}"
                for k, s, px, sq, e in rows), file=sys.stderr, flush=True)
        out = []
        for key, s, px, sq, explicit in rows:
            if explicit or (sq is not None and sq >= 0.12):
                out.append(key)
            elif ink.layered:
                if s >= 0.03 and px >= min_px:
                    out.append(key)
            elif len(rows) >= 4 and s >= base + max(0.035, 0.6 * base) and px >= min_px:
                out.append(key)
        return out

    allergy_items = checked(score_items(allergy_hits))
    conditions = checked(score_items(cond_hits))
    if allergy_items and "allergic" not in questions:
        questions["allergic"] = True

    labels = {k: lbl for k, lbl, _ in ALLERGY_ITEMS}
    if allergy_items:
        put("allergies", ", ".join(labels[k] for k in allergy_items if k != "other")
            or "Other (see form)", 0.8, needs_review=True)
    elif questions.get("allergic") is False:
        put("allergies", "None", 0.6, needs_review=True)

    # ---- Sex: circled M or F (when no written value was paired)
    if "sex" not in fields:
        sex_l = [L for L in parsed["labels"] if L.get("canon") == "sex"]
        for L in sex_l:
            mf = [t for t in tokens if t.get("layer") != "hand" and abs(t["cy"] - L["cy"]) <= 0.7 * med_h
                  and 0 <= t["x1"] - L["x2"] <= 4 * med_h
                  and re.fullmatch(r"\s*[MNmn]\s*[/|\\1Il]?\s*[FEfe]\s*", t["text"])]
            h = max(L["height"], 0.8 * med_h)
            x_hi = (mf[0]["x2"] + 0.3 * h) if mf else L["x2"] + 3.5 * h
            # glyphs start after the colon (the label box may also hold the 'M' of 'Sex: M/F')
            x_start = L["x2"] - 0.1 * h
            lt = L["text"]
            if ":" in lt and not lt.rstrip().endswith(":"):
                x_start = L["x1"] + (L["x2"] - L["x1"]) * (lt.index(":") + 1) / max(len(lt), 1)
            glyphs = [g for g in ink.letters(x_start, x_hi, L["cy"], h, printed=True) if g[0] >= x_start - 2]
            slash = [g for g in glyphs if (g[2] - g[0]) < 0.45 * h]
            wide = [g for g in glyphs if (g[2] - g[0]) >= 0.45 * h]
            if len(wide) >= 2 and wide[-1][0] - wide[0][2] >= 0.15 * h:
                m_box, f_box = wide[0], wide[-1]
            elif len(wide) == 1 and slash and slash[0][0] < wide[0][0]:
                # 'M' merged into the pen stroke of a circle that touches it: it sits left of '/'
                f_box, s = wide[0], slash[0]
                mw = 0.8 * (f_box[2] - f_box[0]) / 0.6
                m_box = (s[0] - 0.08 * h - mw, f_box[1], s[0] - 0.08 * h, f_box[3])
            elif mf:
                t = mf[0]
                tw = t["x2"] - t["x1"]
                m_box = (t["x1"], t["y1"], t["x1"] + 0.36 * tw, t["y2"])
                f_box = (t["x2"] - 0.36 * tw, t["y1"], t["x2"], t["y2"])
            else:
                m_box = (L["x2"] + 0.2 * h, L["y1"], L["x2"] + 0.9 * h, L["y2"])
                f_box = (L["x2"] + 1.5 * h, L["y1"], L["x2"] + 2.2 * h, L["y2"])
            # the letters sit close together: a circle around one crosses the gap between
            # them, so each letter is judged only on its outer side, top and bottom
            label_box = (L["x1"], L["y1"], min(L["x2"], m_box[0] - 0.1 * h), L["y2"])
            d = None
            # a circle: whichever letter the ring is centred on
            rc = ink.ring_centre(L["x2"] - 0.6 * h, x_hi + 1.2 * h, L["cy"], h,
                                 exclude=[m_box, f_box, label_box])
            m_cx, f_cx = (m_box[0] + m_box[2]) / 2.0, (f_box[0] + f_box[2]) / 2.0
            sm = sf = 0.0
            pm = pf = 0
            if rc is not None and abs(abs(rc - m_cx) - abs(rc - f_cx)) >= 0.2 * h:
                d = "a" if abs(rc - m_cx) < abs(rc - f_cx) else "b"
            if d is None:
                sm, pm = ink.around(m_box, h, clip_right=m_box[2] + 0.1 * h, others=[label_box])
                sf, pf = ink.around(f_box, h, clip_left=f_box[0] - 0.1 * h)
                d = _decide(sm, pm, sf, pf, min_px)
            if d is None and ink.layered:
                # a tick drawn across the letter itself: pen ink over the letter box counts
                mid = (m_box[2] + f_box[0]) / 2.0
                sm, pm = ink.around(m_box, h, clip_right=mid, keep_core=True)
                sf, pf = ink.around(f_box, h, clip_left=mid, keep_core=True)
                d = _decide(sm, pm, sf, pf, min_px)
            if os.environ.get("OCR_DEBUG"):
                print(f"[pda] sex glyphs={glyphs} M={m_box} F={f_box} ring={rc} sm={sm:.3f}/{pm} sf={sf:.3f}/{pf} -> {d}",
                      file=sys.stderr, flush=True)
            if d is not None:
                put("sex", "Male" if d == "a" else "Female", 0.75, needs_review=True)
                break

    # ---- recovery: values with a distinctive shape that no label claimed
    free = [A for A in parsed["answers"] if not A.get("used") and not on_question_row(A)]
    top_part = marks["dental"] or (0.45 * H)
    if "dateOfBirth" not in fields:
        cands = []
        for A in free:
            if A["cy"] > top_part or not looks_like_date(A["text"]):
                continue
            iso = to_iso_date(A["text"], past_only=True)
            if iso and iso[:4] < str((today or __import__("datetime").date.today()).year):
                cands.append((iso, A))
        if cands:
            iso, A = min(cands, key=lambda c: c[0])           # oldest date on the page = birthdate
            put("dateOfBirth", iso, A["conf"] * 0.6, needs_review=True)
            A["used"] = True
    if "contactNumber" not in fields:
        for A in free:
            m = re.search(r"(\+?63|0)\s*9\d{2}[\s\-]?\d{3}[\s\-]?\d{4}", A["text"].replace("O", "0"))
            if m and not A.get("used"):
                put("contactNumber", normalise_phone(m.group(0)), A["conf"] * 0.7, needs_review=True)
                A["used"] = True
                break
    if "email" not in fields:
        for A in free:
            if "@" in A["text"] and not A.get("used"):
                e = normalise_email(A["text"])
                if e:
                    put("email", e, A["conf"] * 0.7, needs_review=True)
                    A["used"] = True
                    break

    medical = {"questions": questions, "allergyItems": allergy_items, "conditions": conditions}
    for k in ("physicianName", "physicianSpecialty", "physicianAddress", "physicianPhone",
              "bleedingTime", "bloodType", "bloodPressure"):
        if k in fields:
            medical[k] = fields[k]
    return fields, conf, medical, review


class FormParserCheckbox:
    """Hollow-square checkbox check (some printings use boxes instead of '( )')."""

    @staticmethod
    def find(binv, item):
        from formparse import FormParser
        t = {"x1": item["x"], "x2": item["x_end"], "y1": item["y1"], "y2": item["y2"],
             "cy": item["cy"], "height": item["h"]}
        try:
            return FormParser.find_checkbox(binv, t)
        except Exception:
            return None


def extract_generic(parsed):
    """Any other registration form: keep the fields the lexicon recognises."""
    fields, conf, review = {}, {}, []
    keep = {"lastName", "firstName", "middleName", "dateOfBirth", "sex", "address", "contactNumber",
            "email", "occupation", "nationality", "religion", "nickname", "registrationDate"}
    for p in parsed["pairs"]:
        key = p["canon"]
        if key == "fullName":
            last, first, mid, _ = parse_name(p["value"])
            for k2, v2 in (("lastName", last), ("firstName", first), ("middleName", mid)):
                if v2 and k2 not in fields:
                    nv, _ = _normalise(k2, v2)
                    if nv:
                        fields[k2], conf[k2] = nv, round(p["conf"] * 0.8, 3)
                        review.append(k2)
            continue
        if key not in keep or key in fields:
            continue
        nv, f = _normalise(key, p["value"])
        if nv:
            fields[key] = nv
            conf[key] = round(p["conf"] * f, 3)
            if p["source"] == "rescued" or conf[key] < 0.6:
                review.append(key)
    return fields, conf, review
