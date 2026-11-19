'use strict';
// FR-1 registration (consent, portrait, age), FR-2 search/sort/filter, FR-7 RBAC on patient records, NFR-P2 search speed.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ageOn } = require('../server/lib/dates');
const { startEnv, buildApp, setupStaff, patientBody, jpegDataUrl, PNG, todayISO, daysAgo, daysAhead } = require('./helpers');

const YEAR = new Date().getFullYear();
const pid = (n) => `PT-${YEAR}-${String(n).padStart(4, '0')}`;

describe('API: patient registration (FR-1)', () => {
  let env, staff, mateo;
  const desk = () => staff.frontdesk.cookie;

  before(async () => {
    env = await startEnv();
    staff = await setupStaff(env);
  });
  after(() => env.close());

  it('FR-1: registers a patient with an auto-generated ID, age and consent record', async () => {
    const r = await env.api.post('/api/patients', { cookie: desk(), body: patientBody() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    mateo = r.body;
    assert.equal(mateo.id, pid(1));
    assert.equal(mateo.fullName, 'Mateo L. Dela Cruz');
    assert.equal(mateo.age, ageOn('1992-04-12'));
    assert.equal(mateo.registeredOn, todayISO());
    assert.equal(mateo.allergies, 'Penicillin');
    assert.equal(mateo.hasPortrait, false);
    assert.equal(mateo.balanceCents, 0);
    assert.equal(mateo.consent.version, '1.0');
    assert.equal(mateo.consent.current, true);
    assert.equal(mateo.consent.recordedBy, 'Maria Santos');
    assert.equal(mateo.consent.method, 'staff-verified-signed-form');
    const [created] = env.ctx.audit.list({ action: 'CREATE', patientId: mateo.id });
    assert.equal(created.entity, 'patient');
    assert.equal(created.username, 'desk.maria');
    assert.equal(created.details.consentVersion, '1.0');
  });

  it('NFR-SEC: profiles are encrypted at rest', () => {
    const row = env.ctx.db.prepare('SELECT data_enc FROM patients WHERE id = ?').get(mateo.id);
    assert.match(row.data_enc, /^v1:/);
    assert.ok(!row.data_enc.includes('Dela Cruz'));
    assert.ok(!row.data_enc.includes('Penicillin'));
  });

  it('FR-1: IDs are sequential per year', async () => {
    const r = await env.api.post('/api/patients', { cookie: desk(), body: patientBody({ profile: { lastName: 'Santos', firstName: 'Clara', middleName: '' }, registrationDate: daysAgo(30) }) });
    assert.equal(r.status, 201);
    assert.equal(r.body.id, pid(2));
    assert.equal(r.body.fullName, 'Clara Santos');
    assert.equal(r.body.registeredOn, daysAgo(30));
  });

  it('FR-1: missing consent -> 422 CONSENT_REQUIRED', async () => {
    const before = env.ctx.services.patients.cache.size;
    for (const consent of [undefined, { accepted: false, version: '1.0' }, { accepted: true, version: '0.9' }, { accepted: 'yes', version: '1.0' }]) {
      const r = await env.api.post('/api/patients', { cookie: desk(), body: { ...patientBody(), consent } });
      assert.equal(r.status, 422);
      assert.equal(r.body.error, 'CONSENT_REQUIRED');
      assert.match(r.body.message, /consent/i);
      assert.ok(r.body.fields.consent);
    }
    assert.equal(env.ctx.services.patients.cache.size, before);
  });

  it('FR-1: other invalid fields are reported together (VALIDATION_FAILED)', async () => {
    const r = await env.api.post('/api/patients', {
      cookie: desk(),
      body: {
        profile: { lastName: '', firstName: ' ', middleName: 'x'.repeat(81), dateOfBirth: daysAhead(1), sex: 'M', address: '', contactNumber: 'call me maybe', allergies: 'a'.repeat(301) },
        registrationDate: daysAhead(2),
      },
    });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'VALIDATION_FAILED');
    assert.deepEqual(Object.keys(r.body.fields).sort(),
      ['address', 'allergies', 'consent', 'contactNumber', 'dateOfBirth', 'firstName', 'lastName', 'middleName', 'registrationDate', 'sex']);
    assert.match(r.body.fields.dateOfBirth, /future/);
    assert.match(r.body.fields.registrationDate, /future/);
  });

  it('FR-1: rejects impossible dates and over-long addresses', async () => {
    const r = await env.api.post('/api/patients', {
      cookie: desk(),
      body: patientBody({ profile: { dateOfBirth: '1992-02-30', address: 'x'.repeat(301) }, registrationDate: '2026-13-01' }),
    });
    assert.equal(r.status, 422);
    assert.match(r.body.fields.dateOfBirth, /valid date/);
    assert.match(r.body.fields.address, /300/);
    assert.match(r.body.fields.registrationDate, /valid/);
    const noProfile = await env.api.post('/api/patients', { cookie: desk(), body: { consent: { accepted: true, version: '1.0' } } });
    assert.equal(noProfile.status, 422);
    assert.ok(noProfile.body.fields.lastName);
  });

  it('FR-1: portrait over 500 KB -> 413 PORTRAIT_TOO_LARGE; exactly 500 KB is accepted', async () => {
    const tooBig = await env.api.post('/api/patients', { cookie: desk(), body: patientBody({ portrait: jpegDataUrl(500 * 1024 + 1) }) });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.error, 'PORTRAIT_TOO_LARGE');
    assert.ok(tooBig.body.fields.portrait);
    const limit = await env.api.post('/api/patients', { cookie: desk(), body: patientBody({ profile: { firstName: 'Limit' }, portrait: jpegDataUrl(500 * 1024) }) });
    assert.equal(limit.status, 201);
    assert.equal(limit.body.hasPortrait, true);
  });

  it('FR-1: portraits must really be images', async () => {
    const r = await env.api.post('/api/patients', { cookie: desk(), body: patientBody({ portrait: 'data:image/jpeg;base64,' + Buffer.from('not a jpeg, just text....').toString('base64') }) });
    assert.equal(r.status, 422);
    assert.match(r.body.fields.portrait, /JPEG, PNG or WebP/);
  });

  it('FR-1: portrait is stored encrypted and served back privately', async () => {
    const url = jpegDataUrl(2048);
    const created = await env.api.post('/api/patients', { cookie: desk(), body: patientBody({ profile: { lastName: 'Bautista', firstName: 'Ana' }, portrait: url }) });
    assert.equal(created.status, 201);
    assert.equal(created.body.hasPortrait, true);
    assert.match(created.body.portraitVersion, /^[0-9a-f]{8}$/);
    const img = await env.api.get(`/api/patients/${created.body.id}/portrait`, { cookie: desk() });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal(img.headers.get('cache-control'), 'private, no-store');
    assert.equal(img.headers.get('content-disposition'), `inline; filename="${created.body.id}_Bautista_Profile.jpg"`);
    assert.deepEqual(img.body, Buffer.from(url.split(',')[1], 'base64'));
    const none = await env.api.get(`/api/patients/${mateo.id}/portrait`, { cookie: desk() });
    assert.equal(none.status, 404);
  });

  it('FR-1: replacing a portrait keeps the old file recoverable', async () => {
    const pngUrl = 'data:image/png;base64,' + PNG.toString('base64');
    const r = await env.api.put(`/api/patients/${mateo.id}/portrait`, { cookie: desk(), body: { portrait: pngUrl } });
    assert.equal(r.status, 200);
    assert.equal(r.body.hasPortrait, true);
    const first = r.body.portraitVersion;
    const img = await env.api.get(`/api/patients/${mateo.id}/portrait`, { cookie: desk() });
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('content-disposition'), /_Dela_Cruz_Profile\.png"$/);
    assert.deepEqual(img.body, PNG);
    const again = await env.api.put(`/api/patients/${mateo.id}/portrait`, { cookie: desk(), body: { portrait: jpegDataUrl(100) } });
    assert.notEqual(again.body.portraitVersion, first);
    const files = env.ctx.db.prepare("SELECT deleted_at FROM files WHERE patient_id = ? AND kind = 'portrait' ORDER BY created_at").all(mateo.id);
    assert.equal(files.length, 2);
    assert.ok(files[0].deleted_at);
    assert.equal(files[1].deleted_at, null);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20)]);
    await env.api.put(`/api/patients/${mateo.id}/portrait`, { cookie: desk(), body: { portrait: 'data:image/webp;base64,' + webp.toString('base64') } });
    const w = await env.api.get(`/api/patients/${mateo.id}/portrait`, { cookie: desk() });
    assert.match(w.headers.get('content-disposition'), /\.webp"$/);
  });

  it('FR-1: portrait update requires a valid image under 500 KB', async () => {
    const missing = await env.api.put(`/api/patients/${mateo.id}/portrait`, { cookie: desk(), body: {} });
    assert.equal(missing.status, 422);
    assert.match(missing.body.fields.portrait, /required/);
    const big = await env.api.put(`/api/patients/${mateo.id}/portrait`, { cookie: desk(), body: { portrait: jpegDataUrl(600 * 1024) } });
    assert.equal(big.status, 413);
    const noBody = await env.api.put(`/api/patients/${mateo.id}/portrait`, { cookie: desk() });
    assert.equal(noBody.status, 422);
  });

  it('FR-1: reading a record is audited; unknown IDs are 404', async () => {
    const r = await env.api.get(`/api/patients/${mateo.id}`, { cookie: desk() });
    assert.equal(r.status, 200);
    assert.equal(r.body.lastName, 'Dela Cruz');
    assert.ok(env.ctx.audit.list({ action: 'READ', patientId: mateo.id }).length >= 1);
    const missing = await env.api.get('/api/patients/PT-1999-9999', { cookie: desk() });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'NOT_FOUND');
  });

  it('FR-1: updating demographics records which fields changed', async () => {
    const r = await env.api.put(`/api/patients/${mateo.id}`, {
      cookie: desk(),
      body: { profile: { ...patientBody().profile, address: '15 Sampaguita St., Marikina City', allergies: 'Penicillin; latex' } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.address, '15 Sampaguita St., Marikina City');
    const [upd] = env.ctx.audit.list({ action: 'UPDATE', patientId: mateo.id }).filter((e) => e.entity === 'patient');
    assert.deepEqual(upd.details.changedFields.sort(), ['address', 'allergies']);
    assert.equal(upd.details.consentRecorded, false);
    const bad = await env.api.put(`/api/patients/${mateo.id}`, { cookie: desk(), body: { profile: { lastName: '' } } });
    assert.equal(bad.status, 422);
    const missing = await env.api.put('/api/patients/PT-1999-9999', { cookie: desk(), body: patientBody() });
    assert.equal(missing.status, 404);
  });

  it('NFR-C1: a new consent version must be verified before the next edit', async () => {
    const clara = pid(2);
    env.ctx.clinic.consent.version = '2.0';
    try {
      const detail = await env.api.get(`/api/patients/${clara}`, { cookie: desk() });
      assert.equal(detail.body.consent.current, false);
      const body = { profile: { ...patientBody().profile, lastName: 'Santos', firstName: 'Clara', middleName: '' } };
      const blocked = await env.api.put(`/api/patients/${clara}`, { cookie: desk(), body });
      assert.equal(blocked.status, 422);
      assert.match(blocked.body.fields.consent, /2\.0/);
      const ok = await env.api.put(`/api/patients/${clara}`, {
        cookie: desk(), body: { ...body, registrationDate: daysAgo(10), consent: { accepted: true, version: '2.0' }, portrait: jpegDataUrl(256) },
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.consent.version, '2.0');
      assert.equal(ok.body.consent.current, true);
      assert.equal(ok.body.hasPortrait, true);
      assert.equal(ok.body.registeredOn, daysAgo(10));
      const [upd] = env.ctx.audit.list({ action: 'UPDATE', patientId: clara });
      assert.equal(upd.details.consentRecorded, true);
      assert.equal(upd.details.portraitReplaced, true);
      assert.ok(upd.details.changedFields.includes('registrationDate'));
      assert.equal(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM consents WHERE patient_id = ?').get(clara).n, 2);
    } finally {
      env.ctx.clinic.consent.version = '1.0';
    }
  });

  it('FR-7: front desk cannot delete patients (403 + DENIED audit)', async () => {
    const r = await env.api.del(`/api/patients/${mateo.id}`, { cookie: desk() });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'FORBIDDEN');
    assert.equal(r.body.permission, 'patients.delete');
    assert.match(r.body.message, /Front Desk/);
    const [denied] = env.ctx.audit.list({ action: 'DENIED' });
    assert.equal(denied.username, 'desk.maria');
    assert.equal(denied.entityId, 'patients.delete');
    assert.equal(denied.patientId, mateo.id);
    assert.deepEqual(denied.details, { method: 'DELETE', path: `/api/patients/${mateo.id}` });
    assert.ok(env.ctx.services.patients.cache.has(mateo.id));
  });

  it('NFR-S2: a dentist soft-deletes a patient; it can be restored from the trash', async () => {
    const victim = (await env.api.post('/api/patients', { cookie: desk(), body: patientBody({ profile: { lastName: 'Ramos', firstName: 'Isabel' } }) })).body;
    const del = await env.api.del(`/api/patients/${victim.id}`, { cookie: staff.dentist.cookie });
    assert.equal(del.status, 200);
    assert.equal((await env.api.get(`/api/patients/${victim.id}`, { cookie: desk() })).status, 404);
    assert.equal((await env.api.del(`/api/patients/${victim.id}`, { cookie: staff.dentist.cookie })).status, 404);
    const search = await env.api.get('/api/patients?q=isabel', { cookie: desk() });
    assert.equal(search.body.total, 0);
    const trash = await env.api.get('/api/trash', { cookie: staff.admin.cookie });
    const item = trash.body.items.find((i) => i.type === 'patient' && i.id === victim.id);
    assert.equal(item.patientName, 'Isabel L. Ramos');
    assert.equal(item.deletedBy, 'Dr. Ana Reyes');
    assert.ok(item.purgeOn - item.deletedAt >= 30 * 24 * 3600 * 1000);
    const restored = await env.api.post(`/api/trash/patient/${victim.id}/restore`, { cookie: staff.dentist.cookie });
    assert.equal(restored.status, 200);
    assert.equal((await env.api.get(`/api/patients/${victim.id}`, { cookie: desk() })).body.fullName, 'Isabel L. Ramos');
    assert.equal((await env.api.post(`/api/trash/patient/${victim.id}/restore`, { cookie: staff.dentist.cookie })).status, 404);
    assert.ok(env.ctx.audit.list({ action: 'RESTORE', patientId: victim.id }).length === 1);
  });

  it('NFR-PO2: single-patient JSON export (dentist/admin only)', async () => {
    const r = await env.api.get(`/api/patients/${mateo.id}/export.json`, { cookie: staff.dentist.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-disposition'), `attachment; filename="${mateo.id}_export.json"`);
    assert.equal(r.body.format, 'irby-dental-ledger');
    assert.equal(r.body.patients.length, 1);
    assert.equal(r.body.patients[0].profile.lastName, 'Dela Cruz');
    assert.ok(r.body.patients[0].portrait.data);
    const noFiles = await env.api.get(`/api/patients/${mateo.id}/export.json?files=0`, { cookie: staff.admin.cookie });
    assert.equal(noFiles.body.includesFiles, false);
    assert.equal(noFiles.body.patients[0].portrait.data, undefined);
    assert.equal((await env.api.get(`/api/patients/${mateo.id}/export.json`, { cookie: desk() })).status, 403);
    assert.equal((await env.api.get('/api/patients/PT-1999-0001/export.json', { cookie: staff.admin.cookie })).status, 404);
  });
});

describe('API: patient search, sort and filter (FR-2)', () => {
  let env, staff;
  const ids = {};
  const search = async (qs) => {
    const r = await env.api.get(`/api/patients?${qs}`, { cookie: staff.frontdesk.cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const names = (res) => res.items.map((i) => i.fullName);

  before(async () => {
    env = await startEnv();
    staff = await setupStaff(env);
    const people = [
      ['mateo', 'Dela Cruz', 'Mateo', 'Lorenzo', 'Penicillin', daysAgo(400)],
      ['clara', 'Santos', 'Clara', 'Villanueva', '', daysAgo(300)],
      ['roberto', 'Delacruz', 'Roberto', 'Pascual', 'Diabetic', daysAgo(500)],
      ['katrina', 'Dela Cruz', 'Katrina', 'Mendoza', '', daysAgo(90)],
      ['antonio', 'Reyes', 'Antonio', 'Garcia', 'Latex', daysAgo(150)],
    ];
    for (const [key, lastName, firstName, middleName, allergies, registrationDate] of people) {
      const r = await env.api.post('/api/patients', { cookie: staff.frontdesk.cookie, body: patientBody({ profile: { lastName, firstName, middleName, allergies }, registrationDate }) });
      assert.equal(r.status, 201);
      ids[key] = r.body.id;
    }
    const ledger = (key, visitDate, fee, paid, nextReturn) => env.api.post(`/api/patients/${ids[key]}/ledger`, {
      cookie: staff.frontdesk.cookie, body: { visitDate, procedure: 'Consultation', fee, paid, nextReturn },
    });
    assert.equal((await ledger('mateo', daysAgo(12), 2000, 500, { date: todayISO(), time: '10:30', reason: 'Check' })).status, 201);
    assert.equal((await ledger('roberto', daysAgo(120), 9000, 5800, { date: daysAhead(6) })).status, 201);
    assert.equal((await ledger('antonio', daysAgo(7), 8000, 8000, { date: daysAgo(2) })).status, 201);
    assert.equal((await ledger('clara', daysAgo(21), 12000, 9600)).status, 201);
  });
  after(() => env.close());

  it('FR-2: lists everyone by name when there is no query', async () => {
    const r = await search('');
    assert.equal(r.total, 5);
    assert.equal(r.totalPatients, 5);
    assert.equal(r.sort, 'name');
    assert.equal(r.dir, 'asc');
    assert.deepEqual(names(r), ['Katrina M. Dela Cruz', 'Mateo L. Dela Cruz', 'Roberto P. Delacruz', 'Antonio G. Reyes', 'Clara V. Santos']);
    assert.equal(typeof r.tookMs, 'number');
    const first = r.items.find((i) => i.id === ids.mateo);
    assert.equal(first.balanceCents, 150000);
    assert.equal(first.lastVisit, daysAgo(12));
    assert.equal(first.nextAppointment.date, todayISO());
    assert.equal(first.nextAppointment.reason, 'Check');
    assert.equal(first.consentOnFile, true);
  });

  it('FR-2: "dela crz" finds the Dela Cruz family despite the typo', async () => {
    const r = await search('q=dela%20crz');
    assert.equal(r.sort, 'relevance');
    assert.ok(names(r).includes('Mateo L. Dela Cruz'));
    assert.ok(names(r).includes('Katrina M. Dela Cruz'));
    assert.ok(!names(r).includes('Clara V. Santos'));
  });

  it('FR-2: compound surnames match with or without the space', async () => {
    const r = await search('q=delacruz');
    assert.deepEqual(names(r).sort(), ['Katrina M. Dela Cruz', 'Mateo L. Dela Cruz', 'Roberto P. Delacruz']);
    assert.equal(names(await search('q=mateo%20dela%20cruz'))[0], 'Mateo L. Dela Cruz');
    assert.equal((await search('q=zzzzzz')).total, 0);
  });

  it('FR-2: search by record ID, with or without the PT- prefix', async () => {
    const exact = await search(`q=${ids.clara}`);
    assert.equal(exact.items[0].id, ids.clara);
    assert.equal(exact.items[0].score, 0);
    const bare = await search(`q=${ids.clara.slice(-4)}`);
    assert.deepEqual(bare.items.map((i) => i.id), [ids.clara]);
    const compact = await search(`q=pt${ids.clara.slice(3).replace('-', '')}`);
    assert.deepEqual(compact.items.map((i) => i.id), [ids.clara]);
    assert.equal((await search(`q=${YEAR}`)).total, 5);
  });

  it('FR-2: filters by outstanding balance, follow-up due and medical alerts', async () => {
    assert.deepEqual(names(await search('filter=balance')).sort(), ['Clara V. Santos', 'Mateo L. Dela Cruz', 'Roberto P. Delacruz']);
    assert.deepEqual(names(await search('filter=followup')).sort(), ['Antonio G. Reyes', 'Mateo L. Dela Cruz']);
    assert.deepEqual(names(await search('filter=alerts')).sort(), ['Antonio G. Reyes', 'Mateo L. Dela Cruz', 'Roberto P. Delacruz']);
    assert.deepEqual(names(await search('filter=alerts&q=dela')).sort(), ['Mateo L. Dela Cruz', 'Roberto P. Delacruz']);
  });

  it('FR-2: sorts by every column, both directions', async () => {
    assert.deepEqual(names(await search('sort=name&dir=desc'))[0], 'Clara V. Santos');
    assert.deepEqual((await search('sort=id')).items.map((i) => i.id), Object.values(ids).sort());
    assert.deepEqual((await search('sort=id&dir=desc')).items.map((i) => i.id), Object.values(ids).sort().reverse());
    const balance = await search('sort=balance');
    assert.equal(balance.dir, 'desc');
    assert.deepEqual(balance.items.map((i) => i.balanceCents), [320000, 240000, 150000, 0, 0]);
    const lastVisit = await search('sort=lastVisit');
    assert.deepEqual(names(lastVisit).slice(0, 4), ['Antonio G. Reyes', 'Mateo L. Dela Cruz', 'Clara V. Santos', 'Roberto P. Delacruz']);
    assert.equal(lastVisit.items[4].lastVisit, null); // never visited: last either way
    assert.equal((await search('sort=lastVisit&dir=asc')).items[4].lastVisit, null);
    const next = await search('sort=nextAppointment');
    assert.deepEqual(names(next).slice(0, 3), ['Antonio G. Reyes', 'Mateo L. Dela Cruz', 'Roberto P. Delacruz']);
    assert.equal(next.items[3].nextAppointment, null);
    const reg = await search('sort=registered');
    assert.deepEqual(reg.items.map((i) => i.registeredOn), [daysAgo(90), daysAgo(150), daysAgo(300), daysAgo(400), daysAgo(500)]);
    assert.deepEqual(names(await search('sort=bogus')), names(await search('')));
  });

  it('FR-2: paginates with limit/offset (clamped)', async () => {
    const page = await search('limit=2&offset=1');
    assert.equal(page.total, 5);
    assert.deepEqual(names(page), ['Mateo L. Dela Cruz', 'Roberto P. Delacruz']);
    assert.equal((await search('limit=0')).items.length, 5);
    assert.equal((await search('limit=1&offset=-3')).items[0].fullName, 'Katrina M. Dela Cruz');
  });

  it('NFR-SEC2: searches are audited without storing the query text', async () => {
    await search('q=Villanueva');
    const [entry] = env.ctx.audit.list({ action: 'SEARCH' });
    assert.equal(entry.details.queryLength, 'Villanueva'.length);
    assert.equal(entry.details.results, 1);
    assert.ok(!JSON.stringify(entry).includes('Villanueva'));
  });
});

describe('Service: search speed with 10,000 patients (NFR-P2)', () => {
  let built;
  before(() => { built = buildApp(); });
  after(() => built.cleanup());

  it('NFR-P2: a fuzzy query over 10,000 records finishes in under 300 ms', async () => {
    const { ctx } = built;
    const user = await ctx.services.auth.createUser({ username: 'bench', displayName: 'Bench', role: 'frontdesk', password: 'Speed#Test-2026' }, null);
    const first = ['Mateo', 'Clara', 'Antonio', 'Katrina', 'Roberto', 'Isabel', 'Jose', 'Andrea', 'Miguel', 'Patricia'];
    const last = ['Dela Cruz', 'Santos', 'Reyes', 'Garcia', 'Mendoza', 'Bautista', 'Villanueva', 'Ramos', 'Castillo', 'Aquino', 'Delos Santos'];
    const insert = ctx.db.prepare(`INSERT INTO patients (id, year, seq, data_enc, registered_on, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = Date.now();
    ctx.db.exec('BEGIN');
    for (let i = 1; i <= 10000; i++) {
      const profile = { lastName: last[i % last.length], firstName: first[(i * 7) % first.length], middleName: first[(i * 3) % first.length],
        dateOfBirth: '1990-01-01', sex: 'Female', address: 'Makati', contactNumber: '', allergies: '' };
      insert.run(`PT-2020-${String(i).padStart(5, '0')}`, 2020, i, ctx.vault.encryptJson(profile), '2020-01-01', now, user.id, now, user.id);
    }
    ctx.db.exec('COMMIT');
    ctx.services.patients.load();
    assert.equal(ctx.services.patients.cache.size, 10000);
    const p = ctx.services.patients;
    p.search({ q: 'warm up' });
    for (const q of ['dela crz', 'vilanueva', 'mateo santos', 'PT-2020-09999']) {
      const r = p.search({ q });
      assert.ok(r.total > 0, q);
      assert.ok(r.tookMs < 300, `"${q}" took ${r.tookMs} ms`);
    }
  });
});
