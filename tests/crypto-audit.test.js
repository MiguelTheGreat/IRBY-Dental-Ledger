'use strict';
// NFR-SEC2 tamper-evident audit trail, encryption at rest, password hashing,
// plus the small lib modules (db helpers, errors, images, clinic config, runtime config).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { Vault, loadOrCreateMasterKey, hashPassword, verifyPassword, sha256, randomToken, uuid } = require('../server/lib/crypto');
const { AuditLog } = require('../server/lib/audit');
const { openDatabase, transaction, nn, toBuffer } = require('../server/db');
const { HttpError, ValidationError, notFound, Checker, str } = require('../server/lib/errors');
const { sniffImage, decodeDataUrl } = require('../server/lib/images');
const { loadClinicConfig, validateSymbols, VALID_TEETH, SHAPES, FILLS } = require('../server/lib/clinicConfig');
const { loadConfig, ROOT } = require('../server/config');
const { tmpDir, rmDir, PNG, JPEG } = require('./helpers');

const KEY = crypto.randomBytes(32);

describe('crypto: Vault (encryption at rest)', () => {
  const vault = new Vault(KEY);

  it('derives separate data, backup and audit keys', () => {
    assert.equal(vault.dataKey.length, 32);
    assert.notDeepEqual(vault.dataKey, vault.backupKey);
    assert.notDeepEqual(vault.dataKey, vault.auditKey);
    assert.deepEqual(new Vault(KEY).dataKey, vault.dataKey); // deterministic per master key
  });

  it('round-trips buffers with a random IV', () => {
    const plain = Buffer.from('Patient: Mateo Dela Cruz, allergic to penicillin');
    const a = vault.encryptBuffer(plain);
    const b = vault.encryptBuffer(plain);
    assert.notDeepEqual(a, b);
    assert.equal(a[0], 1); // blob version
    assert.ok(!a.includes(plain));
    assert.deepEqual(vault.decryptBuffer(a), plain);
    assert.deepEqual(vault.decryptBuffer(new Uint8Array(a)), plain); // BLOB columns come back as Uint8Array
  });

  it('round-trips with an explicit key and rejects the wrong key', () => {
    const blob = vault.encryptBuffer(Buffer.from('backup'), vault.backupKey);
    assert.equal(vault.decryptBuffer(blob, vault.backupKey).toString(), 'backup');
    assert.throws(() => vault.decryptBuffer(blob));
  });

  it('detects tampered ciphertext (GCM auth tag)', () => {
    const blob = vault.encryptBuffer(Buffer.from('balance 1500'));
    blob[blob.length - 1] ^= 0xff;
    assert.throws(() => vault.decryptBuffer(blob));
  });

  it('rejects corrupt or unknown blobs', () => {
    assert.throws(() => vault.decryptBuffer(Buffer.alloc(10)), /corrupt/);
    const blob = vault.encryptBuffer(Buffer.from('x'));
    blob[0] = 9;
    assert.throws(() => vault.decryptBuffer(blob), /Unsupported/);
  });

  it('encrypts text and JSON, passing null through', () => {
    const t = vault.encryptText('Penicillin');
    assert.match(t, /^v1:/);
    assert.equal(vault.decryptText(t), 'Penicillin');
    assert.equal(vault.encryptText(null), null);
    assert.equal(vault.encryptText(undefined), null);
    assert.equal(vault.decryptText(null), null);
    assert.equal(vault.decryptText(vault.encryptText(42)), '42');
    assert.throws(() => vault.decryptText('plain text'), /Unsupported encrypted text/);
    const obj = { lastName: 'Dela Cruz', n: 1, nested: [1, 2] };
    assert.deepEqual(vault.decryptJson(vault.encryptJson(obj)), obj);
    assert.equal(vault.decryptJson(null), null);
  });

  it('HMAC is deterministic and key-dependent', () => {
    assert.equal(vault.hmac('abc'), vault.hmac('abc'));
    assert.match(vault.hmac('abc'), /^[0-9a-f]{64}$/);
    assert.notEqual(vault.hmac('abc'), new Vault(crypto.randomBytes(32)).hmac('abc'));
  });
});

