// App bootstrap: sign-in / first-run setup, shell navigation, patient context
// bar + switcher, idle auto-lock (NFR-SEC1) and local-server status.
import { get, post, onUnauthenticated, ApiError } from './api.js';
import { $, $$, html, raw, fmt, toast, toastError, openModal, closeModal, avatarHtml, initials, hasAlert, debounce, dirty } from './ui.js';
import { state, on, can, setActivePatient, clearPatient, rememberedPatientId } from './state.js';
import { setSymbols } from './symbols.js';
import { createQrSvg } from './qrcode.js';
import * as dashboard from './views/dashboard.js';
import * as directory from './views/directory.js';
import * as intake from './views/intake.js';
import * as chart from './views/chart.js';
import * as ledger from './views/ledger.js';
import * as security from './views/security.js';

const VIEWS = { dashboard, directory, intake, chart, ledger, security };
const ORDER = ['dashboard', 'directory', 'intake', 'chart', 'ledger', 'security'];
const LOCK_REASON = 'irby.lockReason';

// ------------------------------------------------------------------ viewport (keeps dock on screen on tablets)
function syncViewportHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
}
syncViewportHeight();
window.addEventListener('resize', syncViewportHeight);
if (window.visualViewport) window.visualViewport.addEventListener('resize', syncViewportHeight);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ------------------------------------------------------------------ server status LED (3-state: Healthy / Degraded / Critical)
let serverUp = true;
async function pingServer() {
  let stateName = 'CRITICAL';
  let code = 'ERR-NET-005';
  let reachable = false;
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    reachable = true;
    stateName = data.status || (r.ok ? 'HEALTHY' : 'CRITICAL');
    code = data.code || (r.ok ? 'OK' : 'ERR-SYS-500');
    serverUp = stateName !== 'CRITICAL' && r.ok;
  } catch {
    serverUp = false;
    reachable = false;
    stateName = 'CRITICAL';
    code = 'ERR-NET-005';
  }
  for (const el of [$('#server-status'), $('#login-server-status')]) {
    if (!el) continue;
    el.classList.toggle('offline', stateName === 'CRITICAL');
    el.classList.toggle('degraded', stateName === 'DEGRADED');
    if (stateName === 'HEALTHY') {
      el.textContent = 'Local server';
      el.title = 'Local clinic server nominal (OK) — click to open Diagnostics';
    } else if (stateName === 'DEGRADED') {
      el.textContent = `Degraded · ${code}`;
      el.title = `System degraded (${code}) — click to inspect Diagnostics`;
    } else {
      el.textContent = reachable ? `Critical · ${code}` : `${code} · Offline`;
      el.title = `Critical fault (${code}) — click to inspect Diagnostics`;
    }
  }
}
pingServer();
setInterval(pingServer, 5000);

// ------------------------------------------------------------------ sign in / setup
let setupMode = false;

function loginError(msg, info = false) {
  const box = $('#login-error');
  box.hidden = !msg;
  box.classList.toggle('login-info', info);
  $('#login-error-text').textContent = msg || '';
}

async function showLogin() {
  document.body.classList.add('locked');
  $('#login-screen').classList.remove('hidden');
  let reason = null;
  try { reason = sessionStorage.getItem(LOCK_REASON); sessionStorage.removeItem(LOCK_REASON); } catch { /* ignore */ }
  try {
    const s = await get('/setup/status');
    setupMode = s.needsSetup;
  } catch { setupMode = false; }
  $('#setup-name-field').hidden = !setupMode;
  $('#setup-confirm-field').hidden = !setupMode;
  $('#login-title').textContent = setupMode ? 'Set up IRBY Dental Ledger' : 'IRBY Dental Ledger';
  $('#login-sub').textContent = setupMode
    ? 'First run: create the administrator account. You can add dentists and front-desk staff afterwards.'
    : 'Sign in with your clinic credentials to unlock patient charts and billing ledgers.';
  $('#login-submit-text').textContent = setupMode ? 'Create administrator' : 'Unlock Ledger';
  $('#login-password').autocomplete = setupMode ? 'new-password' : 'current-password';
  if (reason === 'idle') loginError(`You were signed out after ${state.idleMinutes} minutes of inactivity.`, true);
  else if (reason === 'expired') loginError('Your session ended. Please sign in again.', true);
  else loginError('');
  setTimeout(() => (setupMode ? $('#setup-display-name') : $('#login-username')).focus(), 50);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  if (!username || !password) { loginError('Enter your account and passphrase.'); return; }
  const btn = $('#login-submit');
  btn.disabled = true;
  try {
    let session;
    if (setupMode) {
      if (password !== $('#setup-confirm').value) { loginError('The passphrases do not match.'); return; }
      session = await post('/setup', { username, password, displayName: $('#setup-display-name').value.trim() || username });
    } else {
      session = await post('/auth/login', { username, password });
    }
    $('#login-password').value = '';
    $('#setup-confirm').value = '';
    await enterApp(session);
  } catch (err) {
    loginError(err instanceof ApiError && err.body.fields ? Object.values(err.body.fields).join(' ') : err.message);
  } finally {
    btn.disabled = false;
  }
});

