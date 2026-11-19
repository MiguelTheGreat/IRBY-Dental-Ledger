'use strict';
// Builds the Express application and its services. index.js starts it; tests
// call createApp() with a temporary data directory.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { Vault, loadOrCreateMasterKey } = require('./lib/crypto');
const { AuditLog } = require('./lib/audit');
const { loadClinicConfig } = require('./lib/clinicConfig');
const { HttpError } = require('./lib/errors');
const { createOcr } = require('./ocr');

const { AuthService } = require('./services/auth');
const { FileService } = require('./services/files');
const { PatientService } = require('./services/patients');
const { LedgerService } = require('./services/ledger');
const { AppointmentService } = require('./services/appointments');
const { ChartService } = require('./services/chart');
const { DashboardService } = require('./services/dashboard');
const { TrashService } = require('./services/trash');
const { TransferService } = require('./services/transfer');
const { BackupService } = require('./services/backup');
const { csrfGuard, requireAuth } = require('./routes/mw');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "media-src 'self' blob:", "font-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'",
    "base-uri 'self'", "form-action 'self'", "worker-src 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}

function createApp(options = {}) {
  const config = loadConfig(options);
  fs.mkdirSync(config.dataDir, { recursive: true });

  const vault = new Vault(loadOrCreateMasterKey(config.keyFile, options.env || process.env));
  const db = openDatabase(config.dbFile);
  const audit = new AuditLog(db, vault);
  const clinic = loadClinicConfig(config.configDir);
  const ocr = options.ocr || createOcr(config.ocr, config.root);

  const ctx = { config, db, vault, audit, clinic, ocr, services: {} };
  const s = ctx.services;
  s.auth = new AuthService(ctx);
  s.files = new FileService(ctx);
  s.patients = new PatientService(ctx);
  s.ledger = new LedgerService(ctx);
  s.appointments = new AppointmentService(ctx);
  s.chart = new ChartService(ctx);
  s.dashboard = new DashboardService(ctx);
  s.trash = new TrashService(ctx);
  s.transfer = new TransferService(ctx);
  s.backup = new BackupService(ctx);
  s.patients.load();

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  // ---------------------------------------------------------------- API
  const api = express.Router();
  const smallJson = express.json({ limit: '2mb' });
  api.use((req, res, next) => (req.path === '/import' ? next() : smallJson(req, res, next)));
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use(csrfGuard);
  api.get('/health', (req, res) => res.json({ ok: true, time: Date.now(), version: config.version }));
  api.get('/lan-info', (req, res) => {
    const os = require('node:os');
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);
    res.json({
      hostname: os.hostname(),
      port: config.port,
      httpsPort: config.https.enabled ? config.https.port : null,
      addresses: ips,
      urls: ips.map((ip) => `http://${ip}:${config.port}`),
      httpsUrls: config.https.enabled ? ips.map((ip) => `https://${ip}:${config.https.port}`) : [],
    });
  });
  api.use(require('./routes/auth')(ctx));
  api.use(requireAuth(ctx));
  api.use(require('./routes/clinical')(ctx));
  api.use(require('./routes/admin')(ctx));
  api.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: `No API route for ${req.method} ${req.originalUrl}` }));
  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err instanceof HttpError || (err && err.status && err.code)) {
      return res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra || {}) });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'TOO_LARGE', message: 'The upload is too large.' });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'BAD_JSON', message: 'Malformed JSON body.' });
    }
    console.error('[api]', req.method, req.originalUrl, err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Unexpected server error. The incident was logged.' });
  });
  app.use('/api', api);

  // ---------------------------------------------------------------- static web app
  app.use('/fonts', express.static(config.fontDir, { maxAge: '30d', immutable: true }));
  app.use(express.static(config.publicDir, {
    setHeaders(res, file) {
      if (/\.(html|js|css|webmanifest|json)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(config.publicDir, 'index.html')));

  return {
    app,
    ctx,
    close() { try { db.close(); } catch { /* already closed */ } },
  };
}

module.exports = { createApp };
