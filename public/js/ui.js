// Shared UI helpers: escaping, toasts, modals, formatting, unsaved-change guard.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(v) {
  return v == null ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Tagged template that escapes every interpolated value unless wrapped in raw(). */
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('');
    else out += v instanceof Raw ? v.s : esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}

// ------------------------------------------------------------------ toast
let toastTimer = null;
export function toast(message, kind = 'ok') {
  const t = $('#toast');
  $('#toast-text').textContent = message;
  $('#toast-icon').textContent = kind === 'error' ? '⚠' : kind === 'warn' ? '!' : '✓';
  t.classList.remove('error', 'warn');
  if (kind !== 'ok') t.classList.add(kind);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'error' ? 4200 : 2400);
}

export function toastError(err) {
  toast(err && err.message ? err.message : 'Something went wrong.', 'error');
}

// ------------------------------------------------------------------ modal
let modalResolve = null;
let modalOnClose = null;

export function openModal({ title = '', body = '', actions = [{ label: 'Close', value: null }], wide = false, onMount, onClose, dismissible = true } = {}) {
  closeModal(null);
  const backdrop = $('#modal');
  const dialog = $('#modal-dialog');
  dialog.classList.toggle('wide', !!wide);
  dialog.innerHTML = String(html`
    ${title ? html`<h3>${title}</h3>` : ''}
    <div class="modal-body">${raw(String(body))}</div>
    <div class="modal-actions">${actions.map((a, i) => html`<button type="button" class="${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-secondary danger tall' : 'btn-secondary tall'}" data-modal-action="${i}">${a.label}</button>`)}</div>`);
  backdrop.classList.add('open');
  backdrop.dataset.dismissible = dismissible ? '1' : '';
  modalOnClose = onClose || null;
  return new Promise((resolve) => {
    modalResolve = resolve;
    dialog.querySelectorAll('[data-modal-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const a = actions[Number(btn.dataset.modalAction)];
        if (a.handler) {
          const keep = await a.handler(dialog);
          if (keep === false) return;
        }
        closeModal(typeof a.value === 'function' ? a.value(dialog) : a.value);
      });
    });
    if (onMount) onMount(dialog);
    const focusable = dialog.querySelector('input, select, textarea, [data-autofocus]') || dialog.querySelector('[data-modal-action]:last-child');
    if (focusable) setTimeout(() => focusable.focus(), 30);
  });
}

export function closeModal(value) {
  const backdrop = $('#modal');
  if (!backdrop.classList.contains('open')) return;
  backdrop.classList.remove('open');
  $('#modal-dialog').innerHTML = '';
  if (modalOnClose) { const fn = modalOnClose; modalOnClose = null; fn(); }
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(value); }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#modal').classList.contains('open') && $('#modal').dataset.dismissible) closeModal(null);
});
document.addEventListener('click', (e) => {
  if (e.target === $('#modal') && $('#modal').dataset.dismissible) closeModal(null);
});

export function confirmDialog(message, { title = 'Please confirm', confirmLabel = 'Confirm', danger = false } = {}) {
  return openModal({
    title, body: esc(message),
    actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, kind: danger ? 'danger' : 'primary', value: true }],
  }).then((v) => v === true);
}

export function promptDialog({ title, label, value = '', type = 'text', placeholder = '', required = true, confirmLabel = 'Save', hint = '' }) {
  return openModal({
    title,
    body: String(html`${hint ? html`<p style="margin-bottom:10px;">${hint}</p>` : ''}<div class="field"><div class="field-label"><span>${label}</span></div>
      <input class="input" id="prompt-input" type="${type}" value="${value}" placeholder="${placeholder}" /><div class="field-error" id="prompt-error">Required.</div></div>`),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: confirmLabel, kind: 'primary',
        handler: (d) => {
          const v = d.querySelector('#prompt-input').value.trim();
          if (required && !v) { d.querySelector('.field').classList.add('invalid'); return false; }
          return true;
        },
        value: (d) => d.querySelector('#prompt-input').value.trim(),
      },
    ],
    onMount: (d) => d.querySelector('#prompt-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') d.querySelector('[data-modal-action="1"]').click();
    }),
  });
}

