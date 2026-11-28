# OCR model (FR-8): RapidOCR + Keras document classifier

The web app never talks to an OCR engine directly. It sends the scanned page to a
**provider**, chosen with one setting in `.env`, and maps what comes back onto the
registration form. Staff must review every auto-filled field before saving (NFR-S5).

| `OCR_PROVIDER` | Use when | What runs |
|---|---|---|
| `http` *(default in `.env.example`)* | Normal use: the model stays loaded | `ocr-model/server.py`, started automatically by the app |
| `command` | One-off script per scan (slow: loads the model every time) | `ocr-model/infer.py {image}` |
| `mock` | Demos / UI testing, returns sample data | nothing |
| `module` | A model that runs inside Node.js | copy `js-provider.example.js` |

## Setup (once per clinic PC)

**Installed with `IRBY Dental Ledger Setup.exe`:** nothing to do. The installer's OCR option puts the
official embeddable Python 3.12 in `<install folder>\python`, installs `requirements.txt` into it and
checks the model loads; `server/ocr/autostart.js` uses that interpreter.

**Running from source:** Python 3.10 to 3.12 is needed. From the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File ocr-model\setup-ocr.ps1
```

On macOS / Linux: `sh ocr-model/setup-ocr.sh`. This creates `ocr-model/.venv`, installs
`requirements.txt` (RapidOCR on onnxruntime, OpenCV, Keras / TensorFlow) and checks the model
loads. Then start IRBY Dental Ledger normally (`start-clinic.bat`, `npm start` or the desktop
app). `server/ocr/autostart.js` starts `ocr-model/server.py` with the `.venv` interpreter in the
background and stops it on exit. The OCR card on the Intake screen turns **ready** when `/health`
answers (first start takes about 10 s while TensorFlow loads).

No GPU is used. On a laptop i5 a scanned page takes about 3 to 4 s.

## What happens to a scan

| Stage | File | What it does |
|---|---|---|
| Page recovery | `scan.py` | Finds the paper's four corners in a phone photo and flattens the perspective; turns pages photographed sideways (box shapes) or upside down (RapidOCR's direction classifier); removes the small tilt left over (row-profile search, ±8°); evens out shadows; resizes to a working width where handwriting is readable. Each step falls back to its input if it fails. |
| Ink layers | `scan.py` | Erases printed table rules, then splits the page into a **printed** layer and a **pen** layer by ink colour. Scanners: strongly coloured strokes. Phone JPEGs wash a thin pen line out, so each ink stroke is also classified by its median colour against the page's own colours (Otsu), with weaker strokes next to pen strokes pulled in. Black-ink pages have no pen layer and fall back to typography (below). |
| Boxes | `scan.py` | RapidOCR's detector runs on each layer. Boxes are tightened to their ink, duplicates merged, words the detector cut in half re-joined, multi-line boxes split, boxes split at printed column rules and wide gaps, overlaps cut apart (also across the two layers), and print-layer leftovers of pen strokes dropped. |
| Reading | `scan.py` | All crops go to the recogniser in one call (very long lines are read in chunks, because the recogniser's cost grows with the square of the width). Recovery re-reads: a digits-only decode for dates and phone numbers (`O→0`, `I→1`, `S→5` …) and a contrast-enhanced retry for weak reads (usually handwriting). `Label: value` boxes glued by the detector are cut at the label / answer gap and re-read. |
| Labels and answers | `formparse.py`, `lexicon.py` | Each box becomes a printed **label** (fuzzy match against the PDA label lexicon), a handwritten **answer**, a printed choice (`Yes`, `No`, `M/F`) or form furniture (the questions and checklist wording). Answers are paired to labels geometrically: captions under the line (`Last / First / Middle`) first, then right / below / above by cost, never across a printed column rule or past another label, and only when the value fits the label (a date for *Birthdate*, digits for *Cel/Mobile No.* …). Free text runs on to further boxes; unpaired labels get a second chance with distinctively shaped values (dates split in two boxes, phones). On black-ink scans handwriting is told from print by glyph-height variation, baseline wobble and stroke width against the page's own printed labels. |
| PDA extraction | `pda.py` | Section headings decide duplicates (the second *Occupation* is the guardian's; *Office Address / Number* under MEDICAL HISTORY are the physician's). Yes / No answers are read from ink around the printed `Yes` / `No` on each question row (circles, ticks, crosses), with written `yes` / `no` and circles boxed together with the word as further evidence. `( )` checklists (allergies, the 36 conditions) are read from the ink just left of each item, relative to the other items. *Sex: M/F* is read from the ring's centre, or from ticks. Values are cleaned: ISO dates, `Male/Female`, phone digits, emails with a misread `@` repaired, blood type / pressure, names in title case, dropped spaces restored. |
| Document type | `model.py` | The Keras classifier labels the photo `document / form / invoice / real_life`; the Intake screen warns on `real_life`. |

### About the Keras classifier's second input

`doc_classifier_frozen_easyocr.keras` has two inputs: the 224×224 image (EfficientNetB0) and a
256-value vector that was produced by EasyOCR's recogniser during training. RapidOCR is a
different network and cannot produce those values, and feeding unrelated numbers would push the
classifier off its training distribution. `model.py` therefore feeds that input the moving mean
of its first batch-normalisation layer (the average training vector), which makes that branch
output its neutral value; the image branch decides the class. The printed PDA headings also
force `form`. If the classifier is ever retrained, train it on RapidOCR features or the image
alone.

## Output contract

`predict(image_bytes)` returns:

```json
{
  "fields": { "lastName": "Reyes", "firstName": "Maria Clara", "dateOfBirth": "1992-04-12",
              "sex": "Female", "contactNumber": "0917-845-2390", "email": "maria.reyes@gmail.com" },
  "confidence": { "lastName": 0.99, "email": 0.66 },
  "review": ["email", "sex"],
  "medicalHistory": {
    "questions": { "goodHealth": true, "hospitalized": true, "hospitalizedDetails": "2015, appendicitis" },
    "allergyItems": ["penicillin", "latex"],
    "conditions": ["asthma", "hayFeverAllergies"]
  },
  "documentType": "form", "documentConfidence": 0.92,
  "text": "PHILIPPINE DENTAL ASSOCIATION\n...",
  "fieldsComplete": true,
  "scan": { "page": "perspective-corrected", "rotated": 0, "deskew": 0.0, "handwritingLayer": true, "seconds": 3.4 }
}
```

* Field keys are the Intake form's own names (`server/ocr/parser.js` `ALL_FIELDS`).
* `confidence` is the recogniser's score, lowered for rescued or repaired values.
* `review` lists fields the model is unsure of (rescued, repaired, inferred from marks). The
  Intake screen tags them **check**.
* `fieldsComplete: true` tells the web app not to re-parse `text` for more fields (that parser
  is for simple text-only providers and would read a blank form's labels as values).
* Pages that are not the PDA form still get the fields the lexicon recognises (names, birthdate,
  sex, address, contact number, email).

Other providers may still return just `{ "text": "..." }` or `{ "fields": {...} }`; see
`server/ocr/parser.js`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `OCR_TIMEOUT_MS` | `30000` | The web app gives up after this long |
| `OCR_PYTHON` | `ocr-model/.venv` Python | Interpreter for the auto-started server |
| `OCR_THREADS` | half the CPU cores, max 4 | onnxruntime threads (more is slower on laptop CPUs with efficiency cores) |
| `OCR_AUTOSTART` | `true` | `false` if you run `server.py` yourself |
| `OCR_DEBUG` | off | `1` prints checklist and Sex ink scores to stderr |

`python ocr-model/model.py page.jpg` prints the full result for one image (without `text`).

## Tested so far, and what is not

Measured on synthetic PDA pages (printed labels, handwriting fonts in blue or black pen, circled
or ticked answers), 26 text fields + 13 medical-history answers + both checklists per page:

| Page | Text fields | Yes / No + details | Checklists |
|---|---|---|---|
| Scan, blue pen | 26 / 26 | 13 / 13 | exact |
| Scan, black pen (no colour layer) | 26 / 26 | 13 / 13 | exact |
| Scan, second handwriting style, ticks instead of circles | 26 / 26 | 13 / 13 | exact |
| Phone photo: perspective, shadow, background, JPEG | 25 / 26 | 13 / 13 | exact |
| Rotated 90°, upside down, tilted 3.5° | 26 / 26 each | 13 / 13 | exact |
| Blank form, photo of a hand | nothing filled (correct) | none | none |

**Not yet verified: real handwriting.** Font-rendered handwriting is far tidier than a patient's
pen, so expect lower accuracy on real forms, especially cursive, crowded or very faint writing.
Before the NFR-P7 sign-off (≥ 95 % printed, ≥ 85 % handwritten over 100 real forms), scan real
filled forms, keep their true values in a CSV, run `predict()` on each and compare field by field.
Add any label wording the clinic's printing uses to `FIELD_LEXICON` in `lexicon.py`.

## Limits

* One page per scan, JPEG / PNG / WebP, up to 12 MB (`SCAN_MAX_BYTES`). The browser resizes to
  2400 px before upload, which costs some accuracy on phone photos.
* The scanned image is **not stored**; the `command` provider deletes its temporary file.
