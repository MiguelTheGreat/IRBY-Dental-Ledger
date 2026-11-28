"""
Label <-> answer pairing for scanned paper forms.

Tokens from scan.ocr_document are classified into printed labels, handwritten answers, units,
choices (printed Yes / No / M/F) and ignored form furniture, then paired geometrically:

  * captions printed UNDER the value (Last / First / Middle) are paired first, by column
  * every other answer goes to the cheapest label to its left / above / below, never across
    a printed vertical rule and never past another label in between
  * free-text answers run on to the right (and to the next line for addresses)
  * unpaired labels get a second chance with values of a distinctive shape (dates, phones, ...)

On pages written in coloured ink the print / handwriting split comes from scan.split_layers;
on black-ink or grayscale scans each box gets a handwriting score from its typography
(glyph-height variation, baseline wobble, stroke width against the page's own printed labels).
"""
import re

import cv2
import numpy as np

from lexicon import (ADDRESS_KEYS, FREE_TEXT_KEYS, NAME_CAPTIONS, is_form_furniture, is_unit,
                     match_label, value_fit)
from scan import split_glued_text
from textnorm import looks_like_date, norm

BOLD_STROKE_RATIO = 0.15
THIN_STROKE_RATIO = 0.10
STYLE_MIN_TOL = 0.025

CHOICE_WORDS = {"yes", "no", "m f", "m", "f", "mf"}
MF_RX = re.compile(r"\s*[\(\[]?\s*[MNmn]\s*[\)\]]?\s*[/|\\1Il]?\s*[\(\[]?\s*[FEfe]\s*[\)\]]?\s*")
RESCUE = {"dateOfBirth", "age", "sex", "contactNumber", "email", "bloodType", "bloodPressure",
          "effectiveDate", "homeNo", "officeNo", "bleedingTime"}

PLACE_START = re.compile(r"^(?:brgy|bgy|barangay|city|municipality|prov|province|purok|sitio|zone|subd)\b", re.I)
STREET_END = re.compile(r"\b(?:st|street|ave|avenue|rd|road|blvd|drive|dr|lane|ln|ext|extension)\.?$", re.I)