// ------------------------------------------------------------------ formatting
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmt = {
  peso(cents) {
    if (cents == null || Number.isNaN(cents)) return '—';
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    return `${sign}₱${Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(abs % 100).padStart(2, '0')}`;
  },
  date(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-').map(Number);
    return `${MONTHS[m - 1]} ${String(d).padStart(2, '0')}, ${y}`;
  },
  time(hm) {
    if (!hm) return '';
    const [h, m] = hm.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  },
  // timestamps use the same wording as dates and times everywhere else: "Nov 28, 2026 · 6:02 PM"
  dateTime(ms) {
    if (!ms) return '—';
    return `${fmt.dayOf(ms)} · ${fmt.timeOf(ms)}`;
  },
  dayOf(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return fmt.date(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  },
  timeOf(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return fmt.time(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  },
  // Philippine mobile numbers shown one way ("0917 550 0192") however they were typed;
  // anything else (landlines, foreign numbers) is shown as entered.
  phone(v) {
    if (!v) return '—';
    const digits = String(v).replace(/[^\d+]/g, '');
    const m = /^(?:\+?63|0)?(9\d{2})(\d{3})(\d{4})$/.exec(digits);
    return m ? `0${m[1]} ${m[2]} ${m[3]}` : String(v);
  },
  kb(bytes) { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; },
  sexShort(s) { return s === 'Male' ? 'M' : s === 'Female' ? 'F' : s ? 'O' : ''; },
};

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ageOn(dob, on = todayISO()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || '') || !/^\d{4}-\d{2}-\d{2}$/.test(on || '')) return null;
  const [y1, m1, d1] = dob.split('-').map(Number);
  const [y2, m2, d2] = on.split('-').map(Number);
  let a = y2 - y1;
  if (m2 < m1 || (m2 === m1 && d2 < d1)) a -= 1;
  return a < 0 ? null : a;
}

export function initials(name) {
  const parts = String(name || '').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!parts.length) return '--';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Allergy text that represents an actual alert (not "none" / "N/A"). */
export function hasAlert(text) {
  const t = String(text || '').trim();
  return !!t && !/^(none|n\/?a|nka|nkda|no known( drug)? allerg(y|ies)|wala|-+)\.?$/i.test(t);
}

export function avatarHtml(p, cls = '') {
  if (p && p.hasPortrait) {
    return html`<div class="avatar ${cls}"><img src="/api/patients/${p.id}/portrait?v=${p.portraitVersion || ''}" alt="" loading="lazy" /></div>`;
  }
  return html`<div class="avatar ${cls}">${initials(p && p.fullName)}</div>`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ------------------------------------------------------------------ forms
export function showFieldErrors(root, fields = {}) {
  clearFieldErrors(root);
  let first = null;
  for (const [name, msg] of Object.entries(fields)) {
    const input = root.querySelector(`[name="${name}"]`);
    const field = input ? input.closest('.field') : root.querySelector(`[data-field="${name}"]`);
    if (!field) continue;
    field.classList.add('invalid');
    let errEl = field.querySelector('.field-error');
    if (!errEl) { errEl = document.createElement('div'); errEl.className = 'field-error'; field.appendChild(errEl); }
    errEl.textContent = `⚠ ${msg}`;
    if (!first) first = input || field;
  }
  if (first) { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (first.focus) first.focus({ preventScroll: true }); }
}

export function clearFieldErrors(root) {
  root.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
}

// ------------------------------------------------------------------ unsaved-change guard (NFR-S2)
const dirtyKeys = new Map();
export const dirty = {
  set(key, label) { dirtyKeys.set(key, label); },
  clear(key) { dirtyKeys.delete(key); },
  any() { return dirtyKeys.size > 0; },
  labels() { return [...dirtyKeys.values()]; },
  reset() { dirtyKeys.clear(); },
  async confirmDiscard(action = 'switch patients') {
    if (!dirtyKeys.size) return true;
    const ok = await confirmDialog(`You have unsaved changes in: ${[...dirtyKeys.values()].join(', ')}. Discard them and ${action}?`,
      { title: 'Unsaved changes', confirmLabel: 'Discard changes', danger: true });
    if (ok) {
      const keys = [...dirtyKeys.keys()];
      dirtyKeys.clear();
      document.dispatchEvent(new CustomEvent('irby:discard', { detail: keys }));
    }
    return ok;
  },
};
window.addEventListener('beforeunload', (e) => { if (dirtyKeys.size) { e.preventDefault(); e.returnValue = ''; } });
