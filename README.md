# IRBY Dental Ledger

**Digital Dental Chart & Records Management System** for a single dental clinic. It replaces the paper-folder workflow with a secure web app that runs on the clinic's own PC and is used from desktop browsers at the front desk and from tablets chairside.

It implements the SRS (CPECAPS DOCS) and the Group 6 Test Plan on top of the initial *IRBY Dental Ledger* design. Changes from that design:

* **Video labels removed.** The floating "FR-x / NFR-x" caption bar and its toggles are gone.
* **The teeth section is now a photo dental chart.** Dentists attach intraoral photos and pin PDA findings on them, instead of clicking a predetermined tooth drawing.
* **OCR is a pluggable adapter.** Mounting a model means editing one Python file or setting one environment variable. See [ocr-model/README.md](ocr-model/README.md).
* **Everything is real.** Sign-in, roles, encryption, audit trail, search, ledger, follow-ups, backups and exports all run against a database. Nothing is a mock-up.

---

## Contents

1. [Quick start](#1-quick-start)
2. [Using it in the clinic (LAN, tablets, HTTPS)](#2-using-it-in-the-clinic)
3. [Screens](#3-screens)
4. [Photo dental chart (reworked teeth section)](#4-photo-dental-chart)
5. [OCR scanner: mounting your model](#5-ocr-scanner--mounting-your-model)
6. [Requirements traceability](#6-requirements-traceability)
7. [Security & privacy](#7-security--privacy)
8. [Backups, export & import](#8-backups-export--import)
9. [Configuration](#9-configuration)
10. [Testing & benchmarks](#10-testing--benchmarks)
11. [Project structure & API](#11-project-structure--api)
12. [Assumptions & known limitations](#12-assumptions--known-limitations)

---

## 1. Quick start

**Requirements:** Windows 10+ (or macOS/Linux) and **Node.js 22.13 or newer** (it uses Node's built-in SQLite, so there are no native modules to compile). Python is optional and only needed for a Python OCR model.

```bash
npm install
```

```bash
npm run seed:demo
```

```bash
npm start
```

Open **http://localhost:3000**. On Windows you can double-click `start-clinic.bat` instead.

`npm run seed:demo` creates sample patients (ledger entries, follow-ups due today and overdue, and a demo chart photo with findings) plus three demo accounts:

| Role | Username | Password |
|---|---|---|
| Administrator | `admin` | `Irby#Clinic-Root26` |
| Dentist | `dr.bautista` | `Bautista#Dental26` |
| Front Desk | `m.santos` | `Santos#FrontDesk26` |

> ⚠ **Demo only.** Change these passwords, or deactivate the accounts under *Security → Users*, before storing real patient data.

**Without demo data:** skip the seed step. On first launch the sign-in screen asks you to create the administrator account. Add dentists and front-desk staff afterwards under *Security → Users*.

---

## 2. Using it in the clinic

* **One server, many devices.** Run `npm start` on the clinic PC. The console prints the LAN address (e.g. `http://192.168.1.20:3000`). Open that on the front-desk browser and the chairside tablets.
* **No internet needed (NFR-A1).** Fonts, scripts and the OCR adapter are all local. The app keeps working with the internet disconnected, as long as devices can reach the clinic PC on the LAN.
* **Install as an app.** On a tablet, use *Add to Home Screen*. The app shell is cached by a service worker. Patient data is never cached in the browser.
* **HTTPS for live camera on tablets.** Browsers only allow a live camera preview over HTTPS (or on `localhost`):

  ```bash
  npm run cert
  ```

  Then set `HTTPS=true` in `.env` (copy `.env.example`) and restart. Tablets use `https://<clinic-pc-ip>:3443` and accept the self-signed certificate once. Over plain HTTP the app still captures photos, using the device's camera app through the file picker.
* **Auto-lock.** A workstation signs out after **10 minutes** without activity, with a one-minute warning. The *Lock* button signs out immediately. Locking reloads the page so no patient data stays on screen or in memory.

---

## 3. Screens

| Screen | What it does | SRS |
|---|---|---|
| **Sign-in / first-run setup** | Unique accounts, passwords of 12+ characters, 15-minute lock after 5 failed attempts | FR-7, NFR-SEC1 |
| **Patient bar** (always on top) | Active patient's photo, name, record ID, age/sex, allergy alert, next visit, balance. *Switch Patient* asks for confirmation when there are unsaved edits | NFR-S2 |
| **Dashboard** | Today's appointments, the **Due for Follow-Up** recall queue (overdue, due today, next 7 days) with procedure and contact number, allergy alerts, outstanding balances. Internal only; no SMS is sent | FR-6, TC-03 |
| **Directory** | Typo-tolerant search by name or record ID (up to 2 typos). Sort by next appointment, last visit, balance, name or registration. Filters for follow-ups, balances and alerts. CSV/JSON export | FR-2 |
| **Intake** | Full **Philippine Dental Association (PDA) Patient Information Record** (personal details, Dental History, Medical History Q1–Q12 Yes/No, allergy checklist, Q13 36-condition grid), auto-calculated age, portrait capture (500 KB limit), mandatory consent, and **OCR form scan** with staff review | FR-1, FR-8 |
| **Dental Chart** | Interactive 52-tooth PDA Odontogram + photo-based chart with PDA symbols, FDI/Universal numbering, one-action undo, print/PDF | FR-3, FR-4 |
| **Ledger** | Visit date, age at visit, procedure, fee, amount paid, balance (exact centavos), next return date, edit/void with audit, print/PDF | FR-5, FR-6 |
| **Security** | Secure connection & storage posture cards, live **Diagnostics & Watchdog** telemetry (3-state status LEDs, `ERR-*` codes, log viewer), audit trail with tamper check, users, recently deleted (restore), export/import, encrypted backups, change password | NFR-SEC2, NFR-S2, NFR-PO2 |

The layout follows the original design: a card grid with a sidebar on desktop, a floating bottom dock on tablets and phones, and card-style table rows on phones.

---

## 4. Photo dental chart

The original drawn 5-segment tooth grid was replaced so that dentists can **just add pictures**. Tooth numbers, surfaces and PDA codes are still recorded as structured data, so FR-3 and FR-4 are still met.

### Adding photos
* **📷 Take photo** uses the tablet or webcam camera. **Upload** takes images from the intraoral camera's folder (several at once).
* You can also **drag & drop** images onto the chart or **paste** them (Ctrl+V).
* Pick the view (upper/lower occlusal, frontal, left/right buccal, close-up, X-ray photo, other) with one tap. You can change the view, date and caption later.
* Photos are resized in the browser (2000 px long edge) and stored encrypted.

### Recording a finding (3 taps or fewer, NFR-U2)
| Flow | Taps |
|---|---|
| **A** – tooth → *(surface)* → condition | Saved immediately. Tapping the photo afterwards pins it (optional). |
| **B** – tap the photo → tooth → condition | Saved with the pin where you tapped. |

* **Tooth keypad:** 44 × 44 px keys grouped by quadrant, permanent or primary dentition, **FDI or Universal** numbering. Each key shows a coloured dot for its latest finding, and missing or extracted teeth are struck through.
* **Surfaces:** **M, O/I, D, F/B, L**. Labels adapt to the tooth: *Incisal/Facial* for anterior teeth, *Occlusal/Buccal* for posterior. Tapping one surface toggles only that surface.
* **Conditions:** the PDA legend, e.g. **D** decayed (solid red), **Am/Co** fillings (blue crosshatch), **M** missing (X), **JC** jacket crown, **X/XO** extraction. Each has a unique **shape and pattern as well as colour** (NFR-U4). Whole-tooth conditions ignore surfaces.
* **Keyboard:** `1`–`9` apply the common symbols, `Z` undoes, `Esc` cancels a pending pin.
* **Undo (NFR-S2):** one action reverts the last mark, pin move, photo upload or delete. Deleted findings and photos are soft-deleted and can be restored for 30 days.
* **Findings list:** sorted by tooth, filterable by tooth or photo. *Show* jumps to the pin; *Pin/Re-pin* moves it.
* **Print / PDF:** a printable chart with the photos, pins, findings table, legend and a signature line.
* **Front Desk** sees the chart read-only. Any write attempt is rejected with HTTP 403 and logged.

### Changing the PDA symbols (NFR-M2)
Symbols live in **`config/pda-symbols.json`**. To add or change one, edit `code`, `name`, `category`, `scope` (`surface` or `tooth`), `shape`, `fill`, `color` and optional `key`. No code changes are needed. The file is validated at start-up and errors are reported clearly.

* **Shapes:** `circle square diamond triangle triangle-down hexagon pentagon octagon star x plus check ring ring-double bar x-circle x-square square-inset`
* **Fills:** `solid outline crosshatch hatch dots dashed`

> **NFR-S3:** the included legend follows the PDA/DOH dental record form. A licensed dentist must confirm it and record the sign-off in the file's `signoff` block before go-live.

Photo view types and the default numbering are set in `config/clinic.json`.

---

## 5. OCR scanner – Keras Document Classifier + EasyOCR (automatic startup)

The Intake screen's **Scan Paper Form (OCR)** captures the paper **Philippine Dental Association (PDA) Dental Chart — Patient Information Record**, classifies the document using `ocr-model/doc_classifier_frozen_easyocr.keras` (EfficientNetB0 + frozen EasyOCR 256-dim visual-text features across `["document", "form", "invoice", "real_life"]`), extracts structured fields + circled `Sex (M/F)` + circled `Yes/No` answers + Q8/Q13 checkboxes via EasyOCR & OpenCV ink analysis, and populates the Intake form. Every filled field is highlighted, marked **Auto-filled · confidence %**, and must be **edited or confirmed** before *Save* is allowed (NFR-S5). The scanned image is never stored.

### Automatic sidecar startup
When `OCR_PROVIDER=http` targets `127.0.0.1` / `localhost` (default in `.env`), **IRBY Dental Ledger automatically starts `ocr-model/server.py` silently in the background** when the app opens and stops it cleanly on exit (`server/ocr/autostart.js`). Clinic staff never need to launch a separate terminal or script.

Install the Python dependencies once on the clinic PC:

```bash
pip install -r ocr-model/requirements.txt
```

Switch providers with one `.env` setting if needed:

| `OCR_PROVIDER` | Use when | Mount by |
|---|---|---|
| `http` *(default)* | Built-in Keras + EasyOCR model server (auto-started) | `ocr-model/model.py` + `ocr-model/doc_classifier_frozen_easyocr.keras` |
| `mock` | Demo / UI testing without Python | – |
| `command` | One-shot script per scan | `OCR_COMMAND=python ocr-model/infer.py {image}` |
| `module` | Model runs in Node (`tesseract.js`, `onnxruntime-node`, etc.) | copy `ocr-model/js-provider.example.js`, set `OCR_MODULE` |

Dates, sex values, full names (e.g. "Dela Cruz, Mateo L."), dental history, and medical history checkboxes are normalised automatically. The full contract and accuracy-testing notes are in [ocr-model/README.md](ocr-model/README.md). Scans time out after `OCR_TIMEOUT_MS` (`30000` ms default in `.env` for CPU EasyOCR inference).

---

## 6. Requirements traceability

| ID | Requirement | Implementation | How to verify |
|---|---|---|---|
| **FR-1** | Demographics, auto age, portrait, mandatory consent | `server/services/patients.js`, `public/js/views/intake.js` | Register without ticking consent: submit is blocked and the box turns red with an icon and message. A portrait over 500 KB is rejected immediately (with an optional *Compress automatically*). Save time is shown. |
| **FR-2** | Search by name/ID, ≤ 2 typos, sort by next appt / last visit | `server/lib/fuzzy.js`, `PatientService.search` | Directory → type `Dela Crz` → both "Dela Cruz" patients and "Delacruz" are shown, with timing |
| **FR-3** | Tooth chart with FDI/Universal and 5 surfaces | photo chart: `public/js/views/chart.js`, `server/services/chart.js` | Pick a tooth, toggle one surface (only it highlights), switch notation |
| **FR-4** | PDA symbology applied to the chart | `config/pda-symbols.json`, `public/js/symbols.js` | Apply *Decayed*: a red circle pin and finding appear and are saved |
| **FR-5** | Ledger with auto balance | `server/lib/money.js`, `server/services/ledger.js` | Fee 2000, paid 500 → balance ₱1,500.00 in the ledger and the patient bar |
| **FR-6** | Next return date → internal "Due for Follow-Up" | `server/services/appointments.js`, `dashboard.js` | Save an entry with a return date of today or earlier → it appears on the dashboard with procedure and contact |
| **FR-7** | RBAC, front desk can't edit charts, 403 | `server/lib/rbac.js`, `routes/mw.js` | Sign in as `m.santos`: chart is view-only, API writes return 403 and are audited as *Blocked (403)* |
| **FR-8** | OCR scanner fills registration | `server/ocr/*`, `ocr-model/*` | Intake → *Scan* (mock) → fields auto-filled and marked for review |
| NFR-P1/P2/P5/P6 | Performance & arithmetic | – | `npm run bench` (results below) |
| NFR-P7 | OCR ≤ 10 s, accuracy targets | timeout in `server/ocr/index.js` | accuracy depends on the mounted model; see `ocr-model/README.md` |
| NFR-A1 | Works without internet | local fonts/assets, LAN server, service worker | disconnect the internet and run the acceptance tests |
| NFR-S2 | Fixed patient header, unsaved-switch confirm, one-action undo, 30-day soft delete | `app.js`, `ui.js` (`dirty`), chart undo, `services/trash.js` | |
| NFR-S4 | Reject negative/non-numeric, flag overpayment, audit every financial edit | `money.js`, `ledger.js` | try `-50`, `abc`, or paying more than is owed; edit an entry and see before/after in the audit trail |
| NFR-S5 | OCR output never saved unreviewed | `intake.js` | *Save* is blocked while auto-filled fields are unconfirmed |
| NFR-SEC1 | 12-char passwords, lockout, 10-min idle logout | `services/auth.js`, `app.js` | 5 wrong passwords → locked 15 min |
| NFR-SEC2 | 100% CRUD logged, logs not editable | `lib/audit.js`, DB triggers, HMAC chain | *Security → Audit trail*, chain badge |
| NFR-U2/U3/U4 | 44 px targets, accessible consent error, shape+colour symbols | CSS `--tap`, consent box, glyph shapes | |
| NFR-M1 | ≥ 80% coverage, 100% for ledger & RBAC, build fails if lower | `npm run check` | |
| NFR-M2 | Symbols in config | `config/pda-symbols.json` | |
| NFR-PO2 | JSON/CSV export, PDF chart & ledger, round-trip import | `services/transfer.js`, `print.html` | *Security → Data & backups* |
| NFR-PO3 | Built-in camera, no extra hardware | `public/js/camera.js` | |
| NFR-C1 | Consent stored with timestamp, version, user | `consents` table | Intake → record card shows the consent version, date and user |
| **TC-01** | Encryption, daily backups, tampering prevention | AES-256-GCM fields + files, `Backup_YYYYMMDD_Secure.bak`, append-only HMAC-chained audit | *Security → Data & backups*, audit chain badge |
| **TC-02 – TC-06** | Registration, reminders & allergy alerts, treatment log, odontogram, PDA alignment & search | as above | |
| Test-plan naming | `[PatientID]_[LastName]_Profile.jpg` | portrait download filename | open a portrait in a new tab and save it |

---

## 7. Security & privacy

* **Encryption at rest.** Patient profiles, procedures, notes, appointment reasons, photos and portraits are encrypted with **AES-256-GCM** before they reach the database. Keys are derived (HKDF) from `data/master.key`, which is created on first run. **Back up the master key separately**: without it neither the database nor the backups can be read. You can also supply it through `MASTER_KEY`.
* **Encryption in transit.** Use HTTPS (`npm run cert`, `HTTPS=true`). Session cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` over HTTPS.
* **Roles** (`server/lib/rbac.js`):

  | Permission | Admin | Dentist | Front Desk |
  |---|:-:|:-:|:-:|
  | Patients: view / register / edit | ✓ | ✓ | ✓ |
  | Patients: delete (soft) | ✓ | ✓ | |
  | Dental chart: view | ✓ | ✓ | ✓ |
  | **Dental chart: edit** | | **✓** | |
  | Ledger & appointments: view / edit | ✓ | ✓ | ✓ |
  | OCR scan | ✓ | ✓ | ✓ |
  | Audit trail, recently deleted | ✓ | ✓ | |
  | Export | ✓ | ✓ | |
  | Import, backups, user management | ✓ | | |

* **Audit trail.** Every create/read/update/delete, search, export, sign-in, failed sign-in, lockout and 403 is appended with user, role, time, IP and patient ID. Names are not written to the log. SQLite triggers block `UPDATE`/`DELETE` on the log, and each row carries an **HMAC chain**, so any edit made outside the app is detected (*Audit chain intact* badge).
* **Authentication.** Passwords are hashed with scrypt. Accounts lock for 15 minutes after 5 failures. Sessions expire after 10 idle minutes. Mutating requests require a CSRF header.
* **Browser hardening.** A strict Content-Security-Policy (no inline scripts), `X-Frame-Options: DENY`, `no-store` on all API responses, and only the active patient's ID is kept in `sessionStorage`.
* **Consent (RA 10173).** The consent text and version live in `config/consent.json`. Each patient stores the consent version, text hash, time and recording user. A new consent version requires re-confirmation on the next profile edit.

---

## 8. Backups, export & import

* **Daily encrypted backup.** On start-up and then hourly, the server makes sure today's `data/backups/Backup_YYYYMMDD_Secure.bak` exists (a gzip SQLite snapshot encrypted with AES-256-GCM). It keeps the newest 30. *Security → Data & backups → Run backup now* makes one on demand.
* **Restore** with the server stopped. The current database is kept as `irby.db.pre-restore-<time>`.

  ```bash
  npm run restore -- data/backups/Backup_20261102_Secure.bak
  ```

* **Export:** full JSON (including photos, re-importable), JSON without photos, patients CSV and ledger CSV. CSVs are Excel-friendly and guarded against formula injection. A per-patient JSON export is on the Intake record card.
* **PDF:** *Print / PDF* on the chart and ledger opens a print layout. Choose **Save as PDF**.
* **Import:** *Security → Data & backups → Import* (administrator) merges a JSON export by record ID.

---

## 9. Configuration

Copy `.env.example` to `.env`. All settings are optional.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP listener (0.0.0.0 = reachable on the LAN) |
| `HTTPS`, `HTTPS_PORT`, `TLS_CERT`, `TLS_KEY` | off, `3443`, `data/certs/*` | HTTPS for tablets |
| `DATA_DIR` | `data` | database, master key, backups |
| `MASTER_KEY` / `MASTER_KEY_FILE` | `data/master.key` | encryption key |
| `BACKUPS`, `BACKUP_DIR`, `BACKUP_KEEP` | on, `data/backups`, `30` | daily backups |
| `TRASH_RETENTION_DAYS` | `30` (minimum 30) | soft-delete recovery window |
| `IDLE_MINUTES` | `10` | idle auto-logout |
| `OCR_PROVIDER`, `OCR_HTTP_URL`, `OCR_COMMAND`, `OCR_MODULE`, `OCR_TIMEOUT_MS` | `mock` … `10000` | OCR adapter |
| `PHOTO_MAX_BYTES`, `SCAN_MAX_BYTES` | 8 MB, 12 MB | upload limits (portrait is fixed at 500 KB) |

The clinic name, address, photo views and default notation are in `config/clinic.json`. The fee suggestions shown in the ledger are in `config/procedures.json`.

---

## 10. Testing & benchmarks

```bash
npm test
```

All unit and integration tests, with **≥ 80%** line and function coverage over `server/` required.

```bash
npm run test:critical
```

**100%** line, branch and function coverage of `lib/money.js` (ledger maths) and `lib/rbac.js` (roles). The command fails if coverage drops.

```bash
npm run check
```

Runs both. Use it as the build gate (NFR-M1).

Current results: `test:critical` 28/28 at 100% on both modules. `npm test` passes 250/250 tests (unit + HTTP integration, including a 10,000-patient search) at 99.9% line, 96% branch and 99.5% function coverage over `server/`.

```bash
npm run bench
```

Runs the NFR performance and accuracy checks on a throwaway 10,000-record database. Sample run on the development PC (Windows, Node 24.12, server-side timings):

| Check | Result | Target |
|---|---|---|
| NFR-P1 registration save + 480 KB portrait, p95 | 74 ms | ≤ 200 ms |
| NFR-P2 search + sort, p95 (10,000 records) | 84 ms | ≤ 300 ms |
| NFR-P2 typo queries with intended patient in top 5 (200 queries) | 98 % | ≥ 95 % |
| NFR-P5 ledger arithmetic vs BigInt reference | 1000/1000 | 100 % |
| FR-5 example 2,000 − 500 | ₱1,500.00 | ₱1,500.00 |
| NFR-P6 dashboard with 500 pending follow-ups | 4 ms | ≤ 2 s |

Re-run it on the reference device (4 GB RAM, 4 cores) for the final report. For bulk manual testing, `npm run seed:demo -- --bulk 10000` adds synthetic patients.

The usability targets (NFR-U1, U3, U4, U5), NFR-S3 sign-off and the OCR accuracy targets (NFR-P7) need sessions with real users, a dentist and real forms. The app provides the features; those measurements must be collected by the team.

---

## 11. Project structure & API

```
server/
  index.js            start-up, HTTPS, daily backup + trash purge
  app.js              Express app & service wiring (used by tests)
  config.js           environment settings
  db/                 schema.sql (append-only audit triggers) + node:sqlite helpers
  lib/                crypto (AES-GCM, scrypt, HMAC), money, rbac, fuzzy, audit, dates, clinicConfig
  services/           auth, patients, ledger, appointments, chart, dashboard, trash, transfer, backup, files
  routes/             auth, clinical (patients/ledger/chart/ocr), admin (audit/users/trash/export/backups)
  ocr/                adapter: index.js, parser.js, providers/{mock,http,command,module}.js
public/               web app (vanilla ES modules, no build step), print.html, service worker
config/               pda-symbols.json, consent.json, procedures.json, clinic.json
ocr-model/            model.py (mount here), server.py, infer.py, js-provider.example.js
scripts/              seed-demo, bench, restore-backup, make-cert, demo-image
tests/                node:test suites
```

Main API endpoints (all under `/api`; JSON; session cookie; mutating calls need `X-Requested-With: irby`):

| Method & path | Purpose |
|---|---|
| `POST /setup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | first-run setup & sessions |
| `GET /dashboard` | stats + follow-up queue |
| `GET /patients?q=&sort=&dir=&filter=` / `POST /patients` / `GET,PUT,DELETE /patients/:id` | directory & profiles |
| `GET,PUT /patients/:id/portrait` | portrait (≤ 500 KB) |
| `GET,POST /patients/:id/ledger`, `PUT,DELETE /ledger/:entryId` | ledger |
| `GET,POST /patients/:id/appointments`, `PUT,DELETE /appointments/:id` | return visits |
| `GET /patients/:id/chart`, `POST /patients/:id/chart/photos` (raw image), `POST /patients/:id/chart/marks`, `PUT,DELETE /chart/marks/:id`, `POST /chart/marks/:id/restore` | photo chart |
| `POST /ocr/scan` (raw image), `GET /ocr/status` | OCR |
| `GET /audit`, `GET /audit/verify`, `/users…`, `/trash…`, `/export/*`, `POST /import`, `/backups` | administration |

---

## 12. Assumptions & known limitations

* **Teeth section (FR-3).** Per the client's request, the drawn 5-segment tooth was replaced by photos. The five surfaces are kept as five 44 px toggle chips (M, O/I, D, F/B, L) for each finding, so the surface-level data required by FR-3 and FR-4 is still captured.
* **Offline mode (NFR-A1).** The system needs no internet: it runs on the clinic's PC and LAN. If a device loses its connection to that PC, the app shows *Server unreachable* and does not queue edits locally. This is deliberate, to avoid conflicting copies of medical records. A sync queue would be future work.
* **Database encryption** is application-level (field and file encryption with AES-256-GCM) rather than whole-file SQLCipher. Record IDs, dates and amounts used for sorting are stored in clear. Names, addresses, procedures, notes and images are encrypted.
* **`node:sqlite`** is marked experimental by Node.js (stable enough for this workload). The warning is suppressed in the npm scripts.
* **PDF export** uses the browser's *Save as PDF*, so no server-side PDF library is needed.
* **OCR accuracy** (≥ 95% printed / ≥ 85% handwriting) depends on the mounted model. The default `mock` provider returns demo data and is labelled *demo* in the UI.
* The **PDA legend** needs licensed-dentist sign-off (NFR-S3). The **fee schedule** in `config/procedures.json` is an example.
* Out of scope per the SRS: patient SMS/e-mail, HMO integration, DICOM/X-ray machine integration, multi-branch sync.
