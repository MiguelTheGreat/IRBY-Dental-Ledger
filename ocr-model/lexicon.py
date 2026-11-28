"""
Label lexicon for the PDA Dental Chart - Patient Information Record (and plain patient
registration forms), with fuzzy label matching and label/value compatibility scoring.

The canonical names are the web app's own field keys (lastName, dateOfBirth, ...), plus a few
helper canons that the PDA extractor resolves by section ("officeAddress" under MEDICAL HISTORY
becomes physicianAddress, the second "occupation" under "For Minors" becomes guardianOccupation).

Add new wording found on other clinics' forms to FIELD_LEXICON; everything else adapts.
"""
import difflib
import re

from textnorm import looks_like_date, norm

FIELD_LEXICON = {
    "lastName": ["last name", "last", "surname", "family name", "apelyido"],
    "firstName": ["first name", "first", "given name", "unang pangalan"],
    "middleName": ["middle name", "middle", "middle initial", "gitnang pangalan"],
    "fullName": ["name", "full name", "patient name", "name of patient", "patients name",
                 "pangalan", "buong pangalan"],
    "dateOfBirth": ["birthdate", "birth date", "date of birth", "birthday", "dob",
                    "birthdate mm dd yy", "birthdate mm dd yyyy", "kapanganakan", "petsa ng kapanganakan"],
    "age": ["age", "edad"],
    "sex": ["sex", "gender", "sex m f", "kasarian"],
    "nickname": ["nickname", "nick name"],
    "religion": ["religion", "relihiyon"],
    "nationality": ["nationality", "citizenship", "nasyonalidad"],
    "homeNo": ["home no", "home number", "home tel no", "tel no", "telephone no", "landline"],
    "officeNo": ["office no", "office tel no", "work no"],
    "faxNo": ["fax no", "fax number", "fax"],
    "contactNumber": ["cel mobile no", "cel no", "cell no", "mobile no", "mobile number",
                      "cellphone no", "cellphone number", "cell phone no", "contact no",
                      "contact number", "phone number", "cp no"],
    "email": ["email add", "email address", "email", "e mail", "e mail address"],
    "address": ["home address", "address", "present address", "complete address",
                "residential address", "tirahan"],
    "occupation": ["occupation", "profession", "trabaho", "hanapbuhay"],
    "dentalInsurance": ["dental insurance", "insurance", "hmo", "health card"],
    "effectiveDate": ["effective date", "date effective"],
    "guardianName": ["parents guardians name", "parent guardian name", "parents guardian name",
                     "guardians name", "guardian name", "parents name", "name of parent guardian",
                     "for minors parents guardians name"],
    "referredBy": ["whom may we thank for referring you", "who referred you", "referred by",
                   "referral", "referring physician"],
    "consultationReason": ["what is your reason for dental consultation",
                           "reason for dental consultation", "reason for consultation",
                           "chief complaint", "reason for visit"],
    "previousDentist": ["previous dentist", "previous dentist dr", "former dentist"],
    "lastDentalVisit": ["last dental visit", "date of last dental visit", "last visit"],
    "physicianName": ["name of physician", "name of physician dr", "physician", "physicians name",
                      "attending physician"],
    "physicianSpecialty": ["specialty if applicable", "specialty", "specialization"],
    "officeAddress": ["office address"],
    "officeNumber": ["office number", "office tel number"],
    "bleedingTime": ["bleeding time"],
    "bloodType": ["blood type", "blood group"],
    "bloodPressure": ["blood pressure", "bp"],
    "registrationDate": ["date", "date today", "date of registration", "registration date"],
}

# canons whose answers are words (never mostly digits, never dates)
NAME_KEYS = {"lastName", "firstName", "middleName", "fullName", "nickname", "guardianName",
             "physicianName", "previousDentist"}
PLAIN_TEXT_KEYS = {"religion", "nationality", "occupation", "dentalInsurance", "physicianSpecialty",
                   "referredBy", "consultationReason"}
PHONE_KEYS = {"homeNo", "officeNo", "faxNo", "contactNumber", "officeNumber", "physicianPhone"}
DATE_KEYS = {"dateOfBirth", "effectiveDate", "registrationDate"}
ADDRESS_KEYS = {"address", "officeAddress", "physicianAddress"}
# answers that may run on to the right as a second box
FREE_TEXT_KEYS = ADDRESS_KEYS | PLAIN_TEXT_KEYS | {"lastDentalVisit", "bleedingTime", "guardianName",
                                                   "physicianName", "previousDentist"}