describe('crypto: master key loading', () => {
  let dir;
  before(() => { dir = tmpDir('irby-key-'); });
  after(() => rmDir(dir));

  it('uses MASTER_KEY from the environment when set', () => {
    const file = path.join(dir, 'unused.key');
    const key = loadOrCreateMasterKey(file, { MASTER_KEY: KEY.toString('base64') });
    assert.deepEqual(key, KEY);
    assert.equal(fs.existsSync(file), false);
  });

  it('rejects a MASTER_KEY of the wrong length', () => {
    assert.throws(() => loadOrCreateMasterKey(path.join(dir, 'x.key'), { MASTER_KEY: Buffer.alloc(16).toString('base64') }), /32 bytes/);
  });

  it('creates a key file on first run and reuses it', () => {
    const file = path.join(dir, 'nested', 'master.key');
    const k1 = loadOrCreateMasterKey(file, {});
    assert.equal(k1.length, 32);
    assert.equal(fs.readFileSync(file, 'utf8'), k1.toString('base64') + '\n');
    assert.deepEqual(loadOrCreateMasterKey(file, {}), k1);
  });

  it('refuses a corrupt key file', () => {
    const file = path.join(dir, 'bad.key');
    fs.writeFileSync(file, 'c2hvcnQ=\n');
    assert.throws(() => loadOrCreateMasterKey(file, {}), /corrupt/);
  });
});

