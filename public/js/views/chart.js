// FR-3 / FR-4, reworked as a PHOTO chart: instead of a predetermined tooth
// drawing, dentists attach intraoral photos and pin PDA findings onto them.
//
//   Flow A: tooth -> (surface) -> condition   (saved; then optionally tap photo to pin)
//   Flow B: tap photo -> tooth -> condition   (saved with the pin)
// Both are 3 taps or fewer (NFR-U2). Every mark can be undone in one action (NFR-S2).
import { get, post, put, del, upload } from '../api.js';
import { html, raw, fmt, toast, toastError, todayISO, openModal, closeModal, confirmDialog } from '../ui.js';
import { state, can } from '../state.js';
import { captureImage, pickFiles, prepareClinicalPhoto } from '../camera.js';
import { PERMANENT, PRIMARY, ORDER, toothLabel, toothName, surfaceInfo, formatSurfaces, isPrimary } from '../teeth.js';
import { glyph, symbolFor, isGoneCondition } from '../symbols.js';
import {
  ODONTO_BY_CODE,
  KEEP_SURFACES_ON_TOOTH_CODE,
  buildOdontoMap,
  renderToolbar as renderOdontoToolbar,
  renderOdontoChart,
  buildMarksJsonExport,
} from '../odontogram.js';

let root;
const S = {
  patientId: null,
  mode: 'odontogram',  // 'odontogram' | 'photos'
  odontoTool: 'D',
  photos: [],
  marks: [],
  photoId: null,
  tooth: null,
  surfaces: new Set(),
  pending: null,       // { x, y } tapped before choosing a condition
  pinTarget: null,     // mark id waiting for a photo tap
  selected: null,      // selected mark id
  notation: 'FDI',
  dentition: 'permanent',
  findingsFilter: 'all',
  undo: [],
  lastView: 'upper-occlusal',
  busy: false,
};

const editable = () => can('chart.write');

export function mount(el) {
  root = el;
  S.notation = (state.config.clinic.chart && state.config.clinic.chart.defaultNotation) || 'FDI';
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('dragover', (e) => {
    if (!editable() || !S.patientId) return;
    if ([...(e.dataTransfer.items || [])].some((i) => i.kind === 'file')) { e.preventDefault(); stageEl()?.classList.add('drag'); }
  });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) stageEl()?.classList.remove('drag'); });
  root.addEventListener('drop', (e) => {
    stageEl()?.classList.remove('drag');
    if (!editable() || !S.patientId) return;
    const files = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addPhotos(files); }
  });
  document.addEventListener('paste', (e) => {
    if (state.view !== 'chart' || !editable() || !S.patientId) return;
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const files = [...(e.clipboardData.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addPhotos(files); }
  });
  document.addEventListener('keydown', onKey);
}

export async function show() {
  if (!state.patient) { renderEmpty(); return; }
  if (S.patientId !== state.patient.id) await load();
  else render();
}

export function onPatientChange() {
  S.patientId = null;
  if (state.view === 'chart') show();
}

const stageEl = () => root.querySelector('#photo-stage');

async function load() {
  const pid = state.patient.id;
  root.innerHTML = String(html`<div class="card"><div class="empty-state"><span class="spinner"></span>Loading chart…</div></div>`);
  try {
    const data = await get(`/patients/${pid}/chart`);
    Object.assign(S, {
      patientId: pid, photos: data.photos, marks: data.marks, photoId: data.photos[0] ? data.photos[0].id : null,
      tooth: null, surfaces: new Set(), pending: null, pinTarget: null, selected: null, undo: [],
    });
    render();
  } catch (err) {
    root.innerHTML = String(html`<div class="notice error">⚠ ${err.message}</div>`);
  }
}

function renderEmpty() {
  root.innerHTML = String(html`
    <div class="view-header"><div><h2>Dental Chart</h2><p>Select a patient to view or chart their teeth.</p></div></div>
    <div class="card"><div class="empty-state"><span class="icon">🦷</span><h3>No patient selected</h3>
      <p>Choose a patient from the patient list or with "Find patient" above.</p>
      <button class="btn-primary" data-action="go-directory">Open patient list</button></div></div>`);
}

