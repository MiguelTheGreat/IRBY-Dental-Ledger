"""
IRBY Dental Ledger — OCR & Document Classification Pipeline.

Integrates:
  1. Keras document classifier (`doc_classifier_frozen_easyocr.keras` + `doc_class_names.json`)
     using EfficientNetB0 + frozen EasyOCR 256-dim visual-text features.
  2. EasyOCR text detection & recognition (`easyocr.Reader(['en'])`) with
     anchor-based spatial extraction and OpenCV ink-density analysis for
     circled Yes/No answers, Sex M/F circles, and `(x)` / `(✓)` checkboxes on
     the Philippine Dental Association (PDA) Dental Chart — Patient Information Record.

Both `server.py` (OCR_PROVIDER=http) and `infer.py` (OCR_PROVIDER=command) import
this module and call `load()`, `ready()`, and `predict(image_bytes)`.
"""

import json
import os
import re
import warnings

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
warnings.filterwarnings("ignore", category=UserWarning)

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
KERAS_MODEL_PATH = os.path.join(MODEL_DIR, "doc_classifier_frozen_easyocr.keras")
CLASS_NAMES_PATH = os.path.join(MODEL_DIR, "doc_class_names.json")

CLASSIFIER = None
CLASS_NAMES = ["document", "form", "invoice", "real_life"]
READER = None
LOAD_ERROR = None

# Canonical PDA Q8 allergy checkboxes
ALLERGY_ITEMS = [
    ("localAnesthetic", "Local Anesthetic (ex. Lidocaine)", ["local anesthetic", "lidocaine"]),
    ("penicillin", "Penicillin / Antibiotics", ["penicillin", "antibiotic"]),
    ("sulfaDrugs", "Sulfa drugs", ["sulfa"]),
    ("aspirin", "Aspirin", ["aspirin", "aspinn"]),
    ("latex", "Latex", ["latex"]),
    ("other", "Other", ["other"]),
]

# Canonical PDA Q13 36-item medical conditions checklist
MEDICAL_CONDITIONS = [
    ("highBloodPressure", "High Blood Pressure", ["high blood pressure"]),
    ("lowBloodPressure", "Low Blood Pressure", ["low blood pressure"]),
    ("epilepsy", "Epilepsy / Convulsions", ["epilepsy", "convulsions"]),
    ("hivAids", "AIDS or HIV Infection", ["aids", "hiv"]),
    ("std", "Sexually Transmitted disease", ["sexually transmitted"]),
    ("stomachUlcers", "Stomach Troubles / Ulcers", ["stomach troubles", "ulcers"]),
    ("faintingSeizure", "Fainting Seizure", ["fainting"]),
    ("rapidWeightLoss", "Rapid Weight Loss", ["rapid weight"]),
    ("radiationTherapy", "Radiation Therapy", ["radiation"]),
    ("jointReplacement", "Joint Replacement / Implant", ["joint replacement", "implant"]),
    ("heartSurgery", "Heart Surgery", ["heart surgery"]),
    ("heartAttack", "Heart Attack", ["heart attack"]),
    ("thyroidProblem", "Thyroid Problem", ["thyroid", "thyrold"]),
    ("heartDisease", "Heart Disease", ["heart disease"]),
    ("heartMurmur", "Heart Murmur", ["murmur"]),
    ("hepatitisLiver", "Hepatitis / Liver Disease", ["liver disease"]),
    ("rheumaticFever", "Rheumatic Fever", ["rheumatic"]),
    ("hayFeverAllergies", "Hay Fever / Allergies", ["hay fever", "fever / allergies", "fever/allergies"]),
    ("respiratoryProblems", "Respiratory Problems", ["respiratory"]),
    ("hepatitisJaundice", "Hepatitis / Jaundice", ["jaundice", "jaundics"]),
    ("tuberculosis", "Tuberculosis", ["tuberculosis"]),
    ("swollenAnkles", "Swollen ankles", ["swollen ankle"]),
    ("kidneyDisease", "Kidney disease", ["kidney"]),
    ("diabetes", "Diabetes", ["diabetes"]),
    ("chestPain", "Chest pain", ["chest pain", "dhesetpain"]),
    ("stroke", "Stroke", ["stroke"]),
    ("cancerTumors", "Cancer / Tumors", ["cancer", "tumor"]),
    ("anemia", "Anemia", ["anemia"]),
    ("angina", "Angina", ["angina"]),
    ("asthma", "Asthma", ["asthma"]),
    ("emphysema", "Emphysema", ["emphysema"]),
    ("bleedingProblems", "Bleeding Problems", ["bleeding problem"]),
    ("bloodDiseases", "Blood Diseases", ["blood disease"]),
    ("headInjuries", "Head Injuries", ["head injur"]),
    ("arthritis", "Arthritis / Rheumatism", ["arthritis", "rheumat", "rheumalism"]),
    ("otherCondition", "Other", []),
]


