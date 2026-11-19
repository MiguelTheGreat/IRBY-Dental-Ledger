'use strict';
// Encryption at rest (AES-256-GCM), tamper-evident audit hashing (HMAC-SHA256)
// and password hashing (scrypt). Only Node's built-in crypto is used.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const BLOB_VERSION = 1;
const TEXT_PREFIX = 'v1:';

function loadOrCreateMasterKey(keyFile, env = process.env) {
  if (env.MASTER_KEY) {
    const key = Buffer.from(env.MASTER_KEY, 'base64');
    if (key.length !== 32) throw new Error('MASTER_KEY must be 32 bytes encoded as base64');
    return key;
  }
  if (fs.existsSync(keyFile)) {
    const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`Master key file ${keyFile} is corrupt (expected 32 bytes)`);
    return key;
  }
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString('base64') + '\n', { mode: 0o600 });
  return key;
}

function derive(masterKey, label) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), label, 32));
}

class Vault {
  constructor(masterKey) {
    this.dataKey = derive(masterKey, 'irby:data:v1');
    this.backupKey = derive(masterKey, 'irby:backup:v1');
    this.auditKey = derive(masterKey, 'irby:audit:v1');
  }

  encryptBuffer(plain, key = this.dataKey) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([BLOB_VERSION]), iv, cipher.getAuthTag(), ct]);
  }

  decryptBuffer(blob, key = this.dataKey) {
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    if (buf.length < 29 || buf[0] !== BLOB_VERSION) throw new Error('Unsupported or corrupt encrypted blob');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(1, 13));
    decipher.setAuthTag(buf.subarray(13, 29));
    return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]);
  }

  encryptText(value) {
    if (value == null) return null;
    return TEXT_PREFIX + this.encryptBuffer(Buffer.from(String(value), 'utf8')).toString('base64');
  }

  decryptText(value) {
    if (value == null) return null;
    if (!value.startsWith(TEXT_PREFIX)) throw new Error('Unsupported encrypted text');
    return this.decryptBuffer(Buffer.from(value.slice(TEXT_PREFIX.length), 'base64')).toString('utf8');
  }

  encryptJson(obj) { return this.encryptText(JSON.stringify(obj)); }
  decryptJson(value) { return value == null ? null : JSON.parse(this.decryptText(value)); }

  hmac(data) {
    return crypto.createHmac('sha256', this.auditKey).update(data).digest('hex');
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const dk = await scrypt(password, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, dkB64] = parts;
  const expected = Buffer.from(dkB64, 'base64');
  const dk = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(dk, expected);
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const uuid = () => crypto.randomUUID();

module.exports = { Vault, loadOrCreateMasterKey, hashPassword, verifyPassword, sha256, randomToken, uuid };
