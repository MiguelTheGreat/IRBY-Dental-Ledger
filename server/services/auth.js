'use strict';
// NFR-SEC1: unique credentials, >= 12-character passwords, 15-minute lock after
// 5 failed logins, idle sessions expire after 10 minutes.
const { hashPassword, verifyPassword, sha256, randomToken } = require('../lib/crypto');
const { HttpError, ValidationError, Checker, str } = require('../lib/errors');
const { isRole, roleLabel } = require('../lib/rbac');

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

class AuthService {
  constructor(ctx) {
    this.ctx = ctx;
    this.db = ctx.db;
    this.sec = ctx.config.security;
  }

  get idleMs() { return this.sec.idleMinutes * 60 * 1000; }

  countUsers() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  passwordProblem(password, username = '') {
    const pw = String(password || '');
    if (pw.length < this.sec.minPasswordLength) return `Password must be at least ${this.sec.minPasswordLength} characters.`;
    if (pw.length > 128) return 'Password must be at most 128 characters.';
    if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the username.';
    if (/^(.)\1+$/.test(pw)) return 'Password must not be a single repeated character.';
    return null;
  }

  publicUser(row) {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      roleLabel: roleLabel(row.role),
      active: !!row.active,
      lockedUntil: row.locked_until && row.locked_until > Date.now() ? row.locked_until : null,
      failedAttempts: row.failed_attempts,
      passwordChangedAt: row.password_changed_at,
      createdAt: row.created_at,
    };
  }

  async createUser({ username, displayName, role, password }, actor) {
    const c = new Checker();
    const u = str(username);
    if (!/^[a-z0-9._@-]{3,64}$/i.test(u)) c.fail('username', 'Use 3-64 letters, digits, dot, dash, underscore or @.');
    if (!str(displayName)) c.fail('displayName', 'Display name is required.');
    if (!isRole(role)) c.fail('role', 'Choose a valid role.');
    const pwProblem = this.passwordProblem(password, u);
    if (pwProblem) c.fail('password', pwProblem);
    if (u && this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(u)) c.fail('username', 'That username is already taken.');
    c.throwIfAny();
    const now = Date.now();
    const hash = await hashPassword(password);
    const { lastInsertRowid } = this.db.prepare(`INSERT INTO users
      (username, display_name, role, password_hash, password_changed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(u, str(displayName), role, hash, now, now, now);
    this.ctx.audit.append({ user: actor, ip: actor && actor.ip, action: 'CREATE', entity: 'user', entityId: lastInsertRowid,
      details: { username: u, role } });
    return this.getUser(Number(lastInsertRowid));
  }

  getUser(id) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'User not found.');
    return this.publicUser(row);
  }

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY active DESC, display_name').all().map((r) => this.publicUser(r));
  }

  async login(username, password, { ip = null, userAgent = null } = {}) {
    const u = str(username);
    const row = u ? this.db.prepare('SELECT * FROM users WHERE username = ?').get(u) : null;
    const now = Date.now();
    if (!row || !row.active) {
      await verifyPassword(String(password || ''), DUMMY_HASH); // equalize timing
      this.ctx.audit.append({ action: 'LOGIN_FAILED', entity: 'user', ip, details: { username: u.slice(0, 64), reason: row ? 'inactive' : 'unknown' } });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.');
    }
    const actor = { id: row.id, username: row.username, role: row.role };
    if (row.locked_until && row.locked_until > now) {
      this.ctx.audit.append({ user: actor, ip, action: 'LOGIN_BLOCKED', entity: 'user', entityId: row.id, details: { lockedUntil: row.locked_until } });
      throw new HttpError(423, 'ACCOUNT_LOCKED', this.lockMessage(row.locked_until), { lockedUntil: row.locked_until });
    }
    const ok = await verifyPassword(String(password || ''), row.password_hash);
    if (!ok) {
      const attempts = row.failed_attempts + 1;
      if (attempts >= this.sec.maxFailedLogins) {
        const until = now + this.sec.lockoutMinutes * 60 * 1000;
        this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ?, updated_at = ? WHERE id = ?').run(until, now, row.id);
        this.ctx.audit.append({ user: actor, ip, action: 'LOCKOUT', entity: 'user', entityId: row.id, details: { attempts, lockedUntil: until } });
        throw new HttpError(423, 'ACCOUNT_LOCKED', this.lockMessage(until), { lockedUntil: until });
      }
      this.db.prepare('UPDATE users SET failed_attempts = ?, updated_at = ? WHERE id = ?').run(attempts, now, row.id);
      this.ctx.audit.append({ user: actor, ip, action: 'LOGIN_FAILED', entity: 'user', entityId: row.id, details: { attempts } });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.');
    }
    this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(now, row.id);
    const token = randomToken(32);
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), row.id, now, now, ip, userAgent ? String(userAgent).slice(0, 200) : null);
    this.ctx.audit.append({ user: actor, ip, action: 'LOGIN', entity: 'user', entityId: row.id });
    return { token, user: this.publicUser({ ...row, failed_attempts: 0, locked_until: null }) };
  }

  lockMessage(until) {
    const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    return `This account is locked after ${this.sec.maxFailedLogins} failed sign-ins. Try again in ${mins} minute${mins === 1 ? '' : 's'} or ask an administrator to unlock it.`;
  }

  /** Resolve a session token. `touch: false` for background requests that must not extend the session. */
  authenticate(token, { touch = true } = {}) {
    if (!token) return null;
    const hash = sha256(token);
    const row = this.db.prepare(`SELECT s.token_hash, s.user_id, s.last_seen, u.username, u.display_name, u.role, u.active
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash);
    if (!row) return null;
    const now = Date.now();
    if (!row.active || now - row.last_seen > this.idleMs) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
      if (row.active) {
        this.ctx.audit.append({ user: { id: row.user_id, username: row.username, role: row.role }, action: 'SESSION_TIMEOUT', entity: 'user', entityId: row.user_id });
      }
      return null;
    }
    if (touch && now - row.last_seen > 5000) {
      this.db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, hash);
    }
    return {
      id: row.user_id, username: row.username, displayName: row.display_name, role: row.role, roleLabel: roleLabel(row.role),
      sessionExpiresAt: (touch ? now : row.last_seen) + this.idleMs,
    };
  }

  logout(token, actor) {
    if (!token) return;
    const { changes } = this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    if (changes && actor) this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'LOGOUT', entity: 'user', entityId: actor.id });
  }

  async changePassword(actor, currentPassword, newPassword) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(actor.id);
    if (!row || !(await verifyPassword(String(currentPassword || ''), row.password_hash))) {
      throw new ValidationError({ currentPassword: 'Current password is incorrect.' });
    }
    const problem = this.passwordProblem(newPassword, row.username);
    if (problem) throw new ValidationError({ newPassword: problem });
    const now = Date.now();
    this.db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?')
      .run(await hashPassword(newPassword), now, now, row.id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'PASSWORD_CHANGE', entity: 'user', entityId: row.id });
  }

  activeAdminCount(excludeId) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(excludeId).n;
  }

  updateUser(id, { displayName, role, active }, actor) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'User not found.');
    const next = {
      display_name: displayName !== undefined ? str(displayName) : row.display_name,
      role: role !== undefined ? role : row.role,
      active: active !== undefined ? (active ? 1 : 0) : row.active,
    };
    const c = new Checker();
    if (!next.display_name) c.fail('displayName', 'Display name is required.');
    if (!isRole(next.role)) c.fail('role', 'Choose a valid role.');
    if (row.role === 'admin' && row.active && (next.role !== 'admin' || !next.active) && this.activeAdminCount(row.id) === 0) {
      c.fail('role', 'At least one active administrator is required.');
    }
    c.throwIfAny();
    this.db.prepare('UPDATE users SET display_name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(next.display_name, next.role, next.active, Date.now(), id);
    if (!next.active) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'UPDATE', entity: 'user', entityId: id,
      details: { before: { role: row.role, active: !!row.active }, after: { role: next.role, active: !!next.active } } });
    return this.getUser(id);
  }

  async resetPassword(id, newPassword, actor) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'User not found.');
    const problem = this.passwordProblem(newPassword, row.username);
    if (problem) throw new ValidationError({ password: problem });
    const now = Date.now();
    this.db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
      .run(await hashPassword(newPassword), now, now, id);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'PASSWORD_RESET', entity: 'user', entityId: id });
    return this.getUser(id);
  }

  unlock(id, actor) {
    const { changes } = this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
    if (!changes) throw new HttpError(404, 'NOT_FOUND', 'User not found.');
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'UNLOCK', entity: 'user', entityId: id });
    return this.getUser(id);
  }

  purgeExpiredSessions() {
    this.db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(Date.now() - this.idleMs);
  }

  userNames() {
    const map = new Map();
    for (const r of this.db.prepare('SELECT id, username, display_name FROM users').all()) map.set(r.id, r);
    return map;
  }
}

module.exports = { AuthService };
