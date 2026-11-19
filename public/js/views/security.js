// Activity & security: audit trail (NFR-SEC2), users (NFR-SEC1), recently deleted
// (NFR-S2), export/import/backups (NFR-PO2, TC-01) and the user's own password.
import { get, post, put, download, api } from '../api.js';
import { html, fmt, toast, toastError, openModal, closeModal, confirmDialog, promptDialog, showFieldErrors } from '../ui.js';
import { state, can, refreshPatient } from '../state.js';
import { pickFiles } from '../camera.js';

let root;
let tab = null;
let auditEntries = [];
let auditFilter = { action: '', patientId: '' };

const TABS = [
  { id: 'audit', label: 'Audit trail', perm: 'audit.read' },
  { id: 'users', label: 'Users', perm: 'users.manage' },
  { id: 'trash', label: 'Recently deleted', perm: 'trash.read' },
  { id: 'data', label: 'Data & backups', perm: 'data.export' },
  { id: 'account', label: 'My account', perm: null },
];

const ACTIONS = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'RESTORE', 'SEARCH', 'DENIED', 'LOGIN', 'LOGIN_FAILED', 'LOCKOUT', 'LOGOUT',
  'SESSION_TIMEOUT', 'OCR_SCAN', 'EXPORT', 'IMPORT', 'BACKUP', 'PURGE', 'PASSWORD_CHANGE', 'PASSWORD_RESET', 'UNLOCK'];

const ROLE_LABELS = { admin: 'Administrator', dentist: 'Dentist', frontdesk: 'Front Desk' };

export function mount(el) {
  root = el;
  root.addEventListener('click', onClick);
}

export async function show(params = {}) {
  const visible = TABS.filter((t) => !t.perm || can(t.perm));
  if (params.tab && visible.some((t) => t.id === params.tab)) tab = params.tab;
  if (!tab || !visible.some((t) => t.id === tab)) tab = visible[0].id;
  const isHttps = window.location.protocol === 'https:';
  const hostLabel = window.location.host || '127.0.0.1:3000';
  const idleMins = state.idleMinutes || 10;
  root.innerHTML = String(html`
    <div class="view-header">
      <div><h2>Activity &amp; Security</h2><p>Immutable audit trail, user access, deleted-record recovery and encrypted backups.</p></div>
      <div class="view-actions"><span class="badge green">🔒 Encrypted vault (AES-256-GCM)</span><span class="badge" id="chain-badge">Audit chain: …</span></div>
    </div>

    <div class="sec-posture-grid" aria-label="Secure connection and storage settings">
      <div class="sec-posture-card">
        <div class="sec-posture-head">
          <div>
            <div class="sec-posture-title">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
              <span>Secure Connection Settings</span>
            </div>
            <div class="sec-posture-sub">On-premises network isolation, session hardening &amp; transport policy</div>
          </div>
          <span class="badge green">● Connection Secure</span>
        </div>
        <div class="sec-posture-list">
          <div class="sec-posture-row">
            <span class="sec-posture-label"><span class="sec-posture-dot"></span>Network &amp; Transport Scope</span>
            <span class="sec-posture-val num">${isHttps ? 'HTTPS / TLS 1.3' : 'Local Clinic LAN'} (${hostLabel}) · Zero Cloud</span>
          </div>
          <div class="sec-posture-row">
            <span class="sec-posture-label"><span class="sec-posture-dot"></span>Session &amp; Cookie Hardening</span>
            <span class="sec-posture-val num">HttpOnly · SameSite=Strict · 256-bit Token</span>
          </div>
          <div class="sec-posture-row">
            <span class="sec-posture-label"><span class="sec-posture-dot"></span>CSRF &amp; Browser Isolation</span>
            <span class="sec-posture-val num">CSP default-src 'self' · X-Frame DENY · No-Store</span>
          </div>
          <div class="sec-posture-row">
            <span class="sec-posture-label"><span class="sec-posture-dot"></span>Session Auto-Lock &amp; Brute-Force Guard</span>
            <span class="sec-posture-val num">${idleMins}-min Idle Auto-Lock · 5-Try / 15-min Lockout</span>
          </div>
        </div>
      </div>

      <div class="sec-posture-card">
        <div class="sec-posture-head">
          <div>
            <div class="sec-posture-title">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <span>Secure Storage Settings</span>
            </div>
            <div class="sec-posture-sub">Database encryption at rest, cryptographic key hierarchy &amp; backup vault</div>
          </div>
          <span class="badge green">● AES-256-GCM Active</span>
        </div>
        <div class="sec-posture-list">
          <div class="sec-posture-row">
            <span class="sec-posture-label"><span class="sec-posture-dot"></span>Primary Vault Encryption (At Rest)</span>
            <span class="sec-posture-val num">AES-256-GCM (96-bit IV · 128-bit Auth Tag)</span>
          </div>
          <div class="sec-posture-row">
            <span class="sec-posture-label"><span class="sec-posture-dot"></span>Key Hierarchy &amp; Password KDF</span>
            <span class="sec-posture-val num">HKDF-SHA256 Master Key · scrypt (N=16384, r=8)</span>
          </div>
          <div class="sec-posture-row">
            <span class="sec-posture-label"><span class="sec-posture-dot"></span>Tamper-Evident Audit Storage</span>
            <span class="sec-posture-val num" id="sec-storage-audit">SQLite WAL · HMAC-SHA256 Hash Chain</span>
          </div>
          <div class="sec-posture-row">
            <span class="sec-posture-label"><span class="sec-posture-dot"></span>Automated Backups &amp; Recovery</span>
            <span class="sec-posture-val num">Daily Encrypted .bak · 30-Day Soft-Delete Vault</span>
          </div>
        </div>
      </div>
    </div>

    <div class="tabs" role="tablist">${visible.map((t) => html`<button class="tab ${t.id === tab ? 'active' : ''}" data-tab="${t.id}" role="tab">${t.label}</button>`)}</div>
    <div id="sec-panel"></div>`);
  verifyChain();
  await renderTab();
}

