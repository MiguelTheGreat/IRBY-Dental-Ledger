'use strict';
// FR-6 internal staff dashboard: today's appointments and the "Due for Follow-Up" list.
const { todayISO, addDays } = require('../lib/dates');

class DashboardService {
  constructor(ctx) {
    this.ctx = ctx;
    this.db = ctx.db;
    this.vault = ctx.vault;
  }

  build({ now = new Date(), horizonDays = 7 } = {}) {
    const today = todayISO(now);
    const horizon = addDays(today, horizonDays);
    const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const patients = this.ctx.services.patients;

    const rows = this.db.prepare(`SELECT id, patient_id, date, time, reason_enc, status FROM appointments
      WHERE deleted_at IS NULL AND ((status = 'scheduled' AND date <= ?) OR (date = ? AND status <> 'cancelled'))
      ORDER BY date, COALESCE(time, '99:99')`).all(horizon, today);

    const followUps = [];
    let todayTotal = 0, todayCompleted = 0, overdue = 0, dueToday = 0, upcoming = 0;
    let nextSlot = null;
    for (const r of rows) {
      const e = patients.cache.get(r.patient_id);
      if (!e) continue; // patient soft-deleted
      if (r.date === today) {
        todayTotal++;
        if (r.status === 'completed') todayCompleted++;
      }
      if (r.status !== 'scheduled') continue;
      const status = r.date < today ? 'overdue' : r.date === today ? 'today' : 'upcoming';
      if (status === 'overdue') overdue++; else if (status === 'today') dueToday++; else upcoming++;
      const item = {
        appointmentId: r.id, patientId: e.id, patientName: e.fullName, hasPortrait: !!e.portraitFileId,
        portraitVersion: e.portraitFileId ? e.portraitFileId.slice(0, 8) : null,
        contactNumber: e.profile.contactNumber, allergies: e.profile.allergies, balanceCents: e.summary.balanceCents,
        date: r.date, time: r.time, reason: r.reason_enc ? this.vault.decryptText(r.reason_enc) : '', status,
      };
      followUps.push(item);
      if (!nextSlot && r.date >= today && (r.date > today || !r.time || r.time >= nowHM)) nextSlot = item;
    }

    let outstandingCents = 0, withBalance = 0;
    for (const e of patients.cache.values()) {
      if (e.summary.balanceCents > 0) { outstandingCents += e.summary.balanceCents; withBalance++; }
    }

    return {
      today,
      horizon,
      stats: { todayTotal, todayCompleted, overdue, dueToday, upcoming, patients: patients.cache.size, outstandingCents, withBalance },
      nextSlot,
      followUps,
    };
  }
}

module.exports = { DashboardService };
