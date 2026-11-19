'use strict';
// FR-3 photo-based chart, FR-4 PDA marks (FDI tooth + surfaces + condition), FR-7 dentist-only chart edits, NFR-S2 restore.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startEnv, setupStaff, patientBody, PNG, JPEG, daysAgo, daysAhead, todayISO } = require('./helpers');

describe('API: dental photo chart (FR-3, FR-4, FR-7)', () => {
  let env, staff, patient, other, photo, otherPhoto, mark;
  const doc = () => staff.dentist.cookie;
  const desk = () => staff.frontdesk.cookie;
  const upload = (id, qs, raw = PNG, cookie = doc(), type = 'image/png') =>
    env.api.post(`/api/patients/${id}/chart/photos${qs ? '?' + qs : ''}`, { cookie, raw, type });
  const addMark = (body, id = patient.id, cookie = doc()) => env.api.post(`/api/patients/${id}/chart/marks`, { cookie, body });
  const chart = async (id = patient.id, cookie = doc()) => (await env.api.get(`/api/patients/${id}/chart`, { cookie })).body;
  const denied = () => env.ctx.audit.list({ action: 'DENIED' });

  before(async () => {
    env = await startEnv({ env: { PHOTO_MAX_BYTES: '4096' } });
    staff = await setupStaff(env);
    patient = (await env.api.post('/api/patients', { cookie: desk(), body: patientBody() })).body;
    other = (await env.api.post('/api/patients', { cookie: desk(), body: patientBody({ profile: { lastName: 'Santos', firstName: 'Clara' } }) })).body;
  });
  after(() => env.close());

  it('FR-3: a dentist attaches an intraoral photo', async () => {
    const r = await upload(patient.id, `view=upper-occlusal&label=Before%20treatment&takenOn=${daysAgo(1)}&width=800&height=600.4`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    photo = r.body;
    assert.equal(photo.view, 'upper-occlusal');
    assert.equal(photo.label, 'Before treatment');
    assert.equal(photo.takenOn, daysAgo(1));
    assert.equal(photo.width, 800);
    assert.equal(photo.height, 600);
    assert.equal(photo.createdBy, 'Dr. Ana Reyes');
    const plain = await upload(other.id, 'width=abc', JPEG, doc(), 'image/jpeg');
    assert.equal(plain.status, 201);
    otherPhoto = plain.body;
    assert.equal(otherPhoto.view, 'other');
    assert.equal(otherPhoto.label, '');
    assert.equal(otherPhoto.takenOn, todayISO());
    assert.equal(otherPhoto.width, null);
    const [audit] = env.ctx.audit.list({ action: 'CREATE', patientId: patient.id }).filter((e) => e.entity === 'chart_photo');
    assert.deepEqual(audit.details, { view: 'upper-occlusal', bytes: PNG.length });
  });

  it('FR-3: photos are stored encrypted and served back unchanged', async () => {
    const row = env.ctx.db.prepare('SELECT f.data_enc FROM chart_photos p JOIN files f ON f.id = p.file_id WHERE p.id = ?').get(photo.id);
    assert.ok(!Buffer.from(row.data_enc).includes(PNG.subarray(0, 8)));
    const img = await env.api.get(`/api/chart/photos/${photo.id}/image`, { cookie: desk() });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('cache-control'), 'private, no-store');
    assert.equal(img.headers.get('content-disposition'), null);
    assert.deepEqual(img.body, PNG);
    assert.equal((await env.api.get('/api/chart/photos/nope/image', { cookie: desk() })).status, 404);
  });

  it('FR-3: photo uploads are validated by content, view, date and size', async () => {
    const view = await upload(patient.id, 'view=panoramic');
    assert.equal(view.status, 422);
    assert.ok(view.body.fields.view);
    const date = await upload(patient.id, `takenOn=${daysAhead(1)}&label=${'x'.repeat(121)}`);
    assert.ok(date.body.fields.takenOn && date.body.fields.label);
    const fake = await upload(patient.id, '', Buffer.from('this is plainly not a PNG file'));
    assert.equal(fake.status, 422);
    assert.match(fake.body.fields.image, /JPEG, PNG or WebP/);
    const noBody = await env.api.post(`/api/patients/${patient.id}/chart/photos`, { cookie: doc() });
    assert.equal(noBody.status, 400);
    assert.equal(noBody.body.error, 'NO_IMAGE');
    const json = await env.api.post(`/api/patients/${patient.id}/chart/photos`, { cookie: doc(), body: { image: 'data' } });
    assert.equal(json.status, 400);
    const gif = await upload(patient.id, '', PNG, doc(), 'image/gif');
    assert.equal(gif.status, 400);
    const big = await upload(patient.id, '', Buffer.concat([PNG, Buffer.alloc(4500)]));
    assert.equal(big.status, 413);
    assert.equal(big.body.error, 'PHOTO_TOO_LARGE');
    const huge = await upload(patient.id, '', Buffer.concat([PNG, Buffer.alloc(6000)]));
    assert.equal(huge.status, 413);
    assert.equal(huge.body.error, 'TOO_LARGE');
    assert.equal((await upload('PT-1999-0001', '')).status, 404);
    assert.equal((await chart()).photos.length, 1);
  });

  it('FR-7: front desk cannot edit the chart (403 + DENIED audit row)', async () => {
    const before = denied().length;
    const r = await upload(patient.id, 'view=frontal', PNG, desk());
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'FORBIDDEN');
    assert.equal(r.body.permission, 'chart.write');
    const m = await addMark({ tooth: 16, surfaces: ['M', 'O'], condition: 'D' }, patient.id, desk());
    assert.equal(m.status, 403);
    const admin = await addMark({ tooth: 16, condition: 'D' }, patient.id, staff.admin.cookie);
    assert.equal(admin.status, 403);
    assert.match(admin.body.message, /Administrator/);
    const rows = denied();
    assert.equal(rows.length, before + 3);
    const [adminRow, markRow, photoRow] = rows;
    assert.equal(adminRow.username, 'admin');
    assert.equal(markRow.username, 'desk.maria');
    assert.equal(markRow.entityId, 'chart.write');
    assert.equal(markRow.patientId, patient.id);
    assert.deepEqual(markRow.details, { method: 'POST', path: `/api/patients/${patient.id}/chart/marks` });
    assert.equal(photoRow.details.path, `/api/patients/${patient.id}/chart/photos`); // query string not logged
    assert.equal((await chart()).marks.length, 0);
  });

  it('FR-7: front desk can still view the chart', async () => {
    const r = await env.api.get(`/api/patients/${patient.id}/chart`, { cookie: desk() });
    assert.equal(r.status, 200);
    assert.equal(r.body.photos.length, 1);
    assert.ok(env.ctx.audit.list({ action: 'READ', patientId: patient.id }).some((e) => e.entity === 'chart' && e.details.photos === 1));
    assert.equal((await env.api.get('/api/patients/PT-1999-0001/chart', { cookie: desk() })).status, 404);
  });

  it('FR-4: records a PDA mark with surfaces in canonical M-O-D-F-L order', async () => {
    const r = await addMark({ tooth: 16, surfaces: ['O', 'm', 'O'], condition: 'D', note: 'Deep occlusal caries' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    mark = r.body;
    assert.equal(mark.tooth, 16);
    assert.deepEqual(mark.surfaces, ['M', 'O']);
    assert.equal(mark.condition, 'D');
    assert.equal(mark.photoId, null);
    assert.equal(mark.x, null);
    assert.equal(mark.note, 'Deep occlusal caries');
    assert.equal(mark.createdBy, 'Dr. Ana Reyes');
    const [audit] = env.ctx.audit.list({ action: 'CREATE', patientId: patient.id }).filter((e) => e.entity === 'chart_mark');
    assert.deepEqual(audit.details, { tooth: 16, surfaces: 'M,O', condition: 'D', pinned: false });
  });

  it('FR-4: surfaces may be a comma string; whole-tooth conditions drop surfaces', async () => {
    const s = await addMark({ tooth: '26', surfaces: 'd, o', condition: 'Am' });
    assert.deepEqual(s.body.surfaces, ['O', 'D']);
    assert.equal(s.body.tooth, 26);
    const whole = await addMark({ tooth: 18, surfaces: ['M'], condition: 'M' });
    assert.deepEqual(whole.body.surfaces, []);
    const primary = await addMark({ tooth: 55, condition: 'X' });
    assert.equal(primary.status, 201);
  });

  it('FR-4: marks can be pinned to a position on the patient\'s photo', async () => {
    const r = await addMark({ tooth: 14, surfaces: ['D'], condition: 'Co', photoId: photo.id, x: 0.25, y: '0.5' });
    assert.equal(r.status, 201);
    assert.equal(r.body.photoId, photo.id);
    assert.equal(r.body.x, 0.25);
    assert.equal(r.body.y, 0.5);
    const unpinned = await addMark({ tooth: 15, condition: 'D', x: 0.3, y: 0.3 });
    assert.equal(unpinned.body.x, null, 'a position without a photo is ignored');
    const halfPos = await addMark({ tooth: 13, condition: 'D', photoId: photo.id, x: 0.3 });
    assert.equal(halfPos.body.x, null);
    assert.equal(halfPos.body.photoId, photo.id);
  });

  it('FR-4: invalid teeth, conditions, surfaces, positions and photos are rejected', async () => {
    const r = await addMark({ tooth: 19, surfaces: ['Z'], condition: 'ZZ', photoId: photo.id, x: 1.5, y: 0.5, note: 'n'.repeat(301) });
    assert.equal(r.status, 422);
    assert.deepEqual(Object.keys(r.body.fields).sort(), ['condition', 'note', 'position', 'surfaces', 'tooth']);
    const wrongPatient = await addMark({ tooth: 11, condition: 'D', photoId: otherPhoto.id });
    assert.match(wrongPatient.body.fields.photoId, /does not belong/);
    const missingPhoto = await addMark({ tooth: 11, condition: 'D', photoId: 'nope' });
    assert.ok(missingPhoto.body.fields.photoId);
    for (const tooth of [undefined, 0, 10, 49, 56, 'abc']) {
      assert.equal((await addMark({ tooth, condition: 'D' })).status, 422, String(tooth));
    }
    assert.equal((await env.api.post(`/api/patients/${patient.id}/chart/marks`, { cookie: doc() })).status, 422);
    assert.equal((await addMark({ tooth: 11, condition: 'D' }, 'PT-1999-0001')).status, 404);
  });

  it('FR-4: editing a mark keeps unchanged fields and audits before/after', async () => {
    const r = await env.api.put(`/api/chart/marks/${mark.id}`, { cookie: doc(), body: { condition: 'Co', photoId: photo.id, x: 0.1, y: 0.2 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.condition, 'Co');
    assert.deepEqual(r.body.surfaces, ['M', 'O']);
    assert.equal(r.body.note, 'Deep occlusal caries');
    assert.equal(r.body.x, 0.1);
    const [upd] = env.ctx.audit.list({ action: 'UPDATE', patientId: patient.id }).filter((e) => e.entity === 'chart_mark');
    assert.deepEqual(upd.details.before, { tooth: 16, surfaces: 'M,O', condition: 'D', x: null, y: null });
    assert.deepEqual(upd.details.after, { tooth: 16, surfaces: 'M,O', condition: 'Co', x: 0.1, y: 0.2 });
    const noteOnly = await env.api.put(`/api/chart/marks/${mark.id}`, { cookie: doc(), body: { note: '' } });
    assert.equal(noteOnly.body.note, '');
    assert.equal(noteOnly.body.x, 0.1);
    const clear = await env.api.put(`/api/chart/marks/${mark.id}`, { cookie: doc(), body: { surfaces: [], photoId: null } });
    assert.deepEqual(clear.body.surfaces, []);
    assert.equal(clear.body.photoId, null);
    assert.equal(clear.body.x, null);
    const restoreSurfaces = await env.api.put(`/api/chart/marks/${mark.id}`, { cookie: doc(), body: { surfaces: ['M', 'O'] } });
    assert.deepEqual(restoreSurfaces.body.surfaces, ['M', 'O']);
    const bad = await env.api.put(`/api/chart/marks/${mark.id}`, { cookie: doc(), body: { tooth: 99 } });
    assert.equal(bad.status, 422);
    assert.equal((await env.api.put(`/api/chart/marks/${mark.id}`, { cookie: doc() })).status, 200);
    assert.equal((await env.api.put('/api/chart/marks/nope', { cookie: doc(), body: {} })).status, 404);
    const deskEdit = await env.api.put(`/api/chart/marks/${mark.id}`, { cookie: desk(), body: { tooth: 17 } });
    assert.equal(deskEdit.status, 403);
    assert.equal(denied()[0].patientId, null);
  });

  it('NFR-S2: a deleted mark goes to the trash and can be restored', async () => {
    const count = (await chart()).marks.length;
    assert.equal((await env.api.del(`/api/chart/marks/${mark.id}`, { cookie: doc() })).status, 200);
    assert.equal((await chart()).marks.length, count - 1);
    assert.equal((await env.api.del(`/api/chart/marks/${mark.id}`, { cookie: doc() })).status, 404);
    assert.equal((await env.api.del(`/api/chart/marks/${mark.id}`, { cookie: desk() })).status, 403);
    const [del] = env.ctx.audit.list({ action: 'DELETE', patientId: patient.id });
    assert.deepEqual(del.details, { soft: true, tooth: 16, condition: 'Co' });
    const trash = await env.api.get('/api/trash', { cookie: doc() });
    const item = trash.body.items.find((i) => i.type === 'mark' && i.id === mark.id);
    assert.equal(item.summary, 'Tooth 16 (MO) · Co');
    assert.equal(item.deletedBy, 'Dr. Ana Reyes');
    const restored = await env.api.post(`/api/chart/marks/${mark.id}/restore`, { cookie: doc() });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.id, mark.id);
    assert.equal((await chart()).marks.length, count);
    assert.equal((await env.api.post('/api/chart/marks/nope/restore', { cookie: doc() })).status, 404);
    // and through the generic trash endpoint
    const whole = (await chart()).marks.find((m) => m.surfaces.length === 0 && m.tooth === 18);
    await env.api.del(`/api/chart/marks/${whole.id}`, { cookie: doc() });
    const t2 = await env.api.get('/api/trash', { cookie: doc() });
    assert.equal(t2.body.items.find((i) => i.id === whole.id).summary, 'Tooth 18 · M');
    assert.equal((await env.api.post(`/api/trash/mark/${whole.id}/restore`, { cookie: doc() })).status, 200);
  });

  it('FR-3: photo details can be edited; photos are soft-deleted and restorable', async () => {
    const upd = await env.api.put(`/api/chart/photos/${photo.id}`, { cookie: doc(), body: { label: 'After treatment', view: 'frontal' } });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.label, 'After treatment');
    assert.equal(upd.body.view, 'frontal');
    assert.equal(upd.body.takenOn, daysAgo(1));
    const [audit] = env.ctx.audit.list({ action: 'UPDATE', patientId: patient.id }).filter((e) => e.entity === 'chart_photo');
    assert.deepEqual(audit.details, { before: { view: 'upper-occlusal', takenOn: daysAgo(1) }, after: { view: 'frontal', takenOn: daysAgo(1) } });
    assert.equal((await env.api.put(`/api/chart/photos/${photo.id}`, { cookie: doc(), body: { view: 'selfie' } })).status, 422);
    assert.equal((await env.api.put(`/api/chart/photos/${photo.id}`, { cookie: doc(), body: { label: '' } })).body.label, '');
    assert.equal((await env.api.put(`/api/chart/photos/${photo.id}`, { cookie: doc() })).status, 200);
    assert.equal((await env.api.put('/api/chart/photos/nope', { cookie: doc(), body: {} })).status, 404);

    assert.equal((await env.api.del(`/api/chart/photos/${photo.id}`, { cookie: doc() })).status, 200);
    assert.equal((await chart()).photos.length, 0);
    assert.equal((await env.api.get(`/api/chart/photos/${photo.id}/image`, { cookie: doc() })).status, 404);
    assert.equal((await env.api.del(`/api/chart/photos/${photo.id}`, { cookie: doc() })).status, 404);
    const pinToDeleted = await addMark({ tooth: 11, condition: 'D', photoId: photo.id, x: 0.5, y: 0.5 });
    assert.equal(pinToDeleted.status, 422);
    const trash = await env.api.get('/api/trash', { cookie: doc() });
    assert.match(trash.body.items.find((i) => i.type === 'photo').summary, /^Chart photo \(frontal, /);
    assert.equal((await env.api.post(`/api/chart/photos/${photo.id}/restore`, { cookie: doc() })).status, 200);
    assert.equal((await chart()).photos.length, 1);
    await env.api.del(`/api/chart/photos/${photo.id}`, { cookie: doc() });
    assert.equal((await env.api.post(`/api/trash/photo/${photo.id}/restore`, { cookie: doc() })).status, 200);
    assert.equal((await env.api.post('/api/chart/photos/nope/restore', { cookie: doc() })).status, 404);
  });

  it('chart images of a deleted patient are no longer served', async () => {
    const del = await env.api.del(`/api/patients/${other.id}`, { cookie: doc() });
    assert.equal(del.status, 200);
    assert.equal((await env.api.get(`/api/chart/photos/${otherPhoto.id}/image`, { cookie: doc() })).status, 404);
  });
});
