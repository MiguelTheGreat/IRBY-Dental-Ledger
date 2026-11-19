'use strict';
// Shared test setup. Every app built here lives in its own temporary directory
// (never the real data/ folder) and is removed again by close().
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { todayISO, addDays } = require('../server/lib/dates');

/** Test passwords: >= 12 characters and none contains its username. */
const PASSWORDS = Object.freeze({
  admin: 'Clinic#Root-2026',
  dentist: 'Molar#Crown-2026',
  frontdesk: 'Front#Counter-26',
});

const USERNAMES = Object.freeze({ admin: 'admin', dentist: 'dr.reyes', frontdesk: 'desk.maria' });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);

/** A JPEG data URL of exactly `bytes` decoded bytes. */
function jpegDataUrl(bytes = 64) {
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(bytes - 4, 8), 3)]);
  return 'data:image/jpeg;base64,' + buf.toString('base64');
}

function tmpDir(prefix = 'irby-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/**
 * Build an app on a fresh temp data dir. Paths that could otherwise come from the
 * developer's environment (key file, backup dir) are pinned inside the temp dir.
 */
function buildApp(options = {}) {
  const dir = options.dataDir || tmpDir();
  const { env: extraEnv = {}, ...rest } = options;
  const { app, ctx, close } = createApp({
    dataDir: dir,
    backupsEnabled: false,
    ...rest,
    env: {
      MASTER_KEY_FILE: path.join(dir, 'master.key'),
      BACKUP_DIR: path.join(dir, 'backups'),
      OCR_PROVIDER: 'mock',
      OCR_MOCK_DELAY_MS: '0',
      IDLE_MINUTES: '10',
      ...extraEnv,
    },
  });
  let closed = false;
  return {
    app, ctx, dir,
    cleanup() {
      if (closed) return;
      closed = true;
      close();
      rmDir(dir);
    },
  };
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve(server)));
  });
}

/** Small fetch wrapper. JSON in, JSON (or text / Buffer) out. */
function client(base) {
  async function call(method, url, { body, cookie, headers = {}, raw, type, csrf = true } = {}) {
    const h = { ...headers };
    if (csrf && !['GET', 'HEAD'].includes(method)) h['X-Requested-With'] = 'irby';
    if (cookie !== undefined) h.Cookie = `irby_sid=${cookie}`;
    let payload;
    if (raw !== undefined) {
      payload = raw;
      if (type) h['Content-Type'] = type;
    } else if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      h['Content-Type'] = type || 'application/json';
    }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const ct = res.headers.get('content-type') || '';
    let data;
    if (ct.includes('application/json')) data = await res.json();
    else if (ct.startsWith('image/')) data = Buffer.from(await res.arrayBuffer());
    else data = Buffer.from(await res.arrayBuffer()).toString('utf8'); // unlike res.text(), keeps a UTF-8 BOM
    const setCookie = res.headers.getSetCookie();
    const m = setCookie.map((c) => /^irby_sid=([^;]*)/.exec(c)).find(Boolean);
    return { status: res.status, body: data, headers: res.headers, setCookie, cookie: m ? decodeURIComponent(m[1]) : undefined };
  }
  return {
    call,
    get: (u, o) => call('GET', u, o),
    post: (u, o) => call('POST', u, o),
    put: (u, o) => call('PUT', u, o),
    del: (u, o) => call('DELETE', u, o),
  };
}

/** App + HTTP server on an ephemeral port. */
async function startEnv(options = {}) {
  const built = buildApp(options);
  const server = await listen(built.app);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...built,
    server,
    base,
    api: client(base),
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r()));
      built.cleanup();
    },
  };
}

/** First-run admin via /api/setup, then a dentist and a front desk user, all logged in. */
async function setupStaff(env) {
  const { api } = env;
  const setup = await api.post('/api/setup', {
    body: { username: USERNAMES.admin, displayName: 'Clinic Administrator', password: PASSWORDS.admin },
  });
  if (setup.status !== 201) throw new Error(`setup failed: ${setup.status} ${JSON.stringify(setup.body)}`);
  const staff = { admin: { cookie: setup.cookie, user: setup.body.user, password: PASSWORDS.admin } };
  for (const [role, displayName] of [['dentist', 'Dr. Ana Reyes'], ['frontdesk', 'Maria Santos']]) {
    const created = await api.post('/api/users', {
      cookie: staff.admin.cookie,
      body: { username: USERNAMES[role], displayName, role, password: PASSWORDS[role] },
    });
    if (created.status !== 201) throw new Error(`create ${role} failed: ${created.status} ${JSON.stringify(created.body)}`);
    const login = await api.post('/api/auth/login', { body: { username: USERNAMES[role], password: PASSWORDS[role] } });
    if (login.status !== 200) throw new Error(`login ${role} failed: ${login.status}`);
    staff[role] = { cookie: login.cookie, user: login.body.user, password: PASSWORDS[role] };
  }
  return staff;
}

function patientBody({ profile = {}, ...rest } = {}) {
  return {
    profile: {
      lastName: 'Dela Cruz',
      firstName: 'Mateo',
      middleName: 'Lorenzo',
      dateOfBirth: '1992-04-12',
      sex: 'Male',
      address: 'Unit 14B, Salcedo Village, Makati City',
      contactNumber: '+63 917 550 0192',
      allergies: 'Penicillin',
      ...profile,
    },
    consent: { accepted: true, version: '1.0' },
    ...rest,
  };
}

/** Service-level actor (what req.actor looks like). */
function actorFrom(user) {
  return { id: user.id, username: user.username, role: user.role, ip: '127.0.0.1' };
}

const daysAgo = (n) => addDays(todayISO(), -n);
const daysAhead = (n) => addDays(todayISO(), n);

module.exports = {
  PASSWORDS, USERNAMES, PNG, JPEG, jpegDataUrl, tmpDir, rmDir, buildApp, listen, client, startEnv, setupStaff,
  patientBody, actorFrom, daysAgo, daysAhead, todayISO,
};