// ------------------------------------------------------------------ rendering
function render() {
  const canEdit = editable();
  root.innerHTML = String(html`
    ${canEdit ? '' : html`<div class="rbac-alert"><span>🔒 <strong>View-only:</strong> ${state.user.roleLabel} accounts cannot edit clinical charts.</span></div>`}
    <div class="view-header">
      <div>
        <h2>Dental Chart</h2>
        <p>${S.mode === 'odontogram'
          ? (canEdit ? 'Interactive 52-tooth PDA Dental Record Chart. Pick a code and tap a tooth or surface.' : 'Interactive 52-tooth PDA Dental Record Chart.')
          : (canEdit ? raw('Add intraoral photos, then pick <strong>tooth → surface → condition</strong>. Tap the photo to pin a finding.') : 'Intraoral photos with PDA findings recorded by the dentist.')}</p>
      </div>
      <div class="view-actions">
        <button class="btn-secondary tall num" data-action="notation">Notation: ${S.notation === 'FDI' ? 'FDI (11–48)' : 'Universal (1–32)'}</button>
        ${canEdit ? html`<button class="btn-secondary tall" data-action="undo" ${S.undo.length ? '' : 'disabled'}>↶ Undo (Z)</button>` : ''}
        <button class="btn-secondary tall" data-action="print">Print / PDF</button>
      </div>
    </div>
    <div class="tabs" role="tablist">
      <button type="button" class="tab ${S.mode === 'odontogram' ? 'active' : ''}" data-chart-mode="odontogram" role="tab">Dental record chart</button>
      <button type="button" class="tab ${S.mode === 'photos' ? 'active' : ''}" data-chart-mode="photos" role="tab">Intraoral photos (${S.photos.length})</button>
    </div>
    ${S.mode === 'odontogram' ? html`
      <div class="card odonto-sheet" id="odonto-card">
        <div class="card-top" style="margin-bottom:10px;">
          <div><h3>Intraoral Examination · 52-Tooth Odontogram</h3><span class="card-sub">${S.marks.length} finding${S.marks.length === 1 ? '' : 's'} recorded</span></div>
          <div class="row">
            <button type="button" class="btn-secondary tall" data-action="odonto-json">Show JSON</button>
            ${canEdit ? html`<button type="button" class="btn-secondary danger tall" data-action="odonto-clear" ${S.marks.length ? '' : 'disabled'}>Clear chart</button>` : ''}
          </div>
        </div>
        <div id="odonto-tools-wrap">${raw(renderOdontoToolbar(S.odontoTool, canEdit))}</div>
        <div id="odonto-chart-wrap">${raw(renderOdontoChart(S.marks, S.notation))}</div>
      </div>
    ` : html`
      <div class="chart-grid ${canEdit ? '' : 'readonly'}">
        <div class="card" id="photo-card">
          <div class="card-top">
            <div><h3>Intraoral Photos</h3><span class="card-sub">${S.photos.length} photo${S.photos.length === 1 ? '' : 's'} · ${S.marks.length} finding${S.marks.length === 1 ? '' : 's'}</span></div>
            ${canEdit ? html`<div class="row">
              <button class="btn-secondary tall" data-action="photo-camera">Take photo</button>
              <button class="btn-secondary tall" data-action="photo-upload">Upload</button></div>` : ''}
          </div>
          <div id="photo-strip-wrap">${photoStrip()}</div>
          <div id="chart-hint">${hint()}</div>
          <div class="photo-stage" id="photo-stage">${stage()}</div>
          <div id="photo-meta">${photoMeta()}</div>
        </div>
        <div class="card tools-card" id="tools-card">${canEdit ? tools() : legend()}</div>
      </div>
    `}
    <div class="card" id="findings-card">${findings()}</div>`);
}

function rerender(parts = ['strip', 'hint', 'stage', 'meta', 'tools', 'findings', 'odonto']) {
  if (S.mode === 'odontogram') {
    if (!root.querySelector('#odonto-card')) return render();
    if (parts.includes('odonto') || parts.includes('tools')) {
      const tw = root.querySelector('#odonto-tools-wrap');
      if (tw) tw.innerHTML = renderOdontoToolbar(S.odontoTool, editable());
      const cw = root.querySelector('#odonto-chart-wrap');
      if (cw) cw.innerHTML = renderOdontoChart(S.marks, S.notation);
      const sub = root.querySelector('#odonto-card .card-sub');
      if (sub) sub.textContent = `${S.marks.length} finding${S.marks.length === 1 ? '' : 's'} recorded`;
      const clr = root.querySelector('[data-action="odonto-clear"]');
      if (clr) clr.disabled = !S.marks.length;
    }
    if (parts.includes('findings')) {
      const fc = root.querySelector('#findings-card');
      if (fc) fc.innerHTML = String(findings());
    }
    const undoBtn = root.querySelector('[data-action="undo"]');
    if (undoBtn) undoBtn.disabled = !S.undo.length;
    return;
  }
  if (!root.querySelector('#photo-card')) return render();
  const map = {
    strip: ['#photo-strip-wrap', photoStrip], hint: ['#chart-hint', hint], stage: ['#photo-stage', stage],
    meta: ['#photo-meta', photoMeta], tools: ['#tools-card', editable() ? tools : legend], findings: ['#findings-card', findings],
  };
  for (const p of parts) {
    if (!map[p]) continue;
    const [sel, fn] = map[p];
    const el = root.querySelector(sel);
    if (el) el.innerHTML = String(fn());
  }
  const undoBtn = root.querySelector('[data-action="undo"]');
  if (undoBtn) undoBtn.disabled = !S.undo.length;
}

