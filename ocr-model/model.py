"""
IRBY Dental Ledger - OCR & document classification pipeline (RapidOCR edition).

  1. Document scanning and recovery (scan.py): paper outline + perspective correction,
     deskew, 90/180 degree recovery, lighting flattening, printed-rule removal and a
     print / handwriting split by ink colour.
  2. RapidOCR (PP-OCR detector + recogniser on onnxruntime) with box clean-up and recovery
     re-reads: digits-only decode for dates / phone numbers, contrast-enhanced retry for weak
     (usually handwritten) reads, and splitting of 'Label: value' boxes the detector glued.
  3. Label <-> answer pairing (formparse.py) and the PDA Patient Information Record extractor
     (pda.py): text fields, circled Yes / No, circled Sex M/F, '( )' checklists.
  4. The Keras document classifier (doc_classifier_frozen_easyocr.keras + doc_class_names.json).
     Its second input was trained on EasyOCR recogniser features, which RapidOCR cannot produce,
     so that input receives the layer's own training mean (see _neutral_ocr_features); the
     image branch decides the class.

server.py (OCR_PROVIDER=http) and infer.py (OCR_PROVIDER=command) call load(), ready() and
predict(image_bytes).
"""
import json
import os
import sys
import threading
import time
import warnings

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=DeprecationWarning)

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
if MODEL_DIR not in sys.path:
    sys.path.insert(0, MODEL_DIR)

KERAS_MODEL_PATH = os.path.join(MODEL_DIR, "doc_classifier_frozen_easyocr.keras")
CLASS_NAMES_PATH = os.path.join(MODEL_DIR, "doc_class_names.json")
OCR_FEATURE_LAYER = "batch_normalization_1"     # first layer after the 256-d OCR feature input

CLASSIFIER = None
CLASS_NAMES = ["document", "form", "invoice", "real_life"]
OCR_FEATURES = None
READER = None
LOAD_ERROR = None
CLASSIFIER_ERROR = None
_PREDICT_LOCK = threading.Lock()


def load():
    """Load RapidOCR (required) and the Keras classifier (optional) once at startup."""
    global CLASSIFIER, CLASS_NAMES, READER, LOAD_ERROR, CLASSIFIER_ERROR, OCR_FEATURES
    LOAD_ERROR = CLASSIFIER_ERROR = None
    try:
        from scan import RapidReader
        READER = RapidReader()
        READER.warm_up()                       # first ONNX call is slow; pay it at startup
    except Exception as exc:
        READER = None
        LOAD_ERROR = f"RapidOCR failed to load: {exc}"
        return

    try:
        if os.path.exists(CLASS_NAMES_PATH):
            with open(CLASS_NAMES_PATH, "r", encoding="utf-8") as fh:
                names = json.load(fh)
            if isinstance(names, list) and names:
                CLASS_NAMES = [str(c) for c in names]
        if not os.path.exists(KERAS_MODEL_PATH):
            CLASSIFIER_ERROR = f"missing {os.path.basename(KERAS_MODEL_PATH)}"
            return
        import keras
        import numpy as np
        CLASSIFIER = keras.models.load_model(KERAS_MODEL_PATH, compile=False)
        OCR_FEATURES = _neutral_ocr_features(CLASSIFIER, np)
        dummy = [np.zeros((1, 224, 224, 3), np.float32), OCR_FEATURES]
        CLASSIFIER.predict(dummy, verbose=0)
    except Exception as exc:
        CLASSIFIER = None
        CLASSIFIER_ERROR = str(exc)


def ready():
    """(is_ready, detail) for the web app's OCR status badge."""
    if READER is None:
        return False, LOAD_ERROR or "RapidOCR not loaded"
    if CLASSIFIER is None:
        return True, f"RapidOCR ready (document classifier off: {CLASSIFIER_ERROR or 'not loaded'})"
    return True, f"RapidOCR + Keras document classifier ({len(CLASS_NAMES)} classes) ready"


# ---------------------------------------------------------------------------
# Keras document classifier
# ---------------------------------------------------------------------------
def _neutral_ocr_features(model, np):
    """256-d vector for the 'ocr_feat_input' branch.

    The classifier was trained with EasyOCR's frozen VGG features on that input. RapidOCR's
    recogniser is a different network, so its features would be out of distribution. Feeding
    the input batch-norm's moving mean (the average training feature) makes that branch output
    its neutral value, and the EfficientNet image branch drives the decision."""
    try:
        layer = model.get_layer(OCR_FEATURE_LAYER)
        mean = np.asarray(layer.moving_mean, dtype=np.float32).reshape(1, -1)
        if mean.shape[1] == 256:
            return mean
    except Exception:
        pass
    return np.zeros((1, 256), dtype=np.float32)


