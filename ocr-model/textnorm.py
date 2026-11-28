"""
Text normalisation for OCR output: folding, look-alike digit repair, date and
name parsing. Pure Python (no OpenCV / ONNX) so it is cheap to import and test.

Dates on the PDA Patient Information Record are written month-first
("Birthdate (mm/dd/yy)"), so every parser here defaults to day_first=False.
"""
import datetime as dt
import difflib
import re
import unicodedata

MONTHS = ["january", "february", "march", "april", "may", "june", "july",
          "august", "september", "october", "november", "december"]
TAGALOG_MONTHS = {
    "enero": 1, "pebrero": 2, "marso": 3, "abril": 4, "mayo": 5, "hunyo": 6,
    "hulyo": 7, "agosto": 8, "setyembre": 9, "oktubre": 10, "nobyembre": 11, "disyembre": 12,
}
NAME_PARTICLES = {"de", "dela", "del", "la", "los", "las", "delos", "san", "santa", "sta", "van", "von"}

# Letters a digits-only reading should treat as digits (handwritten 1/7/0/5 are often read as I/O/S)
DIGIT_FIX = str.maketrans({
    "O": "0", "o": "0", "D": "0", "Q": "0", "I": "1", "l": "1", "|": "1", "L": "1", "i": "1",
    "Z": "2", "z": "2", "S": "5", "s": "5", "G": "6", "b": "6", "B": "8", "g": "9", "q": "9",
})


def fold(text):
    """Lower-case ASCII fold ('Peña' -> 'pena')."""
    t = unicodedata.normalize("NFKD", text or "")
    return t.encode("ascii", "ignore").decode("ascii").lower()


def norm(text):
    """Fold, turn separators into spaces, drop punctuation, squeeze spaces."""
    t = re.sub(r"[\-_,&/]+", " ", fold(text))
    t = re.sub(r"[^a-z0-9 ]", "", t)
    return re.sub(r"\s+", " ", t).strip()


def digits(s):
    """Repair common OCR letter/digit swaps inside a numeric string."""
    return (s or "").translate(DIGIT_FIX)


def clean_value(val):
    """Strip underscores (form blanks), stray separators and colons left by a label split."""
    if not val:
        return ""
    s = str(val).replace("_", " ").strip()
    s = re.sub(r"^[\s:;|.,\-–—]+|[\s:;|,\-–—]+$", "", s).strip()
    s = re.sub(r"\s+\.$", "", s)
    s = re.sub(r":+$", "", s).strip()
    return re.sub(r"\s{2,}", " ", s)


def is_na(val):
    s = re.sub(r"[^a-zA-Z0-9]", "", str(val or "")).upper()
    return s in ("NA", "NIA", "NF", "NONE", "NIL", "N4", "WA", "WALA", "XX")


def title_case(s):
    return re.sub(r"(^|[\s'\-])(\w)", lambda m: m.group(1) + m.group(2).upper(), s.lower())


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------
_SLASH_LOOKALIKE = re.compile(r"(?<=[0-9OoIl])[\\|\[\]](?=[0-9OoIl])")
SLASH_DATE_RX = re.compile(
    r"(?<![0-9A-Za-z])([0-9OoIl]{1,4})\s*[/\-.]\s*([0-9OoIl]{1,4})(?:\s*[/\-.]\s*([0-9OoIl]{2,4}))?(?![0-9A-Za-z])"
)
_DIGLIKE = r"[0-9OoIl|SsBZz]"
_MONTH_FIRST_RX = re.compile(rf"([A-Za-z]{{3,10}})\.?\s*({_DIGLIKE}{{1,2}})\s*(?:,\s*|\.\s*|\s+)({_DIGLIKE}{{2,4}})")
_DAY_FIRST_RX = re.compile(rf"({_DIGLIKE}{{1,2}})\s+([A-Za-z]{{3,10}})\.?\s*(?:,\s*|\s+)({_DIGLIKE}{{2,4}})")