function photoStrip() {
  if (!S.photos.length) return '';
  const views = new Map(state.config.clinic.chart.photoViews.map((v) => [v.id, v.label]));
  return html`<div class="photo-strip">
    ${S.photos.map((p) => {
      const n = S.marks.filter((m) => m.photoId === p.id).length;
      return html`<button class="photo-thumb ${p.id === S.photoId ? 'active' : ''}" data-photo="${p.id}" title="${views.get(p.view) || p.view} · ${fmt.date(p.takenOn)}">
        <img src="/api/chart/photos/${p.id}/image" alt="" loading="lazy" /><div class="cap">${views.get(p.view) || p.view}${n ? ` · ${n}` : ''}</div></button>`;
    })}
    ${editable() ? html`<button class="photo-thumb add" data-action="photo-upload"><span>+</span><span>Add</span></button>` : ''}
  </div>`;
}

function hint() {
  if (!editable() || !S.photoId) return '';
  if (S.pinTarget) {
    const m = S.marks.find((x) => x.id === S.pinTarget);
    if (m) return html`<div class="hint-banner"><span>📍 Tap the photo to pin <strong>#${toothLabel(m.tooth, S.notation)} ${formatSurfaces(m.surfaces, m.tooth)} · ${symbolFor(m.condition).name}</strong> (optional)</span><button data-action="cancel-pin">Skip</button></div>`;
  }
  if (S.pending) return html`<div class="hint-banner"><span>📍 Point set. Now choose ${S.tooth ? '' : 'a tooth, '}a condition${S.tooth ? ` for #${toothLabel(S.tooth, S.notation)}` : ''}.</span><button data-action="cancel-pending">Clear point</button></div>`;
  return '';
}

function stage() {
  const photo = S.photos.find((p) => p.id === S.photoId);
  if (!photo) {
    return editable()
      ? html`<div class="dropzone"><span style="font-size:34px;">📸</span><h3>Add the patient's intraoral photos</h3>
          <p>Drag &amp; drop, paste (Ctrl+V), take a photo with the tablet camera, or upload from the intraoral camera's folder.</p>
          <div class="row" style="justify-content:center;"><button class="btn-primary" data-action="photo-camera">Take photo</button><button class="btn-secondary tall" data-action="photo-upload">Upload photos</button></div>
          <p class="small muted">You can also record findings without a photo: pick a tooth and a condition on the right.</p></div>`
      : html`<div class="dropzone"><span style="font-size:34px;">🖼</span><h3>No photos yet</h3><p>The dentist has not added intraoral photos for this patient.</p></div>`;
  }
  const pins = S.marks.filter((m) => m.photoId === photo.id && m.x != null);
  return html`<div class="photo-frame ${editable() ? 'can-pin' : ''}" id="photo-frame">
    <img src="/api/chart/photos/${photo.id}/image" alt="Intraoral photo" id="photo-img" draggable="false" />
    ${pins.map((m) => html`<button class="pin ${m.id === S.selected ? 'selected' : ''}" data-pin="${m.id}" style="left:${(m.x * 100).toFixed(3)}%; top:${(m.y * 100).toFixed(3)}%;" title="${symbolFor(m.condition).name}">
      ${raw(glyph(m.condition, 24))}<span class="pin-label">${toothLabel(m.tooth, S.notation)}${m.surfaces.length ? ' ' + formatSurfaces(m.surfaces, m.tooth) : ''} · ${m.condition}</span></button>`)}
    ${S.pending ? html`<span class="pending-point" style="left:${S.pending.x * 100}%; top:${S.pending.y * 100}%;"></span>` : ''}
  </div>`;
}

function photoMeta() {
  const photo = S.photos.find((p) => p.id === S.photoId);
  if (!photo) return '';
  const views = state.config.clinic.chart.photoViews;
  if (!editable()) {
    const label = (views.find((v) => v.id === photo.view) || {}).label || photo.view;
    return html`<div class="small muted" style="margin-top:10px;">${label} · taken ${fmt.date(photo.takenOn)}${photo.label ? ` · ${photo.label}` : ''}${photo.createdBy ? ` · by ${photo.createdBy}` : ''}</div>`;
  }
  return html`<div class="photo-meta">
    <div class="field"><div class="field-label"><span>View</span></div>
      <select class="input" data-photo-field="view">${views.map((v) => html`<option value="${v.id}" ${v.id === photo.view ? 'selected' : ''}>${v.label}</option>`)}</select></div>
    <div class="field"><div class="field-label"><span>Taken on</span></div><input type="date" class="input num" data-photo-field="takenOn" value="${photo.takenOn}" max="${todayISO()}" /></div>
    <div class="caption-row">
      <div class="field"><div class="field-label"><span>Caption</span></div><input class="input" data-photo-field="label" value="${photo.label}" placeholder="Optional note" maxlength="120" /></div>
      <button class="btn-secondary danger tall" data-action="delete-photo" title="Move photo to Recently deleted">Delete photo</button>
    </div>
  </div>`;
}

function latestByTooth() {
  const map = new Map();
  for (const m of S.marks) map.set(m.tooth, m); // marks are in creation order
  return map;
}

