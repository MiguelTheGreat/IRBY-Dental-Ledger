'use strict';
// NFR-PO2 export/import round trip, TC-01 encrypted daily backups + restore, NFR-S2 trash retention and purge.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { BackupService } = require('../server/services/backup');
const { TransferService, FORMAT, FORMAT_VERSION } = require('../server/services/transfer');
const { parsePatientId, displayName } = require('../server/services/patients');
const { Vault } = require('../server/lib/crypto');
const { compactStamp } = require('../server/lib/dates');
const { buildApp, patientBody, jpegDataUrl, actorFrom, PNG, JPEG, PASSWORDS, USERNAMES, tmpDir, rmDir, daysAgo, daysAhead } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;

async function makeStaff(ctx, roles = ['admin', 'dentist', 'frontdesk']) {
  const names = { admin: 'Clinic Administrator', dentist: 'Dr. Ana Reyes', frontdesk: 'Maria Santos' };
  const out = {};
  for (const role of roles) {
    const user = await ctx.services.auth.createUser({ username: USERNAMES[role], displayName: names[role], role, password: PASSWORDS[role] }, null);
    out[role] = actorFrom(user);
  }
  return out;
}

/** A clinic with a bit of everything: portraits, ledger (incl. voided), appointments, photos, marks, a deleted patient. */
function seedClinic(ctx, staff) {
  const s = ctx.services;
  const desk = staff.frontdesk;
  const doc = staff.dentist;
  const mateo = s.patients.create(patientBody({ portrait: jpegDataUrl(1500), registrationDate: daysAgo(400) }), desk);
  s.patients.setPortrait(mateo.id, 'data:image/png;base64,' + PNG.toString('base64'), desk); // old portrait soft-deleted
  const clara = s.patients.create(patientBody({ profile: { lastName: 'Santos', firstName: 'Clara', middleName: '', allergies: '' } }), desk);
  const gone = s.patients.create(patientBody({ profile: { lastName: 'Gone', firstName: 'Ghost' } }), desk);

  const e1 = s.ledger.create(mateo.id, { visitDate: daysAgo(30), procedure: 'Composite #16 (MO)', fee: '2000', paid: '500',
    nextReturn: { date: daysAhead(10), time: '10:30', reason: 'Composite check' } }, desk);
  s.ledger.create(mateo.id, { visitDate: daysAgo(5), procedure: 'Payment on account', fee: 0, paid: 1500 }, desk);
  const wrong = s.ledger.create(mateo.id, { visitDate: daysAgo(4), procedure: 'Wrong entry', fee: 999, paid: 0 }, desk);
  s.ledger.void(wrong.entryId, 'Typed on the wrong chart', desk);
  s.ledger.update(e1.entryId, { visitDate: daysAgo(30), procedure: 'Composite #16 (MOD)', fee: '2500', paid: '500' }, doc);
  s.ledger.create(clara.id, { visitDate: daysAgo(2), procedure: 'Consultation', fee: 500, paid: 0 }, desk);

  const appt = s.appointments.create(clara.id, { date: daysAhead(3) }, desk);
  s.appointments.update(appt.id, { status: 'cancelled' }, desk);
  s.appointments.create(clara.id, { date: daysAhead(4), time: '15:00', reason: 'Re-book' }, desk);

  const photo = s.chart.addPhoto(mateo.id, { buffer: PNG, view: 'upper-occlusal', label: 'Before', takenOn: daysAgo(30), width: 800, height: 600 }, doc);
  const photo2 = s.chart.addPhoto(mateo.id, { buffer: JPEG, view: 'frontal' }, doc);
  s.chart.deletePhoto(photo2.id, doc);
  s.chart.addMark(mateo.id, { tooth: 16, surfaces: ['M', 'O'], condition: 'Co', photoId: photo.id, x: 0.4, y: 0.6, note: 'Shade A2' }, doc);
  s.chart.addMark(mateo.id, { tooth: 18, condition: 'M' }, doc);
  const bad = s.chart.addMark(mateo.id, { tooth: 21, condition: 'D' }, doc);
  s.chart.deleteMark(bad.id, doc);
  s.ledger.create(gone.id, { visitDate: daysAgo(1), procedure: 'Cleaning', fee: 1200, paid: 1200 }, desk);
  s.patients.softDelete(gone.id, doc);
  return { mateo, clara, gone, photo };
}

