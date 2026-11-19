'use strict';
const express = require('express');
const { HttpError } = require('../lib/errors');
const { permissionsFor } = require('../lib/rbac');
const { sessionToken, setSessionCookie, clearSessionCookie, requireAuth } = require('./mw');

module.exports = (ctx) => {
  const r = express.Router();
  const auth = ctx.services.auth;
  const sessionInfo = (user) => ({
    user,
    permissions: permissionsFor(user.role),
    idleMinutes: ctx.config.security.idleMinutes,
  });

  r.get('/setup/status', (req, res) => {
    res.json({ needsSetup: auth.countUsers() === 0, minPasswordLength: ctx.config.security.minPasswordLength });
  });

  // First run only: create the administrator account.
  r.post('/setup', async (req, res) => {
    if (auth.countUsers() > 0) throw new HttpError(409, 'ALREADY_SET_UP', 'The administrator account already exists.');
    const { username, displayName, password } = req.body || {};
    const user = await auth.createUser({ username, displayName, password, role: 'admin' }, null);
    const { token } = await auth.login(username, password, { ip: req.ip, userAgent: req.get('user-agent') });
    setSessionCookie(req, res, token);
    res.status(201).json(sessionInfo({ ...user, sessionExpiresAt: Date.now() + auth.idleMs }));
  });

  r.post('/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    const { token, user } = await auth.login(username, password, { ip: req.ip, userAgent: req.get('user-agent') });
    setSessionCookie(req, res, token);
    res.json(sessionInfo({ ...user, sessionExpiresAt: Date.now() + auth.idleMs }));
  });

  r.post('/auth/logout', (req, res) => {
    const token = sessionToken(req);
    const user = token ? auth.authenticate(token, { touch: false }) : null;
    auth.logout(token, user ? { ...user, ip: req.ip } : null);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  r.get('/auth/me', requireAuth(ctx), (req, res) => res.json(sessionInfo(req.user)));

  // Explicit "user is active" signal from the browser idle timer (NFR-SEC1).
  r.post('/auth/keepalive', requireAuth(ctx), (req, res) => res.json({ ok: true, sessionExpiresAt: req.user.sessionExpiresAt }));

  r.post('/auth/password', requireAuth(ctx), async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    await auth.changePassword(req.actor, currentPassword, newPassword);
    res.json({ ok: true });
  });

  return r;
};
