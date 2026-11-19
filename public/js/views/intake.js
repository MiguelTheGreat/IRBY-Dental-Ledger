// FR-1 patient registration (portrait <= 500 KB, mandatory consent) and
// FR-8 OCR scanning. OCR output is never saved without staff review (NFR-S5).
import { get, post, put, del, upload, download } from '../api.js';
import {
  html, fmt, toast, toastError, todayISO, ageOn, initials, showFieldErrors, clearFieldErrors,
  dirty, confirmDialog, openModal,
} from '../ui.js';
import { state, can, setActivePatient, clearPatient, emit } from '../state.js';
import { captureImage, pickFiles, loadBitmap, drawToCanvas, encodeUnder, blobToDataUrl, prepareClinicalPhoto } from '../camera.js';

const FIELDS = ['lastName', 'firstName', 'middleName', 'dateOfBirth', 'sex', 'address', 'contactNumber', 'allergies', 'registrationDate'];
const LABELS = {
  lastName: 'Last name', firstName: 'First name', middleName: 'Middle name', dateOfBirth: 'Date of birth', sex: 'Sex',
  address: 'Residential address', contactNumber: 'Contact number', allergies: 'Allergies / medical alerts', registrationDate: 'Registration date',
};

let root;
let mode = 'new';          // 'new' | 'edit'
let editingId = null;
let portrait = null;       // pending { dataUrl, bytes }
let oversized = null;      // rejected File awaiting "compress automatically"
let autofilled = new Map(); // field -> confidence (unconfirmed OCR values)
let ocrInfo = null;
let saving = false;

export function mount(el) {
  root = el;
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);
  document.addEventListener('irby:discard', (e) => { if (e.detail.includes('intake')) resetToCurrent(); });
}

export async function show(params = {}) {
  if (params.new) {
    if (mode !== 'new' || !root.innerHTML || state.patient) {
      if (!(await dirty.confirmDiscard('start a new registration'))) { if (!root.innerHTML) renderForCurrent(); return; }
      // A new registration is never shown under another patient's header (NFR-S2)
      if (state.patient) clearPatient();
      startNew();
    }
  } else if (!root.innerHTML) {
    renderForCurrent();
  } else if (mode === 'edit' && state.patient && state.patient.id !== editingId) {
    renderForCurrent();
  } else if (mode === 'edit' && !state.patient) {
    startNew();
  }
  refreshOcrStatus();
}

export function onPatientChange() {
  // setActivePatient already confirmed discarding unsaved edits
  if (mode === 'edit' || !dirty.labels().includes('Registration form')) renderForCurrent();
}

function renderForCurrent() {
  if (state.patient) startEdit(state.patient); else startNew();
}

function resetToCurrent() {
  autofilled = new Map(); portrait = null; oversized = null; ocrInfo = null;
  if (mode === 'edit' && state.patient) startEdit(state.patient); else startNew();
}

function startNew() {
  mode = 'new'; editingId = null; portrait = null; oversized = null; autofilled = new Map(); ocrInfo = null;
  dirty.clear('intake');
  render({ registrationDate: todayISO() });
}

function startEdit(p) {
  mode = 'edit'; editingId = p.id; portrait = null; oversized = null; autofilled = new Map(); ocrInfo = null;
  dirty.clear('intake');
  render(p);
}

function markDirty() { dirty.set('intake', 'Registration form'); }

// ------------------------------------------------------------------ rendering
function field(name, { type = 'text', required = false, placeholder = '', options = null, attrs = '' } = {}, values) {
  const v = values[name] ?? '';
  const control = options
    ? html`<select class="input" name="${name}" ${attrs}><option value="">Select…</option>${options.map((o) => html`<option ${o === v ? 'selected' : ''}>${o}</option>`)}</select>`
    : type === 'textarea'
      ? html`<textarea class="input" name="${name}" rows="2" placeholder="${placeholder}">${v}</textarea>`
      : html`<input class="input ${type === 'date' ? 'num' : ''}" type="${type}" name="${name}" value="${v}" placeholder="${placeholder}" ${attrs} />`;
  return html`<div class="field" data-field="${name}">
    <div class="field-label"><span>${LABELS[name]}${required ? html` <span class="req">*</span>` : ''}</span></div>
    ${control}<div class="af-slot" data-af="${name}"></div><div class="field-error"></div></div>`;
}

