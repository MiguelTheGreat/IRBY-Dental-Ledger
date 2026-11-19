'use strict';
// FR-3 / FR-4 photo-based dental chart. Dentists attach intraoral photos and pin
// PDA findings (tooth number + optional surfaces + condition code) onto them.
const { nn } = require('../db');
const { uuid } = require('../lib/crypto');
const { HttpError, Checker, notFound, str } = require('../lib/errors');
const { todayISO, isValidISODate } = require('../lib/dates');
const { sniffImage } = require('../lib/images');
const { VALID_TEETH } = require('../lib/clinicConfig');

const SURFACE_ORDER = ['M', 'O', 'D', 'F', 'L']; // Mesial, Occlusal/Incisal, Distal, Facial/Buccal, Lingual

class ChartService {
  constructor(ctx) {
    this.ctx = ctx;
    this.db = ctx.db;
    this.vault = ctx.vault;
  }

  // ---------------------------------------------------------------- photos
  mapPhoto(r, names) {
    const by = names.get(r.created_by);
    return {
      id: r.id, view: r.view, label: r.label_enc ? this.vault.decryptText(r.label_enc) : '', takenOn: r.taken_on,
      width: r.width, height: r.height, createdAt: r.created_at, createdBy: by ? by.display_name : null,
    };
  }

  mapMark(r, names) {
    const by = names.get(r.created_by);
    return {
      id: r.id, photoId: r.photo_id, tooth: r.tooth, surfaces: r.surfaces ? r.surfaces.split(',') : [],
      condition: r.condition, x: r.x, y: r.y, note: r.note_enc ? this.vault.decryptText(r.note_enc) : '',
      createdAt: r.created_at, createdBy: by ? by.display_name : null, updatedAt: r.updated_at,
    };
  }

  list(patientId) {
    this.ctx.services.patients.requireActive(patientId);
    const names = this.ctx.services.auth.userNames();
    const photos = this.db.prepare('SELECT * FROM chart_photos WHERE patient_id = ? AND deleted_at IS NULL ORDER BY taken_on DESC, created_at DESC')
      .all(patientId).map((r) => this.mapPhoto(r, names));
    const marks = this.db.prepare('SELECT * FROM chart_marks WHERE patient_id = ? AND deleted_at IS NULL ORDER BY created_at')
      .all(patientId).map((r) => this.mapMark(r, names));
    return { photos, marks };
  }

  validatePhotoMeta(input, c) {
    const view = str(input.view) || 'other';
    if (!this.ctx.clinic.photoViewIds.has(view)) c.fail('view', 'Unknown photo view.');
    const label = str(input.label);
    if (label.length > 120) c.fail('label', 'Must be 120 characters or fewer.');
    const takenOn = str(input.takenOn) || todayISO();
    if (!isValidISODate(takenOn) || takenOn > todayISO()) c.fail('takenOn', 'Enter a valid photo date (not in the future).');
    return { view, label, takenOn };
  }

