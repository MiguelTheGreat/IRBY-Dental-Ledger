"""
Mount your OCR model here.  <-- the only file you need to edit.

Implement `load()` (called once at start-up) and `predict(image_bytes)` (called
for every scanned registration form). Both server.py (OCR_PROVIDER=http) and
infer.py (OCR_PROVIDER=command) import this file, so the same code serves both.

`predict` must return a dict. Any of these shapes works - the web app maps it to
the registration form and marks every value "auto-filled" for staff review:

  1. Raw text only (the app finds "Last Name:", "Birthdate:" ... itself):
       {"text": "Last Name: Dela Cruz  First Name: Mateo\nBirthdate: 04/12/1992 ..."}

  2. Structured fields (best accuracy, e.g. from a key-value / layout model):
       {"fields": {"lastName": "Dela Cruz", "firstName": "Mateo", "middleName": "Lorenzo",
                   "dateOfBirth": "1992-04-12", "sex": "Male", "address": "...",
                   "contactNumber": "+63 917 550 0192", "allergies": "Penicillin"},
        "confidence": {"lastName": 0.97, "dateOfBirth": 0.88}}

  3. Per-field value + confidence:
       {"fields": {"lastName": {"value": "Dela Cruz", "confidence": 0.97}}}

Field names may also be snake_case (last_name, date_of_birth, contact_number...).
Dates may be in any common format (04/12/1992, April 12, 1992, 1992-04-12).
"""

MODEL = None


def load():
    """Load weights once. Replace the body with your model, e.g.:

        global MODEL
        from paddleocr import PaddleOCR
        MODEL = PaddleOCR(use_angle_cls=True, lang="en")
    """
    global MODEL
    try:
        import pytesseract  # noqa: F401  (optional fallback: pip install pytesseract pillow + Tesseract binary)
        MODEL = "tesseract"
    except ImportError:
        MODEL = None


def ready():
    """Return (is_ready, detail) for the web app's status badge."""
    if MODEL is None:
        return False, "No OCR model mounted: edit ocr-model/model.py (load/predict)."
    return True, f"Model loaded: {MODEL}"


def predict(image_bytes: bytes) -> dict:
    """Run OCR on one scanned page (JPEG/PNG/WebP bytes) and return a dict (see above)."""
    if MODEL is None:
        raise RuntimeError("No OCR model mounted. Edit ocr-model/model.py and implement load()/predict().")

    if MODEL == "tesseract":
        import io
        import pytesseract
        from PIL import Image

        image = Image.open(io.BytesIO(image_bytes)).convert("L")
        data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
        words = [(w, c) for w, c in zip(data["text"], data["conf"]) if w.strip()]
        text = pytesseract.image_to_string(image)
        confs = [float(c) for _, c in words if float(c) >= 0]
        return {"text": text, "confidence": (sum(confs) / len(confs) / 100.0) if confs else None}

    # Example for a custom model:
    #   lines = MODEL.ocr(image_bytes)                       # your inference call
    #   return {"text": "\n".join(l.text for l in lines)}
    raise RuntimeError(f"predict() does not handle model {MODEL!r}")
