'use strict';
const express = require('express');
const { HttpError } = require('../lib/errors');
const { requirePerm } = require('./mw');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function sendImage(res, file, filename) {
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  if (filename) res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  res.end(file.buffer);
}

module.exports = (ctx) => {
  const r = express.Router();
  const s = ctx.services;
  const perm = (p) => requirePerm(ctx, p);
  const audit = (req, action, entity, entityId, patientId, details) =>
    ctx.audit.append({ user: req.actor, ip: req.ip, action, entity, entityId, patientId, details });

  // ------------------------------------------------------------------ config & dashboard
  r.get('/config', async (req, res) => {
    const c = ctx.clinic;
    res.json({
      clinic: c.clinic,
      pda: c.pda,
      consent: { version: c.consent.version, title: c.consent.title, text: c.consent.text, checkboxLabel: c.consent.checkboxLabel },
      procedures: c.procedures,
      limits: ctx.config.limits,
      ocr: await ctx.ocr.status(),
      trashRetentionDays: ctx.config.trashRetentionDays,
      version: ctx.config.version,
    });
  });

  r.get('/dashboard', perm('appointments.read'), (req, res) => {
    const data = s.dashboard.build();
    audit(req, 'READ', 'dashboard', null, null, { followUps: data.followUps.length });
    res.json(data);
  });

  // ------------------------------------------------------------------ patients (FR-1, FR-2)
  r.get('/patients', perm('patients.read'), (req, res) => {
    const result = s.patients.search(req.query);
    audit(req, 'SEARCH', 'patient', null, null, { results: result.total, filter: req.query.filter || 'all', sort: result.sort, queryLength: String(req.query.q || '').length });
    res.json(result);
  });

  r.post('/patients', perm('patients.write'), (req, res) => {
    res.status(201).json(s.patients.create(req.body || {}, req.actor));
  });

  r.get('/patients/:id', perm('patients.read'), (req, res) => {
    const detail = s.patients.detail(req.params.id);
    audit(req, 'READ', 'patient', req.params.id, req.params.id);
    res.json(detail);
  });

  r.put('/patients/:id', perm('patients.write'), (req, res) => {
    res.json(s.patients.update(req.params.id, req.body || {}, req.actor));
  });

  r.delete('/patients/:id', perm('patients.delete'), (req, res) => {
    s.patients.softDelete(req.params.id, req.actor);
    res.json({ ok: true });
  });

  r.get('/patients/:id/portrait', perm('patients.read'), (req, res) => {
    const file = s.patients.portrait(req.params.id);
    const e = s.patients.requireActive(req.params.id);
    sendImage(res, file, `${e.id}_${e.profile.lastName}_Profile.${file.mime === 'image/png' ? 'png' : file.mime === 'image/webp' ? 'webp' : 'jpg'}`);
  });

  r.put('/patients/:id/portrait', perm('patients.write'), (req, res) => {
    res.json(s.patients.setPortrait(req.params.id, req.body && req.body.portrait, req.actor));
  });

  r.get('/patients/:id/export.json', perm('data.export'), (req, res) => {
    const data = s.transfer.exportAll({ patientId: req.params.id, includeFiles: req.query.files !== '0' });
    audit(req, 'EXPORT', 'patient', req.params.id, req.params.id, { format: 'json' });
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}_export.json"`);
    res.json(data);
  });

  // ------------------------------------------------------------------ ledger (FR-5, FR-6)
  r.get('/patients/:id/ledger', perm('ledger.read'), (req, res) => {
    const data = s.ledger.list(req.params.id);
    audit(req, 'READ', 'ledger', null, req.params.id, { entries: data.entries.length });
    res.json(data);
  });

  r.post('/patients/:id/ledger', perm('ledger.write'), (req, res) => {
    res.status(201).json(s.ledger.create(req.params.id, req.body || {}, req.actor));
  });

  r.put('/ledger/:entryId', perm('ledger.write'), (req, res) => {
    res.json(s.ledger.update(req.params.entryId, req.body || {}, req.actor));
  });

  r.delete('/ledger/:entryId', perm('ledger.write'), (req, res) => {
    res.json(s.ledger.void(req.params.entryId, (req.body || {}).reason, req.actor));
  });

  // ------------------------------------------------------------------ appointments (FR-6)
  r.get('/patients/:id/appointments', perm('appointments.read'), (req, res) => {
    const list = s.appointments.listForPatient(req.params.id);
    audit(req, 'READ', 'appointment', null, req.params.id, { count: list.length });
    res.json({ appointments: list });
  });

  r.post('/patients/:id/appointments', perm('appointments.write'), (req, res) => {
    res.status(201).json(s.appointments.create(req.params.id, req.body || {}, req.actor));
  });

  r.put('/appointments/:apptId', perm('appointments.write'), (req, res) => {
    res.json(s.appointments.update(req.params.apptId, req.body || {}, req.actor));
  });

  r.delete('/appointments/:apptId', perm('appointments.write'), (req, res) => {
    s.appointments.softDelete(req.params.apptId, req.actor);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ photo chart (FR-3, FR-4)
  r.get('/patients/:id/chart', perm('chart.read'), (req, res) => {
    const data = s.chart.list(req.params.id);
    audit(req, 'READ', 'chart', null, req.params.id, { photos: data.photos.length, marks: data.marks.length });
    res.json(data);
  });

  r.post('/patients/:id/chart/photos', perm('chart.write'),
    express.raw({ type: IMAGE_TYPES, limit: ctx.config.limits.photoMaxBytes + 1024 }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'NO_IMAGE', 'Send the photo as the request body (image/jpeg, image/png or image/webp).');
      const q = req.query;
      res.status(201).json(s.chart.addPhoto(req.params.id, { buffer: req.body, view: q.view, label: q.label, takenOn: q.takenOn, width: q.width, height: q.height }, req.actor));
    });

  r.get('/chart/photos/:photoId/image', perm('chart.read'), (req, res) => {
    sendImage(res, s.chart.photoImage(req.params.photoId));
  });

  r.put('/chart/photos/:photoId', perm('chart.write'), (req, res) => {
    res.json(s.chart.updatePhoto(req.params.photoId, req.body || {}, req.actor));
  });

  r.delete('/chart/photos/:photoId', perm('chart.write'), (req, res) => {
    s.chart.deletePhoto(req.params.photoId, req.actor);
    res.json({ ok: true });
  });

  r.post('/chart/photos/:photoId/restore', perm('chart.write'), (req, res) => {
    s.chart.restorePhoto(req.params.photoId, req.actor);
    res.json({ ok: true });
  });

  r.post('/patients/:id/chart/marks', perm('chart.write'), (req, res) => {
    res.status(201).json(s.chart.addMark(req.params.id, req.body || {}, req.actor));
  });

  r.put('/chart/marks/:markId', perm('chart.write'), (req, res) => {
    res.json(s.chart.updateMark(req.params.markId, req.body || {}, req.actor));
  });

  r.delete('/chart/marks/:markId', perm('chart.write'), (req, res) => {
    s.chart.deleteMark(req.params.markId, req.actor);
    res.json({ ok: true });
  });

  r.post('/chart/marks/:markId/restore', perm('chart.write'), (req, res) => {
    res.json(s.chart.restoreMark(req.params.markId, req.actor));
  });

  // ------------------------------------------------------------------ OCR (FR-8)
  r.get('/ocr/status', perm('ocr.scan'), async (req, res) => res.json(await ctx.ocr.status()));

  r.post('/ocr/scan', perm('ocr.scan'),
    express.raw({ type: IMAGE_TYPES, limit: ctx.config.limits.scanMaxBytes }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'NO_IMAGE', 'Send the scanned page as the request body.');
      const { sniffImage } = require('../lib/images');
      const mime = sniffImage(req.body);
      if (!mime) throw new HttpError(415, 'BAD_IMAGE', 'The scan must be a JPEG, PNG or WebP image.');
      const result = await ctx.ocr.scan(req.body, mime);
      audit(req, 'OCR_SCAN', 'registration_form', null, null,
        { provider: result.provider, tookMs: result.tookMs, fieldsFilled: Object.keys(result.fields).length, bytes: req.body.length });
      res.json(result);
    });

  return r;
};
