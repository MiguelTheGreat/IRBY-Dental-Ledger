'use strict';
// System diagnostics, 3-state status indicators, error code catalog, rotating
// no-PHI diagnostic log, and periodic 5-subsystem watchdog.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_MEM_LOGS = 200;
const MAX_LOG_BYTES = 1024 * 1024; // 1 MB log rotation threshold

const ERROR_CATALOG = Object.freeze({
  OK: {
    code: 'OK',
    subsystem: 'system',
    severity: 'INFO',
    title: 'All Subsystems Nominal',
    meaning: 'Database, AES-256-GCM vault, HMAC audit chain, backup storage, and HTTP runtime passed self-check.',
    recovery: 'No action required.',
  },
  'ERR-DB-001': {
    code: 'ERR-DB-001',
    subsystem: 'db',
    severity: 'CRITICAL',
    title: 'SQLite Database Integrity / Read Failure',
    meaning: 'SQLite SELECT 1 or PRAGMA quick_check failed, or the database file is locked/corrupted.',
    recovery: 'Stop the server, inspect data/irby.db locks, or restore the newest encrypted backup via scripts/restore-backup.js.',
  },
  'ERR-VAULT-002': {
    code: 'ERR-VAULT-002',
    subsystem: 'vault',
    severity: 'CRITICAL',
    title: 'AES-256-GCM Encryption Vault Failure',
    meaning: 'Encrypt/decrypt round-trip test using master.key failed or key material is mismatched/corrupt.',
    recovery: 'Verify data/master.key (or MASTER_KEY env) matches the database vault key; restore backup master.key.',
  },
  'ERR-AUDIT-003': {
    code: 'ERR-AUDIT-003',
    subsystem: 'audit',
    severity: 'CRITICAL',
    title: 'Audit Hash Chain Break / Tampering Detected',
    meaning: 'Recomputing the HMAC-SHA256 audit chain found a mismatched hash or broken sequence link.',
    recovery: 'Preserve diagnostics.log for investigation, stop server, and restore from last verified encrypted .bak file.',
  },
  'ERR-AUTH-004': {
    code: 'ERR-AUTH-004',
    subsystem: 'auth',
    severity: 'WARN',
    title: 'Account Brute-Force Lockout Triggered',
    meaning: 'A staff account reached 5 consecutive failed sign-in attempts and was temporarily locked (15 min).',
    recovery: 'Verify staff identity; Administrator unlocks account in Security → Users or waits 15 minutes.',
  },
  'ERR-NET-005': {
    code: 'ERR-NET-005',
    subsystem: 'network',
    severity: 'CRITICAL',
    title: 'Clinic Server Unreachable / Connection Lost',
    meaning: 'Client UI or chairside tablet could not reach /api/health within polling timeout.',
    recovery: 'Check clinic PC power/Wi-Fi, restart IRBY Dental Ledger server, and verify firewall allows TCP port 3000.',
  },
  'ERR-BACKUP-006': {
    code: 'ERR-BACKUP-006',
    subsystem: 'storage',
    severity: 'WARN',
    title: 'Backup Directory Unwritable or Missing',
    meaning: 'Automated encrypted backup target path is missing, replaced by a file, or lacks write permissions.',
    recovery: 'Restore write permissions / directory on data/backups (or BACKUP_DIR), then trigger Run backup now.',
  },
  'ERR-OCR-007': {
    code: 'ERR-OCR-007',
    subsystem: 'ocr',
    severity: 'WARN',
    title: 'OCR Provider Timeout or Failure',
    meaning: 'Intake scan OCR subprocess or HTTP service failed or exceeded the 10-second timeout.',
    recovery: 'Check OCR_PROVIDER service health or use manual patient registration until OCR recovers.',
  },
  'ERR-SYS-500': {
    code: 'ERR-SYS-500',
    subsystem: 'runtime',
    severity: 'ERROR',
    title: 'Unhandled Server Exception / High Event-Loop Lag',
    meaning: 'An unexpected runtime exception (HTTP 500) occurred or Node.js event-loop latency exceeded 250 ms.',
    recovery: 'Download diagnostics.log, inspect error stack trace in log, and restart service if lag persists.',
  },
});

class DiagnosticsService {
  constructor(ctx) {
    this.ctx = ctx;
    this.startedAt = Date.now();
    this.logDir = path.join(ctx.config.dataDir, 'logs');
    this.logFile = path.join(this.logDir, 'diagnostics.log');
    this.logs = [];
    this.snapshot = null;
    this.timer = null;
    this.lagTimer = null;
    this.loopLagMs = 0;
    this.prevStatus = null;
    this._loadExistingLogs();
  }

  _loadExistingLogs() {
    try {
      if (!fs.existsSync(this.logFile)) return;
      const raw = fs.readFileSync(this.logFile, 'utf8');
      const lines = raw.trim().split(/\r?\n/).filter(Boolean).slice(-MAX_MEM_LOGS);
      for (const line of lines) {
        try { this.logs.push(JSON.parse(line)); } catch { /* skip malformed line */ }
      }
    } catch { /* ignore unreadable initial log */ }
  }