function keypad() {
  const groups = S.dentition === 'primary' ? PRIMARY : PERMANENT;
  const latest = latestByTooth();
  const counts = new Map();
  for (const m of S.marks) counts.set(m.tooth, (counts.get(m.tooth) || 0) + 1);
  return html`<div class="tooth-keypad">${groups.map((g) => html`
    <div class="quad-label">${g.label}</div>
    <div class="quad ${S.dentition === 'primary' ? 'primary' : ''}">${g.teeth.map((t) => {
      const last = latest.get(t);
      return html`<button class="tooth-key ${S.tooth === t ? 'selected' : ''} ${last && isGoneCondition(last.condition) ? 'gone' : ''}" data-tooth="${t}" aria-pressed="${S.tooth === t}"
        title="${toothName(t)}${counts.get(t) ? ` · ${counts.get(t)} finding(s)` : ''}">${toothLabel(t, S.notation)}${last ? html`<span class="dot" style="background:${symbolFor(last.condition).color};"></span>` : ''}</button>`;
    })}</div>`)}</div>`;
}

function tools() {
  const symbols = state.config.pda.symbols;
  const common = symbols.filter((s) => s.common);
  const others = symbols.filter((s) => !s.common);
  const surf = surfaceInfo(S.tooth);
  const symbolBtn = (s) => html`<button class="symbol-btn" data-symbol="${s.code}" title="${s.name}${s.scope === 'tooth' ? ' (whole tooth)' : ''}">
      ${raw(glyph(s, 26))}<span style="min-width:0;"><span class="sym-name">${s.name}</span><span class="sym-code">${s.code}${s.scope === 'tooth' ? ' · whole tooth' : ''}</span></span>
      ${s.key ? html`<span class="key">${s.key}</span>` : ''}</button>`;
  return html`
    <div class="tool-section">
      <div class="tool-title"><span><span class="step">1</span>Tooth</span>
        <span class="row" style="gap:4px;">
          <button class="btn-secondary ${S.dentition === 'permanent' ? 'active-filter' : ''}" data-dentition="permanent" style="min-height:30px; padding:4px 10px;">Permanent</button>
          <button class="btn-secondary ${S.dentition === 'primary' ? 'active-filter' : ''}" data-dentition="primary" style="min-height:30px; padding:4px 10px;">Primary</button>
        </span></div>
      ${keypad()}
      <div class="selected-tooth-name">${S.tooth ? html`<strong>#${toothLabel(S.tooth, S.notation)}</strong> · ${toothName(S.tooth)}` : 'No tooth selected'}</div>
    </div>
    <div class="tool-section">
      <div class="tool-title"><span><span class="step">2</span>Surfaces <span class="muted" style="text-transform:none;">(optional)</span></span></div>
      <div class="surface-chips">${surf.map((s) => html`<button class="surface-chip ${S.surfaces.has(s.code) ? 'on' : ''}" data-surface="${s.code}" aria-pressed="${S.surfaces.has(s.code)}"><b>${s.short}</b><span>${s.name}</span></button>`)}</div>
    </div>
    <div class="tool-section">
      <div class="tool-title"><span><span class="step">3</span>Condition</span><span class="muted" style="text-transform:none;">keys 1–9</span></div>
      <div class="symbol-grid">${common.map(symbolBtn)}</div>
      ${others.length ? html`<details class="more"><summary>More PDA symbols (${others.length}) ▾</summary><div class="symbol-grid">${others.map(symbolBtn)}</div></details>` : ''}
      <div class="field" style="margin:12px 0 0;"><input class="input" id="mark-note" placeholder="Optional note for the next finding" maxlength="300" /></div>
    </div>`;
}

function legend() {
  const used = new Set(S.marks.map((m) => m.condition));
  const list = state.config.pda.symbols.filter((s) => used.has(s.code));
  return html`<div class="card-top"><h3>Legend</h3><span class="badge">PDA symbols</span></div>
    ${list.length ? html`<div class="legend-list">${list.map((s) => html`<div class="legend-item">${raw(glyph(s, 22))}<span><strong>${s.code}</strong> · ${s.name}</span></div>`)}</div>`
      : html`<p class="card-sub">No findings recorded yet.</p>`}`;
}

function findings() {
  const views = new Map(state.config.clinic.chart.photoViews.map((v) => [v.id, v.label]));
  let list = [...S.marks];
  if (S.findingsFilter === 'tooth' && S.tooth) list = list.filter((m) => m.tooth === S.tooth);
  if (S.findingsFilter === 'photo' && S.photoId) list = list.filter((m) => m.photoId === S.photoId);
  list.sort((a, b) => ORDER.indexOf(a.tooth) - ORDER.indexOf(b.tooth) || a.createdAt - b.createdAt);
  return html`
    <div class="card-top">
      <div><h3>Findings</h3><span class="card-sub">${S.marks.length} recorded · sorted by tooth</span></div>
      <div class="filter-row">
        <button class="btn-secondary ${S.findingsFilter === 'all' ? 'active-filter' : ''}" data-ffilter="all">All</button>
        <button class="btn-secondary ${S.findingsFilter === 'tooth' ? 'active-filter' : ''}" data-ffilter="tooth" ${S.tooth ? '' : 'disabled'}>Selected tooth</button>
        <button class="btn-secondary ${S.findingsFilter === 'photo' ? 'active-filter' : ''}" data-ffilter="photo" ${S.photoId ? '' : 'disabled'}>This photo</button>
      </div>
    </div>
    ${list.length ? html`<div class="findings-list">${list.map((m) => {
      const sym = symbolFor(m.condition);
      const photo = S.photos.find((p) => p.id === m.photoId);
      return html`<div class="finding ${m.id === S.selected ? 'selected' : ''}" data-finding="${m.id}">
        ${raw(glyph(sym, 28))}
        <div style="min-width:0;">
          <div class="f-title">#${toothLabel(m.tooth, S.notation)}${m.surfaces.length ? ` · ${formatSurfaces(m.surfaces, m.tooth)}` : ''} — ${sym.name} <span class="muted">(${m.condition})</span></div>
          <div class="f-meta">${toothName(m.tooth)} · ${photo ? (views.get(photo.view) || photo.view) + (m.x == null ? ' (not pinned)' : '') : 'no photo'} · ${fmt.dateTime(m.createdAt)}${m.createdBy ? ` · ${m.createdBy}` : ''}${m.note ? html` · <em>${m.note}</em>` : ''}</div>
        </div>
        <div class="actions">
          ${photo ? html`<button class="btn-secondary" data-locate="${m.id}">Show</button>` : ''}
          ${editable() && S.photoId ? html`<button class="btn-secondary" data-repin="${m.id}">${m.x == null ? 'Pin' : 'Re-pin'}</button>` : ''}
          ${editable() ? html`<button class="btn-secondary danger" data-delete-mark="${m.id}" title="Delete (can be undone)">✕</button>` : ''}
        </div></div>`;
    })}</div>` : html`<div class="empty-state" style="padding:24px;"><p>${S.marks.length ? 'No findings for this filter.' : 'No findings recorded yet.'}</p></div>`}`;
}

// ------------------------------------------------------------------ interactions
async function onClick(e) {
  if (e.target.closest('[data-action="go-directory"]')) { location.hash = '#/directory'; return; }
  const odontoSvg = e.target.closest('svg[data-odonto-tooth]');
  if (odontoSvg) {
    const seg = e.target.closest('[data-odonto-surface]');
    return handleOdontoClick(Number(odontoSvg.dataset.odontoTooth), seg ? seg.dataset.odontoSurface : null);
  }
  const pin = e.target.closest('[data-pin]');
  if (pin) { e.stopPropagation(); selectMark(pin.dataset.pin); return; }
  if (e.target.id === 'photo-img') { stageTap(e); return; }
  const b = e.target.closest('button');
  if (!b) {
    const f = e.target.closest('[data-finding]');
    if (f) selectMark(f.dataset.finding, true);
    return;
  }
  if (b.dataset.chartMode) { S.mode = b.dataset.chartMode; return render(); }
  if (b.dataset.odontoTool) { S.odontoTool = b.dataset.odontoTool; return rerender(['odonto']); }
  if (b.dataset.tooth) return selectTooth(Number(b.dataset.tooth));
  if (b.dataset.surface) return toggleSurface(b.dataset.surface, b);
  if (b.dataset.symbol) return applyCondition(b.dataset.symbol);
  if (b.dataset.photo) { S.photoId = b.dataset.photo; S.pending = null; return rerender(['strip', 'hint', 'stage', 'meta', 'findings']); }
  if (b.dataset.dentition) { S.dentition = b.dataset.dentition; return rerender(['tools']); }
  if (b.dataset.ffilter) { S.findingsFilter = b.dataset.ffilter; return rerender(['findings']); }
  if (b.dataset.locate) return selectMark(b.dataset.locate, true);
  if (b.dataset.repin) { S.pinTarget = b.dataset.repin; S.pending = null; S.mode = 'photos'; render(); toast('Tap the photo where the finding is'); return; }
  if (b.dataset.deleteMark) return deleteMark(b.dataset.deleteMark);
  switch (b.dataset.action) {
    case 'notation': S.notation = S.notation === 'FDI' ? 'Universal' : 'FDI'; render(); toast(`Showing ${S.notation} numbering`); break;
    case 'undo': undo(); break;
    case 'print': window.open(`/print.html?type=chart&id=${encodeURIComponent(S.patientId)}&notation=${S.notation}`, '_blank', 'noopener'); break;
    case 'odonto-clear': return clearOdontoChart();
    case 'odonto-json': return showOdontoJson();
    case 'photo-camera': return photoFromCamera();
    case 'photo-upload': { const files = await pickFiles({ multiple: true, accept: 'image/*' }); if (files.length) addPhotos(files); break; }
    case 'delete-photo': return deletePhoto();
    case 'cancel-pin': S.pinTarget = null; rerender(['hint']); break;
    case 'cancel-pending': S.pending = null; rerender(['hint', 'stage']); break;
    default: break;
  }
}

function onChange(e) {
  const f = e.target.dataset.photoField;
  if (!f || !S.photoId) return;
  const value = e.target.value;
  put(`/chart/photos/${S.photoId}`, { [f]: value })
    .then((p) => { S.photos = S.photos.map((x) => (x.id === p.id ? p : x)); rerender(['strip']); toast('Photo details saved'); })
    .catch(toastError);
}

function onKey(e) {
  if (state.view !== 'chart' || !editable() || !S.patientId) return;
  if (document.querySelector('#modal.open')) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.key === 'Escape') { S.pending = null; S.pinTarget = null; rerender(['hint', 'stage']); return; }
  const sym = state.config.pda.symbols.find((s) => s.key === e.key);
  if (sym) { e.preventDefault(); applyCondition(sym.code); }
}

function selectTooth(t) {
  S.tooth = S.tooth === t ? null : t;
  if (S.tooth && isPrimary(S.tooth) !== (S.dentition === 'primary')) S.dentition = isPrimary(S.tooth) ? 'primary' : 'permanent';
  S.surfaces = new Set();
  rerender(['tools', 'hint', ...(S.findingsFilter === 'tooth' ? ['findings'] : [])]);
}

function toggleSurface(code, btn) {
  // FR-3: only the tapped surface changes state (no full re-render, < 50 ms)
  if (S.surfaces.has(code)) S.surfaces.delete(code); else S.surfaces.add(code);
  btn.classList.toggle('on', S.surfaces.has(code));
  btn.setAttribute('aria-pressed', S.surfaces.has(code));
}

function selectMark(id, focusPhoto = false) {
  const m = S.marks.find((x) => x.id === id);
  if (!m) return;
  S.selected = S.selected === id && !focusPhoto ? null : id;
  if (focusPhoto && m.photoId && m.photoId !== S.photoId) S.photoId = m.photoId;
  rerender(['strip', 'stage', 'meta', 'findings']);
  if (focusPhoto) root.querySelector('#photo-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function stageTap(e) {
  if (!editable()) return;
  const img = e.target;
  const r = img.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  if (S.pinTarget) return pinMark(S.pinTarget, x, y);
  S.pending = { x, y };
  S.selected = null;
  rerender(['hint', 'stage']);
}

async function applyCondition(code) {
  if (!editable() || S.busy) return;
  if (!S.tooth) {
    toast('Choose a tooth number first', 'warn');
    const kp = root.querySelector('.tooth-keypad');
    if (kp) { kp.style.animation = 'none'; void kp.offsetWidth; kp.style.animation = 'shakeAlert 0.4s ease'; }
    return;
  }
  const sym = symbolFor(code);
  const surfaces = sym.scope === 'surface' ? [...S.surfaces] : [];
  const ignored = sym.scope === 'tooth' && S.surfaces.size ? ' (whole-tooth condition)' : '';
  const noteEl = root.querySelector('#mark-note');
  const body = { tooth: S.tooth, surfaces, condition: code, photoId: S.photoId, note: noteEl ? noteEl.value : '' };
  if (S.pending && S.photoId) { body.x = S.pending.x; body.y = S.pending.y; }
  S.busy = true;
  try {
    const mark = await post(`/patients/${S.patientId}/chart/marks`, body);
    S.marks.push(mark);
    S.undo.push({ type: 'add', id: mark.id, label: `${sym.name} on #${toothLabel(mark.tooth, S.notation)}` });
    S.surfaces = new Set();
    S.pending = null;
    S.selected = mark.id;
    S.pinTarget = S.photoId && mark.x == null ? mark.id : null;
    rerender();
    toast(`#${toothLabel(mark.tooth, S.notation)}${mark.surfaces.length ? ' ' + formatSurfaces(mark.surfaces, mark.tooth) : ''}: ${sym.name}${ignored}`);
  } catch (err) {
    toastError(err);
  } finally {
    S.busy = false;
  }
}