class FormParser:
    IGNORE_PHRASES = (
        "philippine dental association", "patient information record", "dental chart",
        "signature over printed", "to the best of my knowledge", "i certify", "for clinic use",
        "do not fill",
    )
    _TYPO_DEFAULT = {"glyph_height_cv": 0.2, "baseline_std": 0.08, "ink_saturation": 0.0, "stroke_ratio": 0.12}

    def __init__(self):
        self._ign = [f" {norm(p)} " for p in self.IGNORE_PHRASES]
        self._sr_ref = self._sr_tol = None
        self._med_h = 22.0
        self._layered = False

    def _is_boilerplate(self, text):
        n = f" {norm(text)} "
        return any(p in n for p in self._ign)

    # ------------------------------------------------------------------ tokens
    @staticmethod
    def _split_colon_merged_ocr(raw_ocr):
        """'Religion: Catholic' glued in one box is cut at the colon into a label and an answer."""
        out = []
        for item in raw_ocr:
            bbox, text, conf = item[0], item[1], item[2]
            layer = item[3] if len(item) > 3 else None
            txt = text.strip()
            if ":" in txt and layer != "hand":
                left, right = txt.split(":", 1)
                if left.strip() and right.strip() and len(left.split()) <= 6:
                    xs = [p[0] for p in bbox]
                    ys = [p[1] for p in bbox]
                    x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
                    x_mid = x1 + (x2 - x1) * (len(left) + 1) / max(len(txt), 1)
                    l_canon, l_score = match_label(left.strip())
                    l_layer = "print" if (layer is None and l_canon and l_score >= 0.7) else layer
                    r_layer = layer
                    out.append(([[x1, y1], [x_mid, y1], [x_mid, y2], [x1, y2]], left.strip() + ":", conf, l_layer))
                    out.append(([[x_mid + 2, y1], [x2, y1], [x2, y2], [x_mid + 2, y2]], right.strip(), conf, r_layer))
                    continue
            if layer != "hand":
                parts = split_glued_text(txt)
                if len(parts) >= 2:
                    xs = [p[0] for p in bbox]
                    ys = [p[1] for p in bbox]
                    x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
                    unit = (x2 - x1) / max(len(txt), 1)
                    cur = x1
                    for p in parts:
                        px2 = min(cur + unit * len(p), x2)
                        out.append(([[cur, y1], [px2, y1], [px2, y2], [cur, y2]], p, conf, layer))
                        cur = px2 + unit
                    continue
            out.append((bbox, txt, conf, layer))
        return out

    @classmethod
    def _measure_typography(cls, image, x1, y1, x2, y2):
        h, w = image.shape[:2]
        ix1, iy1, ix2, iy2 = max(0, int(x1)), max(0, int(y1)), min(w, int(x2)), min(h, int(y2))
        cw_, ch_ = ix2 - ix1, iy2 - iy1
        d = dict(cls._TYPO_DEFAULT)
        if cw_ <= 2 or ch_ <= 2:
            return d
        crop = image[iy1:iy2, ix1:ix2]
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        _, binv = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
        mask = binv > 0
        sw = None
        if int(mask.sum()) >= 5:
            d["ink_saturation"] = float(np.percentile(hsv[:, :, 1][mask], 75))
            dist = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 3)
            sw = float(4.0 * dist[mask].mean())
        n, _, stats, _ = cv2.connectedComponentsWithStats(binv)
        gh = [stats[i, cv2.CC_STAT_HEIGHT] for i in range(1, n)
              if stats[i, cv2.CC_STAT_HEIGHT] >= 0.3 * ch_ and stats[i, cv2.CC_STAT_WIDTH] >= 2]
        if sw is not None:
            d["stroke_ratio"] = sw / max(float(np.median(gh)) if gh else float(ch_), 1.0)
        hs, bs = [], []
        for i in range(1, n):
            cw, chh, top = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT], stats[i, cv2.CC_STAT_TOP]
            if 2 <= cw <= cw_ * 0.85 and ch_ * 0.22 <= chh <= ch_ * 0.96:
                hs.append(chh)
                bs.append(top + chh)
        if len(hs) >= 3:
            d["glyph_height_cv"] = float(np.std(hs) / max(np.mean(hs), 1e-5))
            d["baseline_std"] = float(np.std(bs)) / float(ch_)
        return d

    def _calibrate_style(self, tokens):
        """Median stroke ratio of the printed 'Label:' captions = this page's own print reference."""
        anchors = [t["stroke_ratio"] for t in tokens
                   if t.get("layer") != "hand" and t["text"].rstrip().endswith(":")
                   and match_label(t["text"])[1] >= 0.95]
        self._sr_ref = self._sr_tol = None
        if len(anchors) >= 3:
            a = np.asarray(anchors, dtype=float)
            ref = float(np.median(a))
            mad = float(np.median(np.abs(a - ref)))
            self._sr_ref, self._sr_tol = ref, max(STYLE_MIN_TOL, 2.5 * 1.4826 * mad)

    def _hand_score(self, tok, ref_h):
        """Handwriting likelihood, only used on scans without coloured ink."""
        s = 0.0
        if tok["ink_saturation"] > 40:
            s += 0.45
        if tok["glyph_height_cv"] > 0.30:
            s += 0.20
        if tok["baseline_std"] > 0.11:
            s += 0.20
        if tok["height"] > ref_h * 1.3:
            s += 0.15
        sr = tok.get("stroke_ratio", 0.12)
        ref, tol = self._sr_ref, self._sr_tol
        if ref is not None:
            if abs(sr - ref) <= tol:
                s -= 0.25
            elif sr < ref - tol:
                s += 0.20
        elif sr >= BOLD_STROKE_RATIO:
            s -= 0.25
        elif sr <= THIN_STROKE_RATIO:
            s += 0.15
        return max(0.0, min(s, 1.0))

    def _classify(self, tok):
        if tok.get("locked"):
            return
        canon, lex = match_label(tok["text"])
        tok["canon"], tok["lex"] = canon, lex
        colon = tok["text"].rstrip().endswith(":")
        tok["colon"] = colon
        hand = tok["hand"]
        n = norm(tok["text"])

        if is_unit(tok["text"]):
            tok["kind"] = "unit"
            return

        if lex >= 0.85:
            kind = "label"
        elif hand >= 0.75:
            kind = "answer"
        elif colon or lex >= 0.70:
            kind = "label"
        else:
            kind = "answer"

        # checklist items like 'Low Blood Pressure' fuzzy-match a label ('Blood Pressure');
        # only an exact label survives when the words are the form's own printed furniture
        if kind == "label" and lex < 0.95 and tok.get("layer") != "hand" and is_form_furniture(tok["text"]):
            kind = "ignore"

        if tok.get("layer") == "hand":
            kind = "answer"
        elif tok.get("layer") == "print":
            if kind != "ignore":
                kind = "label" if (lex >= 0.6 or colon) else "ignore"
            if kind == "ignore" and n in CHOICE_WORDS:
                kind = "choice"
        elif kind == "answer" and MF_RX.fullmatch(tok["text"]):
            kind = "choice"                 # the printed 'M/F' (a circle makes it look handwritten)
        elif kind == "answer" and hand < 0.6:
            # black-ink scan: the form's own printed questions, checklist and Yes/No are not answers
            if n in CHOICE_WORDS:
                kind = "choice"
            elif is_form_furniture(tok["text"]):
                kind = "ignore"

        if kind == "label" and tok["y_norm"] < 0.4 and tok["height"] > 2.0 * self._med_h:
            kind = "ignore"
        if kind == "answer" and (not any(c.isalnum() for c in tok["text"]) or self._is_boilerplate(tok["text"])):
            kind = "ignore"
        tok["kind"] = kind

    # ------------------------------------------------------------------ geometry
    @staticmethod
    def _blocked(a, b, verts):
        """A printed vertical rule between a and b that fully crosses their row = different cells."""
        lo, hi = sorted((a["cx"], b["cx"]))
        half = 0.45 * max(a["height"], 1.0)
        return any(lo < vx < hi and vy1 <= a["cy"] - half and vy2 >= a["cy"] + half
                   for vx, vy1, vy2 in verts)

    @staticmethod
    def _detect_vertical_segments(image, med_h, tokens=None):
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        bs = int(max(15, med_h * 0.9)) | 1
        thr = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, bs, 10)
        min_len = max(int(med_h * 2.2), 26)
        k = cv2.getStructuringElement(cv2.MORPH_RECT, (1, min_len))
        lines = cv2.morphologyEx(thr, cv2.MORPH_OPEN, k, iterations=1)
        cnts, _ = cv2.findContours(lines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        segs = []
        for c in cnts:
            x, y, bw, bh = cv2.boundingRect(c)
            if bh < min_len or bw > max(6, med_h * 0.5):
                continue
            vx = x + bw / 2.0
            if tokens and any(t["x1"] + 2 < vx < t["x2"] - 2 and t["y1"] - 2 < y + bh / 2.0 < t["y2"] + 2
                              for t in tokens):
                continue
            segs.append((vx, y, y + bh))
        return segs

    @staticmethod
    def row_bands(tokens, med_h):
        bands = []
        for t in sorted(tokens, key=lambda t: t["cy"]):
            for b in bands:
                if abs(t["cy"] - float(np.mean([x["cy"] for x in b]))) <= med_h * 0.95:
                    b.append(t)
                    break
            else:
                bands.append([t])
        for b in bands:
            b.sort(key=lambda t: t["x1"])
        return bands

    @staticmethod
    def _merge(a, b):
        a["text"] = f"{a['text']} {b['text']}"
        a["x1"], a["x2"] = min(a["x1"], b["x1"]), max(a["x2"], b["x2"])
        a["y1"], a["y2"] = min(a["y1"], b["y1"]), max(a["y2"], b["y2"])
        a["cx"], a["cy"] = (a["x1"] + a["x2"]) / 2.0, (a["y1"] + a["y2"]) / 2.0
        a["height"] = a["y2"] - a["y1"]
        a["conf"] = min(a["conf"], b["conf"])
        a["hand"] = max(a["hand"], b["hand"])

    def _caption_cells(self, caps, med_h):
        out = []
        for band in self.row_bands(caps, med_h):
            band = sorted(band, key=lambda c: c["cx"])
            edges = [-1e9] + [(a["cx"] + b["cx"]) / 2.0 for a, b in zip(band, band[1:])] + [1e9]
            out.extend((c, edges[i], edges[i + 1]) for i, c in enumerate(band))
        return out

    @staticmethod
    def _name_column(tok, captions, med_h):
        below = [c for c in captions if -0.7 * med_h <= c["y1"] - tok["y2"] <= 1.5 * med_h]
        if len(below) < 2:
            return None
        return id(min(below, key=lambda c: abs(c["cx"] - tok["cx"])))

    def _stitch(self, tokens, verts, med_h):
        out = []
        captions = [t for t in tokens if t["kind"] == "label" and not t.get("colon")
                    and t.get("canon") in NAME_CAPTIONS]
        for band in self.row_bands(tokens, med_h):
            if not band:
                continue
            cur = band[0].copy()
            cur_col = self._name_column(cur, captions, med_h)
            for tok in band[1:]:
                col = self._name_column(tok, captions, med_h)
                gap = tok["x1"] - cur["x2"]
                both_strong = (cur["kind"] == "label" and tok["kind"] == "label"
                               and cur["lex"] >= 0.85 and tok["lex"] >= 0.85)
                intervening = any(
                    other is not cur and other is not tok
                    and other["kind"] != cur["kind"]
                    and cur["x2"] - 2 <= other["cx"] <= tok["x1"] + 2
                    and (min(other["y2"], max(cur["y2"], tok["y2"]))
                         - max(other["y1"], min(cur["y1"], tok["y1"]))) > 0.35 * med_h
                    for other in band
                )
                if (cur["kind"] == tok["kind"] and cur["kind"] in ("label", "answer")
                        and not cur["text"].rstrip().endswith(":") and not both_strong
                        and not intervening
                        and (cur["kind"] != "answer" or col == cur_col)
                        and not self._blocked(cur, tok, verts)
                        and -0.5 * med_h <= gap <= med_h * 2.5):
                    self._merge(cur, tok)
                else:
                    out.append(cur)
                    cur = tok.copy()
                    cur_col = col
            out.append(cur)
        for t in out:
            self._classify(t)
        return out

    def _ignore_above_form(self, tokens, med_h):
        """Answers above the first form label (clinic letterhead, stamps) are not patient data,
        except values written directly above a name caption."""
        tops = [t["y1"] for t in tokens if t.get("kind") == "label" and
                (t["text"].rstrip().endswith(":") or t.get("lex", 0) >= 0.85)]
        top = min(tops) if tops else None
        caps = [t for t in tokens if t.get("kind") == "label" and not t.get("colon")
                and t.get("canon") in NAME_CAPTIONS]

        def over_caption(a):
            return any(-0.7 * med_h <= c["y1"] - a["y2"] <= 1.5 * med_h for c in caps)

        for t in tokens:
            if t.get("kind") != "answer" or t.get("locked"):
                continue
            if top is not None and t["y2"] <= top - 0.2 * med_h and not over_caption(t):
                t.update(kind="ignore", locked=True)

    def _assemble_labels(self, tokens, verts, med_h):
        """'Cel/Mobile' + 'No.:' detected as two boxes -> one label."""
        free = [t for t in tokens if not t.get("locked")]
        rest = [t for t in tokens if t.get("locked")]
        out = []
        for band in self.row_bands(free, med_h):
            i = 0
            while i < len(band):
                merged = False
                for span in range(min(7, len(band) - i), 1, -1):
                    seq = band[i:i + span]
                    ok = all(-3.0 * med_h <= seq[k + 1]["x1"] - seq[k]["x2"] <= 3.0 * med_h
                             and not self._blocked(seq[k], seq[k + 1], verts) for k in range(span - 1))
                    if not ok:
                        continue
                    if self._layered and any(t.get("layer") == "hand" for t in seq):
                        continue
                    if any(t["text"].rstrip().endswith(":") and match_label(t["text"])[1] >= 0.85
                           for t in seq[:-1]):
                        continue
                    text = " ".join(t["text"] for t in seq)
                    canon, lex = match_label(text)
                    if canon and lex >= 0.85 and len(split_glued_text(text)) == 1:
                        head = seq[0].copy()
                        for nxt in seq[1:]:
                            self._merge(head, nxt)
                        head.update(kind="label", canon=canon, lex=lex, locked=True,
                                    colon=text.rstrip().endswith(":"))
                        out.append(head)
                        i += span
                        merged = True
                        break
                if not merged:
                    out.append(band[i])
                    i += 1
        return out + rest

    @staticmethod
    def _word_spans(image, t, n_words):
        H, W = image.shape[:2]
        x1, y1 = int(max(t["x1"], 0)), int(max(t["y1"], 0))
        x2, y2 = int(min(np.ceil(t["x2"]), W)), int(min(np.ceil(t["y2"]), H))
        if n_words < 2 or x2 - x1 < 6 or y2 - y1 < 4:
            return None
        crop = image[y1:y2, x1:x2]
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
        _, binv = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
        col = (binv > 0).sum(axis=0)
        idx = np.flatnonzero(col <= 1)
        gaps = []
        if idx.size:
            br = np.where(np.diff(idx) > 1)[0]
            starts = np.r_[idx[0], idx[br + 1]]
            ends = np.r_[idx[br], idx[-1]]
            gaps = [(a, b) for a, b in zip(starts.tolist(), ends.tolist()) if a > 0 and b < len(col) - 1]
        if len(gaps) < n_words - 1:
            return None
        gaps = sorted(sorted(gaps, key=lambda g: g[0] - g[1])[:n_words - 1])
        bounds = [0.0] + [(a + b) / 2.0 for a, b in gaps] + [float(len(col))]
        return [(x1 + bounds[i], x1 + bounds[i + 1]) for i in range(n_words)]

    @staticmethod
    def _prop_spans(t, words):
        total = sum(len(w) for w in words) + len(words) - 1
        unit, cur, out = (t["x2"] - t["x1"]) / max(total, 1), t["x1"], []
        for w in words:
            out.append((cur, cur + unit * len(w)))
            cur += unit * (len(w) + 1)
        return out

    def _split_across_captions(self, tokens, image, med_h):
        """'DELA CRUZ JUAN SANTOS' read as one box over Last/First/Middle -> one answer per caption."""
        caps = [t for t in tokens if t.get("kind") == "label" and not t.get("colon")
                and t.get("canon") in NAME_CAPTIONS]
        if len(caps) < 2:
            return tokens
        cells = self._caption_cells(caps, med_h)
        out = []
        for t in tokens:
            words = t["text"].split()
            if t.get("kind") != "answer" or len(words) < 2:
                out.append(t)
                continue
            hit = [(c, lo, hi) for c, lo, hi in cells
                   if -0.7 * med_h <= c["y1"] - t["y2"] <= 1.5 * med_h
                   and min(t["x2"], hi) - max(t["x1"], lo) >= med_h]
            hit.sort(key=lambda h: h[1])
            if len(hit) < 2:
                out.append(t)
                continue
            edges = [h[2] for h in hit[:-1]]
            spans = self._word_spans(image, t, len(words)) or self._prop_spans(t, words)
            groups = {}
            for w_, (a, b) in zip(words, spans):
                groups.setdefault(sum((a + b) / 2.0 > e for e in edges), []).append((w_, a, b))
            if len(groups) < 2:
                out.append(t)
                continue
            for col in sorted(groups):
                ws = groups[col]
                n = t.copy()
                n.update(text=" ".join(w for w, _, _ in ws), x1=ws[0][1], x2=ws[-1][2], locked=True)
                n["cx"] = (n["x1"] + n["x2"]) / 2.0
                out.append(n)
        return out

    @staticmethod
    def find_checkbox(binv, t):
        """Ink fill of the nearest hollow square left/right of word `t` (0 = empty), or None."""
        H, W = binv.shape[:2]
        h = max(t["height"], 8.0)
        best = None
        for side in (-1, 1):
            if side < 0:
                x_hi = t["x1"] - 0.1 * h
                x_lo = x_hi - 2.2 * h
            else:
                x_lo = t["x2"] + 0.1 * h
                x_hi = x_lo + 2.2 * h
            x_lo, x_hi = int(max(x_lo, 0)), int(min(x_hi, W))
            y_lo, y_hi = int(max(t["cy"] - h, 0)), int(min(t["cy"] + h, H))
            if x_hi - x_lo < 6 or y_hi - y_lo < 6:
                continue
            win = binv[y_lo:y_hi, x_lo:x_hi]
            cnts, _ = cv2.findContours(win, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for c in cnts:
                x, y, bw, bh = cv2.boundingRect(c)
                if not (0.45 * h <= bw <= 1.7 * h and 0.45 * h <= bh <= 1.7 * h and 0.7 <= bw / bh <= 1.4):
                    continue
                sub = win[y:y + bh, x:x + bw] > 0
                th = max(2, int(0.12 * min(bw, bh)))
                ring = np.concatenate([sub[:th].ravel(), sub[-th:].ravel(),
                                       sub[:, :th].ravel(), sub[:, -th:].ravel()]).mean()
                if ring < 0.6:
                    continue
                m = max(int(0.25 * min(bw, bh)), th + 1)
                inner = sub[m:-m, m:-m] if min(bw, bh) - 2 * m > 2 else sub
                dist = (t["x1"] - (x_lo + x + bw)) if side < 0 else ((x_lo + x) - t["x2"])
                if best is None or dist < best[0]:
                    best = (dist, float(inner.mean()))
        return None if best is None else best[1]

    @staticmethod
    def _relation(L, A, med_h, scale=1.0, max_gap=None):
        """Where is answer A relative to label L? ('right'|'below'|'above', cost) or None."""
        hL, hA = L["y2"] - L["y1"], A["y2"] - A["y1"]
        hmin, hmax = max(min(hL, hA), 1.0), max(hL, hA)
        v_ov = min(L["y2"], A["y2"]) - max(L["y1"], A["y1"])
        wmin = max(min(L["x2"] - L["x1"], A["x2"] - A["x1"]), 1.0)
        x_ov = (min(L["x2"], A["x2"]) - max(L["x1"], A["x1"])) / wmin
        gap_x = A["x1"] - L["x2"]
        dy = A["cy"] - L["cy"]

        # handwriting usually floats a little above the answer line, so an answer on the same
        # line may overlap the printed label by only a third of its height
        same_line = (v_ov / hmin >= 0.5 and abs(dy) <= 0.55 * hmax) or \
                    (v_ov / hmin >= 0.3 and -0.85 * hmax <= dy <= 0.4 * hmax)
        if (same_line and A["cx"] > L["cx"]
                and -0.8 * med_h <= gap_x <= (max_gap if max_gap is not None else 8.0 * med_h * scale)):
            return "right", 0.4 * max(gap_x, 0.0) / med_h + 0.6 * abs(dy) / med_h

        vgap = A["y1"] - L["y2"]
        if (dy > 0 and -0.7 * hmin <= vgap <= 1.6 * med_h * scale
                and (x_ov >= 0.25 or abs(A["x1"] - L["x1"]) <= 2.5 * med_h * scale)):
            return "below", 0.8 + max(vgap, 0.0) / med_h + 0.3 * abs(A["x1"] - L["x1"]) / med_h

        vgap_up = L["y1"] - A["y2"]
        if (dy < 0 and -0.7 * hmin <= vgap_up <= 0.8 * med_h * scale and x_ov >= 0.5
                and not L.get("colon")):
            return "above", 1.6 + max(vgap_up, 0.0) / med_h + 0.3 * abs(A["cx"] - L["cx"]) / med_h
        return None

    @staticmethod
    def _label_between(L, A, labels, med_h, kind):
        for M in labels:
            if M is L:
                continue
            if kind == "right":
                v_ov = min(M["y2"], L["y2"]) - max(M["y1"], L["y1"])
                if (v_ov > 0.4 * min(M["y2"] - M["y1"], L["y2"] - L["y1"])
                        and L["cx"] < M["cx"] < A["cx"] and M["x2"] <= A["x1"] + 0.5 * med_h):
                    return True
            else:
                lo, hi = sorted((L["cy"], A["cy"]))
                x_ov = min(M["x2"], L["x2"]) - max(M["x1"], L["x1"])
                if (lo + 0.3 * med_h < M["cy"] < hi - 0.3 * med_h
                        and (x_ov > 0 or abs(M["x1"] - L["x1"]) < 2.5 * med_h)):
                    return True
        return False

    @staticmethod
    def _drop_parent_labels(labels, med_h):
        out = []
        for L in labels:
            parent = bool(L.get("colon") and L.get("canon") and any(
                M is not L and M.get("canon") == L["canon"]
                and abs(M["cy"] - L["cy"]) <= 0.6 * med_h and 0 <= M["x1"] - L["x2"] <= 8 * med_h
                for M in labels))
            if not parent:
                out.append(L)
        return out

    def _pair_captions(self, labels, answers, verts, med_h):
        """Captions printed UNDER the value ('Dela Cruz' over 'Last'), decided first, by column."""
        out = []
        cand = [L for L in labels if not L.get("colon")]
        for band in self.row_bands(cand, med_h):
            if len(band) < 2:
                continue
            found = []
            for L, lo, hi in self._caption_cells(band, med_h):
                best = None
                for A in answers:
                    v_up = L["y1"] - A["y2"]
                    if A["cy"] >= L["cy"] or not (-0.7 * min(L["height"], A["height"]) <= v_up <= 1.5 * med_h):
                        continue
                    if not (lo <= A["cx"] < hi):
                        continue
                    if self._blocked(L, A, verts) or value_fit(L["canon"], A["text"]) is None:
                        continue
                    cost = max(v_up, 0.0) / med_h + 0.3 * abs(A["cx"] - L["cx"]) / med_h
                    if best is None or cost < best[0]:
                        best = (cost, A)
                if best:
                    found.append((L, best[1]))
            if len(found) >= 2 and len(found) >= 0.6 * len(band):
                used = set()
                for L, A in found:
                    if id(A) not in used:
                        used.add(id(A))
                        out.append((L, A, "above"))
        return out

    def _pair(self, labels, answers, verts, med_h, w, all_labels=None):
        all_labels = all_labels if all_labels is not None else labels
        cands = []
        for li, L in enumerate(labels):
            for ai, A in enumerate(answers):
                if self._blocked(L, A, verts):
                    continue
                rel = self._relation(L, A, med_h, max_gap=max(8.0 * med_h, 0.35 * w))
                if rel is None:
                    continue
                kind, cost = rel
                fit = value_fit(L["canon"], A["text"])
                if fit is None:
                    continue
                if self._label_between(L, A, all_labels, med_h, kind):
                    continue
                cands.append((cost * fit, li, ai, kind))
        cands.sort(key=lambda c: c[0])
        used_l, used_a, pairs = set(), set(), []
        for cost, li, ai, d in cands:
            if cost > 12.0 or li in used_l or ai in used_a:
                continue
            used_l.add(li)
            used_a.add(ai)
            pairs.append((labels[li], answers[ai], d))
        return pairs

    def _extend_right(self, L, A, answers, units, labels, verts, med_h):
        """Free-text answers can run on to the right as further boxes; times take unit words.
        Any answer also takes a fragment that sits flush against it ('1' + '20/80')."""
        if L["canon"] not in FREE_TEXT_KEYS:
            for B in answers:
                if B.get("used") or B is A:
                    continue
                v_ov = min(B["y2"], A["y2"]) - max(B["y1"], A["y1"])
                gap = B["x1"] - A["x2"]
                if v_ov >= 0.5 * min(B["height"], A["height"]) and -0.3 * med_h <= gap <= 0.35 * med_h:
                    B["used"] = True
                    return A["text"] + B["text"], min(A["conf"], B["conf"])
            return A["text"], A["conf"]
        pool = list(answers) + (list(units) if L["canon"] == "bleedingTime" else [])
        text, conf, last = A["text"], A["conf"], A
        while True:
            nxt = None
            for B in pool:
                if B.get("used") or B is last or B is A:
                    continue
                v_ov = min(B["y2"], last["y2"]) - max(B["y1"], last["y1"])
                if v_ov < 0.5 * min(B["height"], last["height"]):
                    continue
                gap = B["x1"] - last["x2"]
                if not (-0.5 * med_h <= gap <= 2.5 * med_h) or self._blocked(last, B, verts):
                    continue
                if any(M is not L and last["x2"] - 2 <= M["cx"] <= B["x1"] + 2
                       and abs(M["cy"] - last["cy"]) < med_h for M in labels):
                    continue
                if nxt is None or B["x1"] < nxt["x1"]:
                    nxt = B
            if nxt is None:
                break
            text = self._join(text, nxt["text"], L["canon"])
            conf = min(conf, nxt["conf"])
            nxt["used"] = True
            last = nxt
        return text, conf

    @staticmethod
    def _join(a, b, canon):
        if canon in ADDRESS_KEYS and not a.rstrip().endswith(","):
            if PLACE_START.match(b.strip()) or STREET_END.search(a.strip()):
                return f"{a}, {b}"
        return f"{a} {b}"

    @staticmethod
    def _extend_multiline(L, A, answers, labels, med_h, text, conf):
        last = A
        for B in sorted(answers, key=lambda t: t["y1"]):
            if B.get("used") or B is A:
                continue
            if any(M is not L and M["x2"] <= B["x1"] + 0.5 * med_h and B["x1"] - M["x2"] <= 8 * med_h
                   and min(M["y2"], B["y2"]) - max(M["y1"], B["y1"]) > 0.5 * min(M["y2"] - M["y1"], B["y2"] - B["y1"])
                   for M in labels):
                continue
            if 0 <= B["y1"] - last["y2"] <= 1.8 * med_h and abs(B["x1"] - A["x1"]) <= 5 * med_h:
                text += ", " + B["text"]
                conf = min(conf, B["conf"])
                B["used"] = True
                last = B
        return text, conf

    # ------------------------------------------------------------------ main
    def parse(self, raw_ocr, clean_image, ruled_image=None):
        """-> dict(tokens, labels, answers, pairs=[{label, canon, value, conf, source, x, y}], med_h, verts)."""
        result = {"tokens": [], "labels": [], "answers": [], "pairs": [], "med_h": 22.0, "verts": []}
        if not raw_ocr:
            return result
        ruled = ruled_image if ruled_image is not None else clean_image
        h, w = clean_image.shape[:2]

        split_ocr = self._split_colon_merged_ocr(raw_ocr)
        layered = any(item[3] for item in split_ocr)
        tokens, heights = [], []
        for bbox, text, conf, layer in split_ocr:
            xs, ys = [p[0] for p in bbox], [p[1] for p in bbox]
            x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
            if not text.strip():
                continue
            heights.append(max(y2 - y1, 1.0))
            typo = (dict(self._TYPO_DEFAULT) if (layered and layer)
                    else self._measure_typography(clean_image, x1, y1, x2, y2))
            tokens.append({
                "text": text.strip(), "conf": float(conf), "layer": layer,
                "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                "cx": (x1 + x2) / 2.0, "cy": (y1 + y2) / 2.0,
                "height": max(y2 - y1, 1.0), "y_norm": y1 / max(h, 1),
                **typo, "used": False,
            })
        med_h = float(np.median(heights)) if heights else 22.0
        self._med_h = med_h
        self._layered = any(t["layer"] for t in tokens)
        self._calibrate_style(tokens)
        for t in tokens:
            if self._layered and t["layer"]:
                t["hand"] = 0.95 if t["layer"] == "hand" else 0.05
            else:
                t["hand"] = self._hand_score(t, med_h)
        verts = self._detect_vertical_segments(ruled, med_h, tokens)

        for t in tokens:
            self._classify(t)
        self._ignore_above_form(tokens, med_h)
        tokens = self._assemble_labels(tokens, verts, med_h)
        tokens = self._split_across_captions(tokens, clean_image, med_h)
        stitched = self._stitch(tokens, verts, med_h)

        labels = [t for t in stitched if t["kind"] == "label" and not self._is_boilerplate(t["text"])]
        answers = [t for t in stitched if t["kind"] == "answer"]
        units = [t for t in stitched if t["kind"] == "unit"]
        # "Name:" is only a row caption when Last / First / Middle captions exist
        if any(L["canon"] in ("lastName", "firstName") for L in labels):
            caps_y = [L["cy"] for L in labels if L["canon"] in ("lastName", "firstName", "middleName")]
            labels = [L for L in labels if not (L["canon"] == "fullName"
                                                and any(abs(L["cy"] - y) < 3 * med_h for y in caps_y))]
        labels = self._drop_parent_labels(labels, med_h)

        pairs_out = []

        def put(L, value, conf, source, A=None):
            pairs_out.append({"label": L["text"].rstrip(":").strip(), "canon": L["canon"], "value": value,
                              "conf": float(conf), "source": source, "x": L["cx"], "y": L["cy"],
                              "y_norm": L["cy"] / max(h, 1), "L": L, "A": A})

        cap_pairs = self._pair_captions(labels, answers, verts, med_h)
        cap_l = {id(p[0]) for p in cap_pairs}
        cap_a = {id(p[1]) for p in cap_pairs}
        pairs = cap_pairs + self._pair([L for L in labels if id(L) not in cap_l],
                                       [A for A in answers if id(A) not in cap_a],
                                       verts, med_h, w, all_labels=labels)
        for L, A, d in pairs:
            A["used"] = True
        paired = set()
        for L, A, d in pairs:
            paired.add(id(L))
            val, conf = self._extend_right(L, A, answers, units, labels, verts, med_h)
            if L["canon"] in ADDRESS_KEYS:
                val, conf = self._extend_multiline(L, A, answers, labels, med_h, val, conf)
            put(L, val, conf, f"paired_{d}", A)

        # Second chance for unpaired labels: values with a distinctive shape, in a plausible spot.
        for L in labels:
            if id(L) in paired:
                continue
            best, best_cost = None, 1e9
            if L["canon"] in RESCUE:
                for A in answers:
                    if A.get("used"):
                        continue
                    fit = value_fit(L["canon"], A["text"])
                    if fit is None or fit >= 1.0 or self._blocked(L, A, verts):
                        continue
                    rel = self._relation(L, A, med_h, scale=2.5, max_gap=max(18.0 * med_h, 0.55 * w))
                    if rel is None or self._label_between(L, A, labels, med_h, rel[0]):
                        continue
                    if rel[1] < best_cost:
                        best, best_cost = A, rel[1]
            # dates split across two boxes ("09/14" + "/98", "September 14," + "1998")
            if best is None and L["canon"] in ("dateOfBirth", "effectiveDate"):
                near = [A for A in answers if not A.get("used") and not self._blocked(L, A, verts)
                        and self._relation(L, A, med_h, scale=2.5, max_gap=max(18.0 * med_h, 0.55 * w)) is not None]
                near.sort(key=lambda t: (t["cy"], t["x1"]))
                for i in range(len(near) - 1):
                    a1, a2 = near[i], near[i + 1]
                    if abs(a1["cy"] - a2["cy"]) <= 0.8 * med_h and 0 <= a2["x1"] - a1["x2"] <= 3.0 * med_h:
                        joined = f"{a1['text']} {a2['text']}".strip()
                        if looks_like_date(joined):
                            a1["used"] = a2["used"] = True
                            best = a1.copy()
                            best["text"] = joined
                            best["conf"] = min(a1["conf"], a2["conf"])
                            break
            if best is not None:
                best["used"] = True
                put(L, best["text"], best["conf"] * 0.85, "rescued", best)
                paired.add(id(L))

        result.update(tokens=stitched, labels=labels, answers=answers, pairs=pairs_out,
                      med_h=med_h, verts=verts, layered=self._layered)
        return result
