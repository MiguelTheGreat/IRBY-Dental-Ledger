'use strict';
// FR-6: next return dates and internal follow-up reminders (no patient SMS).
const { nn } = require('../db');
const { uuid } = require('../lib/crypto');
const { Checker, notFound, str } = require('../lib/errors');
const { todayISO, isValidISODate, isValidTime } = require('../lib/dates');

const STATUSES = ['scheduled', 'completed', 'cancelled'];

class AppointmentService {
  constructor(ctx) {
    this.ctx = ctx;
    this.db = ctx.db;
    this.vault = ctx.vault;
  }

  validate(input, { notBefore = todayISO(), requireDate = true } = {}) {
    const c = new Checker();
    const date = str(input.date);
    const time = str(input.time);
    const reason = str(input.reason);
    if (requireDate || date) {
      if (!isValidISODate(date)) c.fail('date', 'Enter a valid return date.');
      else if (date < notBefore) c.fail('date', 'Return date cannot be earlier than ' + notBefore + '.');
    }
    if (time && !isValidTime(time)) c.fail('time', 'Use a 24-hour time such as 14:30.');
    if (reason.length > 200) c.fail('reason', 'Must be 200 characters or fewer.');
    c.throwIfAny();
    return { date, time: time || null, reason };
  }

  map(r) {
    return {
      id: r.id, patientId: r.patient_id, date: r.date, time: r.time,
      reason: r.reason_enc ? this.vault.decryptText(r.reason_enc) : '', status: r.status,
      sourceEntryId: r.source_entry_id, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  get(id, { includeDeleted = false } = {}) {
    const r = this.db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    if (!r || (r.deleted_at && !includeDeleted)) throw notFound('Appointment');
    return r;
  }

  insertInTx(patientId, v, actor, sourceEntryId = null) {
    const id = uuid();
    const now = Date.now();
    this.db.prepare(`INSERT INTO appointments (id, patient_id, date, time, reason_enc, status, source_entry_id, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`)
      .run(id, patientId, v.date, nn(v.time), v.reason ? this.vault.encryptText(v.reason) : null, nn(sourceEntryId), now, actor.id, now, actor.id);
    return { id, patientId, date: v.date, time: v.time, reason: v.reason, status: 'scheduled' };
  }

  /** Marks scheduled follow-ups on or before a visit date as completed; returns their ids. */
  completeDueInTx(patientId, visitDate, actor) {
    const ids = this.db.prepare(`SELECT id FROM appointments WHERE patient_id = ? AND status = 'scheduled' AND date <= ? AND deleted_at IS NULL`)
      .all(patientId, visitDate).map((r) => r.id);
    const stmt = this.db.prepare(`UPDATE appointments SET status = 'completed', updated_at = ?, updated_by = ? WHERE id = ?`);
    for (const id of ids) stmt.run(Date.now(), actor.id, id);
    return ids;
  }

  create(patientId, input, actor) {
    this.ctx.services.patients.requireActive(patientId);
    const v = this.validate(input);
    const appt = this.insertInTx(patientId, v, actor);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'CREATE', entity: 'appointment', entityId: appt.id, patientId, details: { date: v.date, time: v.time } });
    this.ctx.services.patients.refreshSummary(patientId);
    return appt;
  }

  update(id, input, actor) {
    const r = this.get(id);
    this.ctx.services.patients.requireActive(r.patient_id);
    const status = input.status !== undefined ? str(input.status) : r.status;
    const c = new Checker();
    if (!STATUSES.includes(status)) c.fail('status', 'Unknown status.');
    c.throwIfAny();
    const dateChanged = input.date !== undefined && str(input.date) !== r.date;
    const v = this.validate({
      date: input.date !== undefined ? input.date : r.date,
      time: input.time !== undefined ? input.time : r.time,
      reason: input.reason !== undefined ? input.reason : (r.reason_enc ? this.vault.decryptText(r.reason_enc) : ''),
    }, { notBefore: dateChanged ? todayISO() : '0000-00-00' });
    this.db.prepare('UPDATE appointments SET date = ?, time = ?, reason_enc = ?, status = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(v.date, nn(v.time), v.reason ? this.vault.encryptText(v.reason) : null, status, Date.now(), actor.id, id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'UPDATE', entity: 'appointment', entityId: id, patientId: r.patient_id,
      details: { before: { date: r.date, time: r.time, status: r.status }, after: { date: v.date, time: v.time, status } } });
    this.ctx.services.patients.refreshSummary(r.patient_id);
    return this.map(this.get(id));
  }

  softDelete(id, actor) {
    const r = this.get(id);
    this.db.prepare('UPDATE appointments SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(Date.now(), actor.id, id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'DELETE', entity: 'appointment', entityId: id, patientId: r.patient_id, details: { soft: true } });
    this.ctx.services.patients.refreshSummary(r.patient_id);
  }

  restore(id, actor) {
    const r = this.get(id, { includeDeleted: true });
    this.db.prepare('UPDATE appointments SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'RESTORE', entity: 'appointment', entityId: id, patientId: r.patient_id });
    this.ctx.services.patients.refreshSummary(r.patient_id);
  }

  listForPatient(patientId) {
    this.ctx.services.patients.requireActive(patientId);
    return this.db.prepare(`SELECT * FROM appointments WHERE patient_id = ? AND deleted_at IS NULL
      ORDER BY CASE status WHEN 'scheduled' THEN 0 ELSE 1 END, date DESC LIMIT 50`).all(patientId).map((r) => this.map(r));
  }
}

module.exports = { AppointmentService, STATUSES };