function render(values) {
  const cfg = state.config;
  const p = mode === 'edit' ? state.patient : null;
  const consentOk = p && p.consent && p.consent.current;
  const maxKb = Math.round(cfg.limits.portraitMaxBytes / 1024);
  const today = todayISO();
  root.innerHTML = String(html`
    <div class="view-header">
      <div>
        <h2>${mode === 'edit' ? 'Patient Profile' : 'Patient Registration'}</h2>
        <p>${mode === 'edit' ? html`Editing <strong>${p.fullName}</strong> · <span class="num">${p.id}</span>` : 'Scan the paper registration form or type the details, then verify the signed consent.'}</p>
      </div>
      <div class="view-actions">
        ${mode === 'edit' && can('patients.write') ? html`<button class="btn-secondary tall" data-action="new">+ New registration</button>` : ''}
        ${can('ocr.scan') && can('patients.write') ? html`<button class="btn-primary" data-action="scan-camera">Scan Paper Form (OCR)</button>` : ''}
      </div>
    </div>

    <div id="ocr-banner"></div>

    <div class="bento-2">
      <form class="card" id="intake-form" novalidate autocomplete="off">
        <div class="card-top">
          <h3>Patient Profile</h3>
          <span class="badge warm" id="intake-status">${mode === 'edit' ? 'Saved record' : 'New record'}</span>
        </div>
        <div class="grid-name">
          ${field('lastName', { required: true }, values)}
          ${field('firstName', { required: true }, values)}
          ${field('middleName', {}, values)}
        </div>
        <div class="grid-dob">
          ${field('dateOfBirth', { type: 'date', required: true, attrs: `max="${today}"` }, values)}
          <div class="field"><div class="field-label"><span>Age</span><span class="muted">auto</span></div>
            <input class="input num" id="intake-age" readonly value="${ageOn(values.dateOfBirth) != null ? ageOn(values.dateOfBirth) + ' yrs' : ''}" tabindex="-1" /></div>
          ${field('sex', { required: true, options: ['Male', 'Female', 'Other'] }, values)}
        </div>
        ${field('address', { required: true, placeholder: 'House no., street, barangay, city' }, values)}
        <div class="grid-2">
          ${field('contactNumber', { type: 'tel', placeholder: '+63 9XX XXX XXXX' }, values)}
          ${field('registrationDate', { type: 'date', required: true, attrs: `max="${today}"` }, { ...values, registrationDate: values.registrationDate || values.registeredOn || today })}
        </div>
        ${field('allergies', { type: 'textarea', placeholder: 'e.g. Penicillin, latex, hypertension — or "None"' }, values)}

        <div class="consent-box" id="consent-card" data-field="consent">
          ${consentOk ? html`
            <div class="row"><span class="badge green">✓ Consent v${p.consent.version} on file</span>
              <span class="small muted">Recorded ${fmt.dateTime(p.consent.recordedAt)} by ${p.consent.recordedBy}</span></div>`
          : html`
            <label>
              <input type="checkbox" id="consent-check" name="consent" />
              <span style="font-size:13px; font-weight:600;"><strong>${cfg.consent.title} (v${cfg.consent.version}):</strong> ${cfg.consent.checkboxLabel}</span>
            </label>
            <details style="margin-top:8px;"><summary class="btn-link">Read consent text</summary><div class="consent-text">${cfg.consent.text}</div></details>
            <div class="consent-error-msg" role="alert"><span class="icon">!</span><span>Verification required: confirm the patient's signed data privacy consent before saving.</span></div>`}
        </div>

        <div class="row" style="margin-top:18px;">
          ${can('patients.write') ? html`<button class="btn-primary grow" type="submit" id="intake-save">${mode === 'edit' ? 'Save Changes' : 'Confirm & Save Profile'}</button>` : ''}
          ${mode === 'edit' ? html`<button class="btn-secondary tall" type="button" data-action="revert">Revert</button>` : html`<button class="btn-secondary tall" type="button" data-action="clear">Clear form</button>`}
        </div>
        <div class="small muted" id="save-timing" style="margin-top:8px;"></div>
      </form>

      <div class="stack">
        <div class="card">
          <div class="card-top"><h3>Portrait Identification</h3><span class="badge" id="portrait-badge">Max ${maxKb} KB</span></div>
          <div class="portrait-box" id="portrait-box"></div>
          <div id="portrait-error"></div>
          ${can('patients.write') ? html`<div class="grid-2">
            <button class="btn-secondary tall" type="button" data-action="portrait-camera">Take photo</button>
            <button class="btn-secondary tall" type="button" data-action="portrait-upload">Upload image</button>
          </div>` : ''}
        </div>

        <div class="card">
          <div class="card-top"><h3>OCR Form Scanner</h3><span class="badge" id="ocr-provider">…</span></div>
          <p class="card-sub" id="ocr-detail">Checking OCR model…</p>
          ${can('ocr.scan') && can('patients.write') ? html`<div class="grid-2" style="margin-top:12px;">
            <button class="btn-secondary tall" type="button" data-action="scan-camera">Scan with camera</button>
            <button class="btn-secondary tall" type="button" data-action="scan-upload">Upload scan</button>
          </div>` : ''}
          <div class="small muted" id="ocr-last" style="margin-top:10px;"></div>
        </div>

        ${mode === 'edit' ? html`<div class="card">
          <div class="card-top"><h3>Record</h3><span class="badge warm num">${p.id}</span></div>
          <dl class="kv">
            <dt>Registered</dt><dd>${fmt.date(p.registeredOn)}</dd>
            <dt>Last visit</dt><dd>${fmt.date(p.lastVisit)}</dd>
            <dt>Next return</dt><dd>${p.nextAppointment ? fmt.date(p.nextAppointment.date) : '—'}</dd>
            <dt>Balance</dt><dd class="num" style="${p.balanceCents > 0 ? 'color:var(--red-main)' : ''}">${fmt.peso(p.balanceCents)}</dd>
            <dt>Updated</dt><dd>${fmt.dateTime(p.updatedAt)}</dd>
          </dl>
          <div class="row" style="margin-top:14px;">
            ${can('data.export') ? html`<button class="btn-secondary" type="button" data-action="export">Export JSON</button>` : ''}
            ${can('patients.delete') ? html`<button class="btn-secondary danger" type="button" data-action="delete">Delete record</button>` : ''}
          </div>
        </div>` : ''}
      </div>
    </div>`);
  root.querySelector('#intake-form').addEventListener('submit', (e) => { e.preventDefault(); save(); });
  if (!can('patients.write')) root.querySelectorAll('#intake-form .input').forEach((i) => { i.disabled = true; });
  renderPortrait();
  renderOcrStatus();
  renderAutofill();
}

function renderPortrait() {
  const box = root.querySelector('#portrait-box');
  const badge = root.querySelector('#portrait-badge');
  const p = mode === 'edit' ? state.patient : null;
  const max = state.config.limits.portraitMaxBytes;
  if (portrait) {
    box.innerHTML = String(html`<img src="${portrait.dataUrl}" alt="Portrait preview" />`);
    badge.className = 'badge green num';
    badge.textContent = `${fmt.kb(portrait.bytes)} • ${mode === 'edit' ? 'Replaces on save' : 'Ready'}`;
  } else if (p && p.hasPortrait) {
    box.innerHTML = String(html`<img src="/api/patients/${p.id}/portrait?v=${p.portraitVersion}" alt="Portrait of ${p.fullName}" />`);
    badge.className = 'badge green';
    badge.textContent = 'On file';
  } else {
    const name = [val('firstName'), val('lastName')].filter(Boolean).join(' ');
    box.innerHTML = String(html`<div class="avatar">${initials(name)}</div><span class="small muted" style="font-weight:600;">No portrait captured yet</span>`);
    badge.className = 'badge';
    badge.textContent = `Max ${Math.round(max / 1024)} KB`;
  }
  const err = root.querySelector('#portrait-error');
  err.innerHTML = oversized ? String(html`<div class="notice error" style="margin-bottom:12px;" role="alert">
      <span>⚠</span><div><strong>Portrait rejected:</strong> ${oversized.name || 'image'} is ${fmt.kb(oversized.size)}. The limit is ${Math.round(max / 1024)} KB.
      <div style="margin-top:6px;"><button class="btn-secondary" type="button" data-action="compress">Compress automatically</button></div></div></div>`) : '';
}

async function refreshOcrStatus() {
  try { state.config.ocr = await get('/ocr/status'); } catch { /* keep last */ }
  renderOcrStatus();
}

function renderOcrStatus() {
  const s = state.config.ocr || {};
  const badge = root.querySelector('#ocr-provider');
  if (!badge) return;
  badge.className = `badge ${s.ready ? (s.demo ? 'amber' : 'green') : 'red'}`;
  badge.textContent = `${s.provider || '?'} • ${s.ready ? (s.demo ? 'demo' : 'ready') : 'not ready'}`;
  root.querySelector('#ocr-detail').textContent = s.ready
    ? (s.demo ? 'Demo provider: returns sample data so the review flow can be tested. Mount your model with OCR_PROVIDER (see README).' : `${s.description}. ${s.detail || ''}`)
    : `${s.description || 'OCR'} is not ready: ${s.detail || 'unknown error'}`;
  root.querySelector('#ocr-last').textContent = ocrInfo ? `Last scan: ${ocrInfo.count} field(s) in ${(ocrInfo.tookMs / 1000).toFixed(1)} s` : '';
}

function renderAutofill() {
  root.querySelectorAll('[data-af]').forEach((slot) => {
    const f = slot.dataset.af;
    const input = root.querySelector(`[name="${f}"]`);
    if (autofilled.has(f)) {
      const c = autofilled.get(f);
      slot.innerHTML = String(html`<span class="af-tag">Auto-filled${c != null ? ` · ${Math.round(c * 100)}% confidence` : ''} <button type="button" data-confirm="${f}" title="Mark as reviewed">✓ Confirm</button></span>`);
      if (input) input.classList.add('ocr-highlight');
    } else {
      slot.innerHTML = '';
      if (input) input.classList.remove('ocr-highlight');
    }
  });
  const banner = root.querySelector('#ocr-banner');
  if (ocrInfo && autofilled.size) {
    banner.innerHTML = String(html`<div class="notice warn" style="margin-bottom:16px; justify-content:space-between; flex-wrap:wrap;">
      <div><strong>${autofilled.size} auto-filled field${autofilled.size === 1 ? '' : 's'} need review.</strong>
        OCR (${ocrInfo.provider}) filled ${ocrInfo.count} field(s) in ${(ocrInfo.tookMs / 1000).toFixed(1)} s. Check each highlighted value against the paper form — edit it or tap ✓ Confirm.</div>
      <div class="row"><button class="btn-secondary" type="button" data-action="raw-text">Show scanned text</button>
        <button class="btn-secondary" type="button" data-action="confirm-all">I reviewed all — confirm</button></div></div>`);
  } else if (ocrInfo) {
    banner.innerHTML = String(html`<div class="notice ok" style="margin-bottom:16px;">✓ All auto-filled fields reviewed. Complete the consent check and save.</div>`);
  } else banner.innerHTML = '';
}

// ------------------------------------------------------------------ events
function val(name) {
  const el = root.querySelector(`[name="${name}"]`);
  return el ? el.value.trim() : '';
}

function onInput(e) {
  const t = e.target;
  if (!t.name) return;
  if (t.name === 'consent') {
    if (t.checked) root.querySelector('#consent-card').classList.remove('error');
    markDirty();
    return;
  }
  if (FIELDS.includes(t.name)) {
    markDirty();
    if (e.type === 'input' && autofilled.has(t.name)) { autofilled.delete(t.name); renderAutofill(); }
    const f = t.closest('.field');
    if (f) f.classList.remove('invalid');
    if (t.name === 'dateOfBirth') {
      const a = ageOn(t.value);
      root.querySelector('#intake-age').value = a != null ? `${a} yrs` : '';
    }
    if ((t.name === 'firstName' || t.name === 'lastName') && !portrait) renderPortrait();
  }
}

async function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.confirm) { autofilled.delete(b.dataset.confirm); renderAutofill(); return; }
  switch (b.dataset.action) {
    case 'new': if (await dirty.confirmDiscard('start a new registration')) { clearPatient(); startNew(); } break;
    case 'clear': if (await dirty.confirmDiscard('clear the form')) startNew(); break;
    case 'revert': if (await dirty.confirmDiscard('revert')) resetToCurrent(); break;
    case 'portrait-camera': return portraitFromCamera();
    case 'portrait-upload': return portraitFromFile();
    case 'compress': return compressOversized();
    case 'scan-camera': return scan('camera');
    case 'scan-upload': return scan('upload');
    case 'confirm-all': autofilled.clear(); renderAutofill(); toast('Auto-filled fields confirmed as reviewed'); break;
    case 'raw-text':
      openModal({ title: 'Scanned text', wide: true, body: String(html`<pre style="white-space:pre-wrap; font-family:inherit; font-size:12.5px; background:var(--bg-subtle); padding:12px; border-radius:10px;">${ocrInfo.text || '(the model returned fields only)'}</pre>`) });
      break;
    case 'export': download(`/patients/${editingId}/export.json`); break;
    case 'delete': return deletePatient();
    default: break;
  }
}

// ------------------------------------------------------------------ portrait
async function portraitFromCamera() {
  const blob = await captureImage({ title: 'Capture portrait', mode: 'portrait', hint: 'Centre the patient\'s face in the circle.' });
  if (blob) await usePortraitBlob(blob, true);
}

async function portraitFromFile() {
  const [file] = await pickFiles({ accept: 'image/jpeg,image/png,image/webp' });
  if (!file) return;
  const max = state.config.limits.portraitMaxBytes;
  if (file.size > max) {
    // NFR-P1: an oversized portrait is rejected with a message immediately
    oversized = file;
    renderPortrait();
    toast(`Portrait rejected: ${fmt.kb(file.size)} exceeds ${Math.round(max / 1024)} KB`, 'error');
    return;
  }
  await usePortraitBlob(file, false);
}

async function compressOversized() {
  if (!oversized) return;
  const f = oversized;
  oversized = null;
  await usePortraitBlob(f, true);
}

async function usePortraitBlob(blob, reencode) {
  try {
    let out = blob;
    if (reencode) {
      const canvas = drawToCanvas(await loadBitmap(blob), { maxEdge: 720, square: true });
      out = await encodeUnder(canvas, state.config.limits.portraitMaxBytes - 2048);
    }
    portrait = { dataUrl: await blobToDataUrl(out), bytes: out.size };
    oversized = null;
    markDirty();
    renderPortrait();
  } catch (err) { toastError(err); }
}

// ------------------------------------------------------------------ OCR
async function scan(source) {
  let blob;
  if (source === 'camera') blob = await captureImage({ title: 'Scan registration form', mode: 'document', hint: 'Fit the whole page inside the frame, in good light.' });
  else [blob] = await pickFiles({ accept: 'image/jpeg,image/png,image/webp' });
  if (!blob) return;
  const filledNow = FIELDS.filter((f) => f !== 'registrationDate' && val(f));
  if (filledNow.length && !(await confirmDialog('Scanned values will replace what is typed in the form. Continue?', { confirmLabel: 'Use scan' }))) return;
  const status = root.querySelector('#intake-status');
  status.innerHTML = String(html`<span class="spinner"></span> Reading form…`);
  try {
    const { blob: img } = await prepareClinicalPhoto(blob, 2400);
    const t0 = performance.now();
    const r = await upload('/ocr/scan', img);
    const total = Math.round(performance.now() - t0);
    let count = 0;
    autofilled = new Map();
    for (const [f, v] of Object.entries(r.fields || {})) {
      const el = root.querySelector(`[name="${f}"]`);
      if (!el || !v) continue;
      el.value = v;
      autofilled.set(f, r.confidence && r.confidence[f] != null ? r.confidence[f] : null);
      count++;
    }
    const dob = root.querySelector('[name="dateOfBirth"]').value;
    root.querySelector('#intake-age').value = ageOn(dob) != null ? `${ageOn(dob)} yrs` : '';
    ocrInfo = { provider: r.provider, tookMs: total, count, text: r.text };
    markDirty();
    renderAutofill();
    renderOcrStatus();
    renderPortrait();
    status.textContent = count ? 'Auto-filled • Pending staff review' : 'Scan found no fields';
    toast(count ? `OCR filled ${count} field${count === 1 ? '' : 's'} — please review` : 'No form fields recognised. Type the details manually.', count ? 'ok' : 'warn');
  } catch (err) {
    status.textContent = mode === 'edit' ? 'Saved record' : 'New record';
    toastError(err);
  }
}

// ------------------------------------------------------------------ save / delete
async function save() {
  if (saving) return;
  const form = root.querySelector('#intake-form');
  clearFieldErrors(form);
  const fields = {};
  for (const f of ['lastName', 'firstName', 'dateOfBirth', 'sex', 'address', 'registrationDate']) if (!val(f)) fields[f] = `${LABELS[f]} is required.`;
  if (autofilled.size) {
    for (const f of autofilled.keys()) fields[f] = 'Auto-filled by OCR — review and confirm this value.';
    toast(`Review ${autofilled.size} auto-filled field${autofilled.size === 1 ? '' : 's'} before saving`, 'error');
  }
  const check = root.querySelector('#consent-check');
  const consentCard = root.querySelector('#consent-card');
  const consentMissing = check && !check.checked;
  if (consentMissing) {
    consentCard.classList.remove('error');
    void consentCard.offsetWidth;
    consentCard.classList.add('error');
  }
  if (Object.keys(fields).length || consentMissing) {
    if (Object.keys(fields).length) showFieldErrors(form, fields);
    else consentCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (consentMissing && !autofilled.size) toast('Submission blocked: consent verification required', 'error');
    return;
  }
  const body = {
    profile: Object.fromEntries(FIELDS.filter((f) => f !== 'registrationDate').map((f) => [f, val(f)])),
    registrationDate: val('registrationDate'),
    consent: check ? { accepted: check.checked, version: state.config.consent.version } : undefined,
    portrait: portrait ? portrait.dataUrl : undefined,
    ocrAssisted: !!ocrInfo,
  };
  saving = true;
  const btn = root.querySelector('#intake-save');
  btn.disabled = true;
  const t0 = performance.now();
  try {
    const saved = mode === 'edit' ? await put(`/patients/${editingId}`, body) : await post('/patients', body);
    const ms = Math.round(performance.now() - t0);
    dirty.clear('intake');
    const wasNew = mode === 'new';
    autofilled.clear(); ocrInfo = null; portrait = null;
    if (wasNew) {
      await setActivePatient(saved.id, { skipGuard: true });
      history.replaceState(null, '', '#/intake');
    } else {
      state.patient = saved;
      emit('patient:updated', saved);
    }
    startEdit(saved);
    root.querySelector('#save-timing').textContent = `✓ Saved in ${ms} ms`;
    root.querySelector('#intake-status').textContent = `Verified & saved (${ms} ms)`;
    toast(wasNew ? `Registered ${saved.fullName} (${saved.id})` : 'Patient profile updated');
  } catch (err) {
    if (err.code === 'CONSENT_REQUIRED' || (err.body.fields && err.body.fields.consent)) {
      consentCard.classList.add('error');
    }
    if (err.body.fields) showFieldErrors(form, err.body.fields);
    if (err.code === 'PORTRAIT_TOO_LARGE') { portrait = null; renderPortrait(); }
    toastError(err);
  } finally {
    saving = false;
    const b = root.querySelector('#intake-save');
    if (b) b.disabled = false;
  }
}

async function deletePatient() {
  const p = state.patient;
  if (!(await confirmDialog(`Move ${p.fullName} (${p.id}) to "Recently deleted"? The record can be restored for ${state.config.trashRetentionDays} days.`, { confirmLabel: 'Delete record', danger: true }))) return;
  try {
    await del(`/patients/${p.id}`);
    dirty.clear('intake');
    clearPatient();
    startNew();
    toast('Patient moved to Recently deleted');
  } catch (err) { toastError(err); }
}
