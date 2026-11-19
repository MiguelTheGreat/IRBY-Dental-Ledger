'use strict';
// NFR-SEC1 accounts, passwords, lockout and idle sessions; HTTP plumbing (CSRF, headers, errors, static files).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sha256 } = require('../server/lib/crypto');
const { startEnv, PASSWORDS } = require('./helpers');

const MIN = 60 * 1000;

describe('API: first-run setup and HTTP plumbing', () => {
  let env;
  before(async () => { env = await startEnv(); });
  after(() => env.close());

  it('reports that setup is needed on a fresh install', async () => {
    const r = await env.api.get('/api/setup/status');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { needsSetup: true, minPasswordLength: 12 });
  });

  it('CSRF: mutating requests without X-Requested-With are rejected', async () => {
    const r = await env.api.post('/api/setup', { csrf: false, body: { username: 'admin', displayName: 'A', password: PASSWORDS.admin } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'CSRF_REJECTED');
    assert.equal(env.ctx.services.auth.countUsers(), 0);
  });

  it('NFR-SEC1: setup enforces the password policy', async () => {
    const short = await env.api.post('/api/setup', { body: { username: 'admin', displayName: 'Admin', password: 'short' } });
    assert.equal(short.status, 422);
    assert.equal(short.body.error, 'VALIDATION_FAILED');
    assert.match(short.body.fields.password, /at least 12/);
    const withName = await env.api.post('/api/setup', { body: { username: 'admin', displayName: 'Admin', password: 'my-admin-password' } });
    assert.equal(withName.status, 422);
    assert.match(withName.body.fields.password, /username/);
    const missing = await env.api.post('/api/setup', { body: {} });
    assert.equal(missing.status, 422);
    assert.ok(missing.body.fields.username && missing.body.fields.displayName && missing.body.fields.password);
  });

  it('NFR-SEC1: setup creates the administrator and signs in with a hardened cookie', async () => {
    const r = await env.api.post('/api/setup', { body: { username: 'admin', displayName: 'Clinic Administrator', password: PASSWORDS.admin } });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.username, 'admin');
    assert.equal(r.body.user.role, 'admin');
    assert.equal(r.body.user.roleLabel, 'Administrator');
    assert.equal(r.body.idleMinutes, 10);
    assert.ok(r.body.permissions.includes('users.manage'));
    assert.ok(r.body.user.sessionExpiresAt > Date.now());
    assert.ok(r.cookie && r.cookie.length >= 40);
    assert.match(r.setCookie[0], /HttpOnly/);
    assert.match(r.setCookie[0], /SameSite=Strict/);
    assert.match(r.setCookie[0], /Path=\//);
    // Only the hash of the token is stored.
    assert.ok(env.ctx.db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(sha256(r.cookie)));
    assert.equal(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(r.cookie).n, 0);
    const me = await env.api.get('/api/auth/me', { cookie: r.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'admin');
  });

  it('setup cannot run twice', async () => {
    const r = await env.api.post('/api/setup', { body: { username: 'evil', displayName: 'Evil', password: 'Another#Pass-2026' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'ALREADY_SET_UP');
    assert.equal((await env.api.get('/api/setup/status')).body.needsSetup, false);
  });

  it('health endpoint and security headers', async () => {
    const r = await env.api.get('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.version, require('../package.json').version);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal(r.headers.get('strict-transport-security'), null); // plain HTTP
  });

  it('NFR-SEC1: protected routes require a session and clear stale cookies', async () => {
    const r = await env.api.get('/api/patients');
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'UNAUTHENTICATED');
    const bogus = await env.api.get('/api/auth/me', { cookie: 'not-a-real-token' });
    assert.equal(bogus.status, 401);
    assert.match(bogus.setCookie[0], /Max-Age=0/);
  });

  it('unknown API routes return JSON 404 (after authentication)', async () => {
    const login = await env.api.post('/api/auth/login', { body: { username: 'admin', password: PASSWORDS.admin } });
    const r = await env.api.get('/api/does-not-exist', { cookie: login.cookie });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'NOT_FOUND');
    assert.match(r.body.message, /GET \/api\/does-not-exist/);
  });

  it('malformed JSON is a 400, oversized JSON a 413', async () => {
    const bad = await env.api.post('/api/auth/login', { body: '{"username": ' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'BAD_JSON');
    const big = await env.api.post('/api/auth/login', { body: { username: 'admin', password: 'x'.repeat(2.2 * 1024 * 1024) } });
    assert.equal(big.status, 413);
    assert.equal(big.body.error, 'TOO_LARGE');
  });

  it('serves the web app and falls back to index.html for client routes', async () => {
    const home = await env.api.get('/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(home.body, /<html/i);
    const deep = await env.api.get('/patients/PT-2026-0001');
    assert.equal(deep.status, 200);
    assert.equal(deep.body, home.body);
    const js = await env.api.get('/manifest.webmanifest');
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('cache-control'), 'no-cache');
  });
});

describe('API: login, lockout and sessions (NFR-SEC1)', () => {
  let env, adminCookie;
  const users = {};
  const login = (username, password, opts = {}) => env.api.post('/api/auth/login', { body: { username, password }, ...opts });
  const audit = (action) => env.ctx.audit.list({ action, limit: 500 });
  const setLastSeen = (cookie, ts) => env.ctx.db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(ts, sha256(cookie));
  const lastSeen = (cookie) => env.ctx.db.prepare('SELECT last_seen FROM sessions WHERE token_hash = ?').get(sha256(cookie));

  before(async () => {
    env = await startEnv();
    adminCookie = (await env.api.post('/api/setup', { body: { username: 'admin', displayName: 'Admin', password: PASSWORDS.admin } })).cookie;
    for (const [username, role] of [['desk.ana', 'frontdesk'], ['lock.me', 'frontdesk'], ['dr.cruz', 'dentist'], ['leaving.soon', 'frontdesk']]) {
      const r = await env.api.post('/api/users', { cookie: adminCookie, body: { username, displayName: username, role, password: PASSWORDS.frontdesk } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      users[username] = r.body;
    }
  });
  after(() => env.close());

  it('NFR-SEC1: valid credentials sign in with role permissions', async () => {
    const r = await login('desk.ana', PASSWORDS.frontdesk);
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role, 'frontdesk');
    assert.equal(r.body.user.failedAttempts, 0);
    assert.ok(r.body.permissions.includes('ledger.write'));
    assert.ok(!r.body.permissions.includes('chart.write'));
    assert.ok(r.cookie);
    assert.ok(audit('LOGIN').some((e) => e.username === 'desk.ana'));
  });

  it('NFR-SEC1: usernames are case-insensitive', async () => {
    assert.equal((await login('DESK.ANA', PASSWORDS.frontdesk)).status, 200);
  });

  it('NFR-SEC1: wrong password and unknown user give the same 401', async () => {
    const wrong = await login('desk.ana', 'Wrong#Password-1');
    const unknown = await login('nobody.here', 'Wrong#Password-1');
    const empty = await env.api.post('/api/auth/login', {});
    for (const r of [wrong, unknown, empty]) {
      assert.equal(r.status, 401);
      assert.equal(r.body.error, 'INVALID_CREDENTIALS');
      assert.equal(r.body.message, 'Incorrect username or password.');
    }
    const failed = audit('LOGIN_FAILED');
    assert.ok(failed.some((e) => e.username === 'desk.ana' && e.details.attempts === 1));
    assert.ok(failed.some((e) => e.username === null && e.details.username === 'nobody.here' && e.details.reason === 'unknown'));
    assert.equal((await login('desk.ana', PASSWORDS.frontdesk)).body.user.failedAttempts, 0); // reset on success
  });

  it('NFR-SEC1: 5 failed logins lock the account (423 ACCOUNT_LOCKED)', async () => {
    for (let i = 1; i <= 4; i++) {
      const r = await login('lock.me', `Wrong#Guess-000${i}`);
      assert.equal(r.status, 401, `attempt ${i}`);
    }
    const fifth = await login('lock.me', 'Wrong#Guess-0005');
    assert.equal(fifth.status, 423);
    assert.equal(fifth.body.error, 'ACCOUNT_LOCKED');
    assert.ok(fifth.body.lockedUntil > Date.now() + 14 * MIN);
    assert.match(fifth.body.message, /15 minutes/);
    // Even the right password is refused while locked.
    const right = await login('lock.me', PASSWORDS.frontdesk);
    assert.equal(right.status, 423);
    assert.equal(right.body.error, 'ACCOUNT_LOCKED');
    assert.equal(audit('LOCKOUT').length, 1);
    assert.equal(audit('LOCKOUT')[0].details.attempts, 5);
    assert.ok(audit('LOGIN_BLOCKED').some((e) => e.username === 'lock.me'));
  });

  it('NFR-SEC1: lock expires after 15 minutes', async () => {
    env.ctx.db.prepare('UPDATE users SET locked_until = ? WHERE username = ?').run(Date.now() - 1000, 'lock.me');
    assert.equal((await login('lock.me', PASSWORDS.frontdesk)).status, 200);
    env.ctx.db.prepare('UPDATE users SET locked_until = ? WHERE username = ?').run(Date.now() + 60 * 1000, 'lock.me');
    const r = await login('lock.me', PASSWORDS.frontdesk);
    assert.equal(r.status, 423);
    assert.match(r.body.message, /1 minute /); // singular
  });

  it('NFR-SEC1: an administrator can unlock an account', async () => {
    const list = await env.api.get('/api/users', { cookie: adminCookie });
    const locked = list.body.users.find((u) => u.username === 'lock.me');
    assert.ok(locked.lockedUntil);
    const r = await env.api.post(`/api/users/${locked.id}/unlock`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.lockedUntil, null);
    assert.equal((await login('lock.me', PASSWORDS.frontdesk)).status, 200);
    assert.ok(audit('UNLOCK').length >= 1);
    const missing = await env.api.post('/api/users/9999/unlock', { cookie: adminCookie });
    assert.equal(missing.status, 404);
  });

  it('NFR-SEC1: sessions expire after 10 idle minutes', async () => {
    const { cookie } = await login('dr.cruz', PASSWORDS.frontdesk);
    setLastSeen(cookie, Date.now() - 9 * MIN);
    assert.equal((await env.api.get('/api/auth/me', { cookie })).status, 200, '9 idle minutes is still fine');
    assert.ok(lastSeen(cookie).last_seen > Date.now() - 5000, 'activity extends the session');
    setLastSeen(cookie, Date.now() - 11 * MIN);
    const r = await env.api.get('/api/auth/me', { cookie });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'UNAUTHENTICATED');
    assert.equal(lastSeen(cookie), undefined, 'expired session row is deleted');
    assert.ok(audit('SESSION_TIMEOUT').some((e) => e.username === 'dr.cruz'));
    assert.equal((await env.api.get('/api/auth/me', { cookie })).status, 401);
  });

  it('NFR-SEC1: background polling does not extend the session; keepalive does', async () => {
    const { cookie } = await login('desk.ana', PASSWORDS.frontdesk);
    const old = Date.now() - 60 * 1000;
    setLastSeen(cookie, old);
    const bg = await env.api.get('/api/auth/me', { cookie, headers: { 'X-Background': '1' } });
    assert.equal(bg.status, 200);
    assert.equal(lastSeen(cookie).last_seen, old);
    assert.equal(bg.body.user.sessionExpiresAt, old + 10 * MIN);
    const keep = await env.api.post('/api/auth/keepalive', { cookie });
    assert.equal(keep.status, 200);
    assert.equal(keep.body.ok, true);
    assert.ok(keep.body.sessionExpiresAt > Date.now() + 9 * MIN);
    assert.ok(lastSeen(cookie).last_seen > old);
  });

  it('expired sessions are purged in housekeeping', async () => {
    const { cookie } = await login('desk.ana', PASSWORDS.frontdesk);
    setLastSeen(cookie, Date.now() - 30 * MIN);
    env.ctx.services.auth.purgeExpiredSessions();
    assert.equal(lastSeen(cookie), undefined);
  });

  it('NFR-SEC1: logout ends the session', async () => {
    const { cookie } = await login('desk.ana', PASSWORDS.frontdesk);
    const r = await env.api.post('/api/auth/logout', { cookie });
    assert.equal(r.status, 200);
    assert.match(r.setCookie[0], /Max-Age=0/);
    assert.equal((await env.api.get('/api/auth/me', { cookie })).status, 401);
    const logouts = audit('LOGOUT').length;
    assert.equal((await env.api.post('/api/auth/logout', { cookie })).status, 200); // already gone: no second LOGOUT
    assert.equal((await env.api.post('/api/auth/logout')).status, 200);
    assert.equal(audit('LOGOUT').length, logouts);
  });

  it('NFR-SEC1: change password checks the current password and the policy', async () => {
    const { cookie } = await login('leaving.soon', PASSWORDS.frontdesk);
    const change = (currentPassword, newPassword) => env.api.post('/api/auth/password', { cookie, body: { currentPassword, newPassword } });
    const wrong = await change('Not#The-Password', 'Brand#New-Pass-26');
    assert.equal(wrong.status, 422);
    assert.ok(wrong.body.fields.currentPassword);
    const weak = await change(PASSWORDS.frontdesk, 'short');
    assert.equal(weak.status, 422);
    assert.ok(weak.body.fields.newPassword);
    const named = await change(PASSWORDS.frontdesk, 'xx-leaving.soon-xx');
    assert.equal(named.status, 422);
    const repeated = await change(PASSWORDS.frontdesk, 'zzzzzzzzzzzzzz');
    assert.match(repeated.body.fields.newPassword, /repeated/);
    const long = await change(PASSWORDS.frontdesk, 'Ab#1'.repeat(40));
    assert.match(long.body.fields.newPassword, /at most 128/);
    const ok = await change(PASSWORDS.frontdesk, 'Brand#New-Pass-26');
    assert.equal(ok.status, 200);
    assert.equal((await login('leaving.soon', PASSWORDS.frontdesk)).status, 401);
    assert.equal((await login('leaving.soon', 'Brand#New-Pass-26')).status, 200);
    assert.ok(audit('PASSWORD_CHANGE').some((e) => e.username === 'leaving.soon'));
  });

  it('change password without a JSON body is a validation error, not a crash', async () => {
    const { cookie } = await login('desk.ana', PASSWORDS.frontdesk);
    const r = await env.api.post('/api/auth/password', { cookie });
    assert.equal(r.status, 422);
  });

  it('a malformed session cookie is treated as signed out, not a server error', async () => {
    const r = await env.api.get('/api/auth/me', { headers: { Cookie: 'irby_sid=%E0%A4%A' } });
    assert.equal(r.status, 401);
  });

  it('NFR-SEC1: deactivated accounts lose their sessions and cannot sign in', async () => {
    const { cookie } = await login('leaving.soon', 'Brand#New-Pass-26');
    const id = users['leaving.soon'].id;
    const r = await env.api.put(`/api/users/${id}`, { cookie: adminCookie, body: { active: false } });
    assert.equal(r.status, 200);
    assert.equal(r.body.active, false);
    assert.equal((await env.api.get('/api/auth/me', { cookie })).status, 401);
    const again = await login('leaving.soon', 'Brand#New-Pass-26');
    assert.equal(again.status, 401);
    assert.ok(audit('LOGIN_FAILED').some((e) => e.details.username === 'leaving.soon' && e.details.reason === 'inactive'));
  });

  it('NFR-SEC1: a session of a user deactivated directly in the DB is rejected', async () => {
    const { cookie } = await login('desk.ana', PASSWORDS.frontdesk);
    env.ctx.db.prepare('UPDATE users SET active = 0 WHERE username = ?').run('desk.ana');
    assert.equal((await env.api.get('/api/auth/me', { cookie })).status, 401);
    env.ctx.db.prepare('UPDATE users SET active = 1 WHERE username = ?').run('desk.ana');
  });
});