async function pinMark(id, x, y) {
  const m = S.marks.find((k) => k.id === id);
  if (!m) return;
  const prev = { x: m.x, y: m.y, photoId: m.photoId };
  try {
    const updated = await put(`/chart/marks/${id}`, { x, y, photoId: S.photoId });
    S.marks = S.marks.map((k) => (k.id === id ? updated : k));
    S.undo.push({ type: 'move', id, prev, label: 'pin position' });
    S.pinTarget = null;
    S.selected = id;
    rerender(['strip', 'hint', 'stage', 'findings']);
    toast('Finding pinned on photo');
  } catch (err) { toastError(err); }
}

async function deleteMark(id) {
  try {
    await del(`/chart/marks/${id}`);
    const m = S.marks.find((k) => k.id === id);
    S.marks = S.marks.filter((k) => k.id !== id);
    if (S.selected === id) S.selected = null;
    if (S.pinTarget === id) S.pinTarget = null;
    S.undo.push({ type: 'delete', id, label: m ? `deleted ${m.condition} on #${toothLabel(m.tooth, S.notation)}` : 'delete' });
    rerender();
    toast('Finding deleted — press Undo to restore');
  } catch (err) { toastError(err); }
}

async function undo() {
  const last = S.undo.pop();
  if (!last) { toast('Nothing to undo', 'warn'); return; }
  try {
    await applyUndoEntry(last);
    rerender();
    toast(`Undone: ${last.label}`);
  } catch (err) {
    S.undo.push(last);
    toastError(err);
  }
}

