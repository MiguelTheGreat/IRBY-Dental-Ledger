'use strict';
// FR-5 treatment & financial ledger, FR-6 next return date at checkout,
// NFR-S4 financial guardrails + audit on every edit.
const { transaction, nn } = require('../db');
const { uuid } = require('../lib/crypto');
const { HttpError, Checker, notFound, str } = require('../lib/errors');
const { parseAmount, evaluateEntry, withRunningBalance, totals, formatPeso } = require('../lib/money');
const { todayISO, isValidISODate, ageOn } = require('../lib/dates');

class LedgerService {
  constructor(ctx) {
    this.ctx = ctx;
    this.db = ctx.db;
    this.vault = ctx.vault;
  }

  mapRow(r, names) {
    const created = names.get(r.created_by);
    const updated = names.get(r.updated_by);
    return {
      id: r.id,
      patientId: r.patient_id,
      visitDate: r.visit_date,
      ageAtVisit: r.age_at_visit,
      procedure: this.vault.decryptText(r.procedure_enc),
      feeCents: r.fee_cents,
      paidCents: r.paid_cents,
      overpaymentAck: !!r.overpayment_ack,
      createdAt: r.created_at,
      createdBy: created ? created.display_name : null,
      updatedAt: r.updated_at,
      updatedBy: updated ? updated.display_name : null,
      edited: r.updated_at !== r.created_at,
    };
  }

  list(patientId) {
    this.ctx.services.patients.requireActive(patientId);
    const names = this.ctx.services.auth.userNames();
    const rows = this.db.prepare('SELECT * FROM ledger_entries WHERE patient_id = ? AND deleted_at IS NULL').all(patientId);
    const entries = withRunningBalance(rows.map((r) => this.mapRow(r, names))).reverse(); // newest first
    return { entries, totals: totals(entries) };
  }

  getRow(id, { includeDeleted = false } = {}) {
    const r = this.db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(id);
    if (!r || (r.deleted_at && !includeDeleted)) throw notFound('Ledger entry');
    return r;
  }

  outstanding(patientId, excludeId = null) {
    return this.db.prepare(`SELECT COALESCE(SUM(fee_cents - paid_cents), 0) AS bal FROM ledger_entries
      WHERE patient_id = ? AND deleted_at IS NULL AND id IS NOT ?`).get(patientId, excludeId).bal;
  }

  validate(input, patient, outstandingBeforeCents) {
    const c = new Checker();
    const visitDate = str(input.visitDate);
    if (!isValidISODate(visitDate)) c.fail('visitDate', 'Enter a valid visit date.');
    else if (visitDate > todayISO()) c.fail('visitDate', 'Visit date cannot be in the future.');
    else if (visitDate < patient.profile.dateOfBirth) c.fail('visitDate', 'Visit date is before the patient\'s date of birth.');
    const procedure = str(input.procedure);
    if (!procedure) c.fail('procedure', 'Describe the procedure performed (or "Payment on account").');
    else if (procedure.length > 200) c.fail('procedure', 'Must be 200 characters or fewer.');
    const fee = parseAmount(input.fee);
    if (!fee.ok) c.fail('fee', fee.message);
    const paid = parseAmount(input.paid === '' || input.paid == null ? '0' : input.paid);
    if (!paid.ok) c.fail('paid', paid.message);
    c.throwIfAny();
    const evaluation = evaluateEntry({ feeCents: fee.cents, paidCents: paid.cents, outstandingBeforeCents });
    if (evaluation.flags.includes('OVERPAYMENT') && input.acknowledgeOverpayment !== true) {
      const credit = -evaluation.balanceAfterCents;
      throw new HttpError(422, 'OVERPAYMENT_FLAGGED',
        `Payment exceeds the fee and the outstanding balance by ${formatPeso(credit)}. Confirm to record it as patient credit.`,
        { evaluation, fields: { paid: `Exceeds amount due by ${formatPeso(credit)}.` } });
    }
    return {
      visitDate,
      procedure,
      feeCents: fee.cents,
      paidCents: paid.cents,
      ageAtVisit: ageOn(patient.profile.dateOfBirth, visitDate),
      overpaymentAck: evaluation.flags.includes('OVERPAYMENT') ? 1 : 0,
      evaluation,
    };
  }