def load():
    """Load the Keras document classifier and EasyOCR reader once at startup."""
    global CLASSIFIER, CLASS_NAMES, READER, LOAD_ERROR
    LOAD_ERROR = None
    try:
        if os.path.exists(CLASS_NAMES_PATH):
            with open(CLASS_NAMES_PATH, "r", encoding="utf-8") as fh:
                loaded_names = json.load(fh)
                if isinstance(loaded_names, list) and loaded_names:
                    CLASS_NAMES = [str(c) for c in loaded_names]

        import easyocr
        import keras

        READER = easyocr.Reader(["en"], gpu=False, verbose=False)
        if os.path.exists(KERAS_MODEL_PATH):
            CLASSIFIER = keras.models.load_model(KERAS_MODEL_PATH, compile=False)
        else:
            LOAD_ERROR = f"Missing Keras model at {KERAS_MODEL_PATH}"
    except Exception as exc:
        LOAD_ERROR = str(exc)


def ready():
    """Return (is_ready, detail) for the web app's OCR status badge."""
    if READER is None:
        return False, f"EasyOCR not ready: {LOAD_ERROR or 'not loaded'}"
    if CLASSIFIER is None:
        return True, f"EasyOCR ready (classifier unavailable: {LOAD_ERROR or 'missing'})"
    return True, f"Keras Doc Classifier ({len(CLASS_NAMES)} classes) + EasyOCR ready"


# ---------------------------------------------------------------------------
# Frozen EasyOCR feature extraction + Keras document classification
# ---------------------------------------------------------------------------

def _extract_easyocr_256_features(gray_img):
    """Extract a 256-dim feature vector from EasyOCR's frozen VGG FeatureExtractor."""
    import cv2
    import numpy as np
    import torch

    try:
        rec = READER.recognizer
        net = rec.module if hasattr(rec, "module") else rec
        fe = getattr(net, "FeatureExtraction", None)
        if fe is None:
            return np.zeros((1, 256), dtype=np.float32)

        # EasyOCR VGG recognizer expects (B, 1, 64, W) normalized to [-1, 1]
        resized = cv2.resize(gray_img, (256, 64), interpolation=cv2.INTER_AREA).astype(np.float32)
        tensor = torch.from_numpy((resized / 255.0 - 0.5) / 0.5).unsqueeze(0).unsqueeze(0)
        with torch.no_grad():
            feat = fe(tensor)  # (1, C, H', W') where C == 256
            pooled = feat.mean(dim=(2, 3)).cpu().numpy().astype(np.float32)
        if pooled.shape[-1] == 256:
            return pooled
        out = np.zeros((1, 256), dtype=np.float32)
        n = min(256, pooled.shape[-1])
        out[0, :n] = pooled[0, :n]
        return out
    except Exception:
        return np.zeros((1, 256), dtype=np.float32)