const withoutStamp = ({ exportedAt, ...rest }) => rest;

describe('Transfer: JSON export -> import round trip (NFR-PO2)', () => {
  let a, b, staffA, staffB, seed, dataA;
  before(async () => {
    a = buildApp();
    b = buildApp();
    staffA = await makeStaff(a.ctx);
    seed = seedClinic(a.ctx, staffA);
    // The importing clinic has the same staff usernames (user ids differ).
    await b.ctx.services.auth.createUser({ username: 'placeholder', displayName: 'Shift ids', role: 'frontdesk', password: 'Shift#User-Ids-26' }, null);
    staffB = await makeStaff(b.ctx);
    dataA = JSON.parse(JSON.stringify(a.ctx.services.transfer.exportAll())); // as written to and read from a file
  });
  after(() => { a.cleanup(); b.cleanup(); });

  it('NFR-PO2: export contains every record, including soft-deleted ones', () => {
    assert.equal(dataA.format, FORMAT);
    assert.equal(dataA.formatVersion, FORMAT_VERSION);
    assert.equal(dataA.includesFiles, true);
    assert.ok(!Number.isNaN(Date.parse(dataA.exportedAt)));
    assert.deepEqual(dataA.patients.map((p) => p.id), [seed.mateo.id, seed.clara.id, seed.gone.id]);
    const [m, c, g] = dataA.patients;
    assert.equal(m.ledger.length, 3);
    assert.equal(m.ledger.find((e) => e.deleteReason).deleteReason, 'Typed on the wrong chart');
    assert.equal(m.ledger[0].updatedBy, 'dr.reyes');
    assert.equal(m.portrait.mime, 'image/png');
    assert.equal(Buffer.from(m.portrait.data, 'base64').equals(PNG), true);
    assert.equal(m.chart.photos.length, 2);
    assert.ok(m.chart.photos[1].deletedAt);
    assert.equal(m.chart.marks.length, 3);
    assert.equal(m.appointments.length, 1);
    assert.equal(c.appointments.length, 2);
    assert.equal(c.appointments[0].reason, null);
    assert.ok(g.deletedAt);
    assert.equal(g.ledger.length, 1);
    assert.equal(m.consents[0].recordedBy, 'desk.maria');
  });

  it('NFR-PO2: importing into a fresh clinic reproduces the same data', () => {
    const counts = b.ctx.services.transfer.importData(dataA, staffB.admin);
    assert.deepEqual(counts, { patients: 3, ledger: 5, appointments: 3, photos: 2, marks: 3, files: 3, skippedFiles: 0 });
    const dataB = b.ctx.services.transfer.exportAll();
    assert.deepEqual(dataB.patients, dataA.patients);
    assert.deepEqual(withoutStamp(JSON.parse(JSON.stringify(dataB))), withoutStamp(dataA));
  });

  it('NFR-PO2: the imported clinic is fully usable', () => {
    const s = b.ctx.services;
    assert.equal(s.patients.cache.size, 2); // deleted patient stays in the trash
    const detail = s.patients.detail(seed.mateo.id);
    assert.equal(detail.fullName, 'Mateo L. Dela Cruz');
    assert.equal(detail.balanceCents, 50000);
    assert.equal(detail.nextAppointment.date, daysAhead(10));
    assert.deepEqual(s.patients.portrait(seed.mateo.id).buffer, PNG);
    assert.equal(s.patients.search({ q: 'dela crz' }).total, 1);
    assert.deepEqual(s.chart.photoImage(seed.photo.id).buffer, PNG);
    assert.equal(s.ledger.list(seed.mateo.id).entries[0].createdBy, 'Maria Santos');
    const trash = s.trash.list().map((i) => i.type).sort();
    assert.deepEqual(trash, ['ledger', 'mark', 'patient', 'photo']);
    const [imp] = b.ctx.audit.list({ action: 'IMPORT' });
    assert.equal(imp.username, 'admin');
    assert.equal(imp.details.patients, 3);
    assert.equal(b.ctx.audit.verify().ok, true);
    // New registrations continue after the imported sequence.
    const next = s.patients.create(patientBody({ profile: { lastName: 'New' } }), staffB.frontdesk);
    assert.equal(parsePatientId(next.id).seq, 4);
  });

  it('NFR-PO2: re-importing the same file is idempotent (no duplicate consents)', () => {
    const counts = b.ctx.services.transfer.importData(dataA, staffB.admin);
    assert.equal(counts.patients, 3);
    const again = b.ctx.services.transfer.exportAll().patients.filter((p) => dataA.patients.some((q) => q.id === p.id));
    assert.deepEqual(again, dataA.patients);
    assert.equal(b.ctx.db.prepare('SELECT COUNT(*) AS n FROM consents WHERE patient_id = ?').get(seed.mateo.id).n, 1);
  });

  it('NFR-PO2: unknown staff usernames import as unattributed', async () => {
    const c = buildApp();
    try {
      const admin = (await makeStaff(c.ctx, ['admin'])).admin;
      c.ctx.services.transfer.importData(dataA, admin);
      const [p] = c.ctx.services.transfer.exportAll({ patientId: seed.mateo.id }).patients;
      assert.equal(p.createdBy, null);
      assert.equal(p.ledger[0].updatedBy, null);
      assert.equal(p.consents[0].recordedBy, null);
      assert.deepEqual({ ...p, createdBy: undefined, updatedBy: undefined, ledger: undefined, appointments: undefined, chart: undefined, consents: undefined },
        { ...dataA.patients[0], createdBy: undefined, updatedBy: undefined, ledger: undefined, appointments: undefined, chart: undefined, consents: undefined });
    } finally {
      c.cleanup();
    }
  });

  it('NFR-PO2: a files-excluded export imports records and counts skipped files', async () => {
    const lite = JSON.parse(JSON.stringify(a.ctx.services.transfer.exportAll({ includeFiles: false })));
    assert.equal(lite.includesFiles, false);
    assert.equal(lite.patients[0].portrait.data, undefined);
    const d = buildApp();
    try {
      const admin = (await makeStaff(d.ctx, ['admin'])).admin;
      const counts = d.ctx.services.transfer.importData(lite, admin);
      assert.equal(counts.files, 0);
      assert.equal(counts.skippedFiles, 3);
      assert.equal(counts.patients, 3);
    } finally {
      d.cleanup();
    }
  });

  it('NFR-PO2: rejects foreign files, bad IDs and checksum mismatches atomically', () => {
    const t = b.ctx.services.transfer;
    const actor = staffB.admin;
    assert.throws(() => t.importData(null, actor), /Not an irby-dental-ledger v1 export/);
    assert.throws(() => t.importData({ format: FORMAT, formatVersion: 1 }, actor), (e) => e.status === 400 && e.code === 'BAD_IMPORT');
    const before = b.ctx.db.prepare('SELECT COUNT(*) AS n FROM patients').get().n;
    const fresh = structuredClone(dataA.patients[1]);
    fresh.id = 'PT-2031-0007';
    const broken = structuredClone(dataA.patients[0]);
    broken.chart.photos[0].file.sha256 = '0'.repeat(64);
    assert.throws(() => t.importData({ ...dataA, patients: [fresh, broken] }, actor), /checksum/);
    assert.equal(b.ctx.db.prepare('SELECT COUNT(*) AS n FROM patients').get().n, before, 'nothing from a failed import is kept');
    assert.throws(() => t.importData({ ...dataA, patients: [{ id: 'PT-2031-0008' }] }, actor), /Invalid patient record/);
    assert.throws(() => t.exportAll({ patientId: 'PT-0000-0000' }), /not found/);
  });

  it('CSV helpers guard against formula injection', () => {
    assert.equal(TransferService.csvCell(null), '');
    assert.equal(TransferService.csvCell(0), '0');
    assert.equal(TransferService.csvCell('=1+1'), "'=1+1");
    assert.equal(TransferService.csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(TransferService.csvCell('a\nb'), '"a\nb"');
    assert.equal(TransferService.csvCell('\tcmd'), "'\tcmd");
    assert.equal(TransferService.toCsv(['a', 'b'], [[1, 'x,y']]), '﻿a,b\r\n1,"x,y"\r\n');
  });

  it('patient helpers', () => {
    assert.deepEqual(parsePatientId('PT-2026-0042'), { year: 2026, seq: 42 });
    assert.deepEqual(parsePatientId('PT-2026-12345'), { year: 2026, seq: 12345 });
    assert.equal(parsePatientId('PT-26-1'), null);
    assert.equal(parsePatientId(null), null);
    assert.equal(displayName({ firstName: 'Ana', middleName: ' maria ', lastName: 'Cruz' }), 'Ana M. Cruz');
    assert.equal(displayName({ firstName: 'Ana', middleName: '', lastName: 'Cruz' }), 'Ana Cruz');
  });
});

describe('Backups: daily encrypted Backup_YYYYMMDD_Secure.bak (TC-01)', () => {
  let app, staff, seed;
  const backup = () => app.ctx.services.backup;
  before(async () => {
    app = buildApp();
    staff = await makeStaff(app.ctx);
    seed = seedClinic(app.ctx, staff);
  });
  after(() => app.cleanup());

  it('TC-01: names backups by local date', () => {
    assert.equal(BackupService.fileName(new Date(2026, 0, 9)), 'Backup_20260109_Secure.bak');
    assert.equal(BackupService.fileName(), `Backup_${compactStamp()}_Secure.bak`);
  });

  it('TC-01: no backups listed before the first run', () => {
    assert.equal(fs.existsSync(app.ctx.config.backupDir), false);
    assert.deepEqual(backup().list(), []);
  });

  it('TC-01: run() writes an encrypted snapshot that decrypts to a working SQLite database', () => {
    const made = backup().run({ reason: 'test', actor: staff.admin });
    assert.equal(made.name, `Backup_${compactStamp()}_Secure.bak`);
    const file = path.join(app.ctx.config.backupDir, made.name);
    assert.equal(fs.statSync(file).size, made.size);
    assert.deepEqual(fs.readdirSync(app.ctx.config.backupDir), [made.name], 'no temp snapshot or .part files left behind');
    const plain = BackupService.decrypt(file, app.ctx.vault);
    assert.equal(plain.subarray(0, 15).toString(), 'SQLite format 3');

    const dir = tmpDir('irby-restore-');
    try {
      const restoredFile = path.join(dir, 'restored.db');
      fs.writeFileSync(restoredFile, plain);
      const db = new DatabaseSync(restoredFile);
      const rows = db.prepare('SELECT id, data_enc FROM patients ORDER BY seq').all();
      assert.deepEqual(rows.map((r) => r.id), [seed.mateo.id, seed.clara.id, seed.gone.id]);
      assert.equal(app.ctx.vault.decryptJson(rows[0].data_enc).lastName, 'Dela Cruz');
      // The snapshot is taken just before the BACKUP audit row is appended.
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n - 1);
      db.close();
    } finally {
      rmDir(dir);
    }
    const [audit] = app.ctx.audit.list({ action: 'BACKUP' });
    assert.deepEqual(audit.details, { reason: 'test', bytes: made.size });
    assert.equal(audit.entityId, made.name);
  });

  it('TC-01: only the clinic key can open a backup', () => {
    const file = path.join(app.ctx.config.backupDir, BackupService.fileName());
    assert.throws(() => BackupService.decrypt(file, new Vault(Buffer.alloc(32, 9))));
    const junk = path.join(app.ctx.config.backupDir, 'junk.bin');
    fs.writeFileSync(junk, 'SQLite format 3\0 plain copy');
    assert.throws(() => BackupService.decrypt(junk, app.ctx.vault), /Not an IRBY backup file/);
    fs.rmSync(junk);
  });

  it('TC-01: ensureDaily() makes at most one backup per day', () => {
    assert.equal(backup().ensureDaily(), null);
    fs.rmSync(path.join(app.ctx.config.backupDir, BackupService.fileName()));
    const made = backup().ensureDaily();
    assert.equal(made.name, BackupService.fileName());
    const [audit] = app.ctx.audit.list({ action: 'BACKUP' });
    assert.equal(audit.details.reason, 'daily');
    assert.equal(audit.username, null);
  });

  it('TC-01: keeps only the newest BACKUP_KEEP backups and ignores other files', () => {
    const dir = app.ctx.config.backupDir;
    for (const n of ['Backup_20200101_Secure.bak', 'Backup_20200102_Secure.bak', 'Backup_20200103_Secure.bak', 'notes.txt']) {
      fs.writeFileSync(path.join(dir, n), 'old');
    }
    app.ctx.config.backupKeep = 2;
    try {
      backup().run();
      assert.deepEqual(backup().list().map((x) => x.name), [BackupService.fileName(), 'Backup_20200103_Secure.bak']);
      assert.ok(fs.existsSync(path.join(dir, 'notes.txt')));
      assert.equal(backup().list()[0].size > 3, true);
    } finally {
      app.ctx.config.backupKeep = 30;
    }
  });
});

