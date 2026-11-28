"""
Document scanning, recovery and RapidOCR reading.

Pipeline (scan_page):
  1. decode          - image bytes -> BGR (EXIF rotation honoured by OpenCV)
  2. find_page       - largest 4-corner paper outline -> perspective-corrected page (phone photos)
  3. deskew          - projection-profile search for the small rotation left after step 2
  4. orient          - 90/180 degree recovery: box shapes + recogniser confidence on a sample
  5. prepare_image   - resize to a working width where handwriting strokes are resolvable
  6. ocr_document    - rule removal, print / handwriting ink split, detector boxes, box clean-up,
                       batched recognition with digit-only and contrast re-reads

Box clean-up, the ink-layer split and the re-read strategies follow the approach of the
barangay-form OCR server this module was adapted from.
"""
import os
import re
import unicodedata

import cv2
import numpy as np

from lexicon import is_unit, label_start_canon, match_label, value_fit, PHONE_LIKE_CANONS
from textnorm import DIGIT_FIX, norm

# working resolution
WORK_MIN_WIDTH = 1800
WORK_MAX_SIDE = 3600

# coloured-pen (handwriting) layer split
HAND_CHROMA_SEED = 60
HAND_CHROMA_WEAK = 28
HAND_SEED_FRAC = 0.20
HAND_MIN_COMP = 12
HAND_CHROMA_MEDIAN = 45

JOIN_GAP_LAYERED = 0.6
JOIN_GAP_PLAIN = 0.2

DET_PARAMS = dict(thresh=0.30, box_thresh=0.50, unclip_ratio=1.5, limit_side_len=2048)
MIN_BOX = 10                      # px; detector boxes smaller than this are dropped
LOW_CONF_REREAD = 0.50
WORD_GAP_SPLIT = 1.5

_REC_PAD = 4
_MAX_REC_RATIO = 16.0             # wider line crops are read in chunks (recogniser cost ~ width^2)
_CHUNK_RATIO = 11.0


# =========================================================================
# RapidOCR reader (PP-OCR models on onnxruntime; no TensorFlow / torch clash)
# =========================================================================
def as_bgr(img):
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    return img


def _apply_allowlist(text, allow):
    """RapidOCR has no allowlist -> map look-alikes to digits when digits-only, then drop the rest."""
    allow = set(allow)
    if not any(c.isalpha() for c in allow):
        text = text.translate(DIGIT_FIX)
    return "".join(c for c in text if c in allow)