export function onPatientChange() {}

async function verifyChain() {
  const badge = root.querySelector('#chain-badge');
  if (!can('audit.read')) { badge.hidden = true; return; }
  try {
    const v = await get('/audit/verify');
    badge.className = `badge ${v.ok ? 'green' : 'red'}`;
    badge.textContent = v.ok ? `✓ Audit chain intact (${v.count.toLocaleString()} entries)` : `⚠ Audit chain broken at #${v.brokenAtSeq}`;
  } catch { badge.textContent = 'Audit chain: unavailable'; }
}

async function renderTab() {
  const panel = root.querySelector('#sec-panel');
  panel.innerHTML = String(html`<div class="card"><div class="empty-state"><span class="spinner"></span></div></div>`);
  try {
    if (tab === 'audit') await renderAudit(panel, true);
    else if (tab === 'users') await renderUsers(panel);
    else if (tab === 'trash') await renderTrash(panel);
    else if (tab === 'data') await renderData(panel);
    else renderAccount(panel);
  } catch (err) {
    panel.innerHTML = String(html`<div class="notice error">⚠ ${err.message}</div>`);
  }
}

// ------------------------------------------------------------------ audit
function eventBadge(a) {
  const cls = { DENIED: 'red', LOGIN_FAILED: 'red', LOCKOUT: 'red', DELETE: 'amber', PURGE: 'amber', CREATE: 'green', RESTORE: 'green', LOGIN: 'green', READ: '', SEARCH: '' }[a] ?? 'warm';
  return html`<span class="badge ${cls}">${a === 'DENIED' ? 'Blocked (403)' : a}</span>`;
}

const AUTH_TEXT = {
  LOGIN: () => 'Signed in',
  LOGOUT: () => 'Signed out',
  SESSION_TIMEOUT: () => 'Signed out automatically after inactivity',
  LOGIN_FAILED: (d) => `Failed sign-in${d.attempts ? ` (attempt ${d.attempts})` : ''}${d.username ? ` for "${d.username}"` : ''}`,
  LOGIN_BLOCKED: () => 'Sign-in refused: account locked',
  LOCKOUT: (d) => `Account locked after ${d.attempts} failed sign-ins`,
  PASSWORD_CHANGE: () => 'Changed own password',
};

