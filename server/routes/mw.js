'use strict';
const { can, roleLabel } = require('../lib/rbac');

const COOKIE = 'irby_sid';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // malformed cookie value: ignore it (the request is then simply unauthenticated)
    }
  }
  return out;
}

function sessionToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE] || null;
}

function setSessionCookie(req, res, token) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${secure}`);
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${req.secure ? '; Secure' : ''}`);
}

/** Mutating requests must carry X-Requested-With: irby (CSRF defence on top of SameSite=Strict). */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') === 'irby') return next();
  res.status(403).json({ error: 'CSRF_REJECTED', message: 'Request rejected: missing X-Requested-With header.' });
}

function requireAuth(ctx) {
  return (req, res, next) => {
    const background = req.get('x-background') === '1';
    const user = ctx.services.auth.authenticate(sessionToken(req), { touch: !background });
    if (!user) {
      clearSessionCookie(req, res);
      return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Your session has ended. Please sign in again.' });
    }
    req.user = user;
    req.actor = { id: user.id, username: user.username, role: user.role, ip: req.ip };
    next();
  };
}

/** FR-7: reject with HTTP 403 and record the attempt in the audit trail. */
function requirePerm(ctx, permission) {
  return (req, res, next) => {
    if (can(req.user.role, permission)) return next();
    const pid = [req.params.patientId, req.params.id].find((v) => typeof v === 'string' && v.startsWith('PT-')) || null;
    ctx.audit.append({ user: req.actor, ip: req.ip, action: 'DENIED', entity: 'permission', entityId: permission, patientId: pid,
      details: { method: req.method, path: req.originalUrl.split('?')[0] } });
    res.status(403).json({
      error: 'FORBIDDEN',
      message: `${roleLabel(req.user.role)} accounts are not allowed to do this (${permission}).`,
      permission,
    });
  };
}

module.exports = { COOKIE, parseCookies, sessionToken, setSessionCookie, clearSessionCookie, csrfGuard, requireAuth, requirePerm };