NAME_CAPTIONS = ("lastName", "firstName", "middleName")
PHONE_LIKE_CANONS = PHONE_KEYS

_ALIASES = sorted({(norm(a), canon) for canon, al in FIELD_LEXICON.items() for a in al},
                  key=lambda x: -len(x[0]))
_EXACT = {}
for _a, _c in _ALIASES:                      # longest first, like the matching loop
    _EXACT.setdefault(_a, _c)


def is_unit(text):
    return bool(re.fullmatch(r"(?:year|yr|month|mo|day|min|minute|sec|second)s?(?:\s*/\s*s)?\.?|mm\s*hg",
                             (text or "").strip().lower()))


def label_start_canon(n):
    """Canon of the exact label that normalised text `n` starts with, else None."""
    for alias, canon in _ALIASES:
        if n == alias or n.startswith(alias + " "):
            return canon
    return None


def _label_run(n):
    """'last first middle' -> ['lastName', 'firstName', 'middleName']; None if not only labels."""
    out = []
    while n:
        for alias, canon in _ALIASES:
            if n == alias or n.startswith(alias + " "):
                out.append(canon)
                n = n[len(alias):].strip()
                break
        else:
            return None
    return out


def _match_label_raw(text):
    n = norm(text)
    if not n or n.isdigit() or len(n.split()) > 9:
        return None, 0.0
    if n in _EXACT:
        return _EXACT[n], 1.0
    run = _label_run(n)
    if run and len(set(run)) >= 2:           # several different labels glued together: not one label
        return None, 0.0
    if run and len(run) >= 2:
        return run[0], 0.95
    best = (None, 0.0)
    n_words = len(n.split())
    for alias, canon in _ALIASES:
        a_words = len(alias.split())
        if a_words >= 2 and n.startswith(alias + " ") and n_words - a_words <= 4 and best[1] < 0.88:
            if label_start_canon(n[len(alias) + 1:]) not in (None, canon):
                continue                     # two labels glued
            best = (canon, 0.88)
            continue
        if len(alias) <= 4 or abs(len(n) - len(alias)) > max(3, 0.3 * len(alias)):
            continue
        r = difflib.SequenceMatcher(None, n, alias).ratio()
        need = 0.85 if len(alias) < 10 else 0.72
        if r >= need and r > best[1]:
            best = (canon, r)
    return best


_MATCH_CACHE = {}


def match_label(text):
    """(canon, score 0..1). 'Birthdate (mm/dd/yy):' still counts as 'Birthdate'. Cached."""
    key = text or ""
    hit = _MATCH_CACHE.get(key)
    if hit is not None:
        return hit
    res = _match_uncached(key)
    if len(_MATCH_CACHE) > 20000:
        _MATCH_CACHE.clear()
    _MATCH_CACHE[key] = res
    return res


def _match_uncached(text):
    canon, score = _match_label_raw(text)
    if canon:
        return canon, score
    base = re.sub(r"\([^)]*\)?", " ", text or "")
    base = re.sub(r"\b(?:if applicable|dr)\b\.?", " ", base, flags=re.I)
    if base.strip() and base.strip() != (text or "").strip():
        c2, s2 = _match_label_raw(base)
        if c2 and s2 >= 0.85:
            return c2, 0.9
    return canon, score


STREET_RX = re.compile(r"\b(st|street|blk|block|lot|subd|subdivision|purok|sitio|ave|avenue|road|rd|"
                       r"brgy|barangay|city|village|phase|bldg|building|unit)\b", re.I)


