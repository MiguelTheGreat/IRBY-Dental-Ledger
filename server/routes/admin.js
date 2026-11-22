'use strict';
const express = require('express');
const { requirePerm } = require('./mw');
const { ERROR_CATALOG } = require('../lib/diagnostics');

module.exports = (ctx) => {
  const r = express.Router();
  const s = ctx.services;
  const perm = (p) => requirePerm(ctx, p);

  // ------------------------------------------------------------------ audit (NFR-SEC2)
  r.get('/audit', perm('audit.read'), (req, res) => {
    const q = req.query;
    res.json({ entries: ctx.audit.list({ limit: q.limit, before: q.before, action: q.action, patientId: q.patientId, username: q.username }) });
  });

  r.get('/audit/verify', perm('audit.read'), (req, res) => res.json(ctx.audit.verify()));

  // ------------------------------------------------------------------ users (NFR-SEC1)
  r.get('/users', perm('users.manage'), (req, res) => res.json({ users: s.auth.listUsers() }));

  r.post('/users', perm('users.manage'), async (req, res) => {
    res.status(201).json(await s.auth.createUser(req.body || {}, req.actor));
  });

  r.put('/users/:userId', perm('users.manage'), (req, res) => {
    const { displayName, role, active } = req.body || {};
    if (Number(req.params.userId) === req.user.id && (active === false || (role && role !== req.user.role))) {
      return res.status(422).json({ error: 'SELF_CHANGE', message: 'You cannot deactivate yourself or change your own role.' });
    }
    res.json(s.auth.updateUser(Number(req.params.userId), { displayName, role, active }, req.actor));
  });

  r.post('/users/:userId/reset-password', perm('users.manage'), async (req, res) => {
    res.json(await s.auth.resetPassword(Number(req.params.userId), (req.body || {}).password, req.actor));
  });

  r.post('/users/:userId/unlock', perm('users.manage'), (req, res) => {
    res.json(s.auth.unlock(Number(req.params.userId), req.actor));
  });

  // ------------------------------------------------------------------ trash (NFR-S2)
  r.get('/trash', perm('trash.read'), (req, res) => {
    res.json({ items: s.trash.list(), retentionDays: ctx.config.trashRetentionDays });
  });

  r.post('/trash/:type/:itemId/restore', perm('trash.restore'), (req, res) => {
    s.trash.restore(req.params.type, req.params.itemId, req.actor);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ export / import (NFR-PO2)
  const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

  r.get('/export/full.json', perm('data.export'), (req, res) => {
    const includeFiles = req.query.files !== '0';
    const data = s.transfer.exportAll({ includeFiles });
    ctx.audit.append({ user: req.actor, ip: req.ip, action: 'EXPORT', entity: 'dataset', details: { format: 'json', patients: data.patients.length, includeFiles } });
    res.setHeader('Content-Disposition', `attachment; filename="IRBY_Export_${stamp()}.json"`);
    res.json(data);
  });

  r.get('/export/patients.csv', perm('data.export'), (req, res) => {
    ctx.audit.append({ user: req.actor, ip: req.ip, action: 'EXPORT', entity: 'dataset', details: { format: 'csv', table: 'patients' } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="IRBY_Patients_${stamp()}.csv"`);
    res.send(s.transfer.patientsCsv());
  });

  r.get('/export/ledger.csv', perm('data.export'), (req, res) => {
    ctx.audit.append({ user: req.actor, ip: req.ip, action: 'EXPORT', entity: 'dataset', details: { format: 'csv', table: 'ledger' } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="IRBY_Ledger_${stamp()}.csv"`);
    res.send(s.transfer.ledgerCsv());
  });

  r.post('/import', perm('data.import'), express.json({ limit: '512mb' }), (req, res) => {
    res.json({ ok: true, imported: s.transfer.importData(req.body, req.actor) });
  });

  // ------------------------------------------------------------------ backups (TC-01)
  r.get('/backups', perm('backup.manage'), (req, res) => {
    res.json({ backups: s.backup.list(), directory: ctx.config.backupDir, keep: ctx.config.backupKeep, enabled: ctx.config.backupsEnabled });
  });

  r.post('/backups', perm('backup.manage'), (req, res) => {
    try {
      res.status(201).json(s.backup.run({ reason: 'manual', actor: req.actor }));
    } catch (err) {
      ctx.diagnostics.log('WARN', 'ERR-BACKUP-006', 'storage', `Backup failed: ${err.message}`);
      throw err;
    }
  });

  // ------------------------------------------------------------------ diagnostics & watchdog
  r.get('/diagnostics', perm('audit.read'), (req, res) => {
    const snapshot = ctx.diagnostics.runChecks({ reason: 'watchdog', silent: false });
    res.json({
      snapshot,
      catalog: Object.values(ERROR_CATALOG),
      logs: ctx.diagnostics.getLogs({ limit: req.query.limit || 100, level: req.query.level || '' }),
    });
  });

  r.post('/diagnostics/selftest', perm('audit.read'), (req, res) => {
    const snapshot = ctx.diagnostics.runChecks({ reason: 'manual', silent: false, actor: req.actor });
    res.json({
      snapshot,
      logs: ctx.diagnostics.getLogs({ limit: 100 }),
    });
  });

  r.get('/diagnostics/log', perm('audit.read'), (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="IRBY_Diagnostics_${stamp()}.log"`);
    res.send(ctx.diagnostics.readLogFile());
  });

  return r;
};
