'use strict';
// FR-1 (registration, portrait, consent) and FR-2 (search, sort, filter).
// Profiles are stored encrypted; a decrypted in-memory index serves search so
// queries stay well under 300 ms with 10,000 records (NFR-P2).
const { performance } = require('node:perf_hooks');
const { transaction } = require('../db');
const { HttpError, ValidationError, Checker, notFound, str } = require('../lib/errors');
const { todayISO, isValidISODate, ageOn } = require('../lib/dates');
const { buildIndex, score } = require('../lib/fuzzy');
const { decodeDataUrl } = require('../lib/images');

const SEXES = ['Male', 'Female', 'Other'];
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function displayName(p) {
  const mi = p.middleName ? `${p.middleName.trim()[0].toUpperCase()}. ` : '';
  return `${p.firstName} ${mi}${p.lastName}`.replace(/\s+/g, ' ').trim();
}

function parsePatientId(id) {
  const m = /^PT-(\d{4})-(\d{4,})$/.exec(String(id || ''));
  return m ? { year: Number(m[1]), seq: Number(m[2]) } : null;
}

class PatientService {
  constructor(ctx) {
    this.ctx = ctx;
    this.db = ctx.db;
    this.vault = ctx.vault;
    this.cache = new Map();
  }

  // ---------------------------------------------------------------- cache
  load() {
    this.cache.clear();
    for (const r of this.db.prepare('SELECT * FROM patients WHERE deleted_at IS NULL').iterate()) {
      this.cache.set(r.id, this.entryFromRow(r));
    }
    this.refreshAllSummaries();
  }

  entryFromRow(r) {
    const profile = this.vault.decryptJson(r.data_enc);
    return {
      id: r.id,
      profile,
      fullName: displayName(profile),
      registeredOn: r.registered_on,
      portraitFileId: r.portrait_file_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      index: buildIndex(`${profile.firstName} ${profile.middleName || ''} ${profile.lastName}`),
      summary: { lastVisit: null, nextAppointment: null, balanceCents: 0, consent: null },
    };
  }

  emptySummary() { return { lastVisit: null, nextAppointment: null, balanceCents: 0, consent: null }; }

  refreshAllSummaries() {
    for (const e of this.cache.values()) e.summary = this.emptySummary();
    for (const r of this.db.prepare(`SELECT patient_id, MAX(visit_date) AS last, SUM(fee_cents - paid_cents) AS bal
      FROM ledger_entries WHERE deleted_at IS NULL GROUP BY patient_id`).iterate()) {
      const e = this.cache.get(r.patient_id);
      if (e) { e.summary.lastVisit = r.last; e.summary.balanceCents = r.bal; }
    }
    for (const r of this.db.prepare(`SELECT patient_id, id, date, time, reason_enc FROM appointments
      WHERE status = 'scheduled' AND deleted_at IS NULL ORDER BY date DESC, COALESCE(time, '99:99') DESC`).iterate()) {
      const e = this.cache.get(r.patient_id);
      if (e) e.summary.nextAppointment = this.apptSummary(r); // last write = earliest
    }
    for (const r of this.db.prepare('SELECT patient_id, version, recorded_at FROM consents ORDER BY id').iterate()) {
      const e = this.cache.get(r.patient_id);
      if (e) e.summary.consent = { version: r.version, recordedAt: r.recorded_at };
    }
  }

  apptSummary(r) {
    return { id: r.id, date: r.date, time: r.time, reason: r.reason_enc ? this.vault.decryptText(r.reason_enc) : '' };
  }

  refreshSummary(id) {
    const e = this.cache.get(id);
    if (!e) return;
    const s = this.emptySummary();
    const l = this.db.prepare(`SELECT MAX(visit_date) AS last, COALESCE(SUM(fee_cents - paid_cents), 0) AS bal
      FROM ledger_entries WHERE patient_id = ? AND deleted_at IS NULL`).get(id);
    s.lastVisit = l.last;
    s.balanceCents = l.bal;
    const a = this.db.prepare(`SELECT id, date, time, reason_enc FROM appointments WHERE patient_id = ? AND status = 'scheduled'
      AND deleted_at IS NULL ORDER BY date, COALESCE(time, '99:99') LIMIT 1`).get(id);
    if (a) s.nextAppointment = this.apptSummary(a);
    const c = this.db.prepare('SELECT version, recorded_at FROM consents WHERE patient_id = ? ORDER BY id DESC LIMIT 1').get(id);
    if (c) s.consent = { version: c.version, recordedAt: c.recorded_at };
    e.summary = s;
  }

  requireActive(id) {
    const e = this.cache.get(id);
    if (!e) throw notFound('Patient');
    return e;
  }

