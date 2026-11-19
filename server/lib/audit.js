'use strict';
// NFR-SEC2: every create/read/update/delete on patient records is logged with
// user, timestamp and action. Rows are append-only (enforced by DB triggers) and
// chained with HMAC-SHA256 so any edit made outside the app is detectable.
const { nn } = require('../db');

class AuditLog {
  constructor(db, vault) {
    this.db = db;
    this.vault = vault;
    this.lastStmt = db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');
    this.insertStmt = db.prepare(`INSERT INTO audit_log
      (ts, user_id, username, role, action, entity, entity_id, patient_id, details, ip, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  }

  static payload(row) {
    return JSON.stringify([row.ts, row.user_id, row.username, row.role, row.action, row.entity,
      row.entity_id, row.patient_id, row.details, row.ip]);
  }

  append({ user = null, action, entity = null, entityId = null, patientId = null, details = null, ip = null }) {
    const last = this.lastStmt.get();
    const row = {
      ts: Date.now(),
      user_id: nn(user && user.id),
      username: nn(user && user.username),
      role: nn(user && user.role),
      action,
      entity: nn(entity),
      entity_id: entityId == null ? null : String(entityId),
      patient_id: nn(patientId),
      details: details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)),
      ip: nn(ip),
    };
    const prev = last ? last.hash : 'GENESIS';
    const hash = this.vault.hmac(prev + '|' + AuditLog.payload(row));
    this.insertStmt.run(row.ts, row.user_id, row.username, row.role, row.action, row.entity,
      row.entity_id, row.patient_id, row.details, row.ip, prev, hash);
    return hash;
  }

  list({ limit = 100, before = null, action = null, patientId = null, username = null } = {}) {
    const where = [];
    const params = [];
    if (before) { where.push('seq < ?'); params.push(Number(before)); }
    if (action) { where.push('action = ?'); params.push(action); }
    if (patientId) { where.push('patient_id = ?'); params.push(patientId); }
    if (username) { where.push('username = ? COLLATE NOCASE'); params.push(username); }
    const sql = `SELECT seq, ts, user_id, username, role, action, entity, entity_id, patient_id, details, ip
      FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY seq DESC LIMIT ?`;
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    return this.db.prepare(sql).all(...params).map((r) => ({
      seq: r.seq, ts: r.ts, userId: r.user_id, username: r.username, role: r.role, action: r.action,
      entity: r.entity, entityId: r.entity_id, patientId: r.patient_id, ip: r.ip,
      details: r.details && r.details.startsWith('{') ? JSON.parse(r.details) : r.details,
    }));
  }

  /** Recompute the whole HMAC chain. */
  verify() {
    let prev = 'GENESIS';
    let count = 0;
    for (const row of this.db.prepare('SELECT * FROM audit_log ORDER BY seq').iterate()) {
      const expected = this.vault.hmac(prev + '|' + AuditLog.payload(row));
      if (row.prev_hash !== prev || row.hash !== expected) {
        return { ok: false, count, brokenAtSeq: row.seq };
      }
      prev = row.hash;
      count++;
    }
    return { ok: true, count, brokenAtSeq: null };
  }
}

module.exports = { AuditLog };
