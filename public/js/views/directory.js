// FR-2: typo-tolerant search with sorting by next appointment / last visit.
import { get, download } from '../api.js';
import { html, fmt, toastError, avatarHtml, hasAlert, debounce } from '../ui.js';
import { state, can, setActivePatient } from '../state.js';

let root;
const q = { q: '', sort: '', dir: '', filter: 'all', limit: 50 };
let result = null;
let seq = 0;

const SORTS = [
  ['', 'Best match / name'], ['name', 'Name'], ['nextAppointment', 'Next appointment'], ['lastVisit', 'Last visit'],
  ['balance', 'Balance'], ['registered', 'Registration date'], ['id', 'Record ID'],
];

export function mount(el) {
  root = el;
  root.innerHTML = String(html`
    <div class="view-header">
      <div>
        <div class="row"><h2>Patients</h2><span class="badge warm num" id="dir-total">— records</span></div>
        <p>Search by name or record ID — tolerates up to 2 typos (e.g. "Dela Crz").</p>
      </div>
      <div class="view-actions">
        ${can('data.export') ? html`<button class="btn-secondary tall" data-action="csv">Export CSV</button><button class="btn-secondary tall" data-action="json">Export JSON</button>` : ''}
        ${can('patients.write') ? html`<button class="btn-primary" data-action="register">+ New patient</button>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:12px;">
        <input type="search" class="input grow" id="dir-search" placeholder="Search patient name or record ID (PT-2026-0001)…" autocomplete="off" style="min-width:220px;" />
        <select class="input" id="dir-sort" style="width:auto;" aria-label="Sort by">${SORTS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select>
        <button class="btn-secondary tall" id="dir-dir" title="Toggle sort direction"><span class="btn-ico" aria-hidden="true">↓</span>Desc</button>
      </div>
      <div class="search-meta">
        <div class="filter-row">
          ${[['all', 'All'], ['followup', 'Due follow-up'], ['balance', 'With balance'], ['alerts', 'Medical alerts']].map(([k, l]) =>
            html`<button class="btn-secondary ${k === 'all' ? 'active-filter' : ''}" data-filter="${k}">${l}</button>`)}
        </div>
        <span class="badge warm num" id="dir-meta">…</span>
      </div>
      <div id="dir-results"></div>
    </div>`);
  const search = root.querySelector('#dir-search');
  search.addEventListener('input', debounce(() => { q.q = search.value; q.limit = 50; load(); }, 120));
  root.querySelector('#dir-sort').addEventListener('change', (e) => { q.sort = e.target.value; q.dir = ''; load(); });
  root.querySelector('#dir-dir').addEventListener('click', () => {
    q.dir = (result && result.dir === 'desc') ? 'asc' : 'desc';
    load();
  });
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('tr[data-patient]')) e.target.click();
  });
}

export async function show(params = {}) {
  if (params.filter) setFilter(params.filter);
  await load();
  root.querySelector('#dir-search').focus({ preventScroll: true });
}

function setFilter(f) {
  q.filter = f;
  root.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active-filter', b.dataset.filter === f));
}

async function load() {
  const mine = ++seq;
  const t0 = performance.now();
  try {
    const r = await get('/patients', { query: q });
    if (mine !== seq) return;
    result = r;
    render(Math.round(performance.now() - t0));
  } catch (err) { toastError(err); }
}

function sortHeader(key, label) {
  const active = result && result.sort === key;
  return html`<th class="sortable" data-sort="${key}">${label} ${active ? html`<span class="dir">${result.dir === 'desc' ? '▼' : '▲'}</span>` : ''}</th>`;
}

function nextCell(n) {
  if (!n) return html`<span class="muted">—</span>`;
  const today = new Date().toISOString().slice(0, 10);
  return html`<span class="num" style="${n.date < today ? 'color:var(--red-main);' : ''}">${fmt.date(n.date)}</span>`;
}

function render(roundTripMs) {
  root.querySelector('#dir-total').textContent = `${result.totalPatients.toLocaleString()} active records`;
  root.querySelector('#dir-meta').textContent = q.q
    ? `Matched ${result.total.toLocaleString()} for "${q.q}" · ${result.tookMs} ms server / ${roundTripMs} ms total`
    : `${result.total.toLocaleString()} records · ${roundTripMs} ms`;
  root.querySelector('#dir-sort').value = SORTS.some(([v]) => v === result.sort) ? result.sort : '';
  if (result.sort === 'relevance') root.querySelector('#dir-sort').value = '';
  root.querySelector('#dir-dir').innerHTML = result.dir === 'desc' ? '<span class="btn-ico" aria-hidden="true">↓</span>Desc' : '<span class="btn-ico" aria-hidden="true">↑</span>Asc';
  const box = root.querySelector('#dir-results');
  if (!result.items.length) {
    box.innerHTML = String(html`<div class="empty-state"><span class="icon">🔍</span><h3>No matching patients</h3>
      <p>Check the spelling (up to 2 typos are tolerated) or register a new patient.</p></div>`);
    return;
  }
  const activeId = state.patient && state.patient.id;
  box.innerHTML = String(html`
    <div class="table-wrap"><table class="table">
      <thead><tr>${sortHeader('name', 'Patient Name')}${sortHeader('id', 'Record ID')}<th>Age / Sex</th>${sortHeader('lastVisit', 'Last Visit')}${sortHeader('nextAppointment', 'Next Return')}${sortHeader('balance', 'Balance')}<th>Status</th></tr></thead>
      <tbody>${result.items.map((p) => html`
        <tr class="clickable ${p.id === activeId ? 'selected' : ''}" data-patient="${p.id}" tabindex="0">
          <td data-label="Patient Name"><div class="td-person">${avatarHtml(p)}<strong>${p.fullName}</strong></div></td>
          <td data-label="Record ID" class="num">${p.id}</td>
          <td data-label="Age / Sex">${p.age ?? '—'} • ${fmt.sexShort(p.sex)}</td>
          <td data-label="Last Visit" class="num">${fmt.date(p.lastVisit)}</td>
          <td data-label="Next Return">${nextCell(p.nextAppointment)}</td>
          <td data-label="Balance" class="num" style="${p.balanceCents > 0 ? 'color:var(--red-main);' : ''}">${fmt.peso(p.balanceCents)}</td>
          <td data-label="Status"><div class="row" style="justify-content:flex-end; gap:4px;">
            ${p.consentOnFile ? html`<span class="badge green">Consent on file</span>` : html`<span class="badge red">No consent</span>`}
            ${hasAlert(p.allergies) ? html`<span class="badge red" title="${p.allergies}">⚠ Alert</span>` : ''}
          </div></td>
        </tr>`)}
      </tbody></table></div>
    ${result.total > result.items.length ? html`<div class="table-foot"><button class="btn-secondary tall" data-action="more">Show more (${result.items.length} of ${result.total.toLocaleString()})</button></div>` : ''}`);
}

async function onClick(e) {
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const key = th.dataset.sort;
    if (result && result.sort === key) q.dir = result.dir === 'desc' ? 'asc' : 'desc';
    else { q.sort = key; q.dir = ''; }
    return load();
  }
  const b = e.target.closest('button');
  if (b && b.dataset.filter) { setFilter(b.dataset.filter); return load(); }
  if (b && b.dataset.action === 'more') { q.limit += 50; return load(); }
  if (b && b.dataset.action === 'register') { location.hash = '#/intake?new=1'; return; }
  if (b && b.dataset.action === 'csv') return download('/export/patients.csv');
  if (b && b.dataset.action === 'json') return download('/export/full.json');
  const row = e.target.closest('tr[data-patient]');
  if (row) {
    try {
      const p = await setActivePatient(row.dataset.patient);
      if (p) location.hash = can('chart.write') ? '#/chart' : '#/intake';
    } catch (err) { toastError(err); }
  }
}

export function onPatientChange() {
  if (result) render(0);
}
