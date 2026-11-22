'use strict';
// Controlled fault-injection benchmark measuring MTTD and MTTR across 4 clinic
// faults (3 trials each) against an isolated server instance.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const SCRATCH = process.env.MTTD_SCRATCH || path.join(
  require('node:os').homedir(),
  '.gemini', 'antigravity', 'brain', 'bfee04cb-4337-418f-aa13-cd313c759ba3', 'scratch'
);
const WORK = path.join(SCRATCH, 'mttd_workspace');
const OUT_FILE = path.join(SCRATCH, 'mttd_mttr_results.json');
const PORT = 3899;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (arr) => Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3));

async function req(urlPath, { method = 'GET', cookie = '', body = null } = {}) {
  const headers = { 'X-Requested-With': 'irby' };
  if (cookie) headers.Cookie = cookie;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, ok: res.ok, body: json, cookie: setCookie ? setCookie.split(';')[0] : '' };
}

function startServer(envExtra = {}) {
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(PORT),
    DATA_DIR: path.join(WORK, 'data'),
    BACKUP_DIR: path.join(WORK, 'backups'),
    MASTER_KEY_FILE: path.join(WORK, 'data', 'master.key'),
    BACKUPS: '1',
    ...envExtra,
  };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return proc;
}

async function waitForHealth(wantStatus = null, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await req('/api/health');
      if (r.body && (!wantStatus || r.body.status === wantStatus)) return r.body;
    } catch { /* server starting */ }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for server health (${wantStatus || 'any'})`);
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const t0 = Date.now();
  while (proc.exitCode === null && Date.now() - t0 < 4000) await sleep(100);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

// Simulates app.js 5000 ms client status LED poller starting at random phase offset
async function pollHealthUntil(predicate, pollIntervalMs = 5000, timeoutMs = 30000) {
  const start = performance.now();
  // Random phase delay within [500, pollIntervalMs] so MTTD reflects realistic uniform arrival (~interval/2)
  const initialWait = 500 + Math.floor(Math.random() * (pollIntervalMs - 500));
  await sleep(initialWait);
  while (performance.now() - start < timeoutMs) {
    try {
      const r = await req('/api/health');
      if (predicate(r.body, null)) {
        return { elapsedSec: Number(((performance.now() - start) / 1000).toFixed(3)), health: r.body };
      }
    } catch (err) {
      if (predicate(null, err)) {
        return { elapsedSec: Number(((performance.now() - start) / 1000).toFixed(3)), health: { status: 'CRITICAL', code: 'ERR-NET-005' } };
      }
    }
    await sleep(pollIntervalMs);
  }
  throw new Error('pollHealthUntil timed out without detecting fault');
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, 'data'), { recursive: true });
  fs.mkdirSync(path.join(WORK, 'backups'), { recursive: true });

  let proc = startServer();
  let adminCookie = '';
  let dentistId = null;

  try {
    await waitForHealth('HEALTHY');
    // Setup admin + dentist staff user + initial encrypted backup
    const setup = await req('/api/setup', {
      method: 'POST',
      body: { username: 'admin', password: 'DentalVault#2026', displayName: 'Dr. Andrei Abad' },
    });
    if (setup.status !== 201) throw new Error(`Setup failed: ${JSON.stringify(setup)}`);
    adminCookie = setup.cookie;

    const u = await req('/api/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'dr.reyes', password: 'DentistPass#2026', displayName: 'Dr. Reyes', role: 'dentist' },
    });
    if (u.status !== 201) throw new Error(`User create failed: ${JSON.stringify(u)}`);
    dentistId = u.body.id;

    // Seed one patient & take baseline encrypted backup
    await req('/api/patients', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        lastName: 'Santos', firstName: 'Maria', middleName: 'Cruz', sex: 'Female',
        dateOfBirth: '1994-05-12', contactNumber: '09171234567', address: 'Manila',
        consentSigned: true,
      },
    });
    const bkp = await req('/api/backups', { method: 'POST', cookie: adminCookie });
    if (bkp.status !== 201) throw new Error(`Backup failed: ${JSON.stringify(bkp)}`);
    const bakPath = path.join(WORK, 'backups', bkp.body.name);

    const results = {
      measuredAt: new Date().toISOString(),
      environment: {
        nodeVersion: process.version,
        os: `${process.platform} ${process.arch}`,
        clientLedPollMs: 5000,
        serverWatchdogMs: 15000,
        trialsPerFault: 3,
      },
      faults: [],
    };

    // =========================================================================
    // FAULT 1: Server Process Crash / Unreachable (ERR-NET-005)
    // =========================================================================
    console.log('\n[Fault 1] ERR-NET-005: Server Process Crash / Unreachable...');
    const f1Trials = [];
    for (let i = 1; i <= 3; i++) {
      await stopServer(proc);
      const det = await pollHealthUntil((_h, err) => Boolean(err), 5000);
      const repT0 = performance.now();
      proc = startServer();
      await waitForHealth('HEALTHY');
      const repSec = Number(((performance.now() - repT0) / 1000).toFixed(3));
      // Re-authenticate after server restart? Sessions persist in SQLite! Verify session works:
      const me = await req('/api/auth/me', { cookie: adminCookie });
      if (!me.ok) {
        const l = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'DentalVault#2026' } });
        adminCookie = l.cookie;
      }
      f1Trials.push({ trial: i, mttdSec: det.elapsedSec, mttrSec: repSec, code: det.health.code });
      console.log(`  Trial ${i}: MTTD=${det.elapsedSec}s, MTTR=${repSec}s (${det.health.code})`);
    }
    results.faults.push({
      id: 'F1',
      code: 'ERR-NET-005',
      title: 'Clinic Server Process Crash / Network Unreachable',
      ledColor: 'Red (Pulsing)',
      mechanism: 'Child process terminated (SIGTERM/SIGKILL); simulated client /api/health 5s LED poller detects socket refusal.',
      toolsUsed: [
        'Sidebar Status LED (5s /api/health poller)',
        'Windows Task Manager / Resource Monitor',
        'IRBY Dental Ledger.exe / start-clinic.bat',
      ],
      steps: [
        'Observe pulsing red sidebar LED ("ERR-NET-005 · Offline") within <= 5 s of server outage.',
        'Confirm server process exit in Task Manager or Android tablet error dialog.',
        'Relaunch IRBY Dental Ledger.exe (or run start-clinic.bat); SQLite WAL recovers cleanly and green LED returns.',
      ],
      trials: f1Trials,
      meanMttdSec: mean(f1Trials.map((t) => t.mttdSec)),
      meanMttrSec: mean(f1Trials.map((t) => t.mttrSec)),
      estimatedOperatorMttrSec: 25.0,
    });

    // =========================================================================
    // FAULT 2: Tampered / Corrupted Audit Hash Chain (ERR-AUDIT-003)
    // =========================================================================
    console.log('\n[Fault 2] ERR-AUDIT-003: Tampered / Corrupted Audit Hash Chain...');
    const f2Trials = [];
    for (let i = 1; i <= 3; i++) {
      // Ensure clean backup exists before injecting tamper
      await req('/api/backups', { method: 'POST', cookie: adminCookie });
      // Inject fault outside app into SQLite audit_log
      const db = new DatabaseSync(path.join(WORK, 'data', 'irby.db'));
      db.exec('DROP TRIGGER IF EXISTS audit_log_no_update');
      db.prepare(`UPDATE audit_log SET details = '{"tampered":true}' WHERE seq = 1`).run();
      db.close();

      // Wait for 15s watchdog + 5s /api/health poller to surface ERR-AUDIT-003
      const det = await pollHealthUntil((h) => h && h.status === 'CRITICAL' && h.code === 'ERR-AUDIT-003', 5000, 30000);
      const repT0 = performance.now();
      await stopServer(proc);
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'restore-backup.js'), bakPath], {
        cwd: ROOT,
        env: { ...process.env, DATA_DIR: path.join(WORK, 'data'), BACKUP_DIR: path.join(WORK, 'backups'), MASTER_KEY_FILE: path.join(WORK, 'data', 'master.key') },
        stdio: 'pipe',
      });
      proc = startServer();
      const healthAfter = await waitForHealth('HEALTHY');
      const l = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'DentalVault#2026' } });
      adminCookie = l.cookie;
      const diag = await req('/api/diagnostics', { cookie: adminCookie });
      if (diag.body.snapshot.status !== 'HEALTHY') throw new Error(`Restore did not recover HEALTHY: ${JSON.stringify(diag.body.snapshot)}`);
      const repSec = Number(((performance.now() - repT0) / 1000).toFixed(3));
      f2Trials.push({ trial: i, mttdSec: det.elapsedSec, mttrSec: repSec, code: det.health.code, recoveredStatus: healthAfter.status });
      console.log(`  Trial ${i}: MTTD=${det.elapsedSec}s, MTTR=${repSec}s (${det.health.code})`);
    }
    results.faults.push({
      id: 'F2',
      code: 'ERR-AUDIT-003',
      title: 'Audit Hash Chain Corruption / Tampering Detected',
      ledColor: 'Red (Pulsing)',
      mechanism: 'audit_log row seq=1 mutated externally; HMAC-SHA256 watchdog detects mismatch and flags CRITICAL ERR-AUDIT-003.',
      toolsUsed: [
        'Security -> Diagnostics Watchdog & Audit Chain Badge',
        'data/logs/diagnostics.log',
        'scripts/restore-backup.js (AES-256-GCM decryptor)',
      ],
      steps: [
        'Observe red CRITICAL LED (ERR-AUDIT-003) and inspect brokenAtSeq in Diagnostics tab & diagnostics.log.',
        'Stop server cleanly, preserve *.pre-restore DB artifact for forensics, and run `npm run restore -- <Backup.bak>`.',
        'Restart server and click "Run Self-Test" in Security -> Diagnostics to verify HMAC chain is green & intact.',
      ],
      trials: f2Trials,
      meanMttdSec: mean(f2Trials.map((t) => t.mttdSec)),
      meanMttrSec: mean(f2Trials.map((t) => t.mttrSec)),
      estimatedOperatorMttrSec: 120.0,
    });

    // =========================================================================
    // FAULT 3: Brute-Force Account Lockout (ERR-AUTH-004)
    // =========================================================================
    console.log('\n[Fault 3] ERR-AUTH-004: Brute-Force Account Lockout (5 Bad Logins)...');
    const f3Trials = [];
    for (let i = 1; i <= 3; i++) {
      // Clear previous attempts first
      await req(`/api/users/${dentistId}/unlock`, { method: 'POST', cookie: adminCookie });
      // Send 5 bad password attempts
      for (let a = 0; a < 4; a++) {
        await req('/api/auth/login', { method: 'POST', body: { username: 'dr.reyes', password: 'WrongPassword123!' } });
      }
      const detT0 = performance.now();
      const r5 = await req('/api/auth/login', { method: 'POST', body: { username: 'dr.reyes', password: 'WrongPassword123!' } });
      if (r5.status !== 423) throw new Error(`Expected 423 lockout, got ${r5.status}`);
      const diagAfterLock = await req('/api/diagnostics?level=WARN', { cookie: adminCookie });
      const foundLog = (diagAfterLock.body.logs || []).find((l) => l.code === 'ERR-AUTH-004');
      if (!foundLog) throw new Error('ERR-AUTH-004 not found in diagnostics logs');
      const mttdSec = Number(((performance.now() - detT0) / 1000).toFixed(3));

      const repT0 = performance.now();
      const unl = await req(`/api/users/${dentistId}/unlock`, { method: 'POST', cookie: adminCookie });
      if (!unl.ok) throw new Error(`Unlock failed: ${unl.status}`);
      const loginOk = await req('/api/auth/login', { method: 'POST', body: { username: 'dr.reyes', password: 'DentistPass#2026' } });
      if (!loginOk.ok) throw new Error('Unlocked user login failed');
      const repSec = Number(((performance.now() - repT0) / 1000).toFixed(3));
      f3Trials.push({ trial: i, mttdSec, mttrSec: repSec, code: 'ERR-AUTH-004' });
      console.log(`  Trial ${i}: MTTD=${mttdSec}s, MTTR=${repSec}s (ERR-AUTH-004)`);
    }
    results.faults.push({
      id: 'F3',
      code: 'ERR-AUTH-004',
      title: 'Staff Account Brute-Force Lockout (HTTP 423)',
      ledColor: 'Amber / WARN Log',
      mechanism: '5 consecutive wrong passphrases trigger 15-min lockout (HTTP 423 ACCOUNT_LOCKED) and immediate ERR-AUTH-004 WARN log.',
      toolsUsed: [
        'Login Card Alert Banner + Diagnostics WARN Log',
        'Security -> Users Management Table ("Unlock" action)',
      ],
      steps: [
        'Staff sees immediate lock banner; Administrator opens Security -> Diagnostics / Users and spots ERR-AUTH-004 & red "Locked" badge.',
        'Administrator verifies staff member verbally at clinic desk and clicks "Unlock".',
        'Staff immediately signs back in with valid passphrase (verified by HTTP 200 session).',
      ],
      trials: f3Trials,
      meanMttdSec: mean(f3Trials.map((t) => t.mttdSec)),
      meanMttrSec: mean(f3Trials.map((t) => t.mttrSec)),
      estimatedOperatorMttrSec: 18.0,
    });

    // =========================================================================
    // FAULT 4: Backup Storage Directory Unwritable / Replaced (ERR-BACKUP-006)
    // =========================================================================
    console.log('\n[Fault 4] ERR-BACKUP-006: Backup Storage Path Corrupted / Unwritable...');
    const f4Trials = [];
    const savedBkpDir = path.join(WORK, 'backups_saved');
    for (let i = 1; i <= 3; i++) {
      // Swap backups folder with a regular file so backup writes & directory probe fail
      fs.renameSync(path.join(WORK, 'backups'), savedBkpDir);
      fs.writeFileSync(path.join(WORK, 'backups'), 'blocked-by-file-fault', 'utf8');

      const det = await pollHealthUntil((h) => h && h.status === 'DEGRADED' && h.code === 'ERR-BACKUP-006', 5000, 30000);
      const repT0 = performance.now();
      fs.rmSync(path.join(WORK, 'backups'), { force: true });
      fs.renameSync(savedBkpDir, path.join(WORK, 'backups'));
      const bRun = await req('/api/backups', { method: 'POST', cookie: adminCookie });
      if (bRun.status !== 201) throw new Error(`Backup retry failed: ${bRun.status}`);
      const st = await req('/api/diagnostics/selftest', { method: 'POST', cookie: adminCookie });
      if (st.body.snapshot.status !== 'HEALTHY') throw new Error(`Expected HEALTHY, got ${st.body.snapshot.status}`);
      const repSec = Number(((performance.now() - repT0) / 1000).toFixed(3));
      f4Trials.push({ trial: i, mttdSec: det.elapsedSec, mttrSec: repSec, code: det.health.code });
      console.log(`  Trial ${i}: MTTD=${det.elapsedSec}s, MTTR=${repSec}s (${det.health.code})`);
    }
    results.faults.push({
      id: 'F4',
      code: 'ERR-BACKUP-006',
      title: 'Encrypted Backup Directory Inaccessible / Unwritable',
      ledColor: 'Amber (Pulsing)',
      mechanism: 'Backup path replaced by non-directory/unwritable target; watchdog write probe detects failure and flips LED to DEGRADED.',
      toolsUsed: [
        'Sidebar Amber LED ("Degraded · ERR-BACKUP-006")',
        'Security -> Diagnostics Storage LED Card & Data/Backups Tab',
        'Windows Explorer / icacls Permissions',
      ],
      steps: [
        'Observe pulsing amber LED ("Degraded · ERR-BACKUP-006") within watchdog + 5s poll window.',
        'Restore missing/unwritable backup directory or USB drive permissions at configured path.',
        'Click "Run backup now" in Data & backups and "Run Self-Test" in Diagnostics to confirm green HEALTHY LED.',
      ],
      trials: f4Trials,
      meanMttdSec: mean(f4Trials.map((t) => t.mttdSec)),
      meanMttrSec: mean(f4Trials.map((t) => t.mttrSec)),
      estimatedOperatorMttrSec: 35.0,
    });

    fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf8');
    console.log(`\nSaved MTTD/MTTR benchmark report -> ${OUT_FILE}`);
  } finally {
    await stopServer(proc);
    fs.rmSync(WORK, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