async function enterApp(session) {
  state.user = session.user;
  state.permissions = new Set(session.permissions);
  state.idleMinutes = session.idleMinutes;
  state.config = await get('/config');
  setSymbols(state.config.pda);
  $('#brand-name').textContent = state.config.clinic.shortName || 'IRBY Dental';
  $('#user-name').textContent = state.user.displayName;
  $('#user-role').textContent = state.user.roleLabel;
  $('#user-avatar').textContent = initials(state.user.displayName);
  for (const [name, mod] of Object.entries(VIEWS)) {
    const el = $(`#view-${name}`);
    if (!el.dataset.mounted) { mod.mount(el); el.dataset.mounted = '1'; }
  }
  document.body.classList.remove('locked');
  $('#login-screen').classList.add('hidden');
  startIdleTimer();
  const remembered = rememberedPatientId();
  if (remembered) { try { await setActivePatient(remembered, { skipGuard: true }); } catch { clearPatient(); } }
  renderPatientBar();
  route();
  toast(`Welcome, ${state.user.displayName}`);
}

/** Sign out and reload so no patient data stays in memory or on screen. */
async function lock(reason = null) {
  try { await post('/auth/logout', {}); } catch { /* ignore */ }
  try {
    sessionStorage.removeItem('irby.activePatient');
    if (reason) sessionStorage.setItem(LOCK_REASON, reason);
  } catch { /* ignore */ }
  dirty.reset();
  location.hash = '';
  location.reload();
}

onUnauthenticated(() => { if (state.user) lock('expired'); });

// ------------------------------------------------------------------ idle auto-lock (NFR-SEC1: 10 minutes)
let lastActivity = Date.now();
let lastKeepalive = Date.now();
let idleTimer = null;
let warned = false;

function startIdleTimer() {
  const bump = () => { lastActivity = Date.now(); if (warned) { warned = false; closeModal(null); } };
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => document.addEventListener(ev, bump, { passive: true }));
  clearInterval(idleTimer);
  idleTimer = setInterval(async () => {
    const idleMs = Date.now() - lastActivity;
    const limit = state.idleMinutes * 60000;
    if (idleMs >= limit) { clearInterval(idleTimer); lock('idle'); return; }
    if (!warned && idleMs >= limit - 60000) {
      warned = true;
      openModal({ title: 'Still there?', body: 'For patient privacy this workstation locks in 1 minute. Tap anywhere to stay signed in.', actions: [{ label: 'Stay signed in', kind: 'primary', value: null }] });
    }
    if (lastActivity > lastKeepalive && Date.now() - lastKeepalive > 60000) {
      lastKeepalive = Date.now();
      try { await post('/auth/keepalive', {}); } catch { /* 401 handled globally */ }
    }
  }, 5000);
}

// ------------------------------------------------------------------ router
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  return { view: VIEWS[path] ? path : 'dashboard', params };
}

async function route() {
  if (!state.user) return;
  const { view, params } = parseHash();
  state.view = view;
  $$('[data-nav]').forEach((el) => el.classList.toggle('active', el.dataset.nav === view));
  $('#mobile-dock').style.setProperty('--dock-i', ORDER.indexOf(view));
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${view}`));
  $('#stage').scrollTop = 0;
  try { await VIEWS[view].show(params); } catch (err) { toastError(err); }
}
window.addEventListener('hashchange', route);

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { location.hash = `#/${nav.dataset.nav}`; return; }
  const act = e.target.closest('[data-action="lock"]');
  if (act) { dirty.confirmDiscard('lock the workstation').then((ok) => ok && lock()); }
});