  addPhoto(patientId, { buffer, view, label, takenOn, width, height }, actor) {
    this.ctx.services.patients.requireActive(patientId);
    const c = new Checker();
    const meta = this.validatePhotoMeta({ view, label, takenOn }, c);
    const mime = sniffImage(buffer);
    if (!mime) c.fail('image', 'Upload a JPEG, PNG or WebP photo.');
    c.throwIfAny();
    if (buffer.length > this.ctx.config.limits.photoMaxBytes) {
      throw new HttpError(413, 'PHOTO_TOO_LARGE', `Photo is larger than ${Math.round(this.ctx.config.limits.photoMaxBytes / 1048576)} MB.`);
    }
    const id = uuid();
    const now = Date.now();
    const fileId = this.ctx.services.files.put({ patientId, kind: 'chart_photo', mime, buffer, createdBy: actor.id });
    const w = Number.isFinite(Number(width)) && Number(width) > 0 ? Math.round(Number(width)) : null;
    const h = Number.isFinite(Number(height)) && Number(height) > 0 ? Math.round(Number(height)) : null;
    this.db.prepare(`INSERT INTO chart_photos (id, patient_id, file_id, view, label_enc, taken_on, width, height, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, patientId, fileId, meta.view, meta.label ? this.vault.encryptText(meta.label) : null, meta.takenOn, w, h, now, actor.id, now, actor.id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'CREATE', entity: 'chart_photo', entityId: id, patientId, details: { view: meta.view, bytes: buffer.length } });
    return this.mapPhoto(this.getPhotoRow(id), this.ctx.services.auth.userNames());
  }

  getPhotoRow(id, { includeDeleted = false } = {}) {
    const r = this.db.prepare('SELECT * FROM chart_photos WHERE id = ?').get(id);
    if (!r || (r.deleted_at && !includeDeleted)) throw notFound('Photo');
    return r;
  }

  photoImage(photoId) {
    const r = this.getPhotoRow(photoId);
    this.ctx.services.patients.requireActive(r.patient_id);
    return { patientId: r.patient_id, ...this.ctx.services.files.get(r.file_id) };
  }

  updatePhoto(photoId, input, actor) {
    const r = this.getPhotoRow(photoId);
    const c = new Checker();
    const meta = this.validatePhotoMeta({
      view: input.view !== undefined ? input.view : r.view,
      label: input.label !== undefined ? input.label : (r.label_enc ? this.vault.decryptText(r.label_enc) : ''),
      takenOn: input.takenOn !== undefined ? input.takenOn : r.taken_on,
    }, c);
    c.throwIfAny();
    this.db.prepare('UPDATE chart_photos SET view = ?, label_enc = ?, taken_on = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(meta.view, meta.label ? this.vault.encryptText(meta.label) : null, meta.takenOn, Date.now(), actor.id, photoId);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'UPDATE', entity: 'chart_photo', entityId: photoId, patientId: r.patient_id,
      details: { before: { view: r.view, takenOn: r.taken_on }, after: { view: meta.view, takenOn: meta.takenOn } } });
    return this.mapPhoto(this.getPhotoRow(photoId), this.ctx.services.auth.userNames());
  }

  deletePhoto(photoId, actor) {
    const r = this.getPhotoRow(photoId);
    this.db.prepare('UPDATE chart_photos SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(Date.now(), actor.id, photoId);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'DELETE', entity: 'chart_photo', entityId: photoId, patientId: r.patient_id, details: { soft: true } });
  }

  restorePhoto(photoId, actor) {
    const r = this.getPhotoRow(photoId, { includeDeleted: true });
    this.db.prepare('UPDATE chart_photos SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(photoId);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'RESTORE', entity: 'chart_photo', entityId: photoId, patientId: r.patient_id });
  }

  // ---------------------------------------------------------------- marks
  validateMark(patientId, input, current = null) {
    const c = new Checker();
    const pick = (k, def) => (input[k] !== undefined ? input[k] : def);
    const tooth = Number(pick('tooth', current && current.tooth));
    if (!VALID_TEETH.has(tooth)) c.fail('tooth', 'Choose a valid tooth number.');
    const condition = str(pick('condition', current && current.condition));
    const symbol = this.ctx.clinic.symbolByCode.get(condition);
    if (!symbol) c.fail('condition', 'Choose a condition from the PDA legend.');
    let surfaces = pick('surfaces', current ? (current.surfaces ? current.surfaces.split(',') : []) : []);
    if (!Array.isArray(surfaces)) surfaces = String(surfaces).split(',');
    surfaces = [...new Set(surfaces.map((s) => str(s).toUpperCase()).filter(Boolean))];
    if (surfaces.some((s) => !SURFACE_ORDER.includes(s))) c.fail('surfaces', 'Surfaces must be M, O, D, F or L.');
    if (symbol && symbol.scope === 'tooth') surfaces = [];
    surfaces.sort((a, b) => SURFACE_ORDER.indexOf(a) - SURFACE_ORDER.indexOf(b));
    const photoId = pick('photoId', current && current.photo_id) || null;
    if (photoId) {
      const p = this.db.prepare('SELECT patient_id, deleted_at FROM chart_photos WHERE id = ?').get(photoId);
      if (!p || p.deleted_at || p.patient_id !== patientId) c.fail('photoId', 'Photo does not belong to this patient.');
    }
    let x = pick('x', current && current.x);
    let y = pick('y', current && current.y);
    if (x == null || y == null || !photoId) { x = null; y = null; } else {
      x = Number(x); y = Number(y);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) c.fail('position', 'Pin position must be inside the photo.');
    }
    const note = str(pick('note', current && current.note_enc ? this.vault.decryptText(current.note_enc) : ''));
    if (note.length > 300) c.fail('note', 'Must be 300 characters or fewer.');
    c.throwIfAny();
    return { tooth, condition, surfaces: surfaces.join(','), photoId, x, y, note };
  }

  getMarkRow(id, { includeDeleted = false } = {}) {
    const r = this.db.prepare('SELECT * FROM chart_marks WHERE id = ?').get(id);
    if (!r || (r.deleted_at && !includeDeleted)) throw notFound('Chart mark');
    return r;
  }

  addMark(patientId, input, actor) {
    this.ctx.services.patients.requireActive(patientId);
    const v = this.validateMark(patientId, input);
    const id = uuid();
    const now = Date.now();
    this.db.prepare(`INSERT INTO chart_marks (id, patient_id, photo_id, tooth, surfaces, condition, x, y, note_enc, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, patientId, nn(v.photoId), v.tooth, v.surfaces, v.condition, nn(v.x), nn(v.y), v.note ? this.vault.encryptText(v.note) : null, now, actor.id, now, actor.id);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'CREATE', entity: 'chart_mark', entityId: id, patientId,
      details: { tooth: v.tooth, surfaces: v.surfaces, condition: v.condition, pinned: v.x !== null } });
    return this.mapMark(this.getMarkRow(id), this.ctx.services.auth.userNames());
  }

  updateMark(markId, input, actor) {
    const r = this.getMarkRow(markId);
    const v = this.validateMark(r.patient_id, input, r);
    this.db.prepare(`UPDATE chart_marks SET photo_id = ?, tooth = ?, surfaces = ?, condition = ?, x = ?, y = ?, note_enc = ?, updated_at = ?, updated_by = ? WHERE id = ?`)
      .run(nn(v.photoId), v.tooth, v.surfaces, v.condition, nn(v.x), nn(v.y), v.note ? this.vault.encryptText(v.note) : null, Date.now(), actor.id, markId);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'UPDATE', entity: 'chart_mark', entityId: markId, patientId: r.patient_id,
      details: { before: { tooth: r.tooth, surfaces: r.surfaces, condition: r.condition, x: r.x, y: r.y },
        after: { tooth: v.tooth, surfaces: v.surfaces, condition: v.condition, x: v.x, y: v.y } } });
    return this.mapMark(this.getMarkRow(markId), this.ctx.services.auth.userNames());
  }

  deleteMark(markId, actor) {
    const r = this.getMarkRow(markId);
    this.db.prepare('UPDATE chart_marks SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(Date.now(), actor.id, markId);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'DELETE', entity: 'chart_mark', entityId: markId, patientId: r.patient_id,
      details: { soft: true, tooth: r.tooth, condition: r.condition } });
  }

  restoreMark(markId, actor) {
    const r = this.getMarkRow(markId, { includeDeleted: true });
    this.db.prepare('UPDATE chart_marks SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(markId);
    this.ctx.audit.append({ user: actor, ip: actor.ip, action: 'RESTORE', entity: 'chart_mark', entityId: markId, patientId: r.patient_id });
    return this.mapMark(this.getMarkRow(markId), this.ctx.services.auth.userNames());
  }
}

module.exports = { ChartService, SURFACE_ORDER };
