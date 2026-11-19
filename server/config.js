'use strict';
// Central runtime configuration. Values come from environment variables
// (optionally loaded from a .env file in the project root). See .env.example.
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envFile); } catch { /* malformed .env is reported on first use */ }
}

function int(env, name, def) {
  const v = parseInt(env[name], 10);
  return Number.isFinite(v) ? v : def;
}

function bool(env, name, def) {
  const v = env[name];
  if (v == null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function loadConfig(overrides = {}) {
  const env = { ...process.env, ...(overrides.env || {}) };
  const dataDir = path.resolve(ROOT, overrides.dataDir || env.DATA_DIR || 'data');
  const certDir = path.join(dataDir, 'certs');

  return {
    root: ROOT,
    version: require(path.join(ROOT, 'package.json')).version,
    host: env.HOST || '0.0.0.0',
    port: int(env, 'PORT', 3000),
    https: {
      enabled: bool(env, 'HTTPS', false),
      port: int(env, 'HTTPS_PORT', 3443),
      certFile: path.resolve(ROOT, env.TLS_CERT || path.join(certDir, 'cert.pem')),
      keyFile: path.resolve(ROOT, env.TLS_KEY || path.join(certDir, 'key.pem')),
    },
    dataDir,
    dbFile: path.join(dataDir, 'irby.db'),
    keyFile: path.resolve(ROOT, env.MASTER_KEY_FILE || path.join(dataDir, 'master.key')),
    backupDir: path.resolve(ROOT, env.BACKUP_DIR || path.join(dataDir, 'backups')),
    backupKeep: Math.max(1, int(env, 'BACKUP_KEEP', 30)),
    backupsEnabled: overrides.backupsEnabled ?? bool(env, 'BACKUPS', true),
    configDir: path.join(ROOT, 'config'),
    publicDir: path.join(ROOT, 'public'),
    fontDir: path.join(ROOT, 'node_modules', '@fontsource', 'plus-jakarta-sans', 'files'),
    security: {
      minPasswordLength: 12,
      maxFailedLogins: 5,
      lockoutMinutes: 15,
      idleMinutes: int(env, 'IDLE_MINUTES', 10),
    },
    // NFR-S2: soft-deleted records stay recoverable for at least 30 days.
    trashRetentionDays: Math.max(30, int(env, 'TRASH_RETENTION_DAYS', 30)),
    limits: {
      portraitMaxBytes: 500 * 1024, // FR-1 / NFR-P1
      photoMaxBytes: int(env, 'PHOTO_MAX_BYTES', 8 * 1024 * 1024),
      scanMaxBytes: int(env, 'SCAN_MAX_BYTES', 12 * 1024 * 1024),
    },
    ocr: {
      provider: (overrides.ocrProvider || env.OCR_PROVIDER || 'mock').trim().toLowerCase(),
      timeoutMs: int(env, 'OCR_TIMEOUT_MS', 10000), // NFR-P7: one page in <= 10 s
      httpUrl: env.OCR_HTTP_URL || 'http://127.0.0.1:8765/predict',
      httpHealthUrl: env.OCR_HTTP_HEALTH_URL || '',
      httpAuth: env.OCR_HTTP_AUTH || '',
      command: env.OCR_COMMAND || 'python ocr-model/infer.py {image}',
      modulePath: env.OCR_MODULE || 'ocr-model/js-provider.example.js',
      mockDelayMs: int(env, 'OCR_MOCK_DELAY_MS', 700),
    },
  };
}

module.exports = { loadConfig, ROOT };
