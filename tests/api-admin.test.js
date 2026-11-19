'use strict';
// Admin-side API: user management (NFR-SEC1), audit trail (NFR-SEC2), trash (NFR-S2), export/import + CSV (NFR-PO2),
// encrypted backups (TC-01), OCR scan endpoint (FR-8) and clinic config.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BackupService } = require('../server/services/backup');
const { OcrError } = require('../server/ocr');
const { compactStamp } = require('../server/lib/dates');
const { startEnv, setupStaff, patientBody, jpegDataUrl, PNG, PASSWORDS, daysAgo } = require('./helpers');

describe('API: user management (NFR-SEC1)', () => {
  let env, staff;
  const admin = () => staff.admin.cookie;

  before(async () => {
    env = await startEnv();
    staff = await setupStaff(env);
  });
  after(() => env.close());

  it('only administrators manage users', async () => {
    const list = await env.api.get('/api/users', { cookie: admin() });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.users.map((u) => u.username).sort(), ['admin', 'desk.maria', 'dr.reyes']);
    assert.ok(list.body.users.every((u) => !('password_hash' in u) && !('passwordHash' in u)));
    for (const role of ['dentist', 'frontdesk']) {
      assert.equal((await env.api.get('/api/users', { cookie: staff[role].cookie })).status, 403);
      assert.equal((await env.api.post('/api/users', { cookie: staff[role].cookie, body: {} })).status, 403);
    }
  });

  it('NFR-SEC1: new accounts need a unique username, a role and a strong password', async () => {
    const create = (body) => env.api.post('/api/users', { cookie: admin(), body: { displayName: 'New User', role: 'frontdesk', password: 'Fresh#Account-26', ...body } });
    assert.match((await create({ username: 'a b' })).body.fields.username, /3-64/);
    assert.match((await create({ username: 'ADMIN' })).body.fields.username, /taken/);
    assert.ok((await create({ username: 'new.user', role: 'owner' })).body.fields.role);
    assert.ok((await create({ username: 'new.user', displayName: '  ' })).body.fields.displayName);
    assert.match((await create({ username: 'new.user', password: '############' })).body.fields.password, /repeated/);
    assert.match((await create({ username: 'new.user', password: 'NEW.USER.is.me' })).body.fields.password, /username/);
    const ok = await create({ username: 'new.user' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.roleLabel, 'Front Desk');
    assert.equal(ok.body.active, true);
    assert.ok(env.ctx.audit.list({ action: 'CREATE' }).some((e) => e.entity === 'user' && e.details.username === 'new.user' && e.username === 'admin'));
  });

  it('NFR-SEC1: administrators edit roles and names, with validation', async () => {
    const id = staff.frontdesk.user.id;
    const r = await env.api.put(`/api/users/${id}`, { cookie: admin(), body: { displayName: 'Maria S. Santos', role: 'dentist' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.role, 'dentist');
    assert.equal(r.body.displayName, 'Maria S. Santos');
    const [upd] = env.ctx.audit.list({ action: 'UPDATE' }).filter((e) => e.entity === 'user');
    assert.deepEqual(upd.details, { before: { role: 'frontdesk', active: true }, after: { role: 'dentist', active: true } });
    // the change applies to the live session immediately
    const me = await env.api.get('/api/auth/me', { cookie: staff.frontdesk.cookie });
    assert.ok(me.body.permissions.includes('chart.write'));
    await env.api.put(`/api/users/${id}`, { cookie: admin(), body: { role: 'frontdesk' } });
    assert.equal((await env.api.put(`/api/users/${id}`, { cookie: admin(), body: { displayName: '' } })).status, 422);
    assert.equal((await env.api.put(`/api/users/${id}`, { cookie: admin(), body: { role: 'root' } })).status, 422);
    assert.equal((await env.api.put('/api/users/9999', { cookie: admin(), body: { displayName: 'X' } })).status, 404);
    assert.equal((await env.api.put(`/api/users/${id}`, { cookie: admin() })).status, 200);
  });

  it('NFR-SEC1: administrators cannot lock themselves out', async () => {
    const self = staff.admin.user.id;
    const deactivate = await env.api.put(`/api/users/${self}`, { cookie: admin(), body: { active: false } });
    assert.equal(deactivate.status, 422);
    assert.equal(deactivate.body.error, 'SELF_CHANGE');
    const demote = await env.api.put(`/api/users/${self}`, { cookie: admin(), body: { role: 'dentist' } });
    assert.equal(demote.body.error, 'SELF_CHANGE');
    const rename = await env.api.put(`/api/users/${self}`, { cookie: admin(), body: { displayName: 'Head Administrator', role: 'admin' } });
    assert.equal(rename.status, 200);
  });

  it('NFR-SEC1: at least one active administrator must remain', async () => {
    const second = await env.api.post('/api/users', { cookie: admin(), body: { username: 'admin2', displayName: 'Second Admin', role: 'admin', password: 'Backup#Admin-2026' } });
    const login2 = await env.api.post('/api/auth/login', { body: { username: 'admin2', password: 'Backup#Admin-2026' } });
    const demote = await env.api.put(`/api/users/${staff.admin.user.id}`, { cookie: login2.cookie, body: { role: 'dentist' } });
    assert.equal(demote.status, 200, 'allowed: admin2 is still an admin');
    assert.equal((await env.api.get('/api/users', { cookie: admin() })).status, 403, 'demoted admin loses users.manage');
    await env.api.put(`/api/users/${staff.admin.user.id}`, { cookie: login2.cookie, body: { role: 'admin' } });
    assert.equal((await env.api.put(`/api/users/${second.body.id}`, { cookie: admin(), body: { active: false } })).status, 200);
    // Now admin is the only active administrator.
    const actor = { ...staff.admin.user, ip: '127.0.0.1' };
    assert.throws(() => env.ctx.services.auth.updateUser(staff.admin.user.id, { active: false }, actor), (err) => {
      assert.equal(err.status, 422);
      assert.match(err.extra.fields.role, /At least one active administrator/);
      return true;
    });
    assert.throws(() => env.ctx.services.auth.updateUser(staff.admin.user.id, { role: 'frontdesk' }, actor), /correct/);
    assert.throws(() => env.ctx.services.auth.getUser(424242), /not found/);
  });

  it('NFR-SEC1: password reset revokes sessions and clears lockouts', async () => {
    const id = staff.dentist.user.id;
    env.ctx.db.prepare('UPDATE users SET failed_attempts = 3 WHERE id = ?').run(id);
    const weak = await env.api.post(`/api/users/${id}/reset-password`, { cookie: admin(), body: { password: 'dr.reyes-1234' } });
    assert.equal(weak.status, 422);
    assert.ok(weak.body.fields.password);
    assert.equal((await env.api.post('/api/users/9999/reset-password', { cookie: admin(), body: { password: 'Reset#Password-26' } })).status, 404);
    assert.equal((await env.api.post(`/api/users/${id}/reset-password`, { cookie: admin() })).status, 422);
    const r = await env.api.post(`/api/users/${id}/reset-password`, { cookie: admin(), body: { password: 'Reset#Password-26' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.failedAttempts, 0);
    assert.equal((await env.api.get('/api/auth/me', { cookie: staff.dentist.cookie })).status, 401);
    assert.equal((await env.api.post('/api/auth/login', { body: { username: 'dr.reyes', password: PASSWORDS.dentist } })).status, 401);
    assert.equal((await env.api.post('/api/auth/login', { body: { username: 'dr.reyes', password: 'Reset#Password-26' } })).status, 200);
    assert.ok(env.ctx.audit.list({ action: 'PASSWORD_RESET' }).some((e) => e.entityId === String(id)));
  });
});

describe('API: audit trail, trash, exports and backups', () => {
  let env, staff, mateo, clara, ledgerId;
  const doc = () => staff.dentist.cookie;
  const desk = () => staff.frontdesk.cookie;
  const admin = () => staff.admin.cookie;

  before(async () => {
    env = await startEnv();
    staff = await setupStaff(env);
    mateo = (await env.api.post('/api/patients', { cookie: desk(), body: patientBody({ portrait: jpegDataUrl(300) }) })).body;
    clara = (await env.api.post('/api/patients', {
      cookie: desk(),
      body: patientBody({ profile: { lastName: 'Santos, Jr.', firstName: 'Clara "Clang"', middleName: '', contactNumber: '0918 221 8840', allergies: '=HYPERLINK("http://evil.example")' } }),
    })).body;
    const l1 = await env.api.post(`/api/patients/${mateo.id}/ledger`, { cookie: desk(), body: { visitDate: daysAgo(20), procedure: 'Cleaning', fee: 1200, paid: 1200 } });
    await env.api.post(`/api/patients/${mateo.id}/ledger`, { cookie: desk(), body: { visitDate: daysAgo(10), procedure: 'Filling, composite', fee: 2000, paid: 500 } });
    ledgerId = l1.body.entryId;
    await env.api.post(`/api/patients/${clara.id}/ledger`, { cookie: desk(), body: { visitDate: daysAgo(3), procedure: '-Payment on account', fee: 0, paid: 50, acknowledgeOverpayment: true } });
    await env.api.post(`/api/patients/${mateo.id}/chart/photos?view=frontal`, { cookie: doc(), raw: PNG, type: 'image/png' });
    await env.api.post(`/api/patients/${mateo.id}/chart/marks`, { cookie: doc(), body: { tooth: 16, surfaces: ['M', 'O'], condition: 'D' } });
    await env.api.del(`/api/patients/${mateo.id}`, { cookie: desk() }); // DENIED
  });
  after(() => env.close());

  it('NFR-SEC2: dentists and admins can read and filter the audit trail', async () => {
    const all = await env.api.get('/api/audit?limit=500', { cookie: doc() });
    assert.equal(all.status, 200);
    const actions = new Set(all.body.entries.map((e) => e.action));
    for (const a of ['CREATE', 'LOGIN', 'DENIED']) assert.ok(actions.has(a), a);
    const seqs = all.body.entries.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a));
    const denied = await env.api.get('/api/audit?action=DENIED', { cookie: admin() });
    assert.equal(denied.body.entries.length, 1);
    assert.equal(denied.body.entries[0].username, 'desk.maria');
    const byPatient = await env.api.get(`/api/audit?patientId=${mateo.id}`, { cookie: admin() });
    assert.ok(byPatient.body.entries.length >= 4 && byPatient.body.entries.every((e) => e.patientId === mateo.id));
    const byUser = await env.api.get('/api/audit?username=DR.REYES', { cookie: admin() });
    assert.ok(byUser.body.entries.length > 0 && byUser.body.entries.every((e) => e.username === 'dr.reyes'));
    const page = await env.api.get(`/api/audit?limit=2&before=${seqs[0]}`, { cookie: admin() });
    assert.deepEqual(page.body.entries.map((e) => e.seq), seqs.slice(1, 3));
    assert.equal((await env.api.get('/api/audit', { cookie: desk() })).status, 403);
    assert.equal((await env.api.get('/api/audit/verify', { cookie: desk() })).status, 403);
  });

  it('NFR-SEC2: the chain verifies through the API', async () => {
    const r = await env.api.get('/api/audit/verify', { cookie: admin() });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.count > 10);
    assert.equal(r.body.brokenAtSeq, null);
  });

  it('NFR-S2: trash is limited to dentists/admins and rejects unknown types', async () => {
    assert.equal((await env.api.get('/api/trash', { cookie: desk() })).status, 403);
    assert.equal((await env.api.post(`/api/trash/patient/${mateo.id}/restore`, { cookie: desk() })).status, 403);
    const r = await env.api.get('/api/trash', { cookie: doc() });
    assert.equal(r.status, 200);
    assert.equal(r.body.retentionDays, 30);
    const bad = await env.api.post('/api/trash/invoice/abc/restore', { cookie: doc() });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'BAD_TYPE');
  });

  it('NFR-PO2: full JSON export (with and without files) is audited', async () => {
    const r = await env.api.get('/api/export/full.json', { cookie: doc() });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-disposition'), `attachment; filename="IRBY_Export_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json"`);
    assert.equal(r.body.format, 'irby-dental-ledger');
    assert.equal(r.body.formatVersion, 1);
    assert.equal(r.body.clinic, 'IRBY Dental Clinic');
    assert.equal(r.body.includesFiles, true);
    assert.deepEqual(r.body.patients.map((p) => p.id), [mateo.id, clara.id]);
    const m = r.body.patients[0];
    assert.equal(m.createdBy, 'desk.maria');
    assert.equal(m.ledger.length, 2);
    assert.equal(m.chart.photos.length, 1);
    assert.equal(Buffer.from(m.chart.photos[0].file.data, 'base64').equals(PNG), true);
    assert.equal(m.chart.marks[0].surfaces, 'M,O');
    assert.equal(m.consents[0].version, '1.0');
    const lite = await env.api.get('/api/export/full.json?files=0', { cookie: admin() });
    assert.equal(lite.body.includesFiles, false);
    assert.equal(lite.body.patients[0].portrait.data, undefined);
    const exports = env.ctx.audit.list({ action: 'EXPORT' });
    assert.deepEqual(exports.map((e) => e.details.includeFiles), [false, true]);
    assert.equal((await env.api.get('/api/export/full.json', { cookie: desk() })).status, 403);
  });

  it('NFR-PO2: patients CSV is spreadsheet-safe (BOM, quoting, formula guard)', async () => {
    const r = await env.api.get('/api/export/patients.csv', { cookie: doc() });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/csv/);
    assert.match(r.headers.get('content-disposition'), /IRBY_Patients_\d{8}\.csv/);
    assert.ok(r.body.startsWith('﻿Record ID,Last Name,First Name,'));
    const lines = r.body.slice(1).trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.ok(lines[1].startsWith(`${mateo.id},Dela Cruz,Mateo,Lorenzo,1992-04-12,`));
    assert.ok(lines[1].includes('"Unit 14B, Salcedo Village, Makati City"'));
    assert.ok(lines[1].includes(",'+63 917 550 0192,"), 'leading + is neutralised');
    assert.ok(lines[1].includes(',1500.00,1.0'), 'balance in pesos and consent version');
    assert.ok(lines[2].includes('"Santos, Jr."'));
    assert.ok(lines[2].includes('"Clara ""Clang"""'));
    assert.ok(lines[2].includes(`"'=HYPERLINK(""http://evil.example"")"`), lines[2]);
    assert.ok(lines[2].includes(",'-50.00,"), 'credit balance shown (formula-guarded)');
    assert.equal((await env.api.get('/api/export/patients.csv', { cookie: desk() })).status, 403);
  });

  it('NFR-PO2: ledger CSV has running balances and skips voided entries', async () => {
    const before = await env.api.get('/api/export/ledger.csv', { cookie: admin() });
    const rows = before.body.slice(1).trim().split('\r\n');
    assert.equal(rows[0], 'Record ID,Patient,Visit Date,Age at Visit,Procedure,Fee (PHP),Paid (PHP),Entry Balance (PHP),Running Balance (PHP)');
    assert.equal(rows.length, 4);
    assert.ok(rows[1].startsWith(`${mateo.id},Mateo L. Dela Cruz,${daysAgo(20)},`));
    assert.ok(rows[1].endsWith(',Cleaning,1200.00,1200.00,0.00,0.00'));
    assert.ok(rows[2].endsWith(',"Filling, composite",2000.00,500.00,1500.00,1500.00'));
    assert.ok(rows[3].endsWith(",'-Payment on account,0.00,50.00,'-50.00,'-50.00"), rows[3]);
    await env.api.del(`/api/ledger/${ledgerId}`, { cookie: desk(), body: { reason: 'duplicate' } });
    const afterVoid = await env.api.get('/api/export/ledger.csv', { cookie: admin() });
    assert.equal(afterVoid.body.slice(1).trim().split('\r\n').length, 3);
    assert.ok(env.ctx.audit.list({ action: 'EXPORT' }).some((e) => e.details.table === 'ledger'));
    assert.equal((await env.api.get('/api/export/ledger.csv', { cookie: desk() })).status, 403);
  });

  it('NFR-PO2: import is admin-only and rejects malformed files', async () => {
    const data = (await env.api.get('/api/export/full.json', { cookie: admin() })).body;
    assert.equal((await env.api.post('/api/import', { cookie: doc(), body: data })).status, 403);
    const wrong = await env.api.post('/api/import', { cookie: admin(), body: { format: 'other', patients: [] } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'BAD_IMPORT');
    assert.equal((await env.api.post('/api/import', { cookie: admin(), body: { ...data, formatVersion: 2 } })).status, 400);
    assert.equal((await env.api.post('/api/import', { cookie: admin(), body: { ...data, patients: 'all' } })).status, 400);
    assert.equal((await env.api.post('/api/import', { cookie: admin() })).status, 400);
    const badId = await env.api.post('/api/import', { cookie: admin(), body: { ...data, patients: [{ ...data.patients[0], id: 'P-1' }] } });
    assert.match(badId.body.message, /Invalid patient record P-1/);
    const noProfile = await env.api.post('/api/import', { cookie: admin(), body: { ...data, patients: [{ ...data.patients[0], profile: null }] } });
    assert.equal(noProfile.status, 400);
    const tampered = structuredClone(data);
    tampered.patients[0].portrait.data = Buffer.from('swapped image').toString('base64');
    const sum = await env.api.post('/api/import', { cookie: admin(), body: tampered });
    assert.equal(sum.status, 400);
    assert.match(sum.body.message, /checksum/);
  });

  it('NFR-PO2: re-importing an export is idempotent; large imports bypass the 2 MB JSON limit', async () => {
    const data = (await env.api.get('/api/export/full.json', { cookie: admin() })).body;
    const r = await env.api.post('/api/import', { cookie: admin(), body: data });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.imported, { patients: 2, ledger: 3, appointments: 0, photos: 1, marks: 1, files: 2, skippedFiles: 0 });
    const again = (await env.api.get('/api/export/full.json', { cookie: admin() })).body;
    assert.deepEqual(again.patients, data.patients);
    const big = structuredClone(data);
    big.patients[0].profile.address = 'A'.repeat(3 * 1024 * 1024);
    const bigImport = await env.api.post('/api/import', { cookie: admin(), body: big });
    assert.equal(bigImport.status, 200);
    assert.equal(env.ctx.services.patients.cache.get(mateo.id).profile.address.length, 3 * 1024 * 1024);
    assert.ok(env.ctx.audit.list({ action: 'IMPORT' }).length >= 2);
  });

  it('TC-01: administrators create and list encrypted backups', async () => {
    const empty = await env.api.get('/api/backups', { cookie: admin() });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.backups, []);
    assert.equal(empty.body.directory, path.join(env.dir, 'backups'));
    assert.equal(empty.body.keep, 30);
    assert.equal(empty.body.enabled, false);
    const r = await env.api.post('/api/backups', { cookie: admin() });
    assert.equal(r.status, 201);
    assert.equal(r.body.name, `Backup_${compactStamp()}_Secure.bak`);
    assert.ok(r.body.size > 0);
    const list = await env.api.get('/api/backups', { cookie: admin() });
    assert.deepEqual(list.body.backups.map((b) => b.name), [r.body.name]);
    const file = path.join(env.dir, 'backups', r.body.name);
    const raw = fs.readFileSync(file);
    assert.equal(raw.subarray(0, 8).toString(), 'IRBYBAK1');
    assert.equal(raw.includes(Buffer.from('SQLite format 3')), false, 'backup must not be plain SQLite');
    assert.equal(BackupService.decrypt(file, env.ctx.vault).subarray(0, 15).toString(), 'SQLite format 3');
    const [audit] = env.ctx.audit.list({ action: 'BACKUP' });
    assert.equal(audit.username, 'admin');
    assert.equal(audit.details.reason, 'manual');
    assert.equal((await env.api.get('/api/backups', { cookie: doc() })).status, 403);
    assert.equal((await env.api.post('/api/backups', { cookie: doc() })).status, 403);
  });

  it('FR-8: OCR status and scan endpoints (mock provider, audited without PHI)', async () => {
    const st = await env.api.get('/api/ocr/status', { cookie: desk() });
    assert.equal(st.status, 200);
    assert.equal(st.body.provider, 'mock');
    assert.equal(st.body.ready, true);
    const r = await env.api.post('/api/ocr/scan', { cookie: desk(), raw: PNG, type: 'image/png' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.provider, 'mock');
    assert.equal(r.body.fields.lastName, 'Dela Cruz');
    assert.equal(r.body.fields.dateOfBirth, '1992-04-12');
    const [audit] = env.ctx.audit.list({ action: 'OCR_SCAN' });
    assert.equal(audit.details.provider, 'mock');
    assert.equal(audit.details.bytes, PNG.length);
    assert.equal(audit.details.fieldsFilled, Object.keys(r.body.fields).length);
    assert.ok(!JSON.stringify(audit).includes('Dela Cruz'));
    const fake = await env.api.post('/api/ocr/scan', { cookie: desk(), raw: Buffer.from('definitely not an image'), type: 'image/jpeg' });
    assert.equal(fake.status, 415);
    assert.equal(fake.body.error, 'BAD_IMAGE');
    const none = await env.api.post('/api/ocr/scan', { cookie: desk() });
    assert.equal(none.status, 400);
    assert.equal(none.body.error, 'NO_IMAGE');
  });

  it('clinic configuration for the web app', async () => {
    const r = await env.api.get('/api/config', { cookie: desk() });
    assert.equal(r.status, 200);
    assert.equal(r.body.clinic.name, 'IRBY Dental Clinic');
    assert.ok(r.body.pda.symbols.some((s) => s.code === 'D'));
    assert.equal(r.body.consent.version, '1.0');
    assert.ok(r.body.consent.text.includes('10173'));
    assert.equal(r.body.consent.sha256, undefined);
    assert.ok(r.body.procedures.length > 0);
    assert.equal(r.body.limits.portraitMaxBytes, 500 * 1024);
    assert.equal(r.body.ocr.provider, 'mock');
    assert.equal(r.body.trashRetentionDays, 30);
    assert.equal(r.body.version, require('../package.json').version);
  });

  it('NFR-SEC2: tampering with the audit table is reported by /api/audit/verify', async () => {
    env.ctx.db.exec('DROP TRIGGER audit_log_no_update');
    const target = env.ctx.db.prepare("SELECT seq FROM audit_log WHERE action = 'DENIED' ORDER BY seq LIMIT 1").get().seq;
    env.ctx.db.prepare("UPDATE audit_log SET username = 'someone.else' WHERE seq = ?").run(target);
    const r = await env.api.get('/api/audit/verify', { cookie: admin() });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.brokenAtSeq, target);
    assert.equal(r.body.count, target - 1);
  });
});