describe('Trash retention and purge (NFR-S2)', () => {
  let app, staff, seed;
  const count = (table) => app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  before(async () => {
    app = buildApp();
    staff = await makeStaff(app.ctx);
    seed = seedClinic(app.ctx, staff);
  });
  after(() => app.cleanup());

  it('NFR-S2: the trash lists every soft-deleted record type with its purge date', () => {
    const items = app.ctx.services.trash.list();
    assert.deepEqual(items.map((i) => i.type).sort(), ['ledger', 'mark', 'patient', 'photo']);
    for (const i of items) {
      assert.ok(i.purgeOn - i.deletedAt === 30 * DAY);
      assert.ok(i.deletedBy);
    }
    const sorted = items.map((i) => i.deletedAt);
    assert.deepEqual(sorted, [...sorted].sort((x, y) => y - x));
    assert.equal(items.find((i) => i.type === 'patient').patientName, 'Ghost L. Gone');
    assert.equal(app.ctx.services.trash.patientName('PT-0000-0000'), 'PT-0000-0000');
  });

  it('NFR-S2: nothing is purged within 30 days', () => {
    const auditBefore = count('audit_log');
    const counts = app.ctx.services.trash.purgeExpired(Date.now() + 29 * DAY);
    assert.ok(Object.values(counts).every((n) => n === 0));
    assert.equal(count('audit_log'), auditBefore, 'an empty purge is not logged');
    assert.equal(app.ctx.services.trash.list().length, 4);
  });

  it('NFR-S2: records deleted more than 30 days ago are purged permanently', () => {
    const replacedPortrait = app.ctx.db.prepare("SELECT id FROM files WHERE patient_id = ? AND kind = 'portrait' AND deleted_at IS NOT NULL").get(seed.mateo.id);
    assert.ok(replacedPortrait);
    const counts = app.ctx.services.trash.purgeExpired(Date.now() + 31 * DAY);
    assert.equal(counts.chart_marks, 1);
    assert.equal(counts.chart_photos, 1);
    assert.equal(counts.appointments, 0);
    assert.equal(counts.ledger_entries, 1);
    assert.equal(counts.patients, 1);
    assert.ok(counts.files >= 1);
    assert.deepEqual(app.ctx.services.trash.list(), []);
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM patients WHERE id = ?').get(seed.gone.id).n, 0);
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries WHERE patient_id = ?').get(seed.gone.id).n, 0, 'cascade');
    assert.equal(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM files WHERE id = ?').get(replacedPortrait.id).n, 0, 'replaced portrait purged');
    const [purge] = app.ctx.audit.list({ action: 'PURGE' });
    assert.equal(purge.details.patients, 1);
    assert.equal(purge.details.retentionDays, 30);
    assert.equal(app.ctx.audit.verify().ok, true);
    // live records are untouched
    assert.equal(app.ctx.services.ledger.list(seed.mateo.id).entries.length, 2);
    assert.equal(app.ctx.services.chart.list(seed.mateo.id).marks.length, 2);
    assert.deepEqual(app.ctx.services.chart.photoImage(seed.photo.id).buffer, PNG);
    assert.ok(count('files') >= 2);
  });

  it('NFR-S2: purging a deleted chart photo also removes its encrypted image', () => {
    const orphans = app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM files f WHERE f.kind = 'chart_photo'
      AND NOT EXISTS (SELECT 1 FROM chart_photos p WHERE p.file_id = f.id)`).get().n;
    assert.equal(orphans, 0);
  });
});
