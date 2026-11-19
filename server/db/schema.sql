-- IRBY Dental Ledger schema (SQLite). Columns ending in _enc hold AES-256-GCM
-- ciphertext produced by server/lib/crypto.js. Soft-deleted rows keep
-- deleted_at/deleted_by until the retention window (>= 30 days) passes.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name        TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('admin', 'dentist', 'frontdesk')),
  password_hash       TEXT NOT NULL,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER,
  active              INTEGER NOT NULL DEFAULT 1,
  password_changed_at INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  patient_id TEXT,
  kind       TEXT NOT NULL,            -- portrait | chart_photo
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  data_enc   BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  deleted_at INTEGER,
  deleted_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files_patient ON files(patient_id);

CREATE TABLE IF NOT EXISTS patients (
  id               TEXT PRIMARY KEY,   -- PT-YYYY-NNNN
  year             INTEGER NOT NULL,
  seq              INTEGER NOT NULL,
  data_enc         TEXT NOT NULL,      -- encrypted JSON profile (name, DOB, sex, address, contact, allergies)
  portrait_file_id TEXT,
  registered_on    TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  created_by       INTEGER,
  updated_at       INTEGER NOT NULL,
  updated_by       INTEGER,
  deleted_at       INTEGER,
  deleted_by       INTEGER,
  UNIQUE (year, seq)
);

-- NFR-C1: every patient has a consent entry (timestamp, consent-text version, recording user)
CREATE TABLE IF NOT EXISTS consents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  version     TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  method      TEXT NOT NULL,
  recorded_by INTEGER,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consents_patient ON consents(patient_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id               TEXT PRIMARY KEY,
  patient_id       TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  visit_date       TEXT NOT NULL,
  age_at_visit     INTEGER,
  procedure_enc    TEXT NOT NULL,
  fee_cents        INTEGER NOT NULL CHECK (fee_cents >= 0),
  paid_cents       INTEGER NOT NULL CHECK (paid_cents >= 0),
  overpayment_ack  INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  created_by       INTEGER,
  updated_at       INTEGER NOT NULL,
  updated_by       INTEGER,
  deleted_at       INTEGER,
  deleted_by       INTEGER,
  delete_reason_enc TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_patient ON ledger_entries(patient_id, visit_date);

CREATE TABLE IF NOT EXISTS appointments (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  time            TEXT,
  reason_enc      TEXT,
  status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  source_entry_id TEXT,
  created_at      INTEGER NOT NULL,
  created_by      INTEGER,
  updated_at      INTEGER NOT NULL,
  updated_by      INTEGER,
  deleted_at      INTEGER,
  deleted_by      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_appt_status_date ON appointments(status, date);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id);

CREATE TABLE IF NOT EXISTS chart_photos (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL,
  view       TEXT NOT NULL,
  label_enc  TEXT,
  taken_on   TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER,
  deleted_at INTEGER,
  deleted_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_photos_patient ON chart_photos(patient_id);

CREATE TABLE IF NOT EXISTS chart_marks (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  photo_id   TEXT,
  tooth      INTEGER NOT NULL,          -- canonical FDI number (11-48, 51-85)
  surfaces   TEXT NOT NULL DEFAULT '',  -- comma list of M,D,O,F,L
  condition  TEXT NOT NULL,             -- code from config/pda-symbols.json
  x          REAL,                      -- 0..1 position on the photo
  y          REAL,
  note_enc   TEXT,
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER,
  deleted_at INTEGER,
  deleted_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_marks_patient ON chart_marks(patient_id);

-- NFR-SEC2: append-only, HMAC-chained audit trail
CREATE TABLE IF NOT EXISTS audit_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  user_id    INTEGER,
  username   TEXT,
  role       TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  patient_id TEXT,
  details    TEXT,
  ip         TEXT,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_log(patient_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