describe('API: OCR and unexpected errors from injected providers', () => {
  let env, staff, mode = 'timeout';
  before(async () => {
    const ocr = {
      name: 'stub',
      description: 'test stub',
      status: async () => ({ provider: 'stub', ready: true }),
      scan: async () => {
        if (mode === 'timeout') throw new OcrError(504, 'OCR_TIMEOUT', 'OCR did not finish within 10 s.');
        throw new Error('disk on fire');
      },
    };
    env = await startEnv({ ocr });
    staff = await setupStaff(env);
  });
  after(() => env.close());

  it('NFR-P7: an OCR timeout reaches the client as 504 OCR_TIMEOUT', async () => {
    const r = await env.api.post('/api/ocr/scan', { cookie: staff.frontdesk.cookie, raw: PNG, type: 'image/png' });
    assert.equal(r.status, 504);
    assert.equal(r.body.error, 'OCR_TIMEOUT');
  });

  it('unexpected exceptions become a generic 500 without internals', async () => {
    mode = 'crash';
    const originalError = console.error;
    console.error = () => {};
    try {
      const r = await env.api.post('/api/ocr/scan', { cookie: staff.frontdesk.cookie, raw: PNG, type: 'image/png' });
      assert.equal(r.status, 500);
      assert.equal(r.body.error, 'SERVER_ERROR');
      assert.ok(!JSON.stringify(r.body).includes('disk on fire'));
    } finally {
      console.error = originalError;
    }
  });
});
