'use strict';
// NFR-S2: deleted marks and records are soft-deleted and recoverable for at
// least 30 days, then purged.
const { HttpError } = require('../lib/errors');
const { displayName } = require('./patients');

const DAY = 24 * 60 * 60 * 1000;

class TrashService {
  constructor(ctx) {
    this.ctx = ctx;
    this.db = ctx.db;
    this.vault = ctx.vault;
  }

  get retentionMs() { return this.ctx.config.trashRetentionDays * DAY; }

  patientName(id) {
    const live = this.ctx.services.patients.nameOf(id);
    if (live) return live;
    const r = this.db.prepare('SELECT data_enc FROM patients WHERE id = ?').get(id);
    return r ? displayName(this.vault.decryptJson(r.data_enc)) : id;
  }

  list() {
    const names = this.ctx.services.auth.userNames();
    const items = [];
    const push = (type, r, summary) => items.push({
      type, id: r.id, patientId: r.patient_id || r.id, patientName: this.patientName(r.patient_id || r.id), summary,
      deletedAt: r.deleted_at, deletedBy: (names.get(r.deleted_by) || {}).display_name || null,
      purgeOn: r.deleted_at + this.retentionMs,
    });
    for (const r of this.db.prepare('SELECT id, registered_on, deleted_at, deleted_by FROM patients WHERE deleted_at IS NOT NULL').all()) {
      push('patient', r, `Patient record (registered ${r.registered_on})`);
    }
    for (const r of this.db.prepare('SELECT * FROM ledger_entries WHERE deleted_at IS NOT NULL').all()) {
      const reason = r.delete_reason_enc ? this.vault.decryptText(r.delete_reason_enc) : '';
      push('ledger', r, `${r.visit_date} · ${this.vault.decryptText(r.procedure_enc)} · fee ${r.fee_cents / 100} / paid ${r.paid_cents / 100}${reason ? ' · reason: ' + reason : ''}`);
    }
    for (const r of this.db.prepare('SELECT * FROM appointments WHERE deleted_at IS NOT NULL').all()) {
      push('appointment', r, `Appointment ${r.date}${r.time ? ' ' + r.time : ''}`);
    }
    for (const r of this.db.prepare('SELECT * FROM chart_photos WHERE deleted_at IS NOT NULL').all()) {
      push('photo', r, `Chart photo (${r.view}, ${r.taken_on})`);
    }
    for (const r of this.db.prepare('SELECT * FROM chart_marks WHERE deleted_at IS NOT NULL').all()) {
      push('mark', r, `Tooth ${r.tooth}${r.surfaces ? ' (' + r.surfaces.replace(/,/g, '') + ')' : ''} · ${r.condition}`);
    }
    return items.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  restore(type, id, actor) {
    const s = this.ctx.services;
    switch (type) {
      case 'patient': return s.patients.restore(id, actor);
      case 'ledger': return s.ledger.restore(id, actor);
      case 'appointment': return s.appointments.restore(id, actor);
      case 'photo': return s.chart.restorePhoto(id, actor);
      case 'mark': return s.chart.restoreMark(id, actor);
      default: throw new HttpError(400, 'BAD_TYPE', 'Unknown record type.');
    }
  }

  /** Permanently remove rows deleted longer ago than the retention window. */
  purgeExpired(now = Date.now()) {
    const cutoff = now - this.retentionMs;
    const counts = {};
    // Purge the encrypted image of each expired chart photo together with the photo row.
    counts.photoFiles = Number(this.db.prepare(`DELETE FROM files WHERE id IN
      (SELECT file_id FROM chart_photos WHERE deleted_at IS NOT NULL AND deleted_at < ?)`).run(cutoff).changes);
    for (const table of ['chart_marks', 'chart_photos', 'appointments', 'ledger_entries']) {
      counts[table] = Number(this.db.prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`).run(cutoff).changes);
    }
    const expiredPatients = this.db.prepare('SELECT id FROM patients WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff);
    for (const { id } of expiredPatients) {
      this.db.prepare('DELETE FROM files WHERE patient_id = ?').run(id);
      this.db.prepare('DELETE FROM patients WHERE id = ?').run(id);
    }
    counts.patients = expiredPatients.length;
    counts.files = Number(this.db.prepare('DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoff).changes);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total) this.ctx.audit.append({ action: 'PURGE', entity: 'trash', details: { ...counts, retentionDays: this.ctx.config.trashRetentionDays } });
    return counts;
  }
}

module.exports = { TrashService };
