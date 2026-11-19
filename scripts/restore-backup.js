'use strict';
// Restore an encrypted backup:  npm run restore -- data/backups/Backup_20261102_Secure.bak
// Stop the server first. The current database is kept as irby.db.pre-restore-<time>.
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../server/config');
const { Vault, loadOrCreateMasterKey } = require('../server/lib/crypto');
const { BackupService } = require('../server/services/backup');

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run restore -- <path to Backup_YYYYMMDD_Secure.bak>');
  process.exit(1);
}
const config = loadConfig();
if (!fs.existsSync(config.keyFile) && !process.env.MASTER_KEY) {
  console.error(`Master key not found at ${config.keyFile}. Restore it (or set MASTER_KEY) first - backups cannot be decrypted without it.`);
  process.exit(1);
}
const vault = new Vault(loadOrCreateMasterKey(config.keyFile));
const plain = BackupService.decrypt(path.resolve(file), vault);
if (fs.existsSync(config.dbFile)) {
  const keep = `${config.dbFile}.pre-restore-${Date.now()}`;
  fs.renameSync(config.dbFile, keep);
  for (const ext of ['-wal', '-shm']) fs.rmSync(config.dbFile + ext, { force: true });
  console.log(`Previous database moved to ${keep}`);
}
fs.writeFileSync(config.dbFile, plain);
console.log(`Restored ${path.basename(file)} -> ${config.dbFile} (${Math.round(plain.length / 1024)} KB). Start the server with: npm start`);