// ------------------------------------------------------------------ patient context bar (NFR-S2)
function renderPatientBar() {
  const bar = $('#patient-bar');
  const p = state.patient;
  bar.classList.toggle('empty', !p);
  if (!p) {
    bar.innerHTML = String(html`
      <div class="patient-identity"><div class="avatar" style="background:var(--bg-sand); color:var(--text-muted);">—</div>
        <div><div class="patient-name">No patient selected</div><div class="small muted">Charts and ledgers open for the active patient only.</div></div></div>
      <div class="patient-vitals"><button class="btn-secondary" style="border-radius:var(--r-pill);" data-action="switch-patient">Find patient</button></div>`);
    return;
  }
  const alert = hasAlert(p.allergies);
  bar.innerHTML = String(html`
    <div class="patient-identity">
      ${avatarHtml(p)}
      <div class="patient-title-group">
        <span class="patient-name">${p.fullName}</span>
        <span class="badge warm num">${p.id}</span>
        <span class="badge">${p.age ?? '—'} yrs • ${p.sex}</span>
        <span class="badge ${alert ? 'red' : 'green'}">${alert ? `⚠ Alert: ${p.allergies}` : 'No known allergies'}</span>
      </div>
    </div>
    <div class="patient-vitals">
      <div class="vital-pill"><span>Next:</span><strong class="num">${p.nextAppointment ? fmt.date(p.nextAppointment.date) : '—'}</strong></div>
      <div class="vital-pill"><span>Balance:</span><strong class="num ${p.balanceCents > 0 ? 'owed' : ''}">${fmt.peso(p.balanceCents)}</strong></div>
      <button class="btn-secondary" style="border-radius:var(--r-pill); padding:6px 14px;" data-action="switch-patient">Switch Patient</button>
    </div>`);
}

on('patient', () => {
  renderPatientBar();
  for (const mod of Object.values(VIEWS)) if (mod.onPatientChange) mod.onPatientChange();
});
on('patient:updated', renderPatientBar);

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="switch-patient"]')) openSwitcher();
  if (e.target.closest('[data-action="show-lan"]')) openPairingModal();
  if (e.target.closest('#server-status') && state.user) {
    location.hash = '#/security?tab=diagnostics';
  }
});

async function openPairingModal() {
  try {
    const res = await fetch('/api/lan-info');
    const info = await res.json();
    const addresses = info.addresses || [];
    const port = info.port || 3000;
    const defaultUrl = addresses.length ? `http://${addresses[0]}:${port}` : `http://${location.hostname}:${port}`;
    let currentUrl = defaultUrl;

    await openModal({
      title: 'Pair Devices & Connect Tablets (Clinic LAN)',
      body: String(html`
        <div style="text-align:center; padding: 6px 0 10px;">
          <div id="pairing-qr" style="display:inline-block; padding:12px; background:#FFF; border:1px solid var(--border-light); border-radius:18px; box-shadow:var(--shadow-card); margin-bottom:12px;">
            ${raw(createQrSvg(currentUrl, { size: 210 }))}
          </div>
          <div style="font-weight:800; font-size:15px; color:var(--text-main); margin-bottom:4px;">
            Scan with any Tablet or Phone
          </div>
          <p class="small muted" style="max-width:440px; margin:0 auto 14px;">
            Point your iPad, Android tablet, or smartphone camera at the QR code to open IRBY Dental Ledger chairside on your clinic Wi-Fi.
          </p>

          <div style="display:flex; gap:8px; justify-content:center; align-items:center; max-width:420px; margin:0 auto 16px;">
            <input class="input num" id="pairing-url-input" value="${currentUrl}" readonly style="text-align:center; font-size:14px; font-weight:700;" />
            <button class="btn-primary" type="button" id="copy-pairing-btn" style="white-space:nowrap; padding:8px 14px;">Copy Link</button>
          </div>

          ${addresses.length > 1 ? html`
            <div style="margin-bottom:14px;">
              <span class="small muted" style="display:block; margin-bottom:4px;">Available Clinic Network Interfaces:</span>
              <div class="row" style="justify-content:center; gap:6px;">
                ${addresses.map((ip) => html`
                  <button type="button" class="btn-secondary small" data-pick-ip="${ip}" style="font-size:12px; padding:4px 10px;">${ip}</button>
                `)}
              </div>
            </div>` : ''}

          <div style="text-align:left; background:var(--bg-subtle); border:1px solid var(--border-light); border-radius:12px; padding:12px 14px; font-size:12px; line-height:1.6; color:var(--text-secondary); margin-top:14px;">
            <div style="font-weight:800; color:var(--text-main); margin-bottom:4px;">🖥 Connecting Another Windows PC / Workstation:</div>
            • <strong>In Browser:</strong> Open Microsoft Edge or Google Chrome and enter <code style="font-weight:700; color:var(--brown-800);">${currentUrl}</code><br/>
            • <strong>In Desktop App:</strong> In <em>IRBY Dental Ledger.exe</em>, press <kbd style="background:#FFF; padding:1px 5px; border-radius:4px; border:1px solid #CCC; font-weight:700;">Ctrl+Shift+C</kbd> to set this PC as the Central Server.<br/>
            • <strong>Firewall:</strong> If other PCs cannot reach this PC, ensure Windows Firewall allows incoming port ${port}.
          </div>
        </div>
      `),
      actions: [{ label: 'Done', value: true }],
      onMount: (dialog) => {
        const input = dialog.querySelector('#pairing-url-input');
        const copyBtn = dialog.querySelector('#copy-pairing-btn');
        const qrContainer = dialog.querySelector('#pairing-qr');

        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(input.value);
            copyBtn.textContent = 'Copied! ✓';
            setTimeout(() => { copyBtn.textContent = 'Copy Link'; }, 2000);
          } catch {
            input.select();
            document.execCommand('copy');
            copyBtn.textContent = 'Copied! ✓';
            setTimeout(() => { copyBtn.textContent = 'Copy Link'; }, 2000);
          }
        });

        dialog.querySelectorAll('[data-pick-ip]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const ip = btn.dataset.pickIp;
            const newUrl = `http://${ip}:${port}`;
            input.value = newUrl;
            qrContainer.innerHTML = createQrSvg(newUrl, { size: 210 });
          });
        });
      },
    });
  } catch (err) {
    toastError(err);
  }
}