  // ---------------------------------------------------------------- validation
  validateProfile(input = {}) {
    const c = new Checker();
    const p = {
      lastName: str(input.lastName),
      firstName: str(input.firstName),
      middleName: str(input.middleName),
      dateOfBirth: str(input.dateOfBirth),
      sex: str(input.sex),
      address: str(input.address),
      contactNumber: str(input.contactNumber),
      allergies: str(input.allergies),
    };
    if (!p.lastName) c.fail('lastName', 'Last name is required.');
    if (!p.firstName) c.fail('firstName', 'First name is required.');
    for (const f of ['lastName', 'firstName', 'middleName']) if (p[f].length > 80) c.fail(f, 'Must be 80 characters or fewer.');
    const today = todayISO();
    if (!isValidISODate(p.dateOfBirth)) c.fail('dateOfBirth', 'Enter a valid date of birth.');
    else if (p.dateOfBirth > today) c.fail('dateOfBirth', 'Date of birth cannot be in the future.');
    else if (ageOn(p.dateOfBirth, today) > 130) c.fail('dateOfBirth', 'Please check the year of birth.');
    if (!SEXES.includes(p.sex)) c.fail('sex', 'Select the patient\'s sex.');
    if (!p.address) c.fail('address', 'Residential address is required.');
    else if (p.address.length > 300) c.fail('address', 'Must be 300 characters or fewer.');
    if (p.contactNumber && !/^[0-9+()\-\s.]{7,40}$/.test(p.contactNumber)) c.fail('contactNumber', 'Enter a valid contact number.');
    if (p.allergies.length > 300) c.fail('allergies', 'Must be 300 characters or fewer.');
    return { profile: p, checker: c };
  }

  validateRegistrationDate(value, c) {
    const d = str(value) || todayISO();
    if (!isValidISODate(d)) c.fail('registrationDate', 'Enter a valid registration date.');
    else if (d > todayISO()) c.fail('registrationDate', 'Registration date cannot be in the future.');
    return d;
  }

  decodePortrait(dataUrl, c) {
    if (!dataUrl) return null;
    const img = decodeDataUrl(dataUrl);
    if (!img) { c.fail('portrait', 'Portrait must be a JPEG, PNG or WebP image.'); return null; }
    const max = this.ctx.config.limits.portraitMaxBytes;
    if (img.buffer.length > max) {
      throw new HttpError(413, 'PORTRAIT_TOO_LARGE',
        `Portrait is ${Math.round(img.buffer.length / 1024)} KB. The limit is ${Math.round(max / 1024)} KB.`, { fields: { portrait: 'Portrait is larger than 500 KB.' } });
    }
    return img;
  }

  consentFrom(input) {
    const cfg = this.ctx.clinic.consent;
    return input && input.accepted === true && input.version === cfg.version ? cfg : null;
  }

  nextId(year) {
    const r = this.db.prepare('SELECT MAX(seq) AS m FROM patients WHERE year = ?').get(year);
    const seq = (r.m || 0) + 1;
    return { id: `PT-${year}-${String(seq).padStart(4, '0')}`, seq };
  }