  log(level, code, subsystem, message, meta = null) {
    const entry = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      level: String(level || 'INFO').toUpperCase(),
      code: String(code || 'OK'),
      subsystem: String(subsystem || 'system'),
      message: String(message || ''),
      meta: meta && typeof meta === 'object' ? meta : undefined,
    };
    this.logs.push(entry);
    if (this.logs.length > MAX_MEM_LOGS) this.logs.shift();

    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size >= MAX_LOG_BYTES) {
        const rotated = `${this.logFile}.1`;
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(this.logFile, rotated);
      }
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // Never crash clinical API calls if log volume itself cannot be written
    }
    return entry;
  }

  getLogs({ limit = 100, level = '' } = {}) {
    let items = this.logs;
    if (level) {
      const want = String(level).toUpperCase();
      items = items.filter((e) => e.level === want);
    }
    return items.slice(-Math.min(Math.max(Number(limit) || 100, 1), MAX_MEM_LOGS)).reverse();
  }

  readLogFile() {
    try {
      if (fs.existsSync(this.logFile)) return fs.readFileSync(this.logFile, 'utf8');
    } catch { /* fallback to ring buffer */ }
    return this.logs.map((e) => JSON.stringify(e)).join('\n') + (this.logs.length ? '\n' : '');
  }

  _checkDb() {
    const t0 = performance.now();
    try {
      const one = this.ctx.db.prepare('SELECT 1 AS ok').get();
      const qc = this.ctx.db.prepare('PRAGMA quick_check').get();
      const qcVal = qc ? Object.values(qc)[0] : 'unknown';
      const ms = Number((performance.now() - t0).toFixed(2));
      if (!one || one.ok !== 1 || String(qcVal).toLowerCase() !== 'ok') {
        return { id: 'db', name: 'SQLite Database', status: 'err', code: 'ERR-DB-001', metric: `${ms} ms`, detail: `quick_check=${qcVal}` };
      }
      let kb = 0;
      try { kb = Math.round(fs.statSync(this.ctx.config.dbFile).size / 1024); } catch { /* :memory: */ }
      return { id: 'db', name: 'SQLite Database', status: 'ok', code: 'OK', metric: `${ms} ms · ${kb} KB`, detail: 'SELECT 1 & quick_check OK' };
    } catch (err) {
      return { id: 'db', name: 'SQLite Database', status: 'err', code: 'ERR-DB-001', metric: 'error', detail: err.message };
    }
  }

  _checkVault() {
    const t0 = performance.now();
    try {
      const probe = crypto.randomBytes(16);
      const cipher = this.ctx.vault.encryptBuffer(probe);
      const plain = this.ctx.vault.decryptBuffer(cipher);
      const ms = Number((performance.now() - t0).toFixed(2));
      if (!probe.equals(plain)) {
        return { id: 'vault', name: 'AES-256-GCM Vault', status: 'err', code: 'ERR-VAULT-002', metric: `${ms} ms`, detail: 'Cipher round-trip mismatch' };
      }
      return { id: 'vault', name: 'AES-256-GCM Vault', status: 'ok', code: 'OK', metric: `${ms} ms`, detail: 'Encrypt/decrypt round-trip OK' };
    } catch (err) {
      return { id: 'vault', name: 'AES-256-GCM Vault', status: 'err', code: 'ERR-VAULT-002', metric: 'error', detail: err.message };
    }
  }

  _checkAudit() {
    const t0 = performance.now();
    try {
      const v = this.ctx.audit.verify();
      const ms = Number((performance.now() - t0).toFixed(2));
      if (!v.ok) {
        return {
          id: 'audit', name: 'Audit Hash Chain', status: 'err', code: 'ERR-AUDIT-003',
          metric: `broken @ #${v.brokenAtSeq}`, detail: `Chain verification failed at seq ${v.brokenAtSeq} (${ms} ms)`,
          brokenAtSeq: v.brokenAtSeq, count: v.count,
        };
      }
      return {
        id: 'audit', name: 'Audit Hash Chain', status: 'ok', code: 'OK',
        metric: `${v.count} entries (${ms} ms)`, detail: 'HMAC-SHA256 chain intact',
        count: v.count,
      };
    } catch (err) {
      return { id: 'audit', name: 'Audit Hash Chain', status: 'err', code: 'ERR-AUDIT-003', metric: 'error', detail: err.message };
    }
  }

  _checkStorage() {
    const bdir = this.ctx.config.backupDir;
    try {
      if (!fs.existsSync(bdir)) {
        if (!this.ctx.config.backupsEnabled) {
          return { id: 'storage', name: 'Storage & Backups', status: 'ok', code: 'OK', metric: 'backups off', detail: 'Automated backups disabled by config' };
        }
        return { id: 'storage', name: 'Storage & Backups', status: 'warn', code: 'ERR-BACKUP-006', metric: 'missing dir', detail: `Backup directory missing: ${path.basename(bdir)}` };
      }
      const st = fs.statSync(bdir);
      if (!st.isDirectory()) {
        return { id: 'storage', name: 'Storage & Backups', status: 'warn', code: 'ERR-BACKUP-006', metric: 'not a dir', detail: 'Backup target path is not a directory' };
      }
      const probe = path.join(bdir, `.diag_probe_${process.pid}`);
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.unlinkSync(probe);

      const backups = this.ctx.services.backup ? this.ctx.services.backup.list() : [];
      let freeMb = null;
      try {
        if (typeof fs.statfsSync === 'function') {
          const sf = fs.statfsSync(bdir);
          freeMb = Math.round((Number(sf.bavail) * Number(sf.bsize)) / (1024 * 1024));
        }
      } catch { /* statfs optional */ }
      const latest = backups[0] ? `${backups.length} .bak` : '0 .bak yet';
      const metric = freeMb != null ? `${latest} · ${(freeMb / 1024).toFixed(1)} GB free` : latest;
      return { id: 'storage', name: 'Storage & Backups', status: 'ok', code: 'OK', metric, detail: 'Backup directory writable' };
    } catch (err) {
      return { id: 'storage', name: 'Storage & Backups', status: 'warn', code: 'ERR-BACKUP-006', metric: 'unwritable', detail: err.code || err.message };
    }
  }

  _checkRuntime() {
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    const uptimeSec = Math.round((Date.now() - this.startedAt) / 1000);
    const lag = Number(this.loopLagMs.toFixed(1));
    if (lag > 250) {
      return { id: 'runtime', name: 'Runtime Watchdog', status: 'warn', code: 'ERR-SYS-500', metric: `lag ${lag} ms · ${rssMb} MB`, detail: `High event-loop latency (${lag} ms)` };
    }
    return { id: 'runtime', name: 'Runtime Watchdog', status: 'ok', code: 'OK', metric: `${rssMb} MB RSS · ${lag} ms lag`, detail: `Node ${process.version} · up ${uptimeSec}s` };
  }

  runChecks({ reason = 'watchdog', silent = false, actor = null } = {}) {
    const checks = {
      db: this._checkDb(),
      vault: this._checkVault(),
      audit: this._checkAudit(),
      storage: this._checkStorage(),
      runtime: this._checkRuntime(),
    };

    const list = Object.values(checks);
    const errItem = list.find((c) => c.status === 'err');
    const warnItem = list.find((c) => c.status === 'warn');

    let status = 'HEALTHY';
    let code = 'OK';
    if (errItem) {
      status = 'CRITICAL';
      code = errItem.code;
    } else if (warnItem) {
      status = 'DEGRADED';
      code = warnItem.code;
    }

    const snap = {
      status,
      code,
      led: status === 'HEALTHY' ? 'green' : status === 'DEGRADED' ? 'amber' : 'red',
      checkedAt: Date.now(),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      reason,
      checks,
      logFile: this.logFile,
    };
    this.snapshot = snap;

    if (!silent) {
      if (reason === 'manual') {
        const lvl = status === 'HEALTHY' ? 'INFO' : status === 'DEGRADED' ? 'WARN' : 'CRITICAL';
        this.log(lvl, code, 'watchdog', `Manual self-test finished: ${status}`, { actor: actor ? actor.username : null });
      } else if (this.prevStatus !== status) {
        if (status === 'CRITICAL') {
          this.log('CRITICAL', code, errItem.id, `${errItem.name} fault detected: ${errItem.detail}`);
        } else if (status === 'DEGRADED') {
          this.log('WARN', code, warnItem.id, `${warnItem.name} degraded: ${warnItem.detail}`);
        } else if (this.prevStatus && this.prevStatus !== 'HEALTHY') {
          this.log('INFO', 'OK', 'watchdog', `Recovered from ${this.prevStatus} -> HEALTHY`);
        }
      }
    }
    this.prevStatus = status;
    return snap;
  }

  getHealthSummary() {
    const snap = this.snapshot || this.runChecks({ reason: 'boot', silent: true });
    return {
      ok: snap.status !== 'CRITICAL',
      status: snap.status,
      code: snap.code,
      led: snap.led,
      uptimeSec: snap.uptimeSec,
      lastCheckAt: snap.checkedAt,
      checks: Object.fromEntries(
        Object.entries(snap.checks).map(([k, v]) => [k, { status: v.status, code: v.code }])
      ),
    };
  }

  startWatchdog(intervalMs = 15000) {
    this.stopWatchdog();
    this.runChecks({ reason: 'boot', silent: false });

    let lastTick = performance.now();
    this.lagTimer = setInterval(() => {
      const now = performance.now();
      this.loopLagMs = Math.max(0, now - lastTick - 1000);
      lastTick = now;
    }, 1000);
    if (this.lagTimer.unref) this.lagTimer.unref();

    this.timer = setInterval(() => {
      this.runChecks({ reason: 'watchdog', silent: false });
    }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stopWatchdog() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.lagTimer) { clearInterval(this.lagTimer); this.lagTimer = null; }
  }
}

module.exports = { DiagnosticsService, ERROR_CATALOG };