describe('crypto: passwords and tokens (NFR-SEC1)', () => {
  it('hashes passwords with scrypt and verifies them', async () => {
    const stored = await hashPassword('Molar#Crown-2026');
    assert.match(stored, /^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
    assert.notEqual(await hashPassword('Molar#Crown-2026'), stored); // random salt
    assert.equal(await verifyPassword('Molar#Crown-2026', stored), true);
    assert.equal(await verifyPassword('molar#crown-2026', stored), false);
  });

  it('treats malformed stored hashes as a failed match', async () => {
    assert.equal(await verifyPassword('x', 'bcrypt$whatever'), false);
    assert.equal(await verifyPassword('x', null), false);
    assert.equal(await verifyPassword('x', 'scrypt$1$2$3'), false);
  });

  it('sha256, randomToken and uuid', () => {
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(randomToken(8).length, 11);
    assert.notEqual(randomToken(), randomToken());
    assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('audit log (NFR-SEC2)', () => {
  let db, audit;
  const vault = new Vault(KEY);
  const user = { id: 7, username: 'dr.reyes', role: 'dentist' };

  before(() => {
    db = openDatabase(':memory:');
    audit = new AuditLog(db, vault);
  });
  after(() => db.close());

  it('NFR-SEC2: appends HMAC-chained rows starting from GENESIS', () => {
    const h1 = audit.append({ user, action: 'CREATE', entity: 'patient', entityId: 'PT-2026-0001', patientId: 'PT-2026-0001', details: { a: 1 }, ip: '10.0.0.5' });
    const h2 = audit.append({ action: 'LOGIN_FAILED', details: 'plain string detail' });
    audit.append({ user, action: 'READ', entity: 'ledger', entityId: 42, patientId: 'PT-2026-0002' });
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq').all();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].prev_hash, 'GENESIS');
    assert.equal(rows[0].hash, h1);
    assert.equal(rows[1].prev_hash, h1);
    assert.equal(rows[1].hash, h2);
    assert.equal(rows[1].user_id, null);
    assert.equal(rows[2].entity_id, '42');
    assert.deepEqual(audit.verify(), { ok: true, count: 3, brokenAtSeq: null });
  });

  it('NFR-SEC2: lists newest first, with filters and parsed details', () => {
    const all = audit.list();
    assert.deepEqual(all.map((r) => r.action), ['READ', 'LOGIN_FAILED', 'CREATE']);
    assert.deepEqual(all[2].details, { a: 1 });
    assert.equal(all[1].details, 'plain string detail');
    assert.equal(all[0].details, null);
    assert.equal(all[2].username, 'dr.reyes');
    assert.equal(all[2].ip, '10.0.0.5');
    assert.deepEqual(audit.list({ action: 'CREATE' }).map((r) => r.seq), [1]);
    assert.deepEqual(audit.list({ patientId: 'PT-2026-0002' }).map((r) => r.action), ['READ']);
    assert.equal(audit.list({ username: 'DR.REYES' }).length, 2); // case-insensitive
    assert.deepEqual(audit.list({ before: 3 }).map((r) => r.seq), [2, 1]);
    assert.equal(audit.list({ limit: 1 }).length, 1);
    assert.equal(audit.list({ limit: 'abc' }).length, 3);
    assert.equal(audit.list({ limit: -5 }).length, 1); // clamped to >= 1
  });

  it('NFR-SEC2: UPDATE and DELETE on audit_log are blocked by triggers', () => {
    assert.throws(() => db.prepare("UPDATE audit_log SET details = 'x' WHERE seq = 1").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM audit_log WHERE seq = 1').run(), /append-only/);
    assert.equal(audit.verify().ok, true);
  });

  it('NFR-SEC2: verify() detects a row edited outside the app', () => {
    db.exec('DROP TRIGGER audit_log_no_update');
    db.prepare(`UPDATE audit_log SET details = '{"a":2}' WHERE seq = 1`).run();
    const v = audit.verify();
    assert.equal(v.ok, false);
    assert.equal(v.brokenAtSeq, 1);
    assert.equal(v.count, 0);
  });

  it('NFR-SEC2: verify() detects a deleted row (broken chain)', () => {
    const db2 = openDatabase(':memory:');
    const a2 = new AuditLog(db2, vault);
    for (let i = 0; i < 4; i++) a2.append({ action: 'READ', details: { i } });
    db2.exec('DROP TRIGGER audit_log_no_delete');
    db2.prepare('DELETE FROM audit_log WHERE seq = 2').run();
    assert.deepEqual(a2.verify(), { ok: false, count: 1, brokenAtSeq: 3 });
    db2.close();
  });

  it('NFR-SEC2: a different key cannot forge or validate the chain', () => {
    const db3 = openDatabase(':memory:');
    new AuditLog(db3, vault).append({ action: 'LOGIN' });
    assert.equal(new AuditLog(db3, new Vault(crypto.randomBytes(32))).verify().ok, false);
    db3.close();
  });
});

describe('db helpers', () => {
  it('opens a file database, creating folders and schema', () => {
    const dir = tmpDir('irby-db-');
    try {
      const db = openDatabase(path.join(dir, 'sub', 'test.db'));
      assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1');
      db.close();
      const again = openDatabase(path.join(dir, 'sub', 'test.db')); // idempotent schema
      again.close();
    } finally {
      rmDir(dir);
    }
  });

  it('transaction commits on success and rolls back on error', () => {
    const db = openDatabase(':memory:');
    const put = (k) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(k, 'v');
    assert.equal(transaction(db, () => { put('a'); return 'done'; }), 'done');
    assert.throws(() => transaction(db, () => { put('b'); throw new Error('boom'); }), /boom/);
    const keys = db.prepare('SELECT key FROM meta ORDER BY key').all().map((r) => r.key);
    assert.deepEqual(keys, ['a', 'schema_version']);
    db.close();
  });

  it('nn and toBuffer', () => {
    assert.equal(nn(undefined), null);
    assert.equal(nn(0), 0);
    assert.equal(nn(''), '');
    const b = Buffer.from('abc');
    assert.equal(toBuffer(b), b);
    const u8 = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
    const out = toBuffer(u8);
    assert.ok(Buffer.isBuffer(out));
    assert.deepEqual([...out], [2, 3]);
  });
});

describe('errors', () => {
  it('HttpError, ValidationError and notFound carry status/code/extra', () => {
    const e = new HttpError(409, 'CONFLICT', 'Nope', { x: 1 });
    assert.ok(e instanceof Error);
    assert.equal(e.status, 409);
    assert.equal(e.code, 'CONFLICT');
    assert.deepEqual(e.extra, { x: 1 });
    assert.deepEqual(new HttpError(400, 'X', 'm').extra, {});
    const v = new ValidationError({ fee: 'bad' });
    assert.equal(v.status, 422);
    assert.equal(v.code, 'VALIDATION_FAILED');
    assert.match(v.message, /correct/);
    assert.deepEqual(v.extra, { fields: { fee: 'bad' } });
    assert.equal(new ValidationError({}, 'Custom', 'CONSENT_REQUIRED').code, 'CONSENT_REQUIRED');
    assert.equal(notFound().message, 'Record not found.');
    assert.equal(notFound('Patient').status, 404);
  });

  it('Checker keeps the first message per field', () => {
    const c = new Checker();
    assert.equal(c.ok(), true);
    c.throwIfAny();
    c.fail('fee', 'first').fail('fee', 'second').fail('paid', 'x');
    assert.equal(c.ok(), false);
    assert.deepEqual(c.fields, { fee: 'first', paid: 'x' });
    assert.throws(() => c.throwIfAny('Fix it'), (err) => err instanceof ValidationError && err.message === 'Fix it');
  });

  it('str trims and maps null/undefined to empty', () => {
    assert.equal(str('  a  '), 'a');
    assert.equal(str(null), '');
    assert.equal(str(undefined), '');
    assert.equal(str(12), '12');
  });
});

describe('images (upload sniffing)', () => {
  it('detects JPEG, PNG and WebP by content', () => {
    assert.equal(sniffImage(JPEG), 'image/jpeg');
    assert.equal(sniffImage(PNG), 'image/png');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
    assert.equal(sniffImage(webp), 'image/webp');
    assert.equal(sniffImage(Buffer.from('GIF89a-not-allowed')), null);
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff])), null); // too short
    assert.equal(sniffImage(null), null);
  });

  it('decodes image data URLs and rejects anything else', () => {
    const url = 'data:image/jpeg;base64,' + JPEG.toString('base64');
    const img = decodeDataUrl(url);
    assert.equal(img.mime, 'image/jpeg');
    assert.deepEqual(img.buffer, JPEG);
    // Declared type is not trusted: PNG bytes labelled jpeg are reported as PNG.
    assert.equal(decodeDataUrl('data:image/jpeg;base64,' + PNG.toString('base64')).mime, 'image/png');
    const wrapped = 'data:image/png;base64,' + PNG.toString('base64').replace(/(.{10})/g, '$1\n');
    assert.deepEqual(decodeDataUrl(wrapped).buffer, PNG);
    assert.equal(decodeDataUrl('data:text/plain;base64,aGVsbG8='), null);
    assert.equal(decodeDataUrl('data:image/png;base64,' + Buffer.from('not an image at all').toString('base64')), null);
    assert.equal(decodeDataUrl('https://example.com/a.jpg'), null);
    assert.equal(decodeDataUrl(null), null);
  });
});

describe('clinic config (NFR-M2)', () => {
  const realDir = path.join(ROOT, 'config');
  const goodSymbol = { code: 'Q', name: 'Test', category: 'condition', scope: 'surface', shape: 'circle', fill: 'solid', color: '#112233' };
  const cfg = (symbols) => ({ categories: [{ id: 'condition' }], symbols });

  it('loads the shipped config files', () => {
    const c = loadClinicConfig(realDir);
    assert.ok(c.symbolByCode.get('D'));
    assert.equal(c.symbolByCode.get('M').scope, 'tooth');
    assert.ok(c.photoViewIds.has('upper-occlusal'));
    assert.equal(c.consent.version, '1.0');
    assert.match(c.consent.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(c.procedures) && c.procedures.length > 0);
    assert.ok(SHAPES.includes('circle') && FILLS.includes('solid'));
  });

  it('accepts a valid symbol list', () => {
    const ok = cfg([goodSymbol, { ...goodSymbol, code: 'R', key: '1' }]);
    assert.equal(validateSymbols(ok), ok);
  });

  it('reports every kind of bad symbol entry', () => {
    const bad = cfg([
      { ...goodSymbol, code: 'TOOLONG', key: 'x' },
      { ...goodSymbol, code: 'A', key: '1' },
      { ...goodSymbol, code: 'A', key: '1', name: '' },
      { ...goodSymbol, code: 'B', category: 'nope', scope: 'jaw', shape: 'blob', fill: 'neon', color: 'red' },
      { name: 'no code', category: 'condition', scope: 'tooth', shape: 'x', fill: 'solid', color: '#000000' },
    ]);
    assert.throws(() => validateSymbols(bad), (err) => {
      for (const s of ['code must be 1-4', 'duplicate code', 'name is required', 'unknown category', 'scope must be',
        'shape must be', 'fill must be', 'color must be', 'key must be a single digit', 'duplicate shortcut key']) {
        assert.ok(err.message.includes(s), `missing "${s}" in ${err.message}`);
      }
      return true;
    });
    assert.throws(() => validateSymbols({}), /non-empty array/);
    assert.throws(() => validateSymbols({ categories: [], symbols: [] }), /non-empty array/);
  });

  describe('broken config folders', () => {
    let dir;
    const copy = () => {
      for (const f of fs.readdirSync(realDir)) fs.copyFileSync(path.join(realDir, f), path.join(dir, f));
    };
    const edit = (name, fn) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify(fn(JSON.parse(fs.readFileSync(file, 'utf8')))));
    };
    before(() => { dir = tmpDir('irby-cfg-'); });
    after(() => rmDir(dir));

    it('reports unreadable or malformed files', () => {
      assert.throws(() => loadClinicConfig(dir), /Cannot read config\/pda-symbols\.json/);
      copy();
      fs.writeFileSync(path.join(dir, 'procedures.json'), '{ not json');
      assert.throws(() => loadClinicConfig(dir), /Cannot read config\/procedures\.json/);
    });

    it('requires consent version and text', () => {
      copy();
      edit('consent.json', (c) => ({ ...c, text: '' }));
      assert.throws(() => loadClinicConfig(dir), /consent\.json needs/);
    });

    it('requires chart photo views', () => {
      copy();
      edit('clinic.json', (c) => ({ ...c, chart: {} }));
      assert.throws(() => loadClinicConfig(dir), /photoViews/);
      edit('clinic.json', (c) => ({ ...c, chart: undefined }));
      assert.throws(() => loadClinicConfig(dir), /photoViews/);
    });

    it('defaults procedures to an empty list', () => {
      copy();
      edit('procedures.json', () => ({}));
      assert.deepEqual(loadClinicConfig(dir).procedures, []);
    });
  });

  it('FR-4: knows every valid FDI tooth number', () => {
    assert.equal(VALID_TEETH.size, 52);
    for (const t of [11, 18, 21, 28, 31, 38, 41, 48, 51, 55, 61, 65, 71, 75, 81, 85]) assert.ok(VALID_TEETH.has(t), String(t));
    for (const t of [10, 19, 29, 49, 50, 56, 66, 86, 91, 0]) assert.ok(!VALID_TEETH.has(t), String(t));
  });
});