async function applyUndoEntry(entry) {
  if (entry.type === 'add') {
    await del(`/chart/marks/${entry.id}`);
    S.marks = S.marks.filter((m) => m.id !== entry.id);
    if (S.pinTarget === entry.id) S.pinTarget = null;
  } else if (entry.type === 'delete') {
    const m = await post(`/chart/marks/${entry.id}/restore`);
    S.marks.push(m);
    S.marks.sort((a, b) => a.createdAt - b.createdAt);
  } else if (entry.type === 'move' || entry.type === 'update') {
    const m = await put(`/chart/marks/${entry.id}`, entry.prev);
    S.marks = S.marks.map((k) => (k.id === m.id ? m : k));
  } else if (entry.type === 'batch') {
    for (let i = entry.items.length - 1; i >= 0; i--) {
      await applyUndoEntry(entry.items[i]);
    }
  } else if (entry.type === 'photo-add') {
    await del(`/chart/photos/${entry.id}`);
    S.photos = S.photos.filter((p) => p.id !== entry.id);
    if (S.photoId === entry.id) S.photoId = S.photos[0] ? S.photos[0].id : null;
  } else if (entry.type === 'photo-delete') {
    await post(`/chart/photos/${entry.id}/restore`);
    const data = await get(`/patients/${S.patientId}/chart`);
    S.photos = data.photos; S.marks = data.marks; S.photoId = entry.id;
  }
}