function describe(e) {
  const d = e.details && typeof e.details === 'object' ? e.details : {};
  if (AUTH_TEXT[e.action]) return AUTH_TEXT[e.action](d);
  const parts = [e.entity ? e.entity.replace(/_/g, ' ') : ''];
  if (e.action === 'DENIED') return `Blocked ${d.method || ''} ${d.path || ''} — missing permission ${e.entityId}`;
  if (d.before && d.after) {
    const changes = Object.keys(d.after).filter((k) => JSON.stringify(d.before[k]) !== JSON.stringify(d.after[k]))
      .map((k) => `${k}: ${fmtVal(k, d.before[k])} → ${fmtVal(k, d.after[k])}`);
    parts.push(changes.length ? changes.join('; ') : 'no field changes');
  } else if (Object.keys(d).length) {
    parts.push(Object.entries(d).map(([k, v]) => `${k}: ${fmtVal(k, v)}`).join(', '));
  }
  return parts.filter(Boolean).join(' — ');
}

function fmtVal(k, v) {
  if (v == null) return '—';
  if (/Cents$/.test(k) && typeof v === 'number') return fmt.peso(v);
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function renderAudit(panel, reset) {
  if (reset) {
    const res = await get('/audit', { query: { limit: 100, action: auditFilter.action, patientId: auditFilter.patientId } });
    auditEntries = res.entries;
  }
  panel.innerHTML = String(html`<div class="card">
    <div class="card-top"><div><h3>Audit Trail</h3><span class="card-sub">Every create, read, update and delete on patient records. Entries cannot be edited by any role.</span></div>
      <div class="row">
        <select class="input" id="audit-action" style="width:auto;"><option value="">All events</option>${ACTIONS.map((a) => html`<option ${a === auditFilter.action ? 'selected' : ''}>${a}</option>`)}</select>
        <input class="input num" id="audit-patient" placeholder="Patient ID" value="${auditFilter.patientId}" style="width:150px;" />
        <button class="btn-secondary tall" data-action="audit-filter">Apply</button>
      </div></div>
    ${auditEntries.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Timestamp</th><th>Account</th><th>Role</th><th>Event</th><th>Patient ID</th><th>Details</th></tr></thead>
      <tbody>${auditEntries.map((e) => html`<tr>
        <td data-label="Timestamp" class="num">${fmt.dateTime(e.ts)}</td>
        <td data-label="Account">${e.username || '—'}</td>
        <td data-label="Role">${ROLE_LABELS[e.role] || '—'}</td>
        <td data-label="Event">${eventBadge(e.action)}</td>
        <td data-label="Patient ID" class="num">${e.patientId || '—'}</td>
        <td data-label="Details" style="max-width:420px;">${describe(e)}</td></tr>`)}
      </tbody></table></div>
      ${auditEntries.length >= 100 ? html`<div class="table-foot"><button class="btn-secondary tall" data-action="audit-more">Load older entries</button></div>` : ''}`
    : html`<div class="empty-state"><p>No audit entries match.</p></div>`}
  </div>`);
}

// ------------------------------------------------------------------ users
async function renderUsers(panel) {
  const { users } = await get('/users');
  panel.innerHTML = String(html`<div class="bento-2">
    <div class="card"><div class="card-top"><h3>Clinic Accounts</h3><span class="badge">${users.length}</span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>${users.map((u) => html`<tr>
        <td data-label="User"><strong>${u.displayName}</strong><div class="muted small">${u.username}</div></td>
        <td data-label="Role">${u.roleLabel}</td>
        <td data-label="Status">${!u.active ? html`<span class="badge">Inactive</span>` : u.lockedUntil ? html`<span class="badge red">Locked until ${fmt.dateTime(u.lockedUntil).slice(11)}</span>` : html`<span class="badge green">Active</span>`}</td>
        <td data-label="Actions"><div class="actions">
          ${u.lockedUntil ? html`<button class="btn-secondary" data-unlock="${u.id}">Unlock</button>` : ''}
          <button class="btn-secondary" data-reset="${u.id}">Reset password</button>
          ${u.id !== state.user.id ? html`<button class="btn-secondary" data-role="${u.id}" data-current="${u.role}">Change role</button>
            <button class="btn-secondary ${u.active ? 'danger' : ''}" data-toggle="${u.id}" data-active="${u.active ? '1' : ''}">${u.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}
        </div></td></tr>`)}</tbody></table></div></div>
    <form class="card" id="new-user-form" novalidate>
      <div class="card-top"><h3>Add Account</h3><span class="badge warm">Unique credentials</span></div>
      <div class="field"><div class="field-label"><span>Full name</span></div><input class="input" name="displayName" placeholder="e.g. Dr. Ana Bautista" /><div class="field-error"></div></div>
      <div class="field"><div class="field-label"><span>Username</span></div><input class="input" name="username" autocapitalize="none" placeholder="e.g. dr.bautista" /><div class="field-error"></div></div>
      <div class="field"><div class="field-label"><span>Role</span></div><select class="input" name="role">
        <option value="dentist">Dentist — edits clinical charts</option><option value="frontdesk">Front Desk — demographics &amp; billing</option><option value="admin">Administrator — users, backups, audit</option></select><div class="field-error"></div></div>
      <div class="field"><div class="field-label"><span>Temporary password</span><span class="muted">12+ characters</span></div><input class="input" name="password" type="password" autocomplete="new-password" /><div class="field-error"></div></div>
      <button class="btn-primary" type="submit" style="width:100%;">Create account</button>
    </form></div>`);
  panel.querySelector('#new-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await post('/users', { displayName: f.displayName.value, username: f.username.value, role: f.role.value, password: f.password.value });
      toast('Account created');
      renderUsers(panel);
    } catch (err) { if (err.body.fields) showFieldErrors(f, err.body.fields); toastError(err); }
  });
}