def value_fit(canon, text):
    """None = impossible pairing; <1 strong match; 1 neutral; >1 weak match."""
    t = (text or "").strip()
    if not t or not canon:
        return 1.0
    n_dig = sum(c.isdigit() for c in t)
    n_alpha = sum(c.isalpha() for c in t)
    is_date = looks_like_date(t)
    low = t.lower()

    if canon in DATE_KEYS:
        if is_date:
            return 0.4
        return None if n_dig == 0 else 1.6
    if canon == "lastDentalVisit":
        return 0.6 if is_date or re.search(r"\b(19|20)\d{2}\b|ago|year|month|last", low) else 1.0
    if canon in NAME_KEYS:
        if is_date or (n_dig and n_dig >= n_alpha) or not n_alpha:
            return None
        return 0.8
    if canon in PLAIN_TEXT_KEYS:
        return None if (is_date or (n_dig > n_alpha and n_dig >= 4)) else 1.0
    if canon == "age":
        if re.fullmatch(r"\d{1,3}(\s*(y|yrs?|years?)( old)?)?", low):
            return 0.6
        return None if n_alpha >= 3 else 1.5
    if canon == "sex":
        if low.strip(" .") in {"m", "f", "male", "female", "lalaki", "babae"}:
            return 0.5
        if len(low.strip(" .")) < 4:
            return None
        return 0.7 if difflib.get_close_matches(low, ["male", "female"], n=1, cutoff=0.6) else None
    if canon in PHONE_KEYS:
        if n_dig >= 7:
            return 0.6
        return None if n_alpha > n_dig else 1.4
    if canon == "email":
        if "@" in t or re.search(r"(gmail|yahoo|outlook|hotmail)", low):
            return 0.4
        return None if n_alpha == 0 else 1.5
    if canon in ADDRESS_KEYS:
        if is_date:
            return None
        return 0.7 if STREET_RX.search(t) else 1.0
    if canon == "bloodType":
        return 0.5 if re.fullmatch(r"(?i)\s*(ab|a|b|o|0)\s*[+\-]?\s*(positive|negative|pos|neg)?\s*", t) else 1.6
    if canon == "bloodPressure":
        return 0.5 if re.search(r"\d{2,3}\s*[/\\|]\s*\d{2,3}", t) else 1.6
    if canon == "bleedingTime":
        return 0.6 if n_dig else 1.3
    return 1.0


# ---------------------------------------------------------------------------
# Printed furniture of the PDA form (questions, checklist items, headings, captions).
# A printed token made only of these words is never a handwritten answer.
# ---------------------------------------------------------------------------
FORM_PHRASES = [
    "philippine dental association", "dental chart", "patient information record",
    "patient information", "for minors", "dental history", "medical history",
    "are you in good health", "are you under medical treatment now",
    "if so what is the condition being treated", "have you ever had serious illness or surgical operation",
    "if so what illness or operation", "have you ever been hospitalized", "if so when and why",
    "are you taking any prescription non prescription medication", "if so please specify",
    "do you use tobacco products", "do you use alcohol cocaine or other dangerous drugs",
    "are you allergic to any of the following", "local anesthetic ex lidocaine",
    "penicillin antibiotics", "sulfa drugs", "aspirin", "latex", "other", "for women only",
    "are you pregnant", "are you nursing", "are you taking birth control pills",
    "do you have or have you had any of the following check which apply",
    "high blood pressure", "low blood pressure", "epilepsy convulsions", "aids or hiv infection",
    "sexually transmitted disease", "stomach troubles ulcers", "fainting seizure",
    "rapid weight loss", "radiation therapy", "joint replacement implant", "heart surgery",
    "heart attack", "thyroid problem", "heart disease", "heart murmur", "hepatitis liver disease",
    "rheumatic fever", "hay fever allergies", "respiratory problems", "hepatitis jaundice",
    "tuberculosis", "swollen ankles", "kidney disease", "diabetes", "chest pain", "stroke",
    "cancer tumors", "anemia", "angina", "asthma", "emphysema", "bleeding problems",
    "blood diseases", "head injuries", "arthritis rheumatism", "yes", "no", "m f",
    "signature", "patient guardian signature", "date", "to the best of my knowledge", "dr",
]
_FORM_TEXT = " | ".join(FORM_PHRASES)
_FORM_SET = set(FORM_PHRASES) - {"yes", "no", "m f", "date", "other"}
_FORM_WORDS = {w for p in FORM_PHRASES for w in p.split()}
CHECKBOX_PREFIX = re.compile(r"^\s*[\(\[\{]\s*[^\)\]\}]{0,2}\s*[\)\]\}]\s*|^\s*[\(\[]\s*")


def strip_checkbox(text):
    """'( ) Latex' / '(x)Latex' / '[/] Latex' -> 'Latex'."""
    return CHECKBOX_PREFIX.sub("", text or "").strip()


def is_form_furniture(text):
    """True when `text` is (a piece of) the PDA form's own printed wording."""
    n = norm(strip_checkbox(text))
    if not n:
        return False
    if n in _FORM_SET:
        return True
    words = n.split()
    if len(n) >= 6 and (n in _FORM_TEXT):
        return True
    def known_word(w):
        if w in _FORM_WORDS or w.isdigit():
            return True
        # words the recogniser glued together ('orsurgical', 'haveyou')
        return any(w[:i] in _FORM_WORDS and w[i:] in _FORM_WORDS for i in range(2, len(w) - 1))

    known = sum(1 for w in words if known_word(w))
    return len(words) >= 3 and known >= 0.75 * len(words)