class RapidReader:
    """detect(img) -> [[x1, y1, x2, y2]];  read(img, rects, allowlist) -> [(text, conf) | None]."""

    def __init__(self):
        from rapidocr_onnxruntime import RapidOCR
        # onnxruntime's default (one spinning thread per logical CPU) is 3-4x slower on laptop
        # CPUs with efficiency cores than 4 non-spinning threads. OCR_THREADS overrides.
        threads = int(os.environ.get("OCR_THREADS", "0") or 0) or max(2, min(4, (os.cpu_count() or 4) // 2))
        try:
            self.engine = RapidOCR(intra_op_num_threads=threads, inter_op_num_threads=1)
        except Exception:
            self.engine = RapidOCR()
        self.threads = threads
        self._tune_sessions(threads)
        det = self.engine.text_det
        post = getattr(det, "postprocess_op", None)
        for k in ("thresh", "box_thresh", "unclip_ratio"):
            if post is not None and hasattr(post, k):
                setattr(post, k, DET_PARAMS[k])
        # rapidocr picks the detector input size per call (960/1500/2000); allow larger pages so
        # small handwriting on a full A4 scan keeps enough pixels.
        if hasattr(det, "get_preprocess"):
            try:
                from rapidocr_onnxruntime.ch_ppocr_det.utils import DetPreProcess
                limit = DET_PARAMS["limit_side_len"]

                def _pre(max_wh, _det=det):
                    side = 960 if max_wh < 960 else min(int(max_wh), limit)
                    return DetPreProcess(side, "max", _det.mean, _det.std)
                det.get_preprocess = _pre
            except Exception:
                pass

    def _tune_sessions(self, threads):
        """Recreate rapidocr's ONNX sessions without thread spinning and with denormals flushed."""
        try:
            import onnxruntime as ort
        except Exception:
            return
        holders = [getattr(self.engine.text_det, "infer", None), getattr(self.engine.text_rec, "session", None),
                   getattr(getattr(self.engine, "text_cls", None), "session", None)]
        for h in holders:
            sess = getattr(h, "session", None)
            path = getattr(sess, "_model_path", None)
            if sess is None or not path:
                continue
            try:
                so = ort.SessionOptions()
                so.intra_op_num_threads = threads
                so.inter_op_num_threads = 1
                so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
                so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                so.add_session_config_entry("session.intra_op.allow_spinning", "0")
                so.add_session_config_entry("session.set_denormal_as_zero", "1")
                h.session = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
            except Exception as e:
                print(f"[rapidocr] keeping default session options ({e})", flush=True)

    def detect(self, img):
        img = as_bgr(img)
        H, W = img.shape[:2]
        try:
            boxes, _ = self.engine.text_det(img)
        except Exception as e:
            print(f"[rapidocr] detect failed: {e}", flush=True)
            return []
        rects = []
        for poly in (boxes if boxes is not None else []):
            p = np.asarray(poly, dtype=float).reshape(-1, 2)
            x1, x2 = max(p[:, 0].min(), 0.0), min(p[:, 0].max(), W)
            y1, y2 = max(p[:, 1].min(), 0.0), min(p[:, 1].max(), H)
            if x2 - x1 >= MIN_BOX and y2 - y1 >= MIN_BOX:
                rects.append([float(x1), float(y1), float(x2), float(y2)])
        return rects

    def read_crops(self, crops, allowlist=None):
        """One recogniser call for all crops: rapidocr sorts them by aspect ratio and batches
        similar widths together, so a single long line never pads a batch of short words."""
        out = [None] * len(crops)
        if not crops:
            return out
        try:
            res, _ = self.engine.text_rec(list(crops))
        except Exception as e:
            print(f"[rapidocr] recognise failed: {e}", flush=True)
            return out
        for i, (text, conf) in enumerate(res or []):
            # the PP-OCR models are trained on Chinese + English and emit full-width
            # punctuation ('（', '：', '／'); NFKC folds it back to ASCII
            text = unicodedata.normalize("NFKC", text or "")
            text = (_apply_allowlist(text, allowlist) if allowlist else text).strip()
            if text:
                out[i] = (text, float(conf))
        return out

    @staticmethod
    def _chunks(gray_crop):
        """Cut a very wide line crop at its emptiest columns. The PP-OCRv4 recogniser has global
        attention over the line, so its cost grows with the square of the width: 24 crops of a
        50:1 line take ~15 s on a laptop CPU, the same text in 12:1 chunks well under 1 s.
        -> [(x0, x1, space_before)]"""
        h, w = gray_crop.shape[:2]
        ratio = w / float(max(h, 1))
        if ratio <= _MAX_REC_RATIO:
            return [(0, w, False)]
        _, binv = cv2.threshold(gray_crop, 0, 1, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
        prof = np.convolve(binv.sum(axis=0).astype(float), np.ones(3) / 3.0, mode="same")
        n = int(np.ceil(ratio / _CHUNK_RATIO))
        cuts = []
        for k in range(1, n):
            target = k * w / n
            lo, hi = int(max(target - w / (3.0 * n), 1)), int(min(target + w / (3.0 * n), w - 2))
            if hi <= lo:
                continue
            c = lo + int(np.argmin(prof[lo:hi] + 0.001 * np.abs(np.arange(lo, hi) - target)))
            if not cuts or c - cuts[-1] > 0.5 * h:
                cuts.append(c)
        bounds = [0] + cuts + [w]
        out = []
        for i in range(len(bounds) - 1):
            a, b = bounds[i], bounds[i + 1]
            gap = 0
            if i > 0:                                 # blank columns around the cut = a real space
                j = a
                while j > 0 and prof[j] <= 0.5:
                    j -= 1
                k2 = a
                while k2 < w - 1 and prof[k2] <= 0.5:
                    k2 += 1
                gap = k2 - j
            out.append((a, b, gap >= 0.3 * h))
        return out

    def read(self, img, rects, allowlist=None):
        H, W = img.shape[:2]
        gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        crops, owners = [], []
        for i, r in enumerate(rects):
            x1, y1 = max(int(r[0]), 0), max(int(r[1]), 0)
            x2, y2 = min(int(np.ceil(r[2])), W), min(int(np.ceil(r[3])), H)
            if x2 - x1 < 2 or y2 - y1 < 2:
                continue
            for a, b, space in self._chunks(gray[y1:y2, x1:x2]):
                crop = cv2.copyMakeBorder(img[y1:y2, x1 + a:x1 + b], _REC_PAD, _REC_PAD, _REC_PAD, _REC_PAD,
                                          cv2.BORDER_REPLICATE)
                crops.append(np.ascontiguousarray(as_bgr(crop)))
                owners.append((i, space, b - a))
        out = [None] * len(rects)
        parts = {}
        for (i, space, width), rd in zip(owners, self.read_crops(crops, allowlist)):
            parts.setdefault(i, []).append((rd, space, width))
        for i, ps in parts.items():
            text, wsum, csum = "", 0.0, 0.0
            for rd, space, width in ps:
                if not rd:
                    continue
                text += (" " if (space and text) else "") + rd[0]
                wsum += width
                csum += rd[1] * width
            if text.strip():
                out[i] = (text.strip(), csum / max(wsum, 1.0))
        return out

    def warm_up(self):
        img = np.full((96, 420, 3), 255, np.uint8)
        cv2.putText(img, "Warm up 0123", (12, 64), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 0), 3)
        rects = self.detect(img)
        self.read(img, rects or [[0, 0, 420, 96]])


# =========================================================================
# 1-4. Page recovery: decode, find paper, deskew, upright
# =========================================================================
def decode(image_bytes):
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image bytes (send a JPEG, PNG or WebP image).")
    return img


def _order_corners(pts):
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    s, d = pts.sum(axis=1), np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]],
                    dtype=np.float32)


def _quad_candidates(small):
    """4-corner outlines of the paper: from edges, and from 'bright paper vs darker background'."""
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    masks = []
    edges = cv2.Canny(gray, 40, 130)
    masks.append(cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2))
    _, bright = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    masks.append(cv2.morphologyEx(bright, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8)))
    out = []
    for m in masks:
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:5]:
            hull = cv2.convexHull(c)
            peri = cv2.arcLength(hull, True)
            for eps in (0.015, 0.02, 0.03, 0.045):
                ap = cv2.approxPolyDP(hull, eps * peri, True)
                if len(ap) == 4 and cv2.isContourConvex(ap):
                    out.append(ap.reshape(4, 2).astype(np.float32))
                    break
    return out


def find_page(img):
    """Perspective-correct the sheet when a photo shows it on a background. Returns (img, info)."""
    H, W = img.shape[:2]
    scale = 1000.0 / max(H, W)
    small = cv2.resize(img, (int(W * scale), int(H * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else img
    s = scale if scale < 1 else 1.0
    area = small.shape[0] * small.shape[1]
    best = None
    for q in _quad_candidates(small):
        a = cv2.contourArea(q)
        if not (0.30 * area <= a <= 0.97 * area):
            continue
        q = _order_corners(q)
        # every corner angle must be paper-like (between 55 and 125 degrees)
        ok = True
        for i in range(4):
            p0, p1, p2 = q[i - 1], q[i], q[(i + 1) % 4]
            v1, v2 = p0 - p1, p2 - p1
            cosang = float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-6))
            if abs(cosang) > 0.57:
                ok = False
                break
        if ok and (best is None or a > best[0]):
            best = (a, q)
    if best is None:
        return img, {"page": "full-frame"}
    q = best[1] / s
    tl, tr, br, bl = q
    w_out = int(round(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))))
    h_out = int(round(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))))
    if w_out < 300 or h_out < 300 or not (0.4 <= w_out / float(h_out) <= 2.5):
        return img, {"page": "full-frame"}
    M = cv2.getPerspectiveTransform(q, np.array([[0, 0], [w_out - 1, 0], [w_out - 1, h_out - 1],
                                                 [0, h_out - 1]], dtype=np.float32))
    warped = cv2.warpPerspective(img, M, (w_out, h_out), flags=cv2.INTER_CUBIC,
                                 borderMode=cv2.BORDER_REPLICATE)
    return warped, {"page": "perspective-corrected", "coverage": round(best[0] / area, 3)}