def month_from_text(word):
    w = (word or "").lower().strip(".")
    if w in TAGALOG_MONTHS:
        return TAGALOG_MONTHS[w]
    for i, m in enumerate(MONTHS, 1):
        if len(w) >= 3 and m.startswith(w[:3]) and (m.startswith(w) or w.startswith(m[:3])):
            return i
    if len(w) >= 4:                       # first letters lost by a box cut: 'ptember'
        for i, m in enumerate(MONTHS, 1):
            if m.endswith(w):
                return i
    close = difflib.get_close_matches(w, MONTHS, n=1, cutoff=0.7)
    return MONTHS.index(close[0]) + 1 if close else None


def fix_year(y):
    """2-digit -> 19xx/20xx; repairs OCR leading-digit confusions (4996/7996/2996 -> 1996)."""
    if len(y) == 4 and y[0] in "472" and y[1] == "9":
        y = "1" + y[1:]
    n = int(y)
    if len(y) == 2:
        n += 1900 if n > dt.date.today().year % 100 else 2000
    return n


def make_date(y, m, d):
    try:
        return dt.date(y, m, d)
    except (ValueError, TypeError):
        return None


def parse_slash_date(text, day_first=False, search=False):
    """'04/12/92', '4-12-1992', 'O4/I2/92' -> (date, ambiguous)."""
    t = _SLASH_LOOKALIKE.sub("/", re.sub(r"\s+", " ", (text or "").strip()))
    m = SLASH_DATE_RX.search(t) if search else SLASH_DATE_RX.fullmatch(t)
    if not m:
        return None, False
    groups = [digits(g) for g in m.groups() if g is not None]
    if not all(g.isdigit() for g in groups):
        return None, False
    if len(groups) == 3:
        p1, p2, p3 = groups
        if len(p1) == 4:
            return make_date(int(p1), int(p2), int(p3)), False
        if len(p3) not in (2, 4) or len(p1) > 2:
            return None, False
        a, b, y = int(p1), int(p2), fix_year(p3)
        if a > 12:
            return make_date(y, b, a), False
        if b > 12:
            return make_date(y, a, b), False
        mo, d = (b, a) if day_first else (a, b)
        return make_date(y, mo, d), a != b
    if len(groups) == 2:
        p1, p2 = groups
        if re.match(r"\s*[/\-.]\s*[0-9OoIl]", t[m.end():]):
            return None, False               # '01/15/2': a date with a truncated year
        if len(p2) in (2, 4) and 1 <= int(p1) <= 12:
            return make_date(fix_year(p2), int(p1), 1), True
    return None, False


def parse_pure_numeric_date(text, day_first=False):
    """'04121992' / '041292' (slashes not read) -> (date, ambiguous)."""
    d_str = digits(re.sub(r"[^0-9A-Za-z|]", "", text or ""))
    if not d_str.isdigit() or not (5 <= len(d_str) <= 8):
        return None, False
    year_part, rest = (d_str[-4:], d_str[:-4]) if len(d_str) >= 7 else (d_str[-2:], d_str[:-2])
    year = fix_year(year_part)
    if len(rest) == 4:
        a, b = int(rest[:2]), int(rest[2:])
    elif len(rest) == 3:
        a, b = int(rest[0]), int(rest[1:])
        if not (1 <= a <= 12 and 1 <= b <= 31):
            a, b = int(rest[:2]), int(rest[2])
    else:
        return None, False
    mo, d = (b, a) if day_first else (a, b)
    d1 = make_date(year, mo, d)
    if d1:
        return d1, False
    d2 = make_date(year, d, mo)
    return (d2, True) if d2 else (None, False)