def _classify_document(bgr_img, is_pda_form=False):
    import cv2
    import numpy as np

    if CLASSIFIER is None:
        return ("form" if is_pda_form else "document"), (0.9 if is_pda_form else 0.5)
    rgb = cv2.cvtColor(cv2.resize(bgr_img, (224, 224), interpolation=cv2.INTER_AREA),
                       cv2.COLOR_BGR2RGB).astype(np.float32)
    preds = CLASSIFIER.predict([rgb[None, ...], OCR_FEATURES], verbose=0)[0]
    n_cls = len(CLASS_NAMES)
    sub = np.asarray(preds[:n_cls], dtype=np.float64)
    total = float(sub.sum())
    probs = sub / total if total > 1e-8 else np.ones(n_cls) / n_cls
    idx = int(np.argmax(probs))
    doc_type, doc_conf = CLASS_NAMES[idx], float(probs[idx])
    # the printed PDA headings were read: this is a form whatever the picture looks like
    if is_pda_form and "form" in CLASS_NAMES:
        doc_type, doc_conf = "form", max(doc_conf, 0.92)
    return doc_type, round(doc_conf, 4)


# ---------------------------------------------------------------------------
# Reading-order text for 'Show scanned text'
# ---------------------------------------------------------------------------
def _reading_text(raw, med_h):
    if not raw:
        return ""
    rows = []
    for bbox, text, conf, layer in sorted(raw, key=lambda r: ((r[0][0][1] + r[0][2][1]) / 2.0, r[0][0][0])):
        cy = (bbox[0][1] + bbox[2][1]) / 2.0
        if rows and abs(cy - rows[-1]["cy"]) <= 0.6 * med_h:
            rows[-1]["items"].append((bbox[0][0], text))
        else:
            rows.append({"cy": cy, "items": [(bbox[0][0], text)]})
    return "\n".join("  ".join(t for _, t in sorted(r["items"])) for r in rows)


# ---------------------------------------------------------------------------
# predict
# ---------------------------------------------------------------------------
def predict(image_bytes: bytes) -> dict:
    """One scanned page -> {fields, confidence, medicalHistory?, documentType, documentConfidence,
    text, review, scan}."""
    if READER is None:
        raise RuntimeError(f"OCR model not loaded: {LOAD_ERROR or 'call load() first'}")
    import numpy as np
    from formparse import FormParser
    import pda
    import scan

    t0 = time.time()
    with _PREDICT_LOCK:                         # onnxruntime sessions are shared
        original, work, info = scan.scan_page(READER, image_bytes)
        doc = scan.ocr_document(READER, work)
    parsed = FormParser().parse(doc["raw"], doc["clean"], ruled_image=doc["ruled"])
    tokens_text = [t["text"] for t in parsed["tokens"]]
    is_pda, hits = pda.is_pda_form(tokens_text)

    info.update(boxes=len(doc["raw"]), handwritingLayer=doc["layered"], pdaMarkers=hits)
    try:
        doc_type, doc_conf = _classify_document(original, is_pda_form=is_pda)
    except Exception as exc:
        doc_type, doc_conf = ("form" if is_pda else "document"), 0.5
        info["classifier"] = f"failed: {exc}"

    text = _reading_text(doc["raw"], parsed["med_h"])
    if is_pda:
        fields, conf, medical, review = pda.extract(doc, parsed)
        out = {"fields": fields, "confidence": conf, "medicalHistory": medical}
    else:
        fields, conf, review = pda.extract_generic(parsed)
        out = {"fields": fields, "confidence": conf}
    if not conf:
        mean = float(np.mean([r[2] for r in doc["raw"]])) if doc["raw"] else 0.0
        out["confidence"] = round(mean, 4)
    info["seconds"] = round(time.time() - t0, 2)
    # fieldsComplete: the web app must not re-parse `text` for more fields (see server/ocr/parser.js)
    out.update(documentType=doc_type, documentConfidence=doc_conf, text=text, review=review,
               fieldsComplete=True, scan=info)
    return out


if __name__ == "__main__":                      # python model.py page.jpg
    load()
    print(ready())
    for path in sys.argv[1:]:
        with open(path, "rb") as fh:
            res = predict(fh.read())
        res.pop("text", None)
        print(json.dumps(res, indent=2, ensure_ascii=False))