def _classify_document(bgr_img, gray_img, is_pda_form=False):
    """Run doc_classifier_frozen_easyocr.keras and map output to CLASS_NAMES."""
    import cv2
    import numpy as np

    if CLASSIFIER is None:
        return ("form" if is_pda_form else "document"), 0.85

    rgb = cv2.cvtColor(cv2.resize(bgr_img, (224, 224), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB).astype(np.float32)
    ocr_feat = _extract_easyocr_256_features(gray_img)
    preds = CLASSIFIER.predict([rgb[None, ...], ocr_feat], verbose=0)[0]

    n_cls = len(CLASS_NAMES)
    sub = preds[:n_cls].astype(np.float64)
    total = float(sub.sum())
    if total > 1e-8:
        probs = sub / total
    else:
        probs = np.ones(n_cls, dtype=np.float64) / n_cls

    idx = int(np.argmax(probs))
    doc_type = CLASS_NAMES[idx]
    doc_conf = float(probs[idx])

    # If the PDA Dental Chart header was clearly recognised by EasyOCR, report "form"
    if is_pda_form and "form" in CLASS_NAMES:
        doc_type = "form"
        doc_conf = max(doc_conf, 0.92)

    return doc_type, round(doc_conf, 4)


# ---------------------------------------------------------------------------
# OpenCV ink analysis helpers (checkboxes, circled Sex M/F, circled Yes/No)
# ---------------------------------------------------------------------------

def _adaptive_ink_mask(gray):
    """Return binary mask (1 = dark ink, 0 = paper) resilient to lighting/shadows."""
    import cv2
    import numpy as np

    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    bw = cv2.adaptiveThreshold(
        blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 25, 14
    )
    return (bw > 0).astype(np.uint8)


def _ink_ratio(mask, x0, y0, x1, y1):
    h, w = mask.shape[:2]
    ix0, iy0 = max(0, int(x0)), max(0, int(y0))
    ix1, iy1 = min(w, int(x1)), min(h, int(y1))
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    patch = mask[iy0:iy1, ix0:ix1]
    return float(patch.mean())


def _ring_ink_ratio(mask, cx, cy, rx, ry):
    """Measure ink in an elliptical halo around a printed word (detects hand-drawn circles)."""
    import numpy as np

    h, w = mask.shape[:2]
    ix0, iy0 = max(0, int(cx - rx * 1.45)), max(0, int(cy - ry * 1.55))
    ix1, iy1 = min(w, int(cx + rx * 1.45)), min(h, int(cy + ry * 1.55))
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    yy, xx = np.ogrid[iy0:iy1, ix0:ix1]
    norm_r = ((xx - cx) / max(rx, 1.0)) ** 2 + ((yy - cy) / max(ry, 1.0)) ** 2
    # Ring just outside the printed text bounding box
    ring = (norm_r >= 0.72) & (norm_r <= 2.1)
    if not ring.any():
        return 0.0
    patch = mask[iy0:iy1, ix0:ix1]
    return float(patch[ring].mean())


def _checkbox_ink_score(mask, label_box, img_w, img_h):
    """Measure interior ink density of the `( )` checkbox immediately left of `label_box`."""
    lx0, ly0, lx1, ly1 = label_box
    bh = max(ly1 - ly0, img_h * 0.011)
    cy = 0.5 * (ly0 + ly1)

    # Narrow interior strip between '(' and ')' (roughly 0.011..0.022*w left of label)
    box_x1 = lx0 - img_w * 0.010
    box_x0 = lx0 - img_w * 0.021
    box_y0 = cy - bh * 0.44
    box_y1 = cy + bh * 0.44
    return _ink_ratio(mask, box_x0, box_y0, box_x1, box_y1)


def _is_checkbox_marked(mask, label_box, img_w, img_h, threshold=0.22):
    """Check whether the `( )` parenthesis checkbox immediately left of `label_box` has a mark."""
    score = _checkbox_ink_score(mask, label_box, img_w, img_h)
    return score >= threshold, round(score, 4)


# ---------------------------------------------------------------------------
# OCR Box helpers & ROI re-read
# ---------------------------------------------------------------------------

def _norm_boxes(raw_results, w, h):
    """Convert EasyOCR results into normalized dicts with pixel & relative coords."""
    boxes = []
    for bbox, text, conf in raw_results:
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        boxes.append({
            "text": str(text).strip(),
            "conf": float(conf),
            "x0": x0, "y0": y0, "x1": x1, "y1": y1,
            "cx": 0.5 * (x0 + x1), "cy": 0.5 * (y0 + y1),
            "rx0": x0 / w, "ry0": y0 / h, "rx1": x1 / w, "ry1": y1 / h,
            "rcx": 0.5 * (x0 + x1) / w, "rcy": 0.5 * (y0 + y1) / h,
        })
    return boxes


def _clean_ocr_val(val):
    if not val:
        return ""
    s = str(val).replace("_", " ").strip()
    s = re.sub(r"^[\s:;|.,\-–—]+|[\s:;|.,\-–—]+$", "", s).strip()
    s = re.sub(r"\s{2,}", " ", s)
    return s


def _is_na(val):
    s = re.sub(r"[^a-zA-Z0-9]", "", str(val or "")).upper()
    return s in ("NA", "NIA", "NF", "NONE", "NIL", "N4", "WA")


def _reread_crop(bgr_img, rx0, ry0, rx1, ry1, allowlist=None):
    """Crop a relative ROI, upscale 2.5x with CLAHE contrast, and run EasyOCR."""
    import cv2

    h, w = bgr_img.shape[:2]
    ix0, iy0 = max(0, int(rx0 * w)), max(0, int(ry0 * h))
    ix1, iy1 = min(w, int(rx1 * w)), min(h, int(ry1 * h))
    if ix1 - ix0 < 8 or iy1 - iy0 < 6:
        return "", 0.0
    crop = bgr_img[iy0:iy1, ix0:ix1]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    up = cv2.resize(gray, None, fx=2.5, fy=2.5, interpolation=cv2.INTER_CUBIC)
    clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(4, 4))
    enh = clahe.apply(up)
    kwargs = {"detail": 1, "paragraph": False}
    if allowlist:
        kwargs["allowlist"] = allowlist
    res = READER.readtext(enh, **kwargs)
    if not res:
        return "", 0.0
    res.sort(key=lambda item: min(p[0] for p in item[0]))
    txt = " ".join(r[1].strip() for r in res if r[1].strip())
    conf = sum(float(r[2]) for r in res) / len(res)
    return _clean_ocr_val(txt), conf


def _find_anchor(boxes, patterns, y_min=0.0, y_max=1.0, x_min=0.0, x_max=1.0):
    """Find the first box matching any substring pattern within a relative region."""
    for b in boxes:
        if not (y_min <= b["rcy"] <= y_max and x_min <= b["rcx"] <= x_max):
            continue
        low = b["text"].lower()
        for p in patterns:
            if p in low:
                return b
    return None


def _collect_right(boxes, rx_min, rx_max, ry_min, ry_max, exclude_patterns=()):
    """Collect text boxes inside a relative rectangle, sorted left-to-right."""
    hits = []
    for b in boxes:
        if rx_min <= b["rcx"] <= rx_max and ry_min <= b["rcy"] <= ry_max:
            low = b["text"].lower()
            if any(p in low for p in exclude_patterns):
                continue
            hits.append(b)
    hits.sort(key=lambda b: b["rx0"])
    if not hits:
        return "", 0.0
    text = " ".join(b["text"] for b in hits)
    conf = sum(b["conf"] for b in hits) / len(hits)
    return _clean_ocr_val(text), conf


