// FR-6: internal staff dashboard with the "Due for Follow-Up" recall queue.
import { get, put } from '../api.js';
import { html, fmt, toast, toastError, hasAlert, openModal, confirmDialog, todayISO } from '../ui.js';
import { can, setActivePatient } from '../state.js';

let root;
let data = null;
let filter = 'all';

export function mount(el) {
  root = el;
  root.addEventListener('click', onClick);
}

export async function show() {
  root.innerHTML = String(skeleton());
  await load();
}

function skeleton() {
  return html`
    <div class="view-header">
      <div>
        <h2>Clinic Overview</h2>
        <p>Today's appointments and internal follow-up reminders · <span id="dash-date">${fmt.date(todayISO())}</span></p>
      </div>
      <div class="view-actions">
        <button class="btn-secondary tall" data-action="refresh">↻ Refresh</button>
        ${can('patients.write') ? html`<button class="btn-primary" data-action="register">+ Register Patient</button>` : ''}
      </div>
    </div>
    <div id="dash-body"><div class="card"><div class="empty-state"><span class="spinner"></span>Loading dashboard…</div></div></div>`;
}

async function load() {
  const t0 = performance.now();
  try {
    data = await get('/dashboard');
  } catch (err) {
    root.querySelector('#dash-body').innerHTML = String(html`<div class="notice error">⚠ ${err.message}</div>`);
    return;
  }
  render(Math.round(performance.now() - t0));
}

function statusBadge(s) {
  if (s === 'overdue') return html`<span class="badge red">⚠ Overdue</span>`;
  if (s === 'today') return html`<span class="badge amber">● Due today</span>`;
  return html`<span class="badge">Upcoming</span>`;
}

function render(ms) {
  const st = data.stats;
  const next = data.nextSlot;
  const counts = { all: data.followUps.length, today: st.dueToday, overdue: st.overdue, upcoming: st.upcoming };
  const rows = data.followUps.filter((f) => filter === 'all' || f.status === filter);
  root.querySelector('#dash-body').innerHTML = String(html`
    <div class="priority-grid">
      <div class="stat-card priority-highlight">
        <div class="stat-top"><span class="stat-label">Today's Appointments</span><span class="badge green">Live</span></div>
        <div class="stat-value">${String(st.todayTotal).padStart(2, '0')}</div>
        <div class="stat-meta">${st.todayCompleted} completed • ${Math.max(0, st.todayTotal - st.todayCompleted)} remaining</div>
      </div>
      <div class="stat-card priority-highlight">
        <div class="stat-top"><span class="stat-label">Due for Follow-Up</span>${st.overdue + st.dueToday ? html`<span class="badge red">Action needed</span>` : html`<span class="badge green">All clear</span>`}</div>
        <div class="stat-value" style="${st.overdue + st.dueToday ? 'color:var(--red-main);' : ''}">${String(st.overdue + st.dueToday).padStart(2, '0')}</div>
        <div class="stat-meta">${st.overdue} overdue • ${st.dueToday} due today • ${st.upcoming} in the next 7 days</div>
      </div>
      <div class="stat-card">
        <div class="stat-top"><span class="stat-label">Next Chairside Slot</span>${next ? html`<span class="badge warm num">${next.date === data.today ? (next.time ? fmt.time(next.time) : 'Today') : fmt.date(next.date)}</span>` : ''}</div>
        <div class="stat-value name">${next ? next.patientName : 'No upcoming visits'}</div>
        <div class="stat-meta">${next ? next.reason || 'Follow-up visit' : 'Return dates are captured at ledger checkout.'}</div>
      </div>
    </div>

    <div class="card rise">
      <div class="card-top">
        <div>
          <h3>Follow-Up Recall Queue</h3>
          <p class="card-sub">Patients due for return procedures or post-operative checks. Internal list only — no SMS or e-mail is sent to patients.</p>
        </div>
        <div class="filter-row">
          ${[['all', 'All'], ['today', 'Due today'], ['overdue', 'Overdue'], ['upcoming', 'Next 7 days']].map(([k, label]) =>
            html`<button class="btn-secondary ${filter === k ? 'active-filter' : ''}" data-filter="${k}">${label} (${counts[k]})</button>`)}
        </div>
      </div>
      ${rows.length ? html`
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Patient</th><th>Return Date</th><th>Follow-Up Procedure</th><th>Contact Number</th><th>Status</th><th style="text-align:right;">Action</th></tr></thead>
        <tbody>${rows.map((f) => html`
          <tr>
            <td data-label="Patient">
              <div><strong>${f.patientName}</strong><div class="muted small num">${f.patientId}</div></div>
              ${hasAlert(f.allergies) ? html`<span class="badge red" style="margin-top:4px;" title="Critical alert">⚠ ${f.allergies}</span>` : ''}
            </td>
            <td data-label="Return Date" class="num">${fmt.date(f.date)}${f.time ? html`<div class="muted small">${fmt.time(f.time)}</div>` : ''}</td>
            <td data-label="Procedure">${f.reason || '—'}</td>
            <td data-label="Contact" class="num">${f.contactNumber || '—'}</td>
            <td data-label="Status">${statusBadge(f.status)}</td>
            <td data-label="Action"><div class="actions">
              <button class="btn-secondary" data-open="chart" data-patient="${f.patientId}">Chart</button>
              <button class="btn-secondary" data-open="ledger" data-patient="${f.patientId}">Ledger</button>
              ${can('appointments.write') ? html`<button class="btn-secondary" data-appt-menu="${f.appointmentId}">Update…</button>` : ''}
            </div></td>
          </tr>`)}
        </tbody></table></div>`
      : html`<div class="empty-state"><span class="icon">✓</span><h3>No follow-ups in this list</h3><p>Return dates entered at ledger checkout appear here when they are due.</p></div>`}
    </div>

    <div class="grid-2" style="margin-top:18px;">
      <div class="card">
        <div class="card-top"><h3>Outstanding Balances</h3><span class="badge ${st.outstandingCents ? 'red' : 'green'} num">${fmt.peso(st.outstandingCents)}</span></div>
        <p class="card-sub">${st.withBalance} patient${st.withBalance === 1 ? '' : 's'} with an unpaid balance.</p>
        <button class="btn-secondary tall" style="margin-top:12px;" data-action="balances">View in directory →</button>
      </div>
      <div class="card">
        <div class="card-top"><h3>Records</h3><span class="badge warm num">${st.patients.toLocaleString()} active</span></div>
        <p class="card-sub">Dashboard loaded in ${ms} ms. Data stays on this clinic's server and is encrypted at rest.</p>
      </div>
    </div>`);
}