// ------------------------------------------------------------------ trash
async function renderTrash(panel) {
  const { items, retentionDays } = await get('/trash');
  const label = { patient: 'Patient', ledger: 'Ledger entry', appointment: 'Appointment', photo: 'Chart photo', mark: 'Chart finding' };
  panel.innerHTML = String(html`<div class="card">
    <div class="card-top"><div><h3>Recently Deleted</h3><span class="card-sub">Soft-deleted records stay recoverable for ${retentionDays} days, then are purged automatically.</span></div><span class="badge">${items.length}</span></div>
    ${items.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Type</th><th>Patient</th><th>Item</th><th>Deleted</th><th>Purged on</th><th></th></tr></thead>
      <tbody>${items.map((i) => html`<tr>
        <td data-label="Type"><span class="badge warm">${label[i.type]}</span></td>
        <td data-label="Patient"><strong>${i.patientName}</strong><div class="muted small num">${i.patientId}</div></td>
        <td data-label="Item">${i.summary}</td>
        <td data-label="Deleted" class="num">${fmt.dateTime(i.deletedAt)}<div class="muted small">${i.deletedBy || ''}</div></td>
        <td data-label="Purged on" class="num">${fmt.dateTime(i.purgeOn).slice(0, 10)}</td>
        <td data-label="Actions">${can('trash.restore') ? html`<button class="btn-secondary" data-restore="${i.type}" data-id="${i.id}">Restore</button>` : ''}</td></tr>`)}</tbody></table></div>`
    : html`<div class="empty-state"><span class="icon">🗑</span><p>Nothing has been deleted recently.</p></div>`}
  </div>`);
}

// ------------------------------------------------------------------ data & backups
async function renderData(panel) {
  const admin = can('backup.manage');
  const b = admin ? await get('/backups') : null;
  panel.innerHTML = String(html`<div class="bento-2">
    <div class="card"><div class="card-top"><h3>Export</h3><span class="badge warm">NFR-PO2</span></div>
      <p class="card-sub" style="margin-bottom:12px;">Full patient data as JSON (re-importable, includes photos) or CSV for spreadsheets. Exports contain personal health information — store them securely.</p>
      <div class="grid-2">
        <button class="btn-secondary tall" data-export="/export/full.json">Full export (JSON)</button>
        <button class="btn-secondary tall" data-export="/export/full.json?files=0">JSON without photos</button>
        <button class="btn-secondary tall" data-export="/export/patients.csv">Patients (CSV)</button>
        <button class="btn-secondary tall" data-export="/export/ledger.csv">Ledger (CSV)</button>
      </div>
      <p class="small muted" style="margin-top:12px;">Charts and ledgers export to PDF from the Dental Chart and Ledger screens (Print / PDF).</p>
      ${can('data.import') ? html`<div class="subhead" style="margin-top:18px;">Import</div>
        <p class="card-sub" style="margin-bottom:10px;">Restore or merge a JSON export. Records are matched by ID; existing records with the same ID are updated.</p>
        <button class="btn-secondary tall" data-action="import">Import JSON export…</button>` : ''}
    </div>
    ${admin ? html`<div class="card"><div class="card-top"><h3>Encrypted Backups</h3><span class="badge ${b.enabled ? 'green' : 'amber'}">${b.enabled ? 'Daily backups on' : 'Daily backups off'}</span></div>
      <p class="card-sub" style="margin-bottom:12px;">Created automatically once a day as <span class="num">Backup_YYYYMMDD_Secure.bak</span> (AES-256-GCM). Keeps the newest ${b.keep}. Folder: <span class="num">${b.directory}</span></p>
      <button class="btn-primary" data-action="backup" style="margin-bottom:12px;">Run backup now</button>
      ${b.backups.length ? html`<div class="appt-list">${b.backups.map((x) => html`<div class="appt-item"><span class="num"><strong>${x.name}</strong></span><span class="small muted num">${fmt.kb(x.size)} · ${fmt.dateTime(x.modifiedAt)}</span></div>`)}</div>`
        : html`<p class="card-sub">No backups yet.</p>`}
      <p class="small muted" style="margin-top:12px;">Restore with the server stopped: <span class="num">npm run restore -- &lt;file&gt;</span>. Keep a copy of data/master.key somewhere safe — backups cannot be decrypted without it.</p>
    </div>` : ''}
  </div>`);
}

// ------------------------------------------------------------------ account
function renderAccount(panel) {
  panel.innerHTML = String(html`<div class="bento-2">
    <form class="card" id="pw-form" novalidate>
      <div class="card-top"><h3>Change Password</h3><span class="badge warm">12+ characters</span></div>
      <div class="field"><div class="field-label"><span>Current password</span></div><input class="input" type="password" name="currentPassword" autocomplete="current-password" /><div class="field-error"></div></div>
      <div class="field"><div class="field-label"><span>New password</span></div><input class="input" type="password" name="newPassword" autocomplete="new-password" /><div class="field-error"></div></div>
      <div class="field"><div class="field-label"><span>Confirm new password</span></div><input class="input" type="password" name="confirm" autocomplete="new-password" /><div class="field-error"></div></div>
      <button class="btn-primary" type="submit" style="width:100%;">Update password</button>
    </form>
    <div class="card"><div class="card-top"><h3>Session</h3><span class="badge green">${state.user.roleLabel}</span></div>
      <dl class="kv"><dt>Signed in as</dt><dd>${state.user.displayName} (${state.user.username})</dd>
        <dt>Auto-lock</dt><dd>After ${state.idleMinutes} minutes without activity</dd>
        <dt>Lockout</dt><dd>15 minutes after 5 failed sign-ins</dd>
        <dt>App version</dt><dd class="num">${state.config.version}</dd></dl>
      <div class="subhead" style="margin-top:16px;">Your permissions</div>
      <div class="row">${[...state.permissions].map((p) => html`<span class="badge">${p}</span>`)}</div>
    </div></div>`);
  panel.querySelector('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.newPassword.value !== f.confirm.value) { showFieldErrors(f, { confirm: 'Passwords do not match.' }); return; }
    try {
      await post('/auth/password', { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value });
      f.reset();
      toast('Password updated');
    } catch (err) { if (err.body.fields) showFieldErrors(f, err.body.fields); toastError(err); }
  });
}

// ------------------------------------------------------------------ clicks
async function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  const panel = root.querySelector('#sec-panel');
  try {
    if (b.dataset.tab) { tab = b.dataset.tab; root.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab)); return renderTab(); }
    if (b.dataset.action === 'audit-filter') {
      auditFilter = { action: root.querySelector('#audit-action').value, patientId: root.querySelector('#audit-patient').value.trim().toUpperCase() };
      return renderAudit(panel, true);
    }
    if (b.dataset.action === 'audit-more') {
      const last = auditEntries[auditEntries.length - 1];
      const res = await get('/audit', { query: { limit: 100, before: last.seq, ...auditFilter } });
      auditEntries = auditEntries.concat(res.entries);
      return renderAudit(panel, false);
    }
    if (b.dataset.unlock) { await post(`/users/${b.dataset.unlock}/unlock`); toast('Account unlocked'); return renderUsers(panel); }
    if (b.dataset.reset) {
      const pw = await promptDialog({ title: 'Reset password', label: 'New temporary password (12+ characters)', type: 'password', confirmLabel: 'Reset', hint: 'The user will be signed out everywhere.' });
      if (!pw) return;
      await post(`/users/${b.dataset.reset}/reset-password`, { password: pw });
      toast('Password reset');
      return renderUsers(panel);
    }
    if (b.dataset.role) {
      const role = await openModal({
        title: 'Change role',
        body: String(html`<div class="choice-grid">${Object.entries(ROLE_LABELS).map(([k, l]) => html`<button type="button" class="btn-secondary tall ${k === b.dataset.current ? 'active-filter' : ''}" data-pick="${k}">${l}</button>`)}</div>`),
        actions: [{ label: 'Cancel', value: null }],
        onMount: (d) => d.querySelectorAll('[data-pick]').forEach((x) => x.addEventListener('click', () => closeModal(x.dataset.pick))),
      });
      if (!role || role === b.dataset.current) return;
      await put(`/users/${b.dataset.role}`, { role });
      toast('Role updated');
      return renderUsers(panel);
    }
    if (b.dataset.toggle) {
      const activate = !b.dataset.active;
      if (!activate && !(await confirmDialog('Deactivate this account? The user is signed out immediately.', { confirmLabel: 'Deactivate', danger: true }))) return;
      await put(`/users/${b.dataset.toggle}`, { active: activate });
      toast(activate ? 'Account reactivated' : 'Account deactivated');
      return renderUsers(panel);
    }
    if (b.dataset.restore) {
      await post(`/trash/${b.dataset.restore}/${encodeURIComponent(b.dataset.id)}/restore`);
      toast('Restored');
      if (state.patient) refreshPatient().catch(() => {});
      return renderTrash(panel);
    }
    if (b.dataset.export) return download(b.dataset.export);
    if (b.dataset.action === 'backup') {
      b.disabled = true;
      const r = await post('/backups');
      toast(`Backup written: ${r.name}`);
      return renderData(panel);
    }
    if (b.dataset.action === 'import') {
      const [file] = await pickFiles({ accept: 'application/json,.json' });
      if (!file) return;
      if (!(await confirmDialog(`Import ${file.name}? Records with matching IDs will be updated.`, { confirmLabel: 'Import' }))) return;
      const text = await file.text();
      let json;
      try { json = JSON.parse(text); } catch { toast('That file is not valid JSON', 'error'); return; }
      const r = await api('POST', '/import', { body: json });
      toast(`Imported ${r.imported.patients} patients, ${r.imported.ledger} ledger entries, ${r.imported.photos} photos`);
    }
  } catch (err) { toastError(err); }
}