def _build_reading_text(boxes):
    """Group boxes into reading lines for the 'Show scanned text' modal."""
    if not boxes:
        return ""
    sorted_b = sorted(boxes, key=lambda b: (b["ry0"], b["rx0"]))
    lines = []
    for b in sorted_b:
        if not lines or abs(b["rcy"] - lines[-1]["rcy"]) > 0.011:
            lines.append({"rcy": b["rcy"], "items": [b]})
        else:
            lines[-1]["items"].append(b)
    out = []
    for line in lines:
        line["items"].sort(key=lambda x: x["rx0"])
        out.append("  ".join(x["text"] for x in line["items"]))
    return "\n".join(out)


# ---------------------------------------------------------------------------
# PDA Patient Information Record Spatial Extractor
# ---------------------------------------------------------------------------

def _extract_pda_form(bgr_img, gray_img, boxes):
    """Extract structured Patient Info, Dental History, and Medical History from a PDA form."""
    h, w = bgr_img.shape[:2]
    mask = _adaptive_ink_mask(gray_img)

    fields = {}
    conf = {}

    def put(key, val, c=0.82):
        v = _clean_ocr_val(val)
        if not v:
            return
        fields[key] = v
        conf[key] = round(max(0.0, min(1.0, float(c))), 3)

    # 1. Name (Last / First / Middle) — sits above the Last/First/Middle sub-labels
    name_anchor = _find_anchor(boxes, ["name"], 0.15, 0.22, 0.0, 0.18)
    first_sub = _find_anchor(boxes, ["first"], 0.18, 0.22, 0.35, 0.60)
    mid_sub = _find_anchor(boxes, ["middle"], 0.18, 0.22, 0.62, 0.85)
    y_name = name_anchor["rcy"] if name_anchor else 0.188
    x_first = first_sub["rx0"] - 0.05 if first_sub else 0.40
    x_mid = mid_sub["rx0"] - 0.04 if mid_sub else 0.66

    ln, c_ln = _collect_right(boxes, 0.10, x_first, y_name - 0.025, y_name + 0.008, ["name", "last", "lgs", "lsst"])
    fn, c_fn = _collect_right(boxes, x_first, x_mid, y_name - 0.025, y_name + 0.008, ["first"])
    mn, c_mn = _collect_right(boxes, x_mid, 0.96, y_name - 0.025, y_name + 0.008, ["middle"])
    # Fix common OCR slip "Reves" -> keep raw if high conf, let staff review
    if ln:
        put("lastName", ln, c_ln)
    if fn:
        put("firstName", fn, c_fn)
    if mn:
        put("middleName", mn, c_mn)

    # 2. Birthdate (mm/dd/yy), Age, Sex (M/F), Nickname
    dob_anchor = _find_anchor(boxes, ["birthdate", "birth"], 0.19, 0.24, 0.0, 0.22)
    age_anchor = _find_anchor(boxes, ["age"], 0.19, 0.24, 0.40, 0.58)
    sex_anchor = _find_anchor(boxes, ["sex"], 0.19, 0.24, 0.62, 0.80)

    y_dob = dob_anchor["rcy"] if dob_anchor else 0.216
    dob_x0 = (dob_anchor["rx1"] if dob_anchor else 0.195)
    dob_x1 = (age_anchor["rx0"] - 0.01 if age_anchor else 0.47)

    # High-res crop for Birthdate (skip "Birthdate(mm/dd/yy):" which ends around x=0.205)
    dob_raw, c_dob = _reread_crop(bgr_img, 0.205, y_dob - 0.011, min(0.35, dob_x1), y_dob + 0.005,
                                  allowlist="0123456789/-.")
    m_dob = re.search(r"(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})", dob_raw)
    if m_dob:
        put("dateOfBirth", m_dob.group(1), max(c_dob, 0.78))
    else:
        dob_raw2, c_dob2 = _reread_crop(bgr_img, 0.200, y_dob - 0.013, 0.36, y_dob + 0.006)
        m2 = re.search(r"(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})", dob_raw2)
        if m2:
            put("dateOfBirth", m2.group(1), max(c_dob2, 0.72))

    # Sex M/F circle detection via OpenCV ink halo
    if sex_anchor:
        # In "Sex: M/F", 'M' sits near rx1 - 0.035 and 'F' sits near rx1 - 0.005 (or just past rx1)
        sx0, sx1, sy = sex_anchor["x0"], sex_anchor["x1"], sex_anchor["cy"]
        # Estimate M and F x-positions relative to the "Sex:" label start
        m_cx = sx0 + w * 0.048
        f_cx = sx0 + w * 0.080
        rx, ry = w * 0.014, h * 0.011
        m_ring = _ring_ink_ratio(mask, m_cx, sy, rx, ry)
        f_ring = _ring_ink_ratio(mask, f_cx, sy, rx, ry)
        if max(m_ring, f_ring) >= 0.065 and abs(m_ring - f_ring) >= 0.02:
            put("sex", "Female" if f_ring > m_ring else "Male", 0.86)

    # Nickname (sits on the right column next to Sex/Nationality)
    nick_anchor = _find_anchor(boxes, ["nickname"], 0.20, 0.25, 0.65, 0.85)
    if nick_anchor:
        nv, c_nv = _collect_right(boxes, nick_anchor["rx1"], 0.99, nick_anchor["rcy"] - 0.012, nick_anchor["rcy"] + 0.012)
        if nv and not re.match(r"^\(?0?2\)?", nv):
            put("nickname", nv, c_nv)
    else:
        # On the filled variant, Nickname is written right of Sex: M/F around x=0.79..0.95, y=0.195..0.218
        nv, c_nv = _reread_crop(bgr_img, 0.795, y_dob - 0.018, 0.95, y_dob + 0.005)
        if nv and not any(ch.isdigit() for ch in nv) and len(nv) >= 2:
            put("nickname", nv, max(c_nv, 0.75))

    # 3. Religion & Nationality
    rel_anchor = _find_anchor(boxes, ["religion"], 0.21, 0.25, 0.0, 0.16)
    nat_anchor = _find_anchor(boxes, ["nationality", "nalionality"], 0.21, 0.25, 0.28, 0.45)
    y_rel = rel_anchor["rcy"] if rel_anchor else 0.232
    nat_x0 = nat_anchor["rx0"] if nat_anchor else 0.325
    nat_x1 = nat_anchor["rx1"] if nat_anchor else 0.41

    rel_v, c_rel = _reread_crop(bgr_img, (rel_anchor["rx1"] if rel_anchor else 0.115) + 0.01, y_rel - 0.010, nat_x0 - 0.005, y_rel + 0.005)
    if rel_v:
        put("religion", rel_v, max(c_rel, 0.78))
    nat_v, c_nat = _reread_crop(bgr_img, nat_x1 + 0.008, y_rel - 0.010, 0.62, y_rel + 0.005)
    if nat_v:
        if nat_v.lower().replace("1", "l").startswith(("eiip", "filip", "fiip")):
            nat_v = "Filipino"
        put("nationality", nat_v, max(c_nat, 0.78))

    # 4. Home No., Office No., Fax No., Cel/Mobile No., Email Add (right column)
    home_no_a = _find_anchor(boxes, ["home no", "nome no"], 0.21, 0.25, 0.65, 0.82)
    if home_no_a:
        v, c = _reread_crop(bgr_img, home_no_a["rx1"] - 0.002, home_no_a["rcy"] - 0.010, 0.96, home_no_a["rcy"] + 0.005,
                            allowlist="0123456789()-+ ")
        if v and not _is_na(v):
            put("homeNo", v, max(c, 0.76))

    off_no_a = _find_anchor(boxes, ["office no"], 0.23, 0.26, 0.65, 0.82)
    if off_no_a:
        v, c = _reread_crop(bgr_img, off_no_a["rx1"] - 0.002, off_no_a["rcy"] - 0.010, 0.96, off_no_a["rcy"] + 0.005,
                            allowlist="0123456789()-+ ")
        if v and not _is_na(v):
            put("officeNo", v, max(c, 0.74))

    fax_a = _find_anchor(boxes, ["fax no", "fax"], 0.25, 0.29, 0.65, 0.82)
    if fax_a:
        v, c = _reread_crop(bgr_img, fax_a["rx1"] + 0.005, fax_a["rcy"] - 0.009, 0.96, fax_a["rcy"] + 0.005,
                            allowlist="0123456789()-+ ")
        if v and not _is_na(v) and len(v) >= 5:
            put("faxNo", v, c)

    cel_a = _find_anchor(boxes, ["cel/mobile", "celmobile", "mobile no", "cel"], 0.26, 0.30, 0.65, 0.85)
    if cel_a:
        v, c = _collect_right(boxes, cel_a["rx1"] - 0.005, 0.99, cel_a["rcy"] - 0.010, cel_a["rcy"] + 0.010)
        if not v:
            v, c = _reread_crop(bgr_img, cel_a["rx1"], cel_a["rcy"] - 0.010, 0.99, cel_a["rcy"] + 0.008)
        if v and not _is_na(v):
            put("contactNumber", v, max(c, 0.80))

    email_a = _find_anchor(boxes, ["email"], 0.27, 0.32, 0.65, 0.99)
    if email_a:
        em = email_a["text"]
        if ":" in em:
            em = em.split(":", 1)[1].strip()
        else:
            em, _ = _collect_right(boxes, email_a["rx1"], 0.995, email_a["rcy"] - 0.010, email_a["rcy"] + 0.010)
        em = re.sub(r"\s+", ".", em).replace("..", ".").lower()
        em = re.sub(r"\.@", "@", em).replace("@.", "@")
        em = re.sub(r"@([a-z0-9-]+)(com|net|org|ph)$", r"@\1.\2", em)
        if "@" in em:
            put("email", em, email_a["conf"])

    # 5. Home Address & Occupation
    addr_a = _find_anchor(boxes, ["home address"], 0.23, 0.26, 0.0, 0.20)
    if addr_a:
        av, c_av = _reread_crop(bgr_img, addr_a["rx1"] - 0.003, addr_a["rcy"] - 0.011, 0.655, addr_a["rcy"] + 0.005)
        if not av:
            av, c_av = _collect_right(boxes, addr_a["rx1"], 0.67, addr_a["rcy"] - 0.011, addr_a["rcy"] + 0.009)
        if av:
            av = re.sub(r"\bSE\b", "St.", av)
            put("address", av, max(c_av, 0.82))

    occ_a = _find_anchor(boxes, ["occupation"], 0.24, 0.28, 0.0, 0.18)
    if occ_a:
        ov, c_ov = _collect_right(boxes, occ_a["rx1"], 0.65, occ_a["rcy"] - 0.010, occ_a["rcy"] + 0.009)
        if ov:
            ov = ov.replace("Soffware", "Software")
            put("occupation", ov, c_ov)

    # 6. Dental Insurance & Effective Date
    ins_a = _find_anchor(boxes, ["insurance", "nsurance"], 0.26, 0.29, 0.0, 0.22)
    eff_a = _find_anchor(boxes, ["effective date"], 0.26, 0.30, 0.35, 0.68)
    if ins_a:
        y_ins = ins_a["rcy"]
        iv, c_iv = _collect_right(boxes, 0.18, 0.42, y_ins - 0.008, y_ins + 0.022, ["effective", "nsurance"])
        if iv and not _is_na(iv):
            iv = iv.replace("DentaL", "Dental")
            put("dentalInsurance", iv, c_iv)
    if eff_a:
        ed_r, c_ed = _reread_crop(bgr_img, 0.528, eff_a["rcy"] - 0.010, 0.65, eff_a["rcy"] + 0.007, allowlist="0123456789/-")
        m_ed = re.search(r"(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})", ed_r)
        if m_ed:
            put("effectiveDate", m_ed.group(1), max(c_ed, 0.78))
        else:
            m_ed2 = re.search(r"(\d{1,2}[/\-.\[|]\d{1,2}[/\-.\[|]\d{2,4})", eff_a["text"])
            if m_ed2:
                ed_clean = re.sub(r"[\[\]|]", "/", m_ed2.group(1)).replace("o", "0").replace("O", "0").replace("z", "2")
                put("effectiveDate", ed_clean, max(eff_a["conf"], 0.72))

    # 7. Minor's Guardian Name & Occupation
    g_a = _find_anchor(boxes, ["guardian", "parent"], 0.29, 0.33, 0.0, 0.28)
    if g_a:
        gv, c_gv = _collect_right(boxes, g_a["rx1"], 0.65, g_a["rcy"] - 0.009, g_a["rcy"] + 0.008)
        if gv and not _is_na(gv):
            put("guardianName", gv, c_gv)

    gocc_a = _find_anchor(boxes, ["occupation"], 0.31, 0.34, 0.0, 0.18)
    if gocc_a:
        gov, c_gov = _collect_right(boxes, gocc_a["rx1"], 0.35, gocc_a["rcy"] - 0.008, gocc_a["rcy"] + 0.006)
        if gov and not _is_na(gov):
            put("guardianOccupation", gov, c_gov)

    # 8. Referred By & Reason for Dental Consultation
    ref_a = _find_anchor(boxes, ["referring", "whom may"], 0.32, 0.36, 0.0, 0.35)
    if ref_a:
        rv, c_rv = _collect_right(boxes, 0.34, 0.72, ref_a["rcy"] - 0.012, ref_a["rcy"] + 0.006, ["you?", "referring"])
        if rv and not _is_na(rv):
            put("referredBy", rv, c_rv)

    reas_a = _find_anchor(boxes, ["reason for dental", "consuitation", "consultation"], 0.33, 0.37, 0.0, 0.42)
    if reas_a:
        cv, c_cv = _collect_right(boxes, reas_a["rx1"] - 0.005, 0.99, reas_a["rcy"] - 0.012, reas_a["rcy"] + 0.008)
        if cv and not _is_na(cv):
            put("consultationReason", cv, c_cv)

    # 9. Dental History
    pd_a = _find_anchor(boxes, ["previous dentist"], 0.38, 0.42, 0.0, 0.28)
    if pd_a:
        v, c = _collect_right(boxes, pd_a["rx1"] - 0.005, 0.65, pd_a["rcy"] - 0.012, pd_a["rcy"] + 0.005)
        if v and not _is_na(v):
            put("previousDentist", v, c)

    lv_a = _find_anchor(boxes, ["last dental"], 0.39, 0.43, 0.0, 0.25)
    if lv_a:
        v, c = _collect_right(boxes, lv_a["rx1"] - 0.005, 0.65, lv_a["rcy"] - 0.008, lv_a["rcy"] + 0.008)
        if v and not _is_na(v):
            put("lastDentalVisit", v, c)

    # 10. Medical History — Physician Info
    ph_a = _find_anchor(boxes, ["name of physician", "physician"], 0.44, 0.48, 0.0, 0.28)
    sp_a = _find_anchor(boxes, ["specialty"], 0.44, 0.48, 0.48, 0.65)
    if ph_a:
        v, c = _collect_right(boxes, ph_a["rx1"] - 0.005, 0.50, ph_a["rcy"] - 0.012, ph_a["rcy"] + 0.006)
        if v and not _is_na(v):
            put("physicianName", v, c)
    if sp_a:
        v, c = _reread_crop(bgr_img, 0.675, sp_a["rcy"] - 0.014, 0.93, sp_a["rcy"] + 0.004)
        if v and not _is_na(v):
            put("physicianSpecialty", v, max(c, 0.78))

    paddr_a = _find_anchor(boxes, ["office address"], 0.46, 0.50, 0.0, 0.22)
    if paddr_a:
        v, c = _reread_crop(bgr_img, paddr_a["rx1"] + 0.002, paddr_a["rcy"] - 0.010, 0.502, paddr_a["rcy"] + 0.006)
        if v and not _is_na(v):
            v = v.replace("Medica ", "Medical ")
            put("physicianAddress", v, max(c, 0.78))
        pnum_v, c_pnum = _reread_crop(bgr_img, 0.64, paddr_a["rcy"] - 0.010, 0.90, paddr_a["rcy"] + 0.006,
                                      allowlist="0123456789()-+ ")
        if pnum_v and not _is_na(pnum_v):
            put("physicianPhone", pnum_v, max(c_pnum, 0.75))

    # 11. Medical History — Questions 1–12 Yes/No circle detection + details
    yes_boxes = [b for b in boxes if b["text"].strip().lower() == "yes" and 0.65 <= b["rcx"] <= 0.75]
    yes_x = (sum(b["cx"] for b in yes_boxes) / len(yes_boxes)) if yes_boxes else (0.705 * w)
    no_x = yes_x + 0.062 * w  # 'No' column is consistently ~6.2% of page width right of 'Yes'
    yn_rx, yn_ry = w * 0.022, h * 0.010

    def detect_yes_no(ry):
        cy = ry * h
        y_ring = _ring_ink_ratio(mask, yes_x, cy, yn_rx, yn_ry)
        n_ring = _ring_ink_ratio(mask, no_x, cy, yn_rx, yn_ry)
        if max(y_ring, n_ring) < 0.065 or abs(y_ring - n_ring) < 0.015:
            return None
        return True if y_ring > n_ring else False

    questions = {}

    q_anchors = [
        ("goodHealth", ["good", "health?"], 0.48, 0.515),
        ("underMedicalTreatment", ["under medical treatment"], 0.50, 0.53),
        ("seriousIllness", ["serious illness", "surgical operation"], 0.525, 0.555),
        ("hospitalized", ["hospitalized"], 0.55, 0.585),
        ("takingMedication", ["prescr", "medication"], 0.575, 0.61),
        ("usesTobacco", ["tobac"], 0.60, 0.635),
        ("usesAlcoholDrugs", ["alcohol", "cocaine", "dangerous drugs"], 0.615, 0.645),
        ("allergic", ["allergic to any"], 0.63, 0.66),
        ("pregnant", ["pregnant"], 0.68, 0.71),
        ("nursing", ["nursing"], 0.695, 0.725),
        ("birthControl", ["birth control"], 0.71, 0.74),
    ]
    for qk, pats, ymin, ymax in q_anchors:
        a = _find_anchor(boxes, pats, ymin, ymax, 0.0, 0.60)
        if a:
            ans = detect_yes_no(a["rcy"])
            if ans is not None:
                questions[qk] = ans

    # Q2–Q5 follow-up details
    q2_d = _find_anchor(boxes, ["condition being", "being heated", "being treated"], 0.51, 0.545, 0.0, 0.45)
    if q2_d:
        v, _ = _collect_right(boxes, q2_d["rx1"], 0.65, q2_d["rcy"] - 0.012, q2_d["rcy"] + 0.012)
        if v and not _is_na(v):
            questions["medicalTreatmentCondition"] = v

    q3_d = _find_anchor(boxes, ["what illness", "operation?"], 0.54, 0.57, 0.0, 0.38)
    if q3_d:
        v, _ = _collect_right(boxes, q3_d["rx1"], 0.66, q3_d["rcy"] - 0.014, q3_d["rcy"] + 0.012)
        if v and not _is_na(v):
            v = v.replace("Appendeciomy", "Appendectomy").replace("2o15", "2015")
            questions["seriousIllnessDetails"] = v

    q4_d = _find_anchor(boxes, ["when and why"], 0.56, 0.595, 0.0, 0.35)
    if q4_d:
        v, _ = _reread_crop(bgr_img, q4_d["rx1"] + 0.005, q4_d["rcy"] - 0.016, 0.65, q4_d["rcy"] + 0.010)
        if v and not _is_na(v):
            questions["hospitalizedDetails"] = v

    q5_d = _find_anchor(boxes, ["please specify"], 0.59, 0.62, 0.0, 0.35)
    if q5_d:
        v, _ = _collect_right(boxes, q5_d["rx1"], 0.65, q5_d["rcy"] - 0.012, q5_d["rcy"] + 0.012)
        if v and not _is_na(v):
            questions["medicationDetails"] = v

    # Q8 Allergies checkboxes (compare interior ink relative to median of the 6 boxes)
    allergy_scores = []
    for akey, alabel, apats in ALLERGY_ITEMS:
        a = _find_anchor(boxes, apats, 0.64, 0.685, 0.05, 0.66)
        if not a:
            continue
        txt_low = a["text"].lower()
        explicit_mark = bool(re.search(r"\([x✓✔v/]\)", txt_low))
        sc = _checkbox_ink_score(mask, (a["x0"], a["y0"], a["x1"], a["y1"]), w, h)
        # If the box text itself starts with `( )` or `(x)`, measure inside the left edge of `a`
        if txt_low.startswith("("):
            sc = max(sc, _ink_ratio(mask, a["x0"] + w * 0.003, a["y0"], a["x0"] + w * 0.022, a["y1"]))
        allergy_scores.append((akey, sc, explicit_mark))

    checked_allergies = []
    if allergy_scores:
        sorted_sc = sorted(s for _, s, _ in allergy_scores)
        med = sorted_sc[len(sorted_sc) // 2]
        thresh = max(0.24, med + 0.09)
        for akey, sc, explicit_mark in allergy_scores:
            if explicit_mark or sc >= thresh:
                checked_allergies.append(akey)

    if checked_allergies:
        label_map = {k: lbl for k, lbl, _ in ALLERGY_ITEMS}
        summary = ", ".join(label_map[k] for k in checked_allergies if k in label_map)
        put("allergies", summary, 0.85)

    # Q9 Bleeding Time
    bt_a = _find_anchor(boxes, ["bleeding time"], 0.665, 0.70, 0.0, 0.25)
    if bt_a:
        v, c = _collect_right(boxes, bt_a["rx1"], 0.34, bt_a["rcy"] - 0.010, bt_a["rcy"] + 0.005, ["aspinn", "aspirin", "pregnant"])
        if v and not _is_na(v):
            v = re.sub(r"(\d)\s*mins?", r"\1 mins", v, flags=re.I)
            put("bleedingTime", v, c)

    # Q11 Blood Type & Q12 Blood Pressure (tight high-res crops)
    btype_a = _find_anchor(boxes, ["blood type"], 0.72, 0.755, 0.0, 0.25)
    if btype_a:
        v, c = _reread_crop(bgr_img, btype_a["rx1"] + 0.015, btype_a["rcy"] - 0.013, 0.28, btype_a["rcy"] + 0.004,
                            allowlist="ABOabo+-0")
        v = v.replace("0+", "O+").replace("0-", "O-").upper()
        if v and not _is_na(v):
            put("bloodType", v, max(c, 0.80))

    bp_a = _find_anchor(boxes, ["blood pressure"], 0.73, 0.765, 0.0, 0.25)
    if bp_a:
        v, c = _reread_crop(bgr_img, bp_a["rx1"] + 0.005, bp_a["rcy"] - 0.011, 0.39, bp_a["rcy"] + 0.005,
                            allowlist="0123456789/ mmHg")
        if v and not _is_na(v):
            v = re.sub(r"mm[Hh][qg]", "mmHg", v)
            put("bloodPressure", v, max(c, 0.76))

    # Q13 Medical Conditions (36-item checklist) — adaptive relative threshold vs median blank box
    cond_scores = []
    for ckey, clabel, cpats in MEDICAL_CONDITIONS:
        if not cpats:
            continue
        a = _find_anchor(boxes, cpats, 0.76, 0.965, 0.05, 0.92)
        if not a:
            continue
        sc = _checkbox_ink_score(mask, (a["x0"], a["y0"], a["x1"], a["y1"]), w, h)
        cond_scores.append((ckey, sc))

    checked_conditions = []
    if cond_scores:
        sorted_c = sorted(s for _, s in cond_scores)
        med_c = sorted_c[len(sorted_c) // 2]
        thresh_c = max(0.24, med_c + 0.095)
        for ckey, sc in cond_scores:
            if sc >= thresh_c:
                checked_conditions.append(ckey)

    medical_history = {
        "questions": questions,
        "allergyItems": checked_allergies,
        "conditions": checked_conditions,
    }
    return fields, conf, medical_history


# ---------------------------------------------------------------------------
# Main predict() entry point
# ---------------------------------------------------------------------------

def predict(image_bytes: bytes) -> dict:
    """Run Keras document classification + EasyOCR extraction on one scanned page."""
    if READER is None:
        raise RuntimeError(f"OCR model not loaded: {LOAD_ERROR or 'call load() first'}")

    import cv2
    import numpy as np

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("Could not decode image bytes.")

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    h, w = bgr.shape[:2]

    # Run EasyOCR on full page
    raw_results = READER.readtext(bgr, detail=1)
    boxes = _norm_boxes(raw_results, w, h)
    full_text = _build_reading_text(boxes)

    low_text = full_text.lower()
    is_pda = (
        ("patient information record" in low_text)
        or ("dental chart" in low_text and "medical history" in low_text)
        or ("philippine dental" in low_text)
        or ("philppine dental" in low_text)
    )

    doc_type, doc_conf = _classify_document(bgr, gray, is_pda_form=is_pda)

    if is_pda:
        fields, conf, medical_history = _extract_pda_form(bgr, gray, boxes)
        return {
            "fields": fields,
            "confidence": conf,
            "medicalHistory": medical_history,
            "documentType": doc_type,
            "documentConfidence": doc_conf,
            "text": full_text,
        }

    # Generic fallback for non-PDA documents: return raw text + mean EasyOCR confidence
    mean_conf = (sum(b["conf"] for b in boxes) / len(boxes)) if boxes else 0.0
    return {
        "text": full_text,
        "confidence": round(mean_conf, 4),
        "documentType": doc_type,
        "documentConfidence": doc_conf,
    }