// ------------------------------------------------------------------ odontogram
async function removeSurfaceFromMarks(marksList, letter, ops) {
  for (const m of marksList) {
    const remaining = m.surfaces.filter((s) => s !== letter);
    if (remaining.length === 0) {
      await del(`/chart/marks/${m.id}`);
      S.marks = S.marks.filter((k) => k.id !== m.id);
      ops.push({ type: 'delete', id: m.id });
    } else if (remaining.length < m.surfaces.length) {
      const prevSurfaces = [...m.surfaces];
      const updated = await put(`/chart/marks/${m.id}`, { surfaces: remaining });
      S.marks = S.marks.map((k) => (k.id === m.id ? updated : k));
      ops.push({ type: 'update', id: m.id, prev: { surfaces: prevSurfaces } });
    }
  }
}

async function deleteMarksByIds(ids, ops) {
  for (const id of ids) {
    if (!S.marks.some((m) => m.id === id)) continue;
    await del(`/chart/marks/${id}`);
    S.marks = S.marks.filter((k) => k.id !== id);
    ops.push({ type: 'delete', id });
  }
}

async function handleOdontoClick(tooth, letter) {
  if (!editable() || S.busy) return;
  const tool = S.odontoTool;
  const map = buildOdontoMap(S.marks);
  const st = map.get(tooth) || { code: null, codeMarkIds: [], s: {}, sMarks: {} };
  const ops = [];
  let label = '';
  S.busy = true;
  try {
    if (tool === 'ERASE') {
      if (letter && st.s[letter]) {
        await removeSurfaceFromMarks(st.sMarks[letter] || [], letter, ops);
        label = `erased ${letter} on #${toothLabel(tooth, S.notation)}`;
      } else if (st.codeMarkIds.length) {
        await deleteMarksByIds(st.codeMarkIds, ops);
        label = `erased ${st.code} on #${toothLabel(tooth, S.notation)}`;
      } else {
        const allIds = [...new Set(Object.values(st.sMarks).flat().map((m) => m.id))];
        if (!allIds.length) return;
        await deleteMarksByIds(allIds, ops);
        label = `erased surfaces on #${toothLabel(tooth, S.notation)}`;
      }
    } else if (ODONTO_BY_CODE[tool] && ODONTO_BY_CODE[tool][3] === 'surface') {
      if (!letter) return;
      if (st.s[letter] === tool) {
        await removeSurfaceFromMarks(st.sMarks[letter] || [], letter, ops);
        label = `removed ${tool} (${letter}) on #${toothLabel(tooth, S.notation)}`;
      } else {
        if (st.s[letter]) {
          await removeSurfaceFromMarks(st.sMarks[letter] || [], letter, ops);
        }
        const mark = await post(`/patients/${S.patientId}/chart/marks`, {
          tooth,
          surfaces: [letter],
          condition: tool,
          photoId: null,
          note: '',
        });
        S.marks.push(mark);
        ops.push({ type: 'add', id: mark.id });
        label = `${tool} (${letter}) on #${toothLabel(tooth, S.notation)}`;
      }
    } else {
      if (st.code === tool) {
        await deleteMarksByIds(st.codeMarkIds, ops);
        label = `removed ${tool} on #${toothLabel(tooth, S.notation)}`;
      } else {
        if (st.codeMarkIds.length) {
          await deleteMarksByIds(st.codeMarkIds, ops);
        }
        if (!KEEP_SURFACES_ON_TOOTH_CODE.has(tool)) {
          const surfaceIds = [...new Set(Object.values(st.sMarks).flat().map((m) => m.id))];
          await deleteMarksByIds(surfaceIds, ops);
        }
        const mark = await post(`/patients/${S.patientId}/chart/marks`, {
          tooth,
          surfaces: [],
          condition: tool,
          photoId: null,
          note: '',
        });
        S.marks.push(mark);
        ops.push({ type: 'add', id: mark.id });
        label = `${tool} on #${toothLabel(tooth, S.notation)}`;
      }
    }
    if (ops.length === 1) S.undo.push({ ...ops[0], label });
    else if (ops.length > 1) S.undo.push({ type: 'batch', items: ops, label });
    rerender();
  } catch (err) {
    toastError(err);
  } finally {
    S.busy = false;
  }
}