def parse_date(text, day_first=False):
    """Any common written date -> (datetime.date | None, ambiguous)."""
    t = re.sub(r"^(?:dob|birth\s*date|date\s*of\s*birth|birthday|birthdate)\s*(?:\([^)]*\))?\s*[:\-]?\s*",
               "", (text or "").strip(), flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" ,.;:")
    if not t:
        return None, False

    if re.search(r"[/\-.]", _SLASH_LOOKALIKE.sub("/", t)):
        d, amb = parse_slash_date(t, day_first, search=True)
        if d is not None:
            return d, amb

    t_num = digits(t) if (re.fullmatch(r"[0-9A-Za-z|\-., ]+", t) and sum(c.isdigit() for c in t) >= 4) else t
    m = re.fullmatch(r"(\d{4})[/\-., ]+(\d{1,2})[/\-., ]+(\d{1,2})", t_num)
    if m:
        return make_date(int(m[1]), int(m[2]), int(m[3])), False
    m = re.fullmatch(r"(\d{1,2})[/\-., ]+(\d{1,2})[/\-., ]+(\d{2,4})", t_num)
    if m:
        a, b, y = int(m[1]), int(m[2]), fix_year(m[3])
        if a > 12:
            return make_date(y, b, a), False
        if b > 12:
            return make_date(y, a, b), False
        mo, d = (b, a) if day_first else (a, b)
        return make_date(y, mo, d), a != b

    m = re.fullmatch(r"([A-Za-z]{3,9})\.?\s*(\d{1,2}),?\s*(\d{2,4})", t)
    if m and month_from_text(m[1]):
        return make_date(fix_year(m[3]), month_from_text(m[1]), int(m[2])), False
    m = re.fullmatch(r"(\d{1,2})\s*([A-Za-z]{3,9})\.?,?\s*(\d{2,4})", t)
    if m and month_from_text(m[2]):
        return make_date(fix_year(m[3]), month_from_text(m[2]), int(m[1])), False

    # month-name dates whose digits were read as look-alike letters ('SEPTEMBER 14, I998')
    for rx, mi, di, yi in ((_MONTH_FIRST_RX, 1, 2, 3), (_DAY_FIRST_RX, 2, 1, 3)):
        m = rx.search(t)
        if m and month_from_text(m[mi]):
            day, year = digits(m[di]), digits(m[yi])
            if day.isdigit() and year.isdigit():
                d = make_date(fix_year(year), month_from_text(m[mi]), int(day))
                if d is not None:
                    return d, False
    return parse_pure_numeric_date(t, day_first)


def looks_like_date(text, min_year=1900):
    try:
        low = (text or "").lower()
        if sum(c.isdigit() for c in text or "") < 3 and not any(m[:3] in low for m in MONTHS):
            return False
        d, _ = parse_date(text)
        if d is None:
            d, _ = parse_slash_date(text, search=True)
        return d is not None and min_year <= d.year <= dt.date.today().year + 2
    except Exception:
        return False


def to_iso_date(text, past_only=True):
    """Best-effort ISO date (YYYY-MM-DD) or '' when the text is not a usable date.
    A bare 'month/year' (or a date whose year was cut off, '01/15/2') is not a full date."""
    t = text or ""
    groups = re.findall(r"[0-9OoIl|SsBZz]+", t)
    if len([g for g in groups if any(c.isdigit() for c in g)]) == 2 and not re.search(r"[A-Za-z]{3,}", t):
        return ""
    d, _ = parse_date(t)
    if d is None:
        return ""
    if past_only and not (1900 <= d.year <= dt.date.today().year):
        return ""
    return d.isoformat()


# ---------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------
def parse_name(text):
    """'DELA CRUZ, JUAN O.' / 'Juan O. Dela Cruz' -> (last, first, middle, certain)."""
    t = re.sub(r"\s+", " ", text or "").strip(" ,.")
    if not t:
        return "", "", "", False
    if "," in t:
        last, rest = [x.strip() for x in t.split(",", 1)]
        toks = rest.split()
        mid = ""
        if len(toks) >= 2:
            mid = toks.pop().rstrip(".")
        return title_case(last), title_case(" ".join(toks)), title_case(mid), True
    toks = t.split()
    if len(toks) < 2:
        return "", title_case(t), "", False
    last = [toks.pop()]
    while toks and toks[-1].lower().strip(".") in NAME_PARTICLES:
        last.insert(0, toks.pop())
    mid = ""
    if len(toks) >= 2:
        mid = toks.pop().rstrip(".")
    return title_case(" ".join(last)), title_case(" ".join(toks)), title_case(mid), False