  create(patientId, input, actor) {
    const patient = this.ctx.services.patients.requireActive(patientId);
    const v = this.validate(input, patient, this.outstanding(patientId));
    const appts = this.ctx.services.appointments;
    let nextReturn = null;
    if (input.nextReturn && str(input.nextReturn.date)) {
      nextReturn = appts.validate(input.nextReturn, { notBefore: v.visitDate });
    }
    const id = uuid();
    const now = Date.now();
    let appointment = null;
    let completed = [];
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO ledger_entries (id, patient_id, visit_date, age_at_visit, procedure_enc, fee_cents, paid_cents,
        overpayment_ack, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, patientId, v.visitDate, nn(v.ageAtVisit), this.vault.encryptText(v.procedure), v.feeCents, v.paidCents,
          v.overpaymentAck, now, actor.id, now, actor.id);
      if (input.completeFollowUps) completed = appts.completeDueInTx(patientId, v.visitDate, actor);
      if (nextReturn) appointment = appts.insertInTx(patientId, nextReturn, actor, id);
    });
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'CREATE', entity: 'ledger_entry', entityId: id, patientId,
      details: { visitDate: v.visitDate, feeCents: v.feeCents, paidCents: v.paidCents, entryBalanceCents: v.evaluation.entryBalanceCents,
        balanceAfterCents: v.evaluation.balanceAfterCents, flags: v.evaluation.flags, nextReturn: nextReturn ? nextReturn.date : null,
        completedFollowUps: completed.length } });
    if (appointment) {
      this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'CREATE', entity: 'appointment', entityId: appointment.id, patientId,
        details: { date: appointment.date, time: appointment.time, sourceEntryId: id } });
    }
    for (const apptId of completed) {
      this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'UPDATE', entity: 'appointment', entityId: apptId, patientId,
        details: { status: 'completed', byLedgerEntry: id } });
    }
    this.ctx.services.patients.refreshSummary(patientId);
    return { entryId: id, evaluation: v.evaluation, appointment, completedFollowUps: completed.length, ...this.list(patientId) };
  }

  update(entryId, input, actor) {
    const before = this.getRow(entryId);
    const patient = this.ctx.services.patients.requireActive(before.patient_id);
    const v = this.validate(input, patient, this.outstanding(before.patient_id, entryId));
    const now = Date.now();
    this.db.prepare(`UPDATE ledger_entries SET visit_date = ?, age_at_visit = ?, procedure_enc = ?, fee_cents = ?, paid_cents = ?,
      overpayment_ack = ?, updated_at = ?, updated_by = ? WHERE id = ?`)
      .run(v.visitDate, nn(v.ageAtVisit), this.vault.encryptText(v.procedure), v.feeCents, v.paidCents, v.overpaymentAck, now, actor.id, entryId);
    const prev = { visitDate: before.visit_date, procedure: this.vault.decryptText(before.procedure_enc), feeCents: before.fee_cents, paidCents: before.paid_cents };
    const next = { visitDate: v.visitDate, procedure: v.procedure, feeCents: v.feeCents, paidCents: v.paidCents };
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'UPDATE', entity: 'ledger_entry', entityId: entryId, patientId: before.patient_id,
      details: { before: prev, after: next, flags: v.evaluation.flags } });
    this.ctx.services.patients.refreshSummary(before.patient_id);
    return { entryId, evaluation: v.evaluation, ...this.list(before.patient_id) };
  }

  void(entryId, reason, actor) {
    const r = this.getRow(entryId);
    const why = str(reason);
    if (!why) throw new HttpError(422, 'VALIDATION_FAILED', 'A reason is required to void a financial entry.', { fields: { reason: 'Required.' } });
    this.db.prepare('UPDATE ledger_entries SET deleted_at = ?, deleted_by = ?, delete_reason_enc = ? WHERE id = ?')
      .run(Date.now(), actor.id, this.vault.encryptText(why.slice(0, 200)), entryId);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'DELETE', entity: 'ledger_entry', entityId: entryId, patientId: r.patient_id,
      details: { soft: true, reason: why.slice(0, 200), feeCents: r.fee_cents, paidCents: r.paid_cents, visitDate: r.visit_date } });
    this.ctx.services.patients.refreshSummary(r.patient_id);
    return this.list(r.patient_id);
  }

  restore(entryId, actor) {
    const r = this.getRow(entryId, { includeDeleted: true });
    this.db.prepare('UPDATE ledger_entries SET deleted_at = NULL, deleted_by = NULL, delete_reason_enc = NULL WHERE id = ?').run(entryId);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'RESTORE', entity: 'ledger_entry', entityId: entryId, patientId: r.patient_id });
    this.ctx.services.patients.refreshSummary(r.patient_id);
  }
}

module.exports = { LedgerService };
