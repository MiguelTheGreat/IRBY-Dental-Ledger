'use strict';
// TC-01: automated daily encrypted backups named Backup_YYYYMMDD_Secure.bak.
// File layout: "IRBYBAK1" magic + AES-256-GCM(gzip(SQLite snapshot)).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { compactStamp } = require('../lib/dates');

const MAGIC = Buffer.from('IRBYBAK1');
const NAME_RE = /^Backup_\d{8}_Secure\.bak$/;

class BackupService {
  constructor(ctx) {
    this.ctx = ctx;
    this.dir = ctx.config.backupDir;
  }

  static fileName(date = new Date()) {
    return `Backup_${compactStamp(date)}_Secure.bak`;
  }

  run({ reason = 'manual', actor = null } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const name = BackupService.fileName();
    const finalPath = path.join(this.dir, name);
    const tmpDb = path.join(this.dir, `.snapshot-${process.pid}-${Date.now()}.db`);
    try {
      this.ctx.db.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
      const encrypted = this.ctx.vault.encryptBuffer(zlib.gzipSync(fs.readFileSync(tmpDb)), this.ctx.vault.backupKey);
      fs.writeFileSync(finalPath + '.part', Buffer.concat([MAGIC, encrypted]));
      fs.renameSync(finalPath + '.part', finalPath);
    } finally {
      fs.rmSync(tmpDb, { force: true });
      fs.rmSync(finalPath + '.part', { force: true });
    }
    const size = fs.statSync(finalPath).size;
    this.prune();
    this.ctx.audit.append({ user: actor, ip: actor && actor.ip, action: 'BACKUP', entity: 'database', entityId: name, details: { reason, bytes: size } });
    return { name, size, createdAt: Date.now() };
  }

  ensureDaily() {
    if (!fs.existsSync(path.join(this.dir, BackupService.fileName()))) return this.run({ reason: 'daily' });
    return null;
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter((f) => NAME_RE.test(f))
      .map((f) => { const st = fs.statSync(path.join(this.dir, f)); return { name: f, size: st.size, modifiedAt: st.mtimeMs }; })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  }

  prune() {
    for (const old of this.list().slice(this.ctx.config.backupKeep)) fs.rmSync(path.join(this.dir, old.name), { force: true });
  }

  /** Decrypt a backup into a plain SQLite file (used by scripts/restore-backup.js). */
  static decrypt(file, vault) {
    const buf = fs.readFileSync(file);
    if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an IRBY backup file');
    return zlib.gunzipSync(vault.decryptBuffer(buf.subarray(MAGIC.length), vault.backupKey));
  }
}

module.exports = { BackupService };