# ---------------------------------------------------------------------------
# Small value normalisers used by the PDA extractor
# ---------------------------------------------------------------------------
def normalise_sex(v):
    s = fold(v).strip(" .")
    if s in ("m", "male", "lalaki", "lalake", "boy"):
        return "Male"
    if s in ("f", "female", "babae", "girl"):
        return "Female"
    if len(s) < 4:                      # 'ME' is a misread of the printed 'M/F', not an answer
        return ""
    hit = difflib.get_close_matches(s, ["male", "female"], n=1, cutoff=0.6)
    if hit:
        return hit[0].title()
    return ""


def normalise_phone(v):
    """Keep digits, '+', '(', ')', '-', spaces; repair look-alikes; '' when < 7 digits."""
    t = re.sub(r"[^0-9OoIlSsBZz+()\- ]", "", v or "")
    t = digits(t)
    if sum(c.isdigit() for c in t) < 7:
        return ""
    return re.sub(r"\s{2,}", " ", t).strip(" -")


_MAIL_HOSTS = {"gmail": ["gmail", "gmall", "gmai1", "gmaii", "grnail", "gmial", "gmal"],
               "yahoo": ["yahoo", "yah00", "yaho0", "yahoo0"], "ymail": ["ymail"],
               "hotmail": ["hotmail", "hotmall", "h0tmail"], "outlook": ["outlook", "out1ook", "0utlook"],
               "icloud": ["icloud", "ic1oud"], "live": ["live"]}
_HOST_RX = "|".join(sorted({v for vs in _MAIL_HOSTS.values() for v in vs}, key=len, reverse=True))
_HOST_FIX = {v: k for k, vs in _MAIL_HOSTS.items() for v in vs}


def normalise_email(v, repaired=None):
    """Clean an OCR'd email. When the '@' itself was misread ('maria.reyesagmall.com'), a known
    mail host is used to put it back; `repaired` (a list) receives True in that case."""
    em = (v or "").strip().lower().replace(" ", "")
    em = em.replace("(at)", "@").replace("[at]", "@").replace("(a)", "@")
    em = re.sub(r"\.{2,}", ".", em)
    em = re.sub(r"\.@|@\.", "@", em)
    em = re.sub(r"[,;](com|net|org|ph)$", r".\1", em)
    em = re.sub(rf"({_HOST_RX})\.?(?:om|cm|con|corn|c0m|co)$", r"\1.com", em)   # '.com' clipped / misread
    m = re.search(rf"@?({_HOST_RX})\.?(com\.ph|com|net|ph)$", em)
    if m:
        host = _HOST_FIX.get(m.group(1), m.group(1))
        local = em[:m.start()]
        if "@" not in em:
            # the recogniser turned '@' into a letter: drop one '@'-like character
            if local and local[-1] in "a&q9@":
                local = local[:-1]
            if repaired is not None:
                repaired.append(True)
        em = f"{local.rstrip('@')}@{host}.{m.group(2)}"
    em = re.sub(r"@([a-z0-9-]+)(com|net|org|ph|edu)$", r"@\1.\2", em)
    return em if re.fullmatch(r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}", em) else ""


BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "A", "B", "AB", "O"]


def normalise_blood_type(v):
    t = (v or "").upper().replace(" ", "").replace("0", "O").replace("POS", "+").replace("NEG", "-")
    t = t.replace("POSITIVE", "+").replace("NEGATIVE", "-")
    m = re.search(r"(AB|A|B|O)\s*([+\-])?", t)
    if not m:
        return ""
    return m.group(1) + (m.group(2) or "")


def normalise_blood_pressure(v):
    t = digits(re.sub(r"(?i)mm\s*hg", "", v or ""))
    m = re.search(r"(\d{2,3})\s*[/\\|]\s*(\d{2,3})", t)
    return f"{m.group(1)}/{m.group(2)} mmHg" if m else ""