def _rotate(img, angle):
    H, W = img.shape[:2]
    M = cv2.getRotationMatrix2D((W / 2.0, H / 2.0), angle, 1.0)
    return cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def _profile_score(binv, angle):
    H, W = binv.shape
    M = cv2.getRotationMatrix2D((W / 2.0, H / 2.0), angle, 1.0)
    rot = cv2.warpAffine(binv, M, (W, H), flags=cv2.INTER_NEAREST, borderValue=0)
    prof = rot.sum(axis=1, dtype=np.float64)
    return float(np.var(np.diff(prof)))


def deskew(img, max_angle=8.0):
    """Small-angle rotation from the sharpness of the row profile (text lines + table rules)."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    H, W = gray.shape
    scale = 900.0 / max(H, W)
    small = cv2.resize(gray, (int(W * scale), int(H * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else gray
    binv = cv2.adaptiveThreshold(small, 1, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 15)
    if int(binv.sum()) < 0.002 * binv.size:
        return img, 0.0
    coarse = np.arange(-max_angle, max_angle + 0.01, 1.0)
    best = max(coarse, key=lambda a: _profile_score(binv, a))
    fine = np.arange(best - 1.0, best + 1.01, 0.1)
    angle = float(max(fine, key=lambda a: _profile_score(binv, a)))
    if abs(angle) < 0.15 or abs(angle) >= max_angle:
        return img, 0.0
    return _rotate(img, angle), round(angle, 2)


def _box_shape_votes(rects):
    horiz = sum(1 for r in rects if (r[2] - r[0]) > 1.6 * (r[3] - r[1]))
    vert = sum(1 for r in rects if (r[3] - r[1]) > 1.6 * (r[2] - r[0]))
    return horiz, vert


def _upside_down_votes(reader, img, rects, k=24):
    """RapidOCR's small text-direction classifier (0 / 180 degrees) on a sample of lines."""
    rects = [r for r in rects if 2.0 <= (r[2] - r[0]) / max(r[3] - r[1], 1.0) <= 14.0]
    rects = sorted(rects, key=lambda r: -(r[3] - r[1]))[:k]
    crops = []
    for r in rects:
        x1, y1, x2, y2 = [int(v) for v in r]
        c = img[max(y1, 0):y2, max(x1, 0):x2]
        if c.size:
            crops.append(np.ascontiguousarray(as_bgr(c)))
    if len(crops) < 4:
        return 0, 0
    cls = getattr(reader.engine, "text_cls", None)
    if cls is None:
        return 0, 0
    _, res, _ = cls(crops)
    flipped = sum(1 for lab, score in res if str(lab) == "180" and score >= 0.8)
    upright = sum(1 for lab, score in res if str(lab) == "0" and score >= 0.8)
    return upright, flipped


