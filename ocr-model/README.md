# Mounting the OCR model (FR-8)

The web app never talks to an OCR engine directly. It sends the scanned page to a
**provider**, chosen with one setting in `.env`, and maps whatever comes back onto
the registration form. Staff must review every auto-filled field before saving (NFR-S5).

| `OCR_PROVIDER` | Use when | What to edit |
|---|---|---|
| `mock` (default) | Demos / UI testing – returns sample data | nothing |
| `http` | Your model runs as a server (recommended – model stays loaded) | `ocr-model/model.py`, then run `python ocr-model/server.py` |
| `command` | Simple script, loaded per scan | `ocr-model/model.py` |
| `module` | Model runs in Node.js (tesseract.js, onnxruntime-node, cloud SDK) | copy `js-provider.example.js` |

## Quick start (Python model)

1. Put your inference code in **`model.py`** → `load()` and `predict(image_bytes) -> dict`.
2. Start the wrapper: `python ocr-model/server.py` (port 8765).
3. In `.env`:
   ```
   OCR_PROVIDER=http
   OCR_HTTP_URL=http://127.0.0.1:8765/predict
   ```
4. Restart the web app. The OCR card on the Intake screen shows **ready** when `/health` answers.

## Output contract

`predict()` (or your HTTP server, script, or JS module) returns JSON. Any of:

```json
{ "text": "Last Name: Dela Cruz  First Name: Mateo\nBirthdate: 04/12/1992\nSex: Male ..." }
```
```json
{ "fields": { "lastName": "Dela Cruz", "firstName": "Mateo", "middleName": "Lorenzo",
              "dateOfBirth": "1992-04-12", "sex": "Male", "address": "…",
              "contactNumber": "+63 917 550 0192", "allergies": "Penicillin" },
  "confidence": { "lastName": 0.97, "dateOfBirth": 0.88 } }
```
```json
{ "fields": { "lastName": { "value": "Dela Cruz", "confidence": 0.97 } } }
```

* `fields` take priority; anything missing is extracted from `text` by label
  (`Last Name:`, `Surname:`, `Birthdate:`, `DOB:`, `Sex:`, `Address:`, `Contact No:`, `Allergies:` …,
  including Filipino labels such as `Apelyido`, `Kaarawan`, `Tirahan`).
* `fullName` / `name` is split into last / first / middle (handles `Dela Cruz, Mateo L.` and particles like *de la*, *delos*).
* Dates in `MM/DD/YYYY`, `YYYY-MM-DD`, `April 12, 1992`, `12 Abril 1992` are normalised.
* Sex accepts `M/F`, `Male/Female`, `Lalaki/Babae` and ticked boxes like `[x] Male`.
* `confidence` may be one number (0–1 or 0–100) or per field. It is shown on each auto-filled field.

## Limits

* One page per scan, JPEG/PNG/WebP, up to 12 MB (`SCAN_MAX_BYTES`). The browser resizes to 2400 px before upload.
* The scan must finish within `OCR_TIMEOUT_MS` (default 10 000 ms, NFR-P7).
* The scanned image is **not stored**; the `command` provider deletes its temporary file immediately.

## Testing your model against NFR-P7

Field accuracy targets are ≥ 95 % (printed) and ≥ 85 % (handwriting) over 100 real forms. A simple
way to measure: keep the forms' true values in a CSV, run `predict()` on each scan, and compare field by
field after normalisation. Time each call to confirm ≤ 10 s on the reference device.