describe('runtime config', () => {
  it('reads overrides from env with safe fallbacks', () => {
    const dir = tmpDir('irby-conf-');
    try {
      const c = loadConfig({
        dataDir: dir,
        ocrProvider: ' HTTP ',
        env: {
          PORT: '4100', HOST: '127.0.0.1', HTTPS: 'yes', BACKUPS: 'off', IDLE_MINUTES: 'soon', BACKUP_KEEP: '0',
          TRASH_RETENTION_DAYS: '5', PHOTO_MAX_BYTES: '1234', MASTER_KEY_FILE: path.join(dir, 'k.key'), BACKUP_DIR: path.join(dir, 'b'),
        },
      });
      assert.equal(c.port, 4100);
      assert.equal(c.host, '127.0.0.1');
      assert.equal(c.https.enabled, true);
      assert.equal(c.backupsEnabled, false);
      assert.equal(c.security.idleMinutes, 10);
      assert.equal(c.backupKeep, 1);
      assert.equal(c.trashRetentionDays, 30); // NFR-S2: never below 30 days
      assert.equal(c.limits.photoMaxBytes, 1234);
      assert.equal(c.limits.portraitMaxBytes, 500 * 1024);
      assert.equal(c.ocr.provider, 'http');
      assert.equal(c.dataDir, dir);
      assert.equal(c.dbFile, path.join(dir, 'irby.db'));
      assert.equal(c.keyFile, path.join(dir, 'k.key'));
      assert.equal(c.backupDir, path.join(dir, 'b'));
      assert.equal(c.security.minPasswordLength, 12);
      assert.equal(c.security.maxFailedLogins, 5);
      assert.equal(c.security.lockoutMinutes, 15);
      assert.equal(c.version, require('../package.json').version);

      assert.equal(loadConfig({ dataDir: dir, backupsEnabled: true, env: { BACKUPS: 'false' } }).backupsEnabled, true);
      assert.equal(loadConfig({ dataDir: dir, env: { BACKUPS: '' } }).backupsEnabled, true);
      assert.equal(loadConfig({ dataDir: dir, env: { HTTPS: '0' } }).https.enabled, false);
      assert.equal(loadConfig({ dataDir: dir, env: { TRASH_RETENTION_DAYS: '90' } }).trashRetentionDays, 90);
    } finally {
      rmDir(dir);
    }
  });
});
