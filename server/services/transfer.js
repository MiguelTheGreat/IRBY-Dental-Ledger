'use strict';
// NFR-PO2: full patient data export to JSON and CSV, and round-trip JSON import.
// (Chart and ledger PDFs are produced by the browser print view: /print.html.)
const { transaction, nn, toBuffer } = require('../db');
const { HttpError } = require('../lib/errors');
const { sha256 } = require('../lib/crypto');
const { ageOn } = require('../lib/dates');
const { withRunningBalance } = require('../lib/money');
const { parsePatientId } = require('./patients');

const FORMAT = 'irby-dental-ledger';
const FORMAT_VERSION = 1;

class TransferService {
  constructor(ctx) {
    this.ctx = ctx;
    this.db = ctx.db;
    this.vault = ctx.vault;
  }

  dec(v) { return v == null ? null : this.vault.decryptText(v); }

  fileOut(fileId, includeFiles) {
    if (!fileId) return null;
    const r = this.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!r) return null;
    const out = { id: r.id, kind: r.kind, mime: r.mime, size: r.size, sha256: r.sha256, createdAt: r.created_at, deletedAt: r.deleted_at };
    if (includeFiles) out.data = this.vault.decryptBuffer(toBuffer(r.data_enc)).toString('base64');
    return out;
  }

  patientOut(r, names, includeFiles) {
    const user = (id) => (id == null ? null : (names.get(id) || {}).username || null);
    const id = r.id;
    return {
      id,
      registeredOn: r.registered_on,
      createdAt: r.created_at, createdBy: user(r.created_by), updatedAt: r.updated_at, updatedBy: user(r.updated_by),
      deletedAt: r.deleted_at,
      profile: this.vault.decryptJson(r.data_enc),
      portrait: this.fileOut(r.portrait_file_id, includeFiles),
      consents: this.db.prepare('SELECT * FROM consents WHERE patient_id = ? ORDER BY id').all(id).map((c) => ({
        version: c.version, textSha256: c.text_sha256, method: c.method, recordedBy: user(c.recorded_by), recordedAt: c.recorded_at,
      })),
      ledger: this.db.prepare('SELECT * FROM ledger_entries WHERE patient_id = ? ORDER BY visit_date, created_at').all(id).map((e) => ({
        id: e.id, visitDate: e.visit_date, ageAtVisit: e.age_at_visit, procedure: this.dec(e.procedure_enc), feeCents: e.fee_cents,
        paidCents: e.paid_cents, overpaymentAck: !!e.overpayment_ack, createdAt: e.created_at, createdBy: user(e.created_by),
        updatedAt: e.updated_at, updatedBy: user(e.updated_by), deletedAt: e.deleted_at, deleteReason: this.dec(e.delete_reason_enc),
      })),
      appointments: this.db.prepare('SELECT * FROM appointments WHERE patient_id = ? ORDER BY date, created_at').all(id).map((a) => ({
        id: a.id, date: a.date, time: a.time, reason: this.dec(a.reason_enc), status: a.status, sourceEntryId: a.source_entry_id,
        createdAt: a.created_at, createdBy: user(a.created_by), updatedAt: a.updated_at, updatedBy: user(a.updated_by), deletedAt: a.deleted_at,
      })),
      chart: {
        photos: this.db.prepare('SELECT * FROM chart_photos WHERE patient_id = ? ORDER BY created_at').all(id).map((p) => ({
          id: p.id, view: p.view, label: this.dec(p.label_enc), takenOn: p.taken_on, width: p.width, height: p.height,
          createdAt: p.created_at, createdBy: user(p.created_by), updatedAt: p.updated_at, updatedBy: user(p.updated_by), deletedAt: p.deleted_at,
          file: this.fileOut(p.file_id, includeFiles),
        })),
        marks: this.db.prepare('SELECT * FROM chart_marks WHERE patient_id = ? ORDER BY created_at').all(id).map((m) => ({
          id: m.id, photoId: m.photo_id, tooth: m.tooth, surfaces: m.surfaces, condition: m.condition, x: m.x, y: m.y,
          note: this.dec(m.note_enc), createdAt: m.created_at, createdBy: user(m.created_by), updatedAt: m.updated_at,
          updatedBy: user(m.updated_by), deletedAt: m.deleted_at,
        })),
      },
    };
  }

  exportAll({ includeFiles = true, patientId = null } = {}) {
    const names = this.ctx.services.auth.userNames();
    const rows = patientId
      ? this.db.prepare('SELECT * FROM patients WHERE id = ?').all(patientId)
      : this.db.prepare('SELECT * FROM patients ORDER BY year, seq').all();
    if (patientId && !rows.length) throw new HttpError(404, 'NOT_FOUND', 'Patient not found.');
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      clinic: this.ctx.clinic.clinic.name,
      includesFiles: !!includeFiles,
      patients: rows.map((r) => this.patientOut(r, names, includeFiles)),
    };
  }

  importData(data, actor) {
    if (!data || data.format !== FORMAT || data.formatVersion !== FORMAT_VERSION || !Array.isArray(data.patients)) {
      throw new HttpError(400, 'BAD_IMPORT', `Not an ${FORMAT} v${FORMAT_VERSION} export file.`);
    }
    const userIds = new Map(this.db.prepare('SELECT id, username FROM users').all().map((u) => [u.username.toLowerCase(), u.id]));
    const uid = (name) => (name ? nn(userIds.get(String(name).toLowerCase())) : null);
    const enc = (v) => (v == null || v === '' ? null : this.vault.encryptText(v));
    const counts = { patients: 0, ledger: 0, appointments: 0, photos: 0, marks: 0, files: 0, skippedFiles: 0 };
    const files = this.ctx.services.files;

    const putFile = (f, patientId) => {
      if (!f || !f.data) {
        if (!f) return null;
        counts.skippedFiles++;
        // Export made without files: keep the reference only if this database already has that file.
        return this.db.prepare('SELECT 1 FROM files WHERE id = ?').get(f.id) ? f.id : null;
      }
      const buffer = Buffer.from(f.data, 'base64');
      if (sha256(buffer) !== f.sha256) throw new HttpError(400, 'BAD_IMPORT', `File ${f.id} failed its checksum.`);
      files.put({ id: f.id, patientId, kind: f.kind, mime: f.mime, buffer, createdAt: f.createdAt });
      if (f.deletedAt) this.db.prepare('UPDATE files SET deleted_at = ? WHERE id = ?').run(f.deletedAt, f.id);
      counts.files++;
      return f.id;
    };

    transaction(this.db, () => {
      for (const p of data.patients) {
        const idParts = parsePatientId(p.id);
        if (!idParts || !p.profile) throw new HttpError(400, 'BAD_IMPORT', `Invalid patient record ${p.id}.`);
        const portraitId = p.portrait ? putFile(p.portrait, p.id) : null;
        this.db.prepare(`INSERT INTO patients (id, year, seq, data_enc, portrait_file_id, registered_on, created_at, created_by, updated_at, updated_by, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data_enc = excluded.data_enc, portrait_file_id = excluded.portrait_file_id,
            registered_on = excluded.registered_on, created_at = excluded.created_at, created_by = excluded.created_by,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted_at = excluded.deleted_at`)
          .run(p.id, idParts.year, idParts.seq, this.vault.encryptJson(p.profile), nn(portraitId), p.registeredOn, p.createdAt,
            uid(p.createdBy), p.updatedAt, uid(p.updatedBy), nn(p.deletedAt));
        counts.patients++;
        const existingConsents = new Set(this.db.prepare('SELECT version || \'|\' || recorded_at AS k FROM consents WHERE patient_id = ?').all(p.id).map((r) => r.k));
        for (const c of p.consents || []) {
          if (existingConsents.has(`${c.version}|${c.recordedAt}`)) continue;
          this.db.prepare('INSERT INTO consents (patient_id, version, text_sha256, method, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(p.id, c.version, c.textSha256, c.method, uid(c.recordedBy), c.recordedAt);
        }
        for (const e of p.ledger || []) {
          this.db.prepare(`INSERT INTO ledger_entries (id, patient_id, visit_date, age_at_visit, procedure_enc, fee_cents, paid_cents, overpayment_ack,
            created_at, created_by, updated_at, updated_by, deleted_at, delete_reason_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET visit_date = excluded.visit_date, age_at_visit = excluded.age_at_visit, procedure_enc = excluded.procedure_enc,
              fee_cents = excluded.fee_cents, paid_cents = excluded.paid_cents, overpayment_ack = excluded.overpayment_ack,
              updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted_at = excluded.deleted_at, delete_reason_enc = excluded.delete_reason_enc`)
            .run(e.id, p.id, e.visitDate, nn(e.ageAtVisit), enc(e.procedure), e.feeCents, e.paidCents, e.overpaymentAck ? 1 : 0,
              e.createdAt, uid(e.createdBy), e.updatedAt, uid(e.updatedBy), nn(e.deletedAt), enc(e.deleteReason));
          counts.ledger++;
        }
        for (const a of p.appointments || []) {
          this.db.prepare(`INSERT INTO appointments (id, patient_id, date, time, reason_enc, status, source_entry_id, created_at, created_by, updated_at, updated_by, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET date = excluded.date, time = excluded.time, reason_enc = excluded.reason_enc, status = excluded.status,
              updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted_at = excluded.deleted_at`)
            .run(a.id, p.id, a.date, nn(a.time), enc(a.reason), a.status, nn(a.sourceEntryId), a.createdAt, uid(a.createdBy), a.updatedAt, uid(a.updatedBy), nn(a.deletedAt));
          counts.appointments++;
        }
        for (const ph of (p.chart && p.chart.photos) || []) {
          const fileId = putFile(ph.file, p.id);
          if (!fileId) continue;
          this.db.prepare(`INSERT INTO chart_photos (id, patient_id, file_id, view, label_enc, taken_on, width, height, created_at, created_by, updated_at, updated_by, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET file_id = excluded.file_id, view = excluded.view, label_enc = excluded.label_enc, taken_on = excluded.taken_on,
              width = excluded.width, height = excluded.height, updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted_at = excluded.deleted_at`)
            .run(ph.id, p.id, fileId, ph.view, enc(ph.label), ph.takenOn, nn(ph.width), nn(ph.height), ph.createdAt, uid(ph.createdBy), ph.updatedAt, uid(ph.updatedBy), nn(ph.deletedAt));
          counts.photos++;
        }
        for (const m of (p.chart && p.chart.marks) || []) {
          this.db.prepare(`INSERT INTO chart_marks (id, patient_id, photo_id, tooth, surfaces, condition, x, y, note_enc, created_at, created_by, updated_at, updated_by, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET photo_id = excluded.photo_id, tooth = excluded.tooth, surfaces = excluded.surfaces, condition = excluded.condition,
              x = excluded.x, y = excluded.y, note_enc = excluded.note_enc, updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted_at = excluded.deleted_at`)
            .run(m.id, p.id, nn(m.photoId), m.tooth, m.surfaces || '', m.condition, nn(m.x), nn(m.y), enc(m.note), m.createdAt, uid(m.createdBy), m.updatedAt, uid(m.updatedBy), nn(m.deletedAt));
          counts.marks++;
        }
      }
    });
    this.ctx.services.patients.load();
    this.ctx.audit.append({ user: actor, ip: actor && actor.ip, action: 'IMPORT', entity: 'dataset', details: counts });
    return counts;
  }

  // ---------------------------------------------------------------- CSV
  static csvCell(v) {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  static toCsv(header, rows) {
    return '﻿' + [header, ...rows].map((r) => r.map(TransferService.csvCell).join(',')).join('\r\n') + '\r\n';
  }

  patientsCsv() {
    const p = this.ctx.services.patients;
    const rows = [...p.cache.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((e) => [e.id, e.profile.lastName, e.profile.firstName, e.profile.middleName, e.profile.dateOfBirth, ageOn(e.profile.dateOfBirth),
        e.profile.sex, e.profile.address, e.profile.contactNumber, e.profile.allergies, e.registeredOn, e.summary.lastVisit || '',
        e.summary.nextAppointment ? e.summary.nextAppointment.date : '', (e.summary.balanceCents / 100).toFixed(2),
        e.summary.consent ? e.summary.consent.version : '']);
    return TransferService.toCsv(['Record ID', 'Last Name', 'First Name', 'Middle Name', 'Date of Birth', 'Age', 'Sex', 'Address',
      'Contact Number', 'Allergies / Alerts', 'Registration Date', 'Last Visit', 'Next Appointment', 'Balance (PHP)', 'Consent Version'], rows);
  }

  ledgerCsv() {
    const p = this.ctx.services.patients;
    const byPatient = new Map();
    for (const r of this.db.prepare('SELECT * FROM ledger_entries WHERE deleted_at IS NULL').iterate()) {
      if (!p.cache.has(r.patient_id)) continue;
      if (!byPatient.has(r.patient_id)) byPatient.set(r.patient_id, []);
      byPatient.get(r.patient_id).push({ visitDate: r.visit_date, createdAt: r.created_at, feeCents: r.fee_cents, paidCents: r.paid_cents,
        ageAtVisit: r.age_at_visit, procedure: this.vault.decryptText(r.procedure_enc) });
    }
    const rows = [];
    for (const id of [...byPatient.keys()].sort()) {
      for (const e of withRunningBalance(byPatient.get(id))) {
        rows.push([id, p.nameOf(id), e.visitDate, e.ageAtVisit, e.procedure, (e.feeCents / 100).toFixed(2), (e.paidCents / 100).toFixed(2),
          (e.entryBalanceCents / 100).toFixed(2), (e.runningBalanceCents / 100).toFixed(2)]);
      }
    }
    return TransferService.toCsv(['Record ID', 'Patient', 'Visit Date', 'Age at Visit', 'Procedure', 'Fee (PHP)', 'Paid (PHP)',
      'Entry Balance (PHP)', 'Running Balance (PHP)'], rows);
  }
}

module.exports = { TransferService, FORMAT, FORMAT_VERSION };