def orient(reader, img):
    """Recover pages photographed sideways or upside down. Returns (img, degrees_rotated)."""
    H, W = img.shape[:2]
    scale = 1280.0 / max(H, W)
    small = cv2.resize(img, (int(W * scale), int(H * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else img.copy()
    rects = reader.detect(small)
    horiz, vert = _box_shape_votes(rects)
    turned = 0
    if vert > max(6, 1.5 * horiz):
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        small = cv2.rotate(small, cv2.ROTATE_90_CLOCKWISE)
        rects = reader.detect(small)
        turned = 90
    upright, flipped = _upside_down_votes(reader, small, rects)
    if flipped >= 4 and flipped > 2 * upright:
        img = cv2.rotate(img, cv2.ROTATE_180)
        turned = (turned + 180) % 360
    return img, turned


def prepare_image(img):
    h, w = img.shape[:2]
    scale = WORK_MIN_WIDTH / float(w) if w < WORK_MIN_WIDTH else 1.0
    scale = min(scale, WORK_MAX_SIDE / float(max(h, w)))
    if abs(scale - 1.0) < 0.03:
        return img
    interp = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
    return cv2.resize(img, (int(round(w * scale)), int(round(h * scale))), interpolation=interp)


def flatten_illumination(img):
    """Divide out uneven lighting (phone shadows) while keeping ink colour for the layer split."""
    H, W = img.shape[:2]
    k = max(31, (min(H, W) // 18) | 1)
    out = np.empty_like(img)
    for c in range(3):
        ch = img[:, :, c]
        bg = cv2.morphologyEx(ch, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
        bg = cv2.GaussianBlur(bg, (k, k), 0)
        out[:, :, c] = np.clip(ch.astype(np.float32) / np.maximum(bg.astype(np.float32), 1.0) * 245.0,
                               0, 255).astype(np.uint8)
    return out


def needs_flattening(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA)
    bg = cv2.morphologyEx(small, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    return float(np.percentile(bg, 95) - np.percentile(bg, 5)) > 40


def scan_page(reader, image_bytes):
    """bytes -> (original BGR, work BGR, info). Every step falls back to its input on failure."""
    original = decode(image_bytes)
    info = {}
    img = original
    try:
        img, page = find_page(img)
        info.update(page)
    except Exception as e:
        info["page"] = f"full-frame ({e})"
    try:
        img, turned = orient(reader, img)
        info["rotated"] = turned
    except Exception:
        info["rotated"] = 0
    try:
        img, angle = deskew(img)
        info["deskew"] = angle
    except Exception:
        info["deskew"] = 0.0
    work = prepare_image(img)
    if needs_flattening(work):
        work = flatten_illumination(work)
        info["illumination"] = "flattened"
    return original, work, info


# =========================================================================
# 5. Ink, rules, print / handwriting layers
# =========================================================================
def _rect_inter(a, b):
    return min(a[2], b[2]) - max(a[0], b[0]), min(a[3], b[3]) - max(a[1], b[1])


def _rect_area(r):
    return max(r[2] - r[0], 0.0) * max(r[3] - r[1], 0.0)


def _runs(mask):
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return []
    br = np.where(np.diff(idx) > 1)[0]
    starts = np.r_[idx[0], idx[br + 1]]
    ends = np.r_[idx[br], idx[-1]]
    return list(zip(starts.tolist(), ends.tolist()))


def chroma(img):
    b, g, r = [c.astype(np.int16) for c in cv2.split(img)]
    return np.maximum(np.maximum(b, g), r) - np.minimum(np.minimum(b, g), r)


def prep_ink(image):
    """gray, ink mask (rules removed), horizontal-rule mask, vertical-rule mask."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    H, W = gray.shape[:2]
    bs = max(25, (W // 70) | 1)
    binv = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, bs, 12)
    hk = cv2.getStructuringElement(cv2.MORPH_RECT, (max(30, W // 14), 1))
    vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(30, H // 30)))
    hl = cv2.morphologyEx(binv, cv2.MORPH_OPEN, hk)
    vl = cv2.morphologyEx(binv, cv2.MORPH_OPEN, vk)
    k = 5 if W >= 1500 else 3
    lines = cv2.dilate(cv2.bitwise_or(hl, vl), np.ones((k, k), np.uint8))
    ink = cv2.bitwise_and(binv, cv2.bitwise_not(lines))
    return gray, ink, hl, vl


def erase_rules(image, hl, vl):
    """Whiten printed rules / answer lines (coloured pen strokes crossing a rule are kept)."""
    k = 5 if image.shape[1] >= 1500 else 3
    lines = cv2.dilate(cv2.bitwise_or(hl, vl), np.ones((k, k), np.uint8))
    kill = (lines > 0) & (chroma(image) <= 45)
    out = image.copy()
    out[kill] = (255, 255, 255)
    return out


def ink_only(gray):
    bs = max(25, (gray.shape[1] // 70) | 1)
    return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, bs, 12)


def _comp_median(lab, vals, mask, n):
    out = np.zeros(n, np.float32)
    m = mask & (lab > 0)
    if not m.any():
        return out
    ids, v = lab[m], vals[m].astype(np.int32)
    order = np.lexsort((v, ids))
    ids, v = ids[order], v[order]
    starts = np.r_[0, np.flatnonzero(np.diff(ids)) + 1]
    ends = np.r_[starts[1:], ids.size]
    out[ids[starts]] = v[(starts + ends - 1) // 2]
    return out


def _strict_hand_core(clean, chrom, gray):
    """Strongly coloured strokes (flatbed scans of blue / red ballpen)."""
    H, W = gray.shape
    seed = (chrom >= HAND_CHROMA_SEED) & (gray < 200)
    if int(seed.sum()) < max(300, 0.0004 * H * W):
        return None
    weak = ((chrom >= HAND_CHROMA_WEAK) & (gray < 230)) | seed
    n, lab, stats, _ = cv2.connectedComponentsWithStats(weak.astype(np.uint8), connectivity=8)
    seeds = np.bincount(lab[seed], minlength=n)
    area = stats[:, cv2.CC_STAT_AREA]
    typical = _comp_median(lab, chrom, gray < 160, n)
    keep = np.zeros(n, bool)
    keep[1:] = ((area[1:] >= HAND_MIN_COMP) & (seeds[1:] >= HAND_SEED_FRAC * area[1:])
                & (typical[1:] >= HAND_CHROMA_MEDIAN))
    return keep[lab]


def _otsu_1d(hist):
    total = hist.sum()
    if total <= 0:
        return None
    levels = np.arange(hist.size, dtype=np.float64)
    w0 = np.cumsum(hist)
    m0 = np.cumsum(hist * levels)
    mt = m0[-1]
    w1 = total - w0
    with np.errstate(divide="ignore", invalid="ignore"):
        between = (mt * w0 / total - m0) ** 2 / (w0 * w1 / total)
    between[~np.isfinite(between)] = 0
    return int(np.argmax(between))


def _adaptive_hand_core(chrom, gray):
    """Phone photos: JPEG chroma subsampling and blur wash a thin pen stroke out to a chroma of
    20-30, far below a scanner's 100+. Classify whole ink strokes instead: median colour of each
    connected stroke, split print / pen with Otsu on the page's own stroke colours."""
    ink = ink_only(gray) > 0
    n, lab, stats, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8), connectivity=8)
    if n < 30:
        return None
    med = _comp_median(lab, chrom, ink, n)
    area = stats[:, cv2.CC_STAT_AREA].astype(np.float64)
    valid = np.zeros(n, bool)
    valid[1:] = area[1:] >= HAND_MIN_COMP
    vals = np.clip(med[valid], 0, 255).astype(int)
    if vals.size < 30:
        return None
    t = _otsu_1d(np.bincount(vals, weights=area[valid], minlength=256))
    if t is None:
        return None
    lo, hi = vals[vals <= t], vals[vals > t]
    if hi.size < 8 or lo.size < 8:
        return None
    lo_m, hi_m = float(np.median(lo)), float(np.median(hi))
    if hi_m < 15 or hi_m - lo_m < 12:
        return None                    # no colour population distinct from the print
    H, W = gray.shape
    x, y, w, h = (stats[:, cv2.CC_STAT_LEFT], stats[:, cv2.CC_STAT_TOP],
                  stats[:, cv2.CC_STAT_WIDTH], stats[:, cv2.CC_STAT_HEIGHT])
    inside = (x > 1) & (y > 1) & (x + w < W - 1) & (y + h < H - 1)   # background left at the edges
    strong = max(t, lo_m + 8, 10)
    keep = valid & inside & (med > strong)
    # hysteresis: weaker strokes touching the pen zone (i-dots, commas, washed-out letters)
    k = max(7, (W // 110) | 1)
    near = cv2.dilate(keep[lab].astype(np.uint8), np.ones((k, k), np.uint8)) > 0
    ids = np.unique(lab[near & (lab > 0)])
    weak = np.zeros(n, bool)
    weak[ids] = True
    keep |= weak & inside & (area >= 3) & (med > (lo_m + strong) / 2.0)
    return keep[lab]


def split_layers(clean):
    """Split into (print_img, hand_img) by ink colour, or None when the page has no coloured ink.
    Blue / red ballpen on a black-printed form is the common case at the clinic."""
    chrom = chroma(clean)
    gray = cv2.cvtColor(clean, cv2.COLOR_BGR2GRAY)
    H, W = gray.shape
    need = max(300, 0.0004 * H * W)
    core = _strict_hand_core(clean, chrom, gray)
    strict_px = int(core.sum()) if core is not None else 0
    try:
        alt = _adaptive_hand_core(chrom, gray)
    except Exception:
        alt = None
    if alt is not None and int(alt.sum()) >= need:
        # strict catches saturated strokes, the adaptive pass the washed-out ones (phone JPEGs)
        core = alt if core is None else (core | alt)
    if core is None or int(core.sum()) < need:
        return None
    zone = cv2.dilate(core.astype(np.uint8) * 255, np.ones((3, 3), np.uint8)) > 0
    hand = np.full_like(clean, 255)
    hand[zone] = clean[zone]
    # the print copy loses a wider halo: the faint anti-aliased rim of a pen stroke would
    # otherwise be detected again on the print layer and cut the real handwriting box in two
    k = 5 if W >= 1500 else 3
    wide = cv2.dilate(core.astype(np.uint8) * 255, np.ones((k, k), np.uint8)) > 0
    prn = clean.copy()
    prn[wide] = 255
    return prn, hand


# =========================================================================
# 6a. Box clean-up
# =========================================================================
def _drop_edge_stubs(crop):
    h, w = crop.shape
    if h < 12 or w < 6:
        return crop
    prof = crop.sum(axis=1)
    if prof.max() <= 0:
        return crop
    core = np.flatnonzero(prof >= 0.35 * prof.max())
    top, bot = int(core[0]), int(core[-1])
    bh = bot - top + 1
    n, lab, stats, _ = cv2.connectedComponentsWithStats(crop.astype(np.uint8), connectivity=8)
    out = crop.copy()
    for i in range(1, n):
        _, y, _, ch, _ = stats[i]
        if y > 0 and y + ch < h:
            continue
        cy = y + ch / 2.0
        if cy < top - 0.35 * bh or cy > bot + 0.35 * bh:
            out[lab == i] = False
    return out


def tighten(r, ink, pad=2, min_w=0.4):
    """Shrink a box to the ink it contains. Never grows the box."""
    H, W = ink.shape[:2]
    x1, y1 = int(max(r[0], 0)), int(max(r[1], 0))
    x2, y2 = int(min(np.ceil(r[2]), W)), int(min(np.ceil(r[3]), H))
    if x2 - x1 < 4 or y2 - y1 < 4:
        return r
    crop = ink[y1:y2, x1:x2] > 0
    stub_free = _drop_edge_stubs(crop)
    if stub_free.sum() >= 0.5 * crop.sum():
        crop = stub_free
    rows = np.where(crop.sum(axis=1) >= 2)[0]
    cols = np.where(crop.sum(axis=0) >= 2)[0]
    if rows.size == 0 or cols.size == 0:
        return r
    nr = [float(max(x1 + cols[0] - pad, r[0])), float(max(y1 + rows[0] - pad, r[1])),
          float(min(x1 + cols[-1] + 1 + pad, r[2])), float(min(y1 + rows[-1] + 1 + pad, r[3]))]
    if (nr[3] - nr[1]) < 0.4 * (r[3] - r[1]) or (nr[2] - nr[0]) < min_w * (r[2] - r[0]):
        return r
    return nr


def cut_at(axis, lo, hi, s_lo, s_hi, ink, rules):
    """Best place to cut between lo..hi: a printed rule if present, else the emptiest line."""
    mid = (lo + hi) / 2.0
    if ink is None or rules is None:
        return mid
    H, W = ink.shape[:2]
    lim_a, lim_b = (H, W) if axis == "y" else (W, H)
    lo_i, hi_i = max(int(round(lo)), 0), min(int(round(hi)), lim_a)
    s0, s1 = max(int(round(s_lo)), 0), min(int(round(s_hi)), lim_b)
    if hi_i - lo_i < 2 or s1 - s0 < 2:
        return mid
    if axis == "y":
        p_rule = (rules[lo_i:hi_i, s0:s1] > 0).sum(axis=1)
        p_ink = (ink[lo_i:hi_i, s0:s1] > 0).sum(axis=1)
    else:
        p_rule = (rules[s0:s1, lo_i:hi_i] > 0).sum(axis=0)
        p_ink = (ink[s0:s1, lo_i:hi_i] > 0).sum(axis=0)
    ruled = np.where(p_rule >= 0.5 * (s1 - s0))[0]
    if ruled.size:
        return lo_i + float(np.median(ruled))
    prof = np.convolve(p_ink.astype(float), np.ones(3) / 3.0, mode="same")
    prof = prof + 0.02 * np.abs(np.arange(len(prof)) - len(prof) / 2.0)
    return lo_i + float(np.argmin(prof))


def _split_rows(r, ink, med_h, depth=0):
    h = r[3] - r[1]
    if depth >= 3 or h < 1.9 * med_h:
        return [r]
    x1, x2 = int(r[0]), int(np.ceil(r[2]))
    y1, y2 = int(r[1]), int(np.ceil(r[3]))
    crop = ink[y1:y2, x1:x2] > 0
    if crop.size == 0:
        return [r]
    prof = np.convolve(crop.sum(axis=1).astype(float), np.ones(3) / 3.0, mode="same")
    lo, hi = int(0.25 * len(prof)), int(0.75 * len(prof))
    if hi - lo < 2 or prof.max() <= 0:
        return [r]
    k = lo + int(np.argmin(prof[lo:hi]))
    if prof[k] > 0.04 * prof.max():
        return [r]
    cut = y1 + k
    if cut - y1 < 0.7 * med_h or y2 - cut < 0.7 * med_h:
        return [r]
    top = [r[0], r[1], r[2], float(cut)]
    bot = [r[0], float(cut), r[2], r[3]]
    return _split_rows(top, ink, med_h, depth + 1) + _split_rows(bot, ink, med_h, depth + 1)


def _split_at_rules(r, vl):
    x1, x2 = int(r[0]), int(np.ceil(r[2]))
    y1, y2 = int(r[1]), int(np.ceil(r[3]))
    if x2 - x1 < 8 or y2 - y1 < 4:
        return [r]
    frac = (vl[y1:y2, x1:x2] > 0).sum(axis=0) / float(y2 - y1)
    pad = int(max(4, 0.25 * (y2 - y1)))
    up = vl[max(y1 - pad, 0):y1, x1:x2] > 0
    dn = vl[y2:y2 + pad, x1:x2] > 0
    cont = ((up.any(axis=0) if up.size else np.zeros(x2 - x1, bool))
            | (dn.any(axis=0) if dn.size else np.zeros(x2 - x1, bool)))
    runs = _runs((frac >= 0.55) & cont)
    if not runs:
        return [r]
    out, start = [], x1
    for a, b in runs:
        end = x1 + a - 1
        if end - start >= 6:
            out.append([float(start), r[1], float(end), r[3]])
        start = x1 + b + 2
    if x2 - start >= 6:
        out.append([float(start), r[1], float(x2), r[3]])
    return out or [r]


def split_at_gaps(r, ink):
    x1, x2 = int(r[0]), int(np.ceil(r[2]))
    y1, y2 = int(r[1]), int(np.ceil(r[3]))
    h = y2 - y1
    if h < 6 or x2 - x1 < 3 * h:
        return [r]
    col = (ink[y1:y2, x1:x2] > 0).sum(axis=0)
    need = max(8, int(WORD_GAP_SPLIT * h))
    runs = [(a, b) for a, b in _runs(col <= max(1, int(0.06 * h)))
            if b - a + 1 >= need and a > 0 and b < len(col) - 1]
    if not runs:
        return [r]
    out, start = [], x1
    for a, b in runs:
        end = x1 + a
        if end - start >= 6:
            out.append([float(start), r[1], float(end), r[3]])
        start = x1 + b + 1
    if x2 - start >= 6:
        out.append([float(start), r[1], float(x2), r[3]])
    return out or [r]


def _merge_duplicates(rects):
    rects = [list(r) for r in rects]
    changed = True
    while changed:
        changed = False
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                a, b = rects[i], rects[j]
                ix, iy = _rect_inter(a, b)
                if ix <= 0 or iy <= 0:
                    continue
                a1, a2 = _rect_area(a), _rect_area(b)
                if ix * iy / max(min(a1, a2), 1e-6) >= 0.75 and min(a1, a2) >= 0.5 * max(a1, a2):
                    rects[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                    del rects[j]
                    changed = True
                    break
            if changed:
                break
    return rects


def _carve_rects(B, S):
    bh, bw = B[3] - B[1], B[2] - B[0]
    sh, sw = S[3] - S[1], S[2] - S[0]
    if sw >= 0.6 * bw and sh < 0.6 * bh:
        cands = [("v", [B[0], B[1], B[2], S[1] - 1]), ("v", [B[0], S[3] + 1, B[2], B[3]])]
    else:
        cands = [("h", [B[0], B[1], S[0] - 1, B[3]]), ("h", [S[2] + 1, B[1], B[2], B[3]])]
    out = []
    for axis, rc in cands:
        size = (rc[2] - rc[0]) if axis == "h" else (rc[3] - rc[1])
        if size >= (max(10.0, 0.8 * bh) if axis == "h" else 8.0):
            out.append([float(v) for v in rc])
    return out


def _carve_contained(rects, noise_area):
    rects = [list(r) for r in rects]
    tried = set()
    for _ in range(150):
        rects.sort(key=lambda r: -_rect_area(r))
        hit = None
        for bi, B in enumerate(rects):
            for S in rects[bi + 1:]:
                if (tuple(B), tuple(S)) in tried:
                    continue
                a_s, a_b = _rect_area(S), _rect_area(B)
                if a_s > 0.6 * a_b:
                    continue
                ix, iy = _rect_inter(B, S)
                if ix <= 0 or iy <= 0 or ix * iy < 0.7 * a_s:
                    continue
                hit = (B, S)
                break
            if hit:
                break
        if not hit:
            break
        B, S = hit
        tried.add((tuple(B), tuple(S)))
        if _rect_area(S) < noise_area:
            rects.remove(S)
            continue
        rects.remove(B)
        rects.extend(_carve_rects(B, S))
    return rects


def _cut_pair(a, b, ink, hl, vl):
    """Cut two overlapping rects apart (in place) along the axis of smaller overlap."""
    ix, iy = _rect_inter(a, b)
    if ix <= 1 or iy <= 1:
        return True
    if ix <= iy:
        left, right = (a, b) if (a[0] + a[2]) <= (b[0] + b[2]) else (b, a)
        c = cut_at("x", right[0], left[2], max(a[1], b[1]), min(a[3], b[3]), ink, vl)
        if not (left[0] + 3 < c < right[2] - 3):
            c = (right[0] + left[2]) / 2.0
        if left[0] + 3 < c < right[2] - 3:
            left[2] = right[0] = c
            return True
    else:
        top, bot = (a, b) if (a[1] + a[3]) <= (b[1] + b[3]) else (b, a)
        c = cut_at("y", bot[1], top[3], max(a[0], b[0]), min(a[2], b[2]), ink, hl)
        if not (top[1] + 3 < c < bot[3] - 3):
            c = (bot[1] + top[3]) / 2.0
        if top[1] + 3 < c < bot[3] - 3:
            top[3] = bot[1] = c
            return True
    return False


def _separate_overlaps(rects, ink, hl, vl):
    rects = [list(r) for r in rects]
    for _ in range(6):
        changed = False
        rects.sort(key=lambda r: (r[1], r[0]))
        drop = set()
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                if i in drop or j in drop:
                    continue
                a, b = rects[i], rects[j]
                if b[1] >= a[3]:
                    break
                ix, iy = _rect_inter(a, b)
                if ix <= 1 or iy <= 1:
                    continue
                if not _cut_pair(a, b, ink, hl, vl):
                    drop.add(i if _rect_area(a) <= _rect_area(b) else j)
                changed = True
        if drop:
            rects = [r for k, r in enumerate(rects) if k not in drop]
        if not changed:
            break
    return rects


def _separate_cross(A, B, ink, hl, vl, min_frac=0.015):
    """Cut overlapping boxes across ink layers (print vs handwriting)."""
    for _ in range(6):
        changed = False
        for a in A:
            for b in B:
                ix, iy = _rect_inter(a, b)
                if ix <= 2 or iy <= 2:
                    continue
                if ix * iy / max(min(_rect_area(a), _rect_area(b)), 1e-6) < min_frac:
                    continue
                if _cut_pair(a, b, ink, hl, vl):
                    changed = True
        if not changed:
            break


def _merge_same_line(rects, ink, join_gap=0.0):
    """Join same-layer boxes on one line that the detector cut in two ('SE' | 'PTEMBER')."""
    rects = [list(r) for r in rects]
    changed = True
    while changed:
        changed = False
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                a, b = rects[i], rects[j]
                ix, iy = _rect_inter(a, b)
                if iy <= 0:
                    continue
                ha, hb = a[3] - a[1], b[3] - b[1]
                hmin = min(ha, hb)
                if iy < 0.6 * hmin or max(ha, hb) > 1.8 * hmin:
                    continue
                if ix > 0:
                    if ix < 0.15 * min(a[2] - a[0], b[2] - b[0]):
                        continue
                elif -ix > join_gap * hmin:
                    continue
                u = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                if len(split_at_gaps(u, ink)) > 1:
                    continue
                rects[i] = u
                del rects[j]
                changed = True
                break
            if changed:
                break
    return rects


def refine_boxes(rects, ink, hl, vl, join_gap=JOIN_GAP_PLAIN):
    """Raw detector rectangles -> clean, non-overlapping, one-field-per-box rectangles."""
    H, W = ink.shape[:2]
    cur = []
    for r in rects:
        r = [max(float(r[0]), 0.0), max(float(r[1]), 0.0), min(float(r[2]), float(W)), min(float(r[3]), float(H))]
        if r[2] - r[0] >= 6 and r[3] - r[1] >= 6:
            cur.append(tighten(r, ink))
    if not cur:
        return []
    med_h = float(np.median([r[3] - r[1] for r in cur]))
    cur = _merge_duplicates(cur)
    cur = _merge_same_line(cur, ink, join_gap)
    orig = [list(r) for r in cur]
    pieces = []
    for i, r in enumerate(cur):
        ps = _split_rows(r, ink, med_h)
        ps = [q for p in ps for q in _split_at_rules(p, vl)]
        ps = [tighten(p, ink, min_w=0.05) for p in ps]
        ps = [q for p in ps for q in split_at_gaps(p, ink)]
        if len(ps) > 1:
            keep = []
            for p in ps:
                a_p = max(_rect_area(p), 1e-6)
                covered = False
                for j in range(len(orig)):
                    if j == i:
                        continue
                    ix, iy = _rect_inter(p, orig[j])
                    if ix > 0 and iy > 0 and ix * iy / a_p >= 0.6:
                        covered = True
                        break
                if not covered:
                    keep.append(p)
            ps = keep or [max(ps, key=_rect_area)]
        pieces.extend(ps)
    cur = pieces
    med_area = float(np.median([_rect_area(r) for r in cur])) if cur else 0.0
    cur = _carve_contained(cur, 0.12 * med_area)
    cur = _separate_overlaps(cur, ink, hl, vl)
    cur = [tighten(r, ink, min_w=0.1) for r in cur]
    cur = _separate_overlaps(cur, ink, hl, vl)
    return [r for r in cur if (r[2] - r[0]) >= 6 and (r[3] - r[1]) >= 8]


# =========================================================================
# 6b. Recognition with recovery re-reads
# =========================================================================
_NUMLIKE = re.compile(r"[0-9OoIl|SsBZzDQGgqb\-/:.,+\s()]+")
_LOOKALIKE = set("OoIl|SsBZzDQGgqb")
_GLUE_STOP = {"of", "and", "or", "the", "ng", "sa", "at", "in", "na", "para", "for", "if", "so"}


def _numeric_like(text):
    t = (text or "").strip()
    return bool(_NUMLIKE.fullmatch(t)) and sum(c.isdigit() for c in t) >= 4


def split_glued_text(text, new_rules=True):
    """'Cel/Mobile No. 0917-845-2390' -> ['Cel/Mobile No.', '0917-845-2390'];
    'Religion Nationality' -> ['Religion', 'Nationality']. new_rules=False on the handwriting layer."""
    words = (text or "").split()
    whole_exact = match_label(text)[1] >= 0.95
    if whole_exact and new_rules:
        return [text]
    for k in range(1, len(words)):
        left, right = " ".join(words[:k]), " ".join(words[k:])
        if not any(c.isalnum() for c in left) or not any(c.isalnum() for c in right):
            continue
        lc, ls = match_label(left)
        rc, rs = match_label(right)
        l_strong = bool(lc and ls >= 0.9)
        r_strong = bool(rc and rs >= 0.9)
        l_exact = new_rules and bool(lc and ls >= 0.95) and not whole_exact
        cond = False
        if is_unit(left):
            cond = True
        elif l_strong and not r_strong and (left.rstrip().endswith(":") or lc in PHONE_LIKE_CANONS):
            cond = True
        elif r_strong and not l_strong and right.rstrip().endswith(":"):
            cond = True
        elif l_exact and label_start_canon(norm(right)) not in (None, lc):
            cond = True
        elif (l_exact and rs < 0.7 and right[0] not in "([/"
              and words[k].lower().strip(".,") not in _GLUE_STOP
              and value_fit(lc, right) is not None and len(norm(left)) > 4):
            cond = True
        if cond:
            return [left] + split_glued_text(right, new_rules)
    return [text]


def _widest_gap(r, ink, lo, hi):
    """Centre x of the widest ink-free column run inside box r between lo..hi, or None."""
    x1, x2 = int(max(r[0], lo)), int(min(np.ceil(r[2]), hi))
    y1, y2 = int(r[1]), int(np.ceil(r[3]))
    h = max(y2 - y1, 1)
    if x2 - x1 < 4:
        return None
    col = (ink[y1:y2, x1:x2] > 0).sum(axis=0)
    runs = [(a, b) for a, b in _runs(col <= max(1, int(0.04 * h))) if a > 0 and b < len(col) - 1]
    if not runs:
        return None
    a, b = max(runs, key=lambda ab: ab[1] - ab[0])
    if b - a + 1 < max(3, 0.2 * h):
        return None
    return x1 + (a + b) / 2.0


def _split_glued_items(items, reader, gray, ink, vl, hand=False):
    plans = []
    for it in items:
        parts = split_glued_text(it["text"], new_rules=not hand)
        subs = None
        if len(parts) >= 2:
            r = it["r"]
            w = r[2] - r[0]
            total = sum(len(p) for p in parts) + (len(parts) - 1)
            cuts, run = [], 0
            for idx, p in enumerate(parts[:-1]):
                run += len(p) + (1 if idx > 0 else 0)
                x_est = r[0] + w * (run + 0.5) / max(total, 1)
                # handwriting is wider per character than print: prefer the widest blank gap
                # near the proportional estimate over the estimate itself
                c = _widest_gap(r, ink, x_est - 0.25 * w, x_est + 0.25 * w)
                if c is None:
                    win = 0.1 * w
                    c = cut_at("x", x_est - win, x_est + win, r[1], r[3], ink, vl)
                cuts.append(min(max(c, r[0] + 4), r[2] - 4))
            bounds = [r[0]] + cuts + [r[2]]
            cand = [[bounds[i], r[1], bounds[i + 1], r[3]] for i in range(len(parts))]
            if not (any(s[2] - s[0] < 6 for s in cand)
                    or any(cand[i][2] > cand[i + 1][0] + 0.5 for i in range(len(cand) - 1))):
                subs = [tighten(s, ink, min_w=0.1) for s in cand]
        plans.append((it, parts, subs))

    flat = [s for _, _, subs in plans if subs for s in subs]
    reads = reader.read(gray, flat) if flat else []
    out, k = [], 0
    for it, parts, subs in plans:
        if not subs:
            out.append(it)
            continue
        for s, p in zip(subs, parts):
            rd = reads[k]
            k += 1
            txt, cf = (rd if rd and rd[0] else (p, it["conf"]))
            out.append({"r": s, "text": txt, "conf": cf})
    return out


def recognize_items(reader, gray, gray_alt, rects, ink, vl, hand=False):
    reads = reader.read(gray, rects) if rects else []
    items = []
    for r, rd in zip(rects, reads):
        if rd and rd[0].strip():
            items.append({"r": r, "text": rd[0].replace("_", " ").strip(), "conf": rd[1]})

    # digits-only second decode fixes O/0, I/1, S/5 in dates and phone numbers (one batched call)
    num = [it for it in items if _numeric_like(it["text"])]
    if num:
        rereads = reader.read(gray, [it["r"] for it in num], allowlist="0123456789-/.+()")
        for it, rr in zip(num, rereads):
            if rr and rr[0]:
                better = rr[1] >= it["conf"] - 0.02 or any(c in _LOOKALIKE for c in it["text"])
                if better and sum(c.isdigit() for c in rr[0]) >= sum(c.isdigit() for c in it["text"]) - 1:
                    it["text"], it["conf"] = rr[0], max(rr[1], it["conf"])

    # weak reads (typical for handwriting): retry on a contrast-enhanced copy (one batched call)
    weak = [it for it in items if it["conf"] < LOW_CONF_REREAD]
    if weak:
        rereads = reader.read(gray_alt, [it["r"] for it in weak])
        for it, rr in zip(weak, rereads):
            if rr and rr[0] and rr[1] > it["conf"] + 0.03:
                it["text"], it["conf"] = rr[0].replace("_", " ").strip(), rr[1]

    items = _split_glued_items(items, reader, gray, ink, vl, hand=hand)
    return [it for it in items if any(c.isalnum() for c in it["text"]) and it["conf"] >= 0.05]


def _drop_pen_remnants(prn, hand):
    """Print-layer boxes sitting on handwriting with little printed ink of their own are what is
    left of the pen strokes after the colour split, not printed text: drop them."""
    keep = []
    for r in prn["rects"]:
        a = _rect_area(r)
        x1, y1, x2, y2 = int(r[0]), int(r[1]), int(np.ceil(r[2])), int(np.ceil(r[3]))
        cover = 0.0
        for q in hand["rects"]:
            ix, iy = _rect_inter(r, q)
            if ix > 0 and iy > 0:
                cover += ix * iy
        if a > 0 and cover >= 0.5 * a:
            p_ink = int((prn["ink"][y1:y2, x1:x2] > 0).sum())
            h_ink = int((hand["ink"][y1:y2, x1:x2] > 0).sum())
            if p_ink < 0.6 * h_ink:
                continue
        keep.append(r)
    return keep


def ocr_document(reader, work):
    """work image -> dict(raw=[(bbox4, text, conf, layer)], clean, hand, print, hl, vl, layered).
    layer is 'print' / 'hand' when the page has coloured ink, otherwise None."""
    _, ink_all, hl, vl = prep_ink(work)
    clean = erase_rules(work, hl, vl)
    layers = split_layers(clean)
    passes = [("print", layers[0]), ("hand", layers[1])] if layers else [(None, clean)]

    prep = []
    for name, img in passes:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        alt = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
        ink = ink_only(gray)
        rects = refine_boxes(reader.detect(img), ink, hl, vl,
                             JOIN_GAP_LAYERED if layers else JOIN_GAP_PLAIN)
        prep.append({"name": name, "gray": gray, "alt": alt, "ink": ink, "rects": rects})
    if len(prep) == 2:
        prep[0]["rects"] = _drop_pen_remnants(prep[0], prep[1])
        _separate_cross(prep[0]["rects"], prep[1]["rects"], ink_all, hl, vl)
        for p in prep:
            p["rects"] = [r for r in (tighten(r, p["ink"], min_w=0.1) for r in p["rects"])
                          if (r[2] - r[0]) >= 6 and (r[3] - r[1]) >= 8]
    items = []
    for p in prep:
        for it in recognize_items(reader, p["gray"], p["alt"], p["rects"], p["ink"], vl,
                                  hand=(p["name"] == "hand")):
            it["layer"] = p["name"]
            items.append(it)
    items = [it for it in items
             if not (it["layer"] == "print" and it["conf"] < 0.2)
             and not (it["conf"] < 0.4 and sum(c.isalnum() for c in it["text"]) <= 3
                      and not any(c.isdigit() for c in it["text"])
                      and it["text"].strip().lower() not in ("m", "f", "no", "yes", "x"))]
    items.sort(key=lambda it: ((it["r"][1] + it["r"][3]) / 2.0, it["r"][0]))
    raw = []
    for it in items:
        x1, y1, x2, y2 = it["r"]
        raw.append(([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], it["text"], it["conf"], it["layer"]))
    return {
        "raw": raw, "clean": clean, "ruled": work,
        "print": layers[0] if layers else None, "hand": layers[1] if layers else None,
        "hl": hl, "vl": vl, "layered": bool(layers),
    }
