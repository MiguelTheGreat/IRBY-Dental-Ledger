'use strict';
// Encrypted binary storage (portraits, clinical photos) kept inside the database
// so that one encrypted backup file captures everything.
const { uuid, sha256 } = require('../lib/crypto');
const { notFound } = require('../lib/errors');
const { nn, toBuffer } = require('../db');

class FileService {
  constructor(ctx) {
    this.db = ctx.db;
    this.vault = ctx.vault;
  }

  put({ patientId, kind, mime, buffer, id = uuid(), createdAt = Date.now(), createdBy = null }) {
    this.db.prepare(`INSERT INTO files (id, patient_id, kind, mime, size, sha256, data_enc, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET patient_id = excluded.patient_id, kind = excluded.kind, mime = excluded.mime,
        size = excluded.size, sha256 = excluded.sha256, data_enc = excluded.data_enc, deleted_at = NULL, deleted_by = NULL`)
      .run(id, nn(patientId), kind, mime, buffer.length, sha256(buffer), this.vault.encryptBuffer(buffer), createdAt, nn(createdBy));
    return id;
  }

  get(id, { includeDeleted = false } = {}) {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    if (!row || (row.deleted_at && !includeDeleted)) throw notFound('File');
    return {
      id: row.id, patientId: row.patient_id, kind: row.kind, mime: row.mime, size: row.size, sha256: row.sha256,
      createdAt: row.created_at, buffer: this.vault.decryptBuffer(toBuffer(row.data_enc)),
    };
  }

  softDelete(id, userId) {
    this.db.prepare('UPDATE files SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), nn(userId), id);
  }

  restore(id) {
    this.db.prepare('UPDATE files SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(id);
  }
}

module.exports = { FileService };
