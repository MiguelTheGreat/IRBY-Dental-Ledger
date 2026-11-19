'use strict';
// FR-5 treatment & financial ledger, NFR-S4 financial guardrails, FR-6 next return dates, follow-ups and dashboard.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ageOn } = require('../server/lib/dates');
const { startEnv, buildApp, setupStaff, patientBody, actorFrom, todayISO, daysAgo, daysAhead } = require('./helpers');

describe('API: treatment & financial ledger (FR-5, NFR-S4)', () => {
  let env, staff, patient, firstEntryId;
  const desk = () => staff.frontdesk.cookie;
  const post = (body, id = patient.id) => env.api.post(`/api/patients/${id}/ledger`, { cookie: desk(), body });
  const entry = (over = {}) => ({ visitDate: daysAgo(10), procedure: 'Composite restoration #16 (MO)', fee: 2000, paid: 500, ...over });

  before(async () => {
    env = await startEnv();
    staff = await setupStaff(env);
    patient = (await env.api.post('/api/patients', { cookie: desk(), body: patientBody() })).body;
  });
  after(() => env.close());

  it('FR-5: fee 2000 - paid 500 = 1500 balance', async () => {
    const r = await post(entry());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    firstEntryId = r.body.entryId;
    assert.deepEqual(r.body.totals, { feeCents: 200000, paidCents: 50000, balanceCents: 150000 });
    assert.deepEqual(r.body.evaluation, { entryBalanceCents: 150000, balanceAfterCents: 150000, flags: [] });
    const [e] = r.body.entries;
    assert.equal(e.id, firstEntryId);
    assert.equal(e.procedure, 'Composite restoration #16 (MO)');
    assert.equal(e.entryBalanceCents, 150000);
    assert.equal(e.runningBalanceCents, 150000);
    assert.equal(e.ageAtVisit, ageOn('1992-04-12', daysAgo(10)));
    assert.equal(e.createdBy, 'Maria Santos');
    assert.equal(e.edited, false);
    assert.equal(e.overpaymentAck, false);
    assert.equal(r.body.appointment, null);
    const detail = await env.api.get(`/api/patients/${patient.id}`, { cookie: desk() });
    assert.equal(detail.body.balanceCents, 150000);
    assert.equal(detail.body.lastVisit, daysAgo(10));
  });

  it('NFR-SEC: procedure text is encrypted at rest; amounts are integer centavos', () => {
    const row = env.ctx.db.prepare('SELECT procedure_enc, fee_cents, paid_cents FROM ledger_entries WHERE id = ?').get(firstEntryId);
    assert.match(row.procedure_enc, /^v1:/);
    assert.ok(!row.procedure_enc.includes('Composite'));
    assert.equal(row.fee_cents, 200000);
    assert.equal(row.paid_cents, 50000);
  });

  it('FR-5: accepts peso-formatted strings; a blank payment counts as zero', async () => {
    const r = await post(entry({ visitDate: daysAgo(5), procedure: 'Periapical X-ray', fee: '₱1,200.50', paid: '' }));
    assert.equal(r.status, 201);
    assert.equal(r.body.evaluation.entryBalanceCents, 120050);
    assert.equal(r.body.totals.balanceCents, 270050);
    const newest = r.body.entries[0];
    assert.equal(newest.paidCents, 0);
    assert.equal(newest.runningBalanceCents, 270050); // running balance is chronological
  });

  it('NFR-S4: negative or non-numeric amounts are rejected with 422', async () => {
    const neg = await post(entry({ fee: -2000 }));
    assert.equal(neg.status, 422);
    assert.equal(neg.body.error, 'VALIDATION_FAILED');
    assert.match(neg.body.fields.fee, /negative/);
    const text = await post(entry({ paid: 'five hundred' }));
    assert.equal(text.status, 422);
    assert.ok(text.body.fields.paid);
    const negPaid = await post(entry({ paid: '-1' }));
    assert.match(negPaid.body.fields.paid, /negative/);
    const decimals = await post(entry({ fee: '19.999' }));
    assert.match(decimals.body.fields.fee, /2 decimal/);
    const missing = await post(entry({ fee: undefined }));
    assert.match(missing.body.fields.fee, /required/i);
  });

  it('FR-5: visit date and procedure are validated', async () => {
    const r = await post({ visitDate: daysAhead(1), procedure: '', fee: 100, paid: 0 });
    assert.equal(r.status, 422);
    assert.match(r.body.fields.visitDate, /future/);
    assert.ok(r.body.fields.procedure);
    assert.match((await post(entry({ visitDate: '1991-01-01' }))).body.fields.visitDate, /before the patient's date of birth/);
    assert.match((await post(entry({ visitDate: 'yesterday' }))).body.fields.visitDate, /valid/);
    assert.match((await post(entry({ procedure: 'x'.repeat(201) }))).body.fields.procedure, /200/);
    assert.equal((await post(entry(), 'PT-1999-0001')).status, 404);
    assert.equal(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get().n, 2);
  });

  it('NFR-S4: paying an old balance is allowed (no overpayment)', async () => {
    const r = await post(entry({ visitDate: daysAgo(1), procedure: 'Payment on account', fee: 0, paid: 700.5 }));
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.evaluation.flags, ['PAYMENT_EXCEEDS_FEE']);
    assert.equal(r.body.totals.balanceCents, 200000);
  });

  it('NFR-S4: payment beyond fee + outstanding -> 422 OVERPAYMENT_FLAGGED', async () => {
    const r = await post(entry({ visitDate: todayISO(), procedure: 'Payment on account', fee: 0, paid: 2100 }));
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'OVERPAYMENT_FLAGGED');
    assert.match(r.body.message, /₱100\.00/);
    assert.match(r.body.fields.paid, /₱100\.00/);
    assert.equal(r.body.evaluation.balanceAfterCents, -10000);
    assert.deepEqual(r.body.evaluation.flags, ['PAYMENT_EXCEEDS_FEE', 'OVERPAYMENT']);
    const notTrue = await post(entry({ visitDate: todayISO(), fee: 0, paid: 2100, acknowledgeOverpayment: 'yes' }));
    assert.equal(notTrue.status, 422, 'acknowledgement must be literally true');
  });

  it('NFR-S4: an acknowledged overpayment is recorded as patient credit', async () => {
    const r = await post(entry({ visitDate: todayISO(), procedure: 'Payment on account', fee: 0, paid: 2100, acknowledgeOverpayment: true }));
    assert.equal(r.status, 201);
    assert.equal(r.body.totals.balanceCents, -10000);
    assert.equal(r.body.entries[0].overpaymentAck, true);
    const [audit] = env.ctx.audit.list({ action: 'CREATE', patientId: patient.id }).filter((e) => e.entity === 'ledger_entry');
    assert.deepEqual(audit.details.flags, ['PAYMENT_EXCEEDS_FEE', 'OVERPAYMENT']);
    assert.equal(audit.details.balanceAfterCents, -10000);
    const balance = await env.api.get('/api/patients?filter=balance', { cookie: desk() });
    assert.equal(balance.body.total, 0, 'a credit is not an outstanding balance');
  });

  it('FR-5 / NFR-S4: editing an entry is audited with before and after values', async () => {
    const r = await env.api.put(`/api/ledger/${firstEntryId}`, { cookie: staff.dentist.cookie, body: entry({ fee: 2500, paid: 500, procedure: 'Composite restoration #16 (MOD)' }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.entryId, firstEntryId);
    assert.equal(r.body.totals.balanceCents, 40000);
    const edited = r.body.entries.find((e) => e.id === firstEntryId);
    assert.equal(edited.edited, true);
    assert.equal(edited.updatedBy, 'Dr. Ana Reyes');
    const [upd] = env.ctx.audit.list({ action: 'UPDATE', patientId: patient.id }).filter((e) => e.entity === 'ledger_entry');
    assert.equal(upd.entityId, firstEntryId);
    assert.equal(upd.username, 'dr.reyes');
    assert.deepEqual(upd.details.before, { visitDate: daysAgo(10), procedure: 'Composite restoration #16 (MO)', feeCents: 200000, paidCents: 50000 });
    assert.deepEqual(upd.details.after, { visitDate: daysAgo(10), procedure: 'Composite restoration #16 (MOD)', feeCents: 250000, paidCents: 50000 });
  });

  it('NFR-S4: edits are validated and overpayment-checked too', async () => {
    const bad = await env.api.put(`/api/ledger/${firstEntryId}`, { cookie: desk(), body: entry({ fee: 'abc' }) });
    assert.equal(bad.status, 422);
    const over = await env.api.put(`/api/ledger/${firstEntryId}`, { cookie: desk(), body: entry({ fee: 0, paid: 5000 }) });
    assert.equal(over.status, 422);
    assert.equal(over.body.error, 'OVERPAYMENT_FLAGGED');
    assert.equal((await env.api.put('/api/ledger/no-such-entry', { cookie: desk(), body: entry() })).status, 404);
    assert.equal((await env.api.put(`/api/ledger/${firstEntryId}`, { cookie: desk() })).status, 422);
  });

  it('FR-5: the ledger lists newest first with running balances (audited read)', async () => {
    const r = await env.api.get(`/api/patients/${patient.id}/ledger`, { cookie: desk() });
    assert.equal(r.status, 200);
    assert.equal(r.body.entries.length, 4);
    const dates = r.body.entries.map((e) => e.visitDate);
    assert.deepEqual(dates, [...dates].sort().reverse());
    assert.equal(r.body.entries[0].runningBalanceCents, r.body.totals.balanceCents);
    assert.ok(env.ctx.audit.list({ action: 'READ', patientId: patient.id }).some((e) => e.entity === 'ledger' && e.details.entries === 4));
    assert.equal((await env.api.get('/api/patients/PT-1999-0001/ledger', { cookie: desk() })).status, 404);
  });

  it('NFR-S4: voiding an entry needs a reason and is recoverable from the trash', async () => {
    const noReason = await env.api.del(`/api/ledger/${firstEntryId}`, { cookie: desk(), body: {} });
    assert.equal(noReason.status, 422);
    assert.ok(noReason.body.fields.reason);
    assert.equal((await env.api.del(`/api/ledger/${firstEntryId}`, { cookie: desk() })).status, 422);
    const r = await env.api.del(`/api/ledger/${firstEntryId}`, { cookie: desk(), body: { reason: '  Entered on the wrong patient  ' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.entries.length, 3);
    assert.equal(r.body.totals.balanceCents, 120050 - 70050 - 210000); // remaining entries only
    const [del] = env.ctx.audit.list({ action: 'DELETE', patientId: patient.id });
    assert.equal(del.details.reason, 'Entered on the wrong patient');
    assert.equal(del.details.soft, true);
    assert.equal(del.details.feeCents, 250000);
    assert.equal((await env.api.del(`/api/ledger/${firstEntryId}`, { cookie: desk(), body: { reason: 'again' } })).status, 404);

    const trash = await env.api.get('/api/trash', { cookie: staff.dentist.cookie });
    const item = trash.body.items.find((i) => i.type === 'ledger' && i.id === firstEntryId);
    assert.equal(item.patientId, patient.id);
    assert.match(item.summary, /Composite restoration #16 \(MOD\) · fee 2500 \/ paid 500 · reason: Entered on the wrong patient/);
    assert.equal((await env.api.post(`/api/trash/ledger/${firstEntryId}/restore`, { cookie: staff.dentist.cookie })).status, 200);
    const back = await env.api.get(`/api/patients/${patient.id}/ledger`, { cookie: desk() });
    assert.equal(back.body.entries.length, 4);
    assert.equal(back.body.totals.balanceCents, 40000);
    assert.equal((await env.api.post('/api/trash/ledger/nope/restore', { cookie: staff.dentist.cookie })).status, 404);
  });
});

describe('API: next return dates and appointments (FR-6)', () => {
  let env, staff, patient, other, apptId;
  const desk = () => staff.frontdesk.cookie;
  const appts = async (id = patient.id) => (await env.api.get(`/api/patients/${id}/appointments`, { cookie: desk() })).body.appointments;

  before(async () => {
    env = await startEnv();
    staff = await setupStaff(env);
    patient = (await env.api.post('/api/patients', { cookie: desk(), body: patientBody() })).body;
    other = (await env.api.post('/api/patients', { cookie: desk(), body: patientBody({ profile: { lastName: 'Santos', firstName: 'Clara' } }) })).body;
  });
  after(() => env.close());

  it('FR-6: a next return date at checkout creates a follow-up appointment', async () => {
    const r = await env.api.post(`/api/patients/${patient.id}/ledger`, {
      cookie: desk(),
      body: { visitDate: todayISO(), procedure: 'Oral prophylaxis', fee: 1200, paid: 1200, nextReturn: { date: daysAhead(14), time: '09:30', reason: '6-month recall' } },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.appointment.date, daysAhead(14));
    assert.equal(r.body.appointment.time, '09:30');
    assert.equal(r.body.appointment.status, 'scheduled');
    const list = await appts();
    assert.equal(list.length, 1);
    assert.equal(list[0].sourceEntryId, r.body.entryId);
    assert.equal(list[0].reason, '6-month recall');
    const detail = (await env.api.get(`/api/patients/${patient.id}`, { cookie: desk() })).body;
    assert.equal(detail.nextAppointment.date, daysAhead(14));
    const audit = env.ctx.audit.list({ action: 'CREATE', patientId: patient.id }).find((e) => e.entity === 'appointment');
    assert.equal(audit.details.sourceEntryId, r.body.entryId);
  });

  it('FR-6: an invalid return date blocks the whole checkout', async () => {
    const before = env.ctx.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get().n;
    const r = await env.api.post(`/api/patients/${patient.id}/ledger`, {
      cookie: desk(), body: { visitDate: daysAgo(3), procedure: 'Check', fee: 500, paid: 500, nextReturn: { date: daysAgo(4), time: '25:00' } },
    });
    assert.equal(r.status, 422);
    assert.match(r.body.fields.date, /earlier than/);
    assert.match(r.body.fields.time, /24-hour/);
    assert.equal(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get().n, before);
    const blank = await env.api.post(`/api/patients/${patient.id}/ledger`, {
      cookie: desk(), body: { visitDate: daysAgo(3), procedure: 'Check', fee: 500, paid: 500, nextReturn: { date: '  ' } },
    });
    assert.equal(blank.status, 201);
    assert.equal(blank.body.appointment, null);
  });

  it('FR-6: appointments can be booked directly, with validation', async () => {
    const r = await env.api.post(`/api/patients/${other.id}/appointments`, { cookie: desk(), body: { date: todayISO(), time: '14:30', reason: 'Tooth #36 check' } });
    assert.equal(r.status, 201);
    apptId = r.body.id;
    assert.equal(r.body.reason, 'Tooth #36 check');
    const past = await env.api.post(`/api/patients/${other.id}/appointments`, { cookie: desk(), body: { date: daysAgo(1) } });
    assert.equal(past.status, 422);
    const bad = await env.api.post(`/api/patients/${other.id}/appointments`, { cookie: desk(), body: { date: 'tomorrow', time: '2pm', reason: 'x'.repeat(201) } });
    assert.deepEqual(Object.keys(bad.body.fields).sort(), ['date', 'reason', 'time']);
    const none = await env.api.post(`/api/patients/${other.id}/appointments`, { cookie: desk() });
    assert.equal(none.status, 422);
    assert.equal((await env.api.post('/api/patients/PT-1999-0001/appointments', { cookie: desk(), body: { date: todayISO() } })).status, 404);
    const noTime = await env.api.post(`/api/patients/${other.id}/appointments`, { cookie: desk(), body: { date: daysAhead(30) } });
    assert.equal(noTime.body.time, null);
    assert.equal(noTime.body.reason, '');
  });

  it('FR-6: completing a visit closes follow-ups that were due', async () => {
    const r = await env.api.post(`/api/patients/${other.id}/ledger`, {
      cookie: desk(), body: { visitDate: todayISO(), procedure: 'Tooth #36 check', fee: 500, paid: 500, completeFollowUps: true },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.completedFollowUps, 1);
    const list = await appts(other.id);
    assert.equal(list.find((a) => a.id === apptId).status, 'completed');
    assert.equal(list.find((a) => a.id !== apptId).status, 'scheduled'); // future one untouched
    assert.ok(env.ctx.audit.list({ action: 'UPDATE', patientId: other.id }).some((e) => e.entityId === apptId && e.details.status === 'completed'));
  });

  it('FR-6: appointments can be rescheduled, cancelled and annotated', async () => {
    const [future] = await appts(patient.id);
    const moved = await env.api.put(`/api/appointments/${future.id}`, { cookie: desk(), body: { date: daysAhead(21), time: '' } });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.date, daysAhead(21));
    assert.equal(moved.body.time, null);
    assert.equal(moved.body.reason, '6-month recall');
    const toPast = await env.api.put(`/api/appointments/${future.id}`, { cookie: desk(), body: { date: daysAgo(1) } });
    assert.equal(toPast.status, 422);
    const badStatus = await env.api.put(`/api/appointments/${future.id}`, { cookie: desk(), body: { status: 'no-show' } });
    assert.equal(badStatus.status, 422);
    assert.ok(badStatus.body.fields.status);
    const cancelled = await env.api.put(`/api/appointments/${future.id}`, { cookie: desk(), body: { status: 'cancelled', reason: '' } });
    assert.equal(cancelled.body.status, 'cancelled');
    assert.equal(cancelled.body.reason, '');
    const [upd] = env.ctx.audit.list({ action: 'UPDATE', patientId: patient.id }).filter((e) => e.entity === 'appointment');
    assert.deepEqual(upd.details.after, { date: daysAhead(21), time: null, status: 'cancelled' });
    assert.equal((await env.api.get(`/api/patients/${patient.id}`, { cookie: desk() })).body.nextAppointment, null);
    assert.equal((await env.api.put('/api/appointments/nope', { cookie: desk(), body: {} })).status, 404);
    assert.equal((await env.api.put(`/api/appointments/${future.id}`, { cookie: desk() })).status, 200);
  });

  it('NFR-S2: appointments are soft-deleted and restorable', async () => {
    const [a] = await appts(other.id);
    assert.equal((await env.api.del(`/api/appointments/${a.id}`, { cookie: desk() })).status, 200);
    assert.ok(!(await appts(other.id)).some((x) => x.id === a.id));
    assert.equal((await env.api.del(`/api/appointments/${a.id}`, { cookie: desk() })).status, 404);
    const trash = await env.api.get('/api/trash', { cookie: staff.admin.cookie });
    const item = trash.body.items.find((i) => i.type === 'appointment' && i.id === a.id);
    assert.match(item.summary, new RegExp(`^Appointment ${a.date}`));
    assert.equal(item.patientName, 'Clara L. Santos');
    assert.equal((await env.api.post(`/api/trash/appointment/${a.id}/restore`, { cookie: staff.admin.cookie })).status, 200);
    assert.ok((await appts(other.id)).some((x) => x.id === a.id));
    assert.equal((await env.api.get('/api/patients/PT-1999-0001/appointments', { cookie: desk() })).status, 404);
  });
});

describe('Dashboard and follow-up list (FR-6)', () => {
  let built, actor, ids;
  const now = new Date();
  const at = (h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);

  before(async () => {
    built = buildApp();
    const s = built.ctx.services;
    const user = await s.auth.createUser({ username: 'desk', displayName: 'Desk', role: 'frontdesk', password: 'Front#Counter-26' }, null);
    actor = actorFrom(user);
    const mk = (lastName) => s.patients.create(patientBody({ profile: { lastName, firstName: 'Test', allergies: lastName === 'Overdue' ? 'Latex' : '' } }), actor).id;
    ids = { overdue: mk('Overdue'), morning: mk('Morning'), anytime: mk('Anytime'), soon: mk('Soon'), later: mk('Later'), done: mk('Done'), gone: mk('Gone') };
    const book = (id, date, time, reason = '') => s.appointments.insertInTx(id, { date, time, reason }, actor);
    book(ids.overdue, daysAgo(3), '09:00', 'Suture removal');
    book(ids.morning, todayISO(), '10:30', 'Composite check');
    book(ids.anytime, todayISO(), null);
    book(ids.soon, daysAhead(3), '15:00');
    book(ids.later, daysAhead(30), '08:00');
    const done = book(ids.done, todayISO(), '08:00');
    s.appointments.update(done.id, { status: 'completed' }, actor);
    const cancelled = book(ids.soon, todayISO(), '11:00');
    s.appointments.update(cancelled.id, { status: 'cancelled' }, actor);
    book(ids.gone, todayISO(), '13:00');
    s.patients.softDelete(ids.gone, actor);
    s.ledger.create(ids.overdue, { visitDate: daysAgo(10), procedure: 'Extraction', fee: 1500, paid: 500 }, actor);
    s.ledger.create(ids.morning, { visitDate: daysAgo(10), procedure: 'Filling', fee: 2000, paid: 500 }, actor);
    s.patients.refreshAllSummaries();
  });
  after(() => built.cleanup());

  it('FR-6: counts today, overdue, due today and upcoming (7-day horizon)', () => {
    const d = built.ctx.services.dashboard.build({ now: at(9, 0) });
    assert.equal(d.today, todayISO());
    assert.equal(d.horizon, daysAhead(7));
    assert.deepEqual(d.stats, {
      todayTotal: 3, todayCompleted: 1, overdue: 1, dueToday: 2, upcoming: 1, patients: 6, outstandingCents: 250000, withBalance: 2,
    });
    assert.deepEqual(d.followUps.map((f) => [f.patientId, f.status]), [
      [ids.overdue, 'overdue'], [ids.morning, 'today'], [ids.anytime, 'today'], [ids.soon, 'upcoming'],
    ]);
    const first = d.followUps[0];
    assert.equal(first.reason, 'Suture removal');
    assert.equal(first.allergies, 'Latex');
    assert.equal(first.balanceCents, 100000);
    assert.equal(first.patientName, 'Test L. Overdue');
  });

  it('FR-6: the next slot is the first scheduled visit not yet past', () => {
    const svc = built.ctx.services.dashboard;
    assert.equal(svc.build({ now: at(9, 0) }).nextSlot.patientId, ids.morning);
    assert.equal(svc.build({ now: at(11, 0) }).nextSlot.patientId, ids.anytime); // untimed visit today
    assert.equal(svc.build({ now: at(11, 0), horizonDays: 60 }).followUps.length, 5);
  });

  it('FR-6: dashboard API is audited', async () => {
    const env = await startEnv();
    try {
      const staff = await setupStaff(env);
      const p = (await env.api.post('/api/patients', { cookie: staff.frontdesk.cookie, body: patientBody() })).body;
      await env.api.post(`/api/patients/${p.id}/appointments`, { cookie: staff.frontdesk.cookie, body: { date: daysAhead(2) } });
      const r = await env.api.get('/api/dashboard', { cookie: staff.frontdesk.cookie });
      assert.equal(r.status, 200);
      assert.equal(r.body.stats.upcoming, 1);
      assert.equal(r.body.followUps[0].patientId, p.id);
      assert.equal(r.body.nextSlot.patientId, p.id);
      const [audit] = env.ctx.audit.list({ action: 'READ' }).filter((e) => e.entity === 'dashboard');
      assert.equal(audit.details.followUps, 1);
    } finally {
      await env.close();
    }
  });
});