async function openSwitcher() {
  let results = [];
  const renderList = (dialog) => {
    const list = dialog.querySelector('#switch-list');
    list.innerHTML = results.length ? String(html`${results.map((p) => html`
      <button type="button" class="patient-option" data-pick="${p.id}">
        <span class="td-person">${avatarHtml(p)}<span><strong>${p.fullName}</strong><span class="muted small" style="display:block;">${p.id} · ${p.age ?? '—'} yrs · ${p.sex}</span></span></span>
        <span class="badge ${p.balanceCents > 0 ? 'red' : 'green'} num">${fmt.peso(p.balanceCents)}</span>
      </button>`)}`) : '<p class="small muted">No matching patients.</p>';
  };
  const search = async (dialog, q) => {
    try {
      const r = await get('/patients', { query: { q, limit: 8, sort: q ? '' : 'lastVisit' } });
      results = r.items;
      renderList(dialog);
    } catch (err) { toastError(err); }
  };
  const pickedId = await openModal({
    title: 'Select Active Patient',
    body: String(html`
      ${dirty.any() ? html`<span class="badge red" style="margin-bottom:8px;">Unsaved changes: ${dirty.labels().join(', ')}</span>` : ''}
      <p>Charts and ledger entries are always written to the patient shown in the header.</p>
      <input class="input" id="switch-search" type="search" placeholder="Name or record ID (typos OK)" autocomplete="off" style="margin-top:12px;" />
      <div class="patient-switch-list" id="switch-list"><span class="spinner"></span></div>`),
    actions: [
      { label: 'Cancel', value: null },
      ...(can('patients.write') ? [{ label: '+ Register new', value: '__new__' }] : []),
    ],
    onMount: (d) => {
      const input = d.querySelector('#switch-search');
      input.addEventListener('input', debounce(() => search(d, input.value), 150));
      d.querySelector('#switch-list').addEventListener('click', (e) => {
        const b = e.target.closest('[data-pick]');
        if (b) closeModal(b.dataset.pick);
      });
      search(d, '');
    },
  });
  if (!pickedId) return;
  if (pickedId === '__new__') { location.hash = '#/intake?new=1'; return; }
  try {
    const p = await setActivePatient(pickedId);
    if (p) toast(`Active chart: ${p.fullName}`);
  } catch (err) { toastError(err); }
}

// ------------------------------------------------------------------ boot
(async function boot() {
  try {
    const session = await get('/auth/me');
    await enterApp(session);
  } catch {
    showLogin();
  }
})();