async function clearOdontoChart() {
  if (!editable() || !S.marks.length || S.busy) return;
  if (!(await confirmDialog('Clear every mark on this chart? You can restore them with Undo.', { confirmLabel: 'Clear chart', danger: true }))) return;
  const ops = [];
  S.busy = true;
  try {
    const ids = S.marks.map((m) => m.id);
    await deleteMarksByIds(ids, ops);
    if (ops.length) S.undo.push({ type: 'batch', items: ops, label: 'clear chart' });
    rerender();
    toast('Chart cleared — press Undo to restore');
  } catch (err) {
    toastError(err);
  } finally {
    S.busy = false;
  }
}

function showOdontoJson() {
  const jsonText = buildMarksJsonExport(state.patient, S.marks);
  openModal({
    title: 'Chart Data (JSON · chart_marks)',
    body: String(html`<p class="small muted" style="margin-bottom:8px;">Structured PDA odontogram data matching <span class="num">chart_marks</span>.</p>
      <textarea class="input num" id="odonto-json-box" readonly style="min-height:240px; font-family:ui-monospace,monospace; font-size:12px;">${jsonText}</textarea>`),
    actions: [
      { label: 'Copy JSON', cls: 'btn-primary', value: 'copy' },
      { label: 'Close', value: null },
    ],
    onMount: (d) => {
      const btn = d.querySelector('[data-modal-val="copy"]');
      if (btn) {
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          navigator.clipboard?.writeText(jsonText).then(() => toast('JSON copied')).catch(() => {
            const box = d.querySelector('#odonto-json-box');
            box?.select();
            document.execCommand?.('copy');
            toast('JSON copied');
          });
        });
      }
    },
  });
}

// ------------------------------------------------------------------ photos
async function chooseView() {
  const views = state.config.clinic.chart.photoViews;
  return openModal({
    title: 'Which view is this?',
    body: String(html`<p>Tap the view to upload. You can change it later.</p>
      <div class="choice-grid">${views.map((v) => html`<button type="button" class="btn-secondary tall ${v.id === S.lastView ? 'active-filter' : ''}" data-view-choice="${v.id}">${v.label}</button>`)}</div>
      <div class="field"><div class="field-label"><span>Photo date</span></div><input type="date" class="input num" id="photo-date" value="${todayISO()}" max="${todayISO()}" /></div>`),
    actions: [{ label: 'Cancel', value: null }],
    onMount: (d) => d.querySelectorAll('[data-view-choice]').forEach((btn) => btn.addEventListener('click', () => {
      closeModal({ view: btn.dataset.viewChoice, takenOn: d.querySelector('#photo-date').value || todayISO() });
    })),
  });
}

async function photoFromCamera() {
  const blob = await captureImage({ title: 'Intraoral photo', mode: 'photo', hint: 'Use a retractor/mirror as usual. The photo is attached to this patient only.' });
  if (blob) addPhotos([blob]);
}

async function addPhotos(files) {
  const pid = S.patientId;
  const choice = await chooseView();
  if (!choice || pid !== S.patientId) return;
  S.lastView = choice.view;
  const maxEdge = state.config.clinic.chart.maxPhotoEdgePx || 2000;
  let added = 0;
  for (const f of files) {
    try {
      const { blob, width, height } = await prepareClinicalPhoto(f, maxEdge);
      const p = await upload(`/patients/${pid}/chart/photos`, blob, { view: choice.view, takenOn: choice.takenOn, width, height });
      S.photos.unshift(p);
      S.photoId = p.id;
      S.undo.push({ type: 'photo-add', id: p.id, label: 'photo upload' });
      added++;
    } catch (err) { toastError(err); }
  }
  if (added) { S.pending = null; rerender(); toast(`${added} photo${added === 1 ? '' : 's'} added — now pick a tooth and condition`); }
}

async function deletePhoto() {
  const photo = S.photos.find((p) => p.id === S.photoId);
  if (!photo) return;
  const n = S.marks.filter((m) => m.photoId === photo.id).length;
  if (!(await confirmDialog(`Delete this photo?${n ? ` Its ${n} finding(s) stay in the findings list.` : ''} It can be restored from "Recently deleted" or with Undo.`, { confirmLabel: 'Delete photo', danger: true }))) return;
  try {
    await del(`/chart/photos/${photo.id}`);
    S.photos = S.photos.filter((p) => p.id !== photo.id);
    S.photoId = S.photos[0] ? S.photos[0].id : null;
    S.undo.push({ type: 'photo-delete', id: photo.id, label: 'photo delete' });
    rerender();
    toast('Photo deleted');
  } catch (err) { toastError(err); }
}