async function onClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.filter) { filter = t.dataset.filter; render(0); return; }
  if (t.dataset.action === 'refresh') { await load(); toast('Dashboard refreshed'); return; }
  if (t.dataset.action === 'register') { location.hash = '#/intake?new=1'; return; }
  if (t.dataset.action === 'balances') { location.hash = '#/directory?filter=balance'; return; }
  if (t.dataset.open) {
    try {
      const p = await setActivePatient(t.dataset.patient);
      if (p) location.hash = `#/${t.dataset.open}`;
    } catch (err) { toastError(err); }
    return;
  }
  if (t.dataset.apptMenu) apptMenu(t.dataset.apptMenu);
}

async function apptMenu(id) {
  const f = data.followUps.find((x) => x.appointmentId === id);
  if (!f) return;
  const choice = await openModal({
    title: 'Update follow-up',
    body: String(html`<p><strong>${f.patientName}</strong> · ${fmt.date(f.date)}${f.time ? ' ' + fmt.time(f.time) : ''}</p><p>${f.reason || 'Follow-up visit'}</p>
      <div class="grid-2" style="margin-top:14px;">
        <div class="field"><div class="field-label"><span>Reschedule to</span></div><input type="date" class="input num" id="resched-date" min="${todayISO()}" value="${f.date < todayISO() ? todayISO() : f.date}" /></div>
        <div class="field"><div class="field-label"><span>Time (optional)</span></div><input type="time" class="input num" id="resched-time" value="${f.time || ''}" /></div>
      </div>`),
    actions: [
      { label: 'Close', value: null },
      { label: 'Cancel visit', kind: 'danger', value: 'cancel' },
      { label: 'Reschedule', value: (d) => ({ date: d.querySelector('#resched-date').value, time: d.querySelector('#resched-time').value }) },
      { label: 'Mark done', kind: 'primary', value: 'done' },
    ],
  });
  if (!choice) return;
  try {
    if (choice === 'done') await put(`/appointments/${id}`, { status: 'completed' });
    else if (choice === 'cancel') {
      if (!(await confirmDialog('Cancel this follow-up visit?', { confirmLabel: 'Cancel visit', danger: true }))) return;
      await put(`/appointments/${id}`, { status: 'cancelled' });
    } else await put(`/appointments/${id}`, { date: choice.date, time: choice.time });
    toast(choice === 'done' ? 'Follow-up marked as done' : choice === 'cancel' ? 'Follow-up cancelled' : 'Follow-up rescheduled');
    await load();
  } catch (err) { toastError(err); }
}

export function onPatientChange() {}