  // ---------------------------------------------------------------- commands
  create(input, actor) {
    const { profile, checker: c } = this.validateProfile(input.profile);
    const registeredOn = this.validateRegistrationDate(input.registrationDate, c);
    const consent = this.consentFrom(input.consent);
    if (!consent) c.fail('consent', 'Verification required: confirm the patient\'s signed data privacy consent before saving.');
    const portrait = this.decodePortrait(input.portrait, c);
    if (!c.ok()) {
      const code = c.fields.consent && Object.keys(c.fields).length === 1 ? 'CONSENT_REQUIRED' : 'VALIDATION_FAILED';
      throw new ValidationError(c.fields, code === 'CONSENT_REQUIRED' ? c.fields.consent : undefined, code);
    }
    const now = Date.now();
    const year = new Date().getFullYear();
    const id = transaction(this.db, () => {
      const { id, seq } = this.nextId(year);
      let portraitFileId = null;
      if (portrait) portraitFileId = this.ctx.services.files.put({ patientId: id, kind: 'portrait', mime: portrait.mime, buffer: portrait.buffer, createdBy: actor.id });
      this.db.prepare(`INSERT INTO patients (id, year, seq, data_enc, portrait_file_id, registered_on, created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, year, seq, this.vault.encryptJson(profile), portraitFileId, registeredOn, now, actor.id, now, actor.id);
      this.db.prepare('INSERT INTO consents (patient_id, version, text_sha256, method, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, consent.version, consent.sha256, 'staff-verified-signed-form', actor.id, now);
      return id;
    });
    this.cache.set(id, this.entryFromRow(this.db.prepare('SELECT * FROM patients WHERE id = ?').get(id)));
    this.refreshSummary(id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'CREATE', entity: 'patient', entityId: id, patientId: id,
      details: { consentVersion: consent.version, portrait: !!portrait, ocrAssisted: !!input.ocrAssisted } });
    return this.detail(id);
  }

  update(id, input, actor) {
    const entry = this.requireActive(id);
    const { profile, checker: c } = this.validateProfile(input.profile);
    const registeredOn = this.validateRegistrationDate(input.registrationDate || entry.registeredOn, c);
    const currentVersion = this.ctx.clinic.consent.version;
    const hasCurrentConsent = entry.summary.consent && entry.summary.consent.version === currentVersion;
    const consent = this.consentFrom(input.consent);
    if (!hasCurrentConsent && !consent) c.fail('consent', `Consent version ${currentVersion} must be verified before saving.`);
    const portrait = this.decodePortrait(input.portrait, c);
    c.throwIfAny();
    const changed = Object.keys(profile).filter((k) => (entry.profile[k] || '') !== profile[k]);
    if (registeredOn !== entry.registeredOn) changed.push('registrationDate');
    const now = Date.now();
    transaction(this.db, () => {
      this.db.prepare('UPDATE patients SET data_enc = ?, registered_on = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(this.vault.encryptJson(profile), registeredOn, now, actor.id, id);
      if (consent && !hasCurrentConsent) {
        this.db.prepare('INSERT INTO consents (patient_id, version, text_sha256, method, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, consent.version, consent.sha256, 'staff-verified-signed-form', actor.id, now);
      }
      if (portrait) this.replacePortraitInTx(id, entry, portrait, actor);
    });
    this.cache.set(id, this.entryFromRow(this.db.prepare('SELECT * FROM patients WHERE id = ?').get(id)));
    this.refreshSummary(id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'UPDATE', entity: 'patient', entityId: id, patientId: id,
      details: { changedFields: changed, portraitReplaced: !!portrait, consentRecorded: !!(consent && !hasCurrentConsent) } });
    return this.detail(id);
  }

  replacePortraitInTx(id, entry, portrait, actor) {
    const files = this.ctx.services.files;
    if (entry.portraitFileId) files.softDelete(entry.portraitFileId, actor.id);
    const fileId = files.put({ patientId: id, kind: 'portrait', mime: portrait.mime, buffer: portrait.buffer, createdBy: actor.id });
    this.db.prepare('UPDATE patients SET portrait_file_id = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(fileId, Date.now(), actor.id, id);
  }

  setPortrait(id, dataUrl, actor) {
    const entry = this.requireActive(id);
    const c = new Checker();
    const portrait = this.decodePortrait(dataUrl, c);
    if (!portrait) c.fail('portrait', 'A portrait image is required.');
    c.throwIfAny();
    transaction(this.db, () => this.replacePortraitInTx(id, entry, portrait, actor));
    this.cache.set(id, this.entryFromRow(this.db.prepare('SELECT * FROM patients WHERE id = ?').get(id)));
    this.refreshSummary(id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'UPDATE', entity: 'portrait', entityId: id, patientId: id, details: { bytes: portrait.buffer.length } });
    return this.detail(id);
  }

  portrait(id) {
    const e = this.requireActive(id);
    if (!e.portraitFileId) throw notFound('Portrait');
    return this.ctx.services.files.get(e.portraitFileId);
  }

  softDelete(id, actor) {
    this.requireActive(id);
    this.db.prepare('UPDATE patients SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(Date.now(), actor.id, id);
    this.cache.delete(id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'DELETE', entity: 'patient', entityId: id, patientId: id, details: { soft: true } });
  }

  restore(id, actor) {
    const r = this.db.prepare('SELECT * FROM patients WHERE id = ? AND deleted_at IS NOT NULL').get(id);
    if (!r) throw notFound('Deleted patient');
    this.db.prepare('UPDATE patients SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(id);
    this.cache.set(id, this.entryFromRow({ ...r, deleted_at: null }));
    this.refreshSummary(id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'RESTORE', entity: 'patient', entityId: id, patientId: id });
  }

  // ---------------------------------------------------------------- queries
  detail(id) {
    const e = this.requireActive(id);
    const consent = this.db.prepare(`SELECT c.version, c.method, c.recorded_at, u.display_name FROM consents c
      LEFT JOIN users u ON u.id = c.recorded_by WHERE c.patient_id = ? ORDER BY c.id DESC LIMIT 1`).get(id);
    return {
      id: e.id,
      ...e.profile,
      fullName: e.fullName,
      age: ageOn(e.profile.dateOfBirth),
      registeredOn: e.registeredOn,
      hasPortrait: !!e.portraitFileId,
      portraitVersion: e.portraitFileId ? e.portraitFileId.slice(0, 8) : null,
      consent: consent ? {
        version: consent.version, method: consent.method, recordedAt: consent.recorded_at,
        recordedBy: consent.display_name || 'Unknown', current: consent.version === this.ctx.clinic.consent.version,
      } : null,
      lastVisit: e.summary.lastVisit,
      nextAppointment: e.summary.nextAppointment,
      balanceCents: e.summary.balanceCents,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  }

  listItem(e, s) {
    return {
      id: e.id,
      fullName: e.fullName,
      lastName: e.profile.lastName,
      firstName: e.profile.firstName,
      age: ageOn(e.profile.dateOfBirth),
      sex: e.profile.sex,
      contactNumber: e.profile.contactNumber,
      allergies: e.profile.allergies,
      registeredOn: e.registeredOn,
      hasPortrait: !!e.portraitFileId,
      portraitVersion: e.portraitFileId ? e.portraitFileId.slice(0, 8) : null,
      lastVisit: e.summary.lastVisit,
      nextAppointment: e.summary.nextAppointment,
      balanceCents: e.summary.balanceCents,
      consentOnFile: !!e.summary.consent,
      score: s,
    };
  }

  search({ q = '', sort = '', dir = '', filter = 'all', limit = 50, offset = 0 } = {}) {
    const t0 = performance.now();
    const query = str(q).slice(0, 80);
    const today = todayISO();
    const idMode = /^(pt[-\s]?)?\d[\d-]*$/i.test(query);
    const idNeedle = query.toUpperCase().replace(/^PT[-\s]?/, '').replace(/\s/g, '');
    const hits = [];
    for (const e of this.cache.values()) {
      if (filter === 'balance' && !(e.summary.balanceCents > 0)) continue;
      if (filter === 'followup' && !(e.summary.nextAppointment && e.summary.nextAppointment.date <= today)) continue;
      if (filter === 'alerts' && !e.profile.allergies) continue;
      let s = 0;
      if (query) {
        if (idMode) {
          const bare = e.id.slice(3);
          if (!bare.includes(idNeedle) && !bare.replace(/-/g, '').includes(idNeedle.replace(/-/g, ''))) continue;
          s = bare === idNeedle ? 0 : 0.05;
        } else {
          s = score(query, e.index);
          if (s === null) continue;
        }
      }
      hits.push({ e, s });
    }
    const sortKey = sort || (query ? 'relevance' : 'name');
    const desc = dir ? dir === 'desc' : ['lastVisit', 'balance', 'registered'].includes(sortKey);
    const byName = (a, b) => collator.compare(a.e.profile.lastName, b.e.profile.lastName)
      || collator.compare(a.e.profile.firstName, b.e.profile.firstName) || (a.e.id < b.e.id ? -1 : 1);
    const nullsLast = (va, vb, a, b) => {
      if (va == null && vb == null) return byName(a, b);
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return (desc ? -c : c) || byName(a, b);
    };
    const cmp = {
      relevance: (a, b) => a.s - b.s || byName(a, b),
      name: (a, b) => (desc ? -1 : 1) * byName(a, b),
      id: (a, b) => (desc ? -1 : 1) * (a.e.id < b.e.id ? -1 : 1),
      lastVisit: (a, b) => nullsLast(a.e.summary.lastVisit, b.e.summary.lastVisit, a, b),
      nextAppointment: (a, b) => nullsLast(
        a.e.summary.nextAppointment && `${a.e.summary.nextAppointment.date} ${a.e.summary.nextAppointment.time || '99:99'}`,
        b.e.summary.nextAppointment && `${b.e.summary.nextAppointment.date} ${b.e.summary.nextAppointment.time || '99:99'}`, a, b),
      balance: (a, b) => nullsLast(a.e.summary.balanceCents, b.e.summary.balanceCents, a, b),
      registered: (a, b) => nullsLast(a.e.registeredOn, b.e.registeredOn, a, b),
    }[sortKey] || ((a, b) => byName(a, b));
    hits.sort(cmp);
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    return {
      items: hits.slice(off, off + lim).map((h) => this.listItem(h.e, h.s)),
      total: hits.length,
      totalPatients: this.cache.size,
      sort: sortKey,
      dir: desc ? 'desc' : 'asc',
      tookMs: Math.round((performance.now() - t0) * 10) / 10,
    };
  }

  /** Lightweight name lookup used by other services (dashboard, trash). */
  nameOf(id) {
    const e = this.cache.get(id);
    return e ? e.fullName : null;
  }
}

module.exports = { PatientService, displayName, parsePatientId, SEXES };
