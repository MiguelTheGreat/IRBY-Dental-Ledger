// FR-5 treatment & financial ledger, FR-6 next return date at checkout.
// NFR-S4: negative / non-numeric amounts are rejected, overpayments are flagged,
// every edit is audited server-side.
import { get, post, put, del } from '../api.js';
import { html, fmt, toast, toastError, todayISO, ageOn, showFieldErrors, clearFieldErrors, dirty, confirmDialog, promptDialog, openModal } from '../ui.js';
import { state, can, refreshPatient } from '../state.js';
import { parseAmount } from '../money.js';

let root;
let data = null;       // { entries, totals }
let appts = [];
let loadedFor = null;
let editing = null;    // entry being edited

export function mount(el) {
  root = el;
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  document.addEventListener('irby:discard', (e) => { if (e.detail.includes('ledger')) { editing = null; if (loadedFor) renderAll(); } });
}

export async function show() {
  if (!state.patient) { renderEmpty(); return; }
  if (loadedFor !== state.patient.id) await load();
}

export function onPatientChange() {
  loadedFor = null;
  editing = null;
  if (state.view === 'ledger') show();
}

function renderEmpty() {
  loadedFor = null;
  root.innerHTML = String(html`
    <div class="view-header"><div><h2>Treatment &amp; Financial Ledger</h2><p>Select a patient to record treatments and payments.</p></div></div>
    <div class="card"><div class="empty-state"><span class="icon">₱</span><h3>No patient selected</h3>
      <button class="btn-primary" data-action="go-directory">Open Patient Directory</button></div></div>`);
}

async function load() {
  const pid = state.patient.id;
  root.innerHTML = String(html`<div class="card"><div class="empty-state"><span class="spinner"></span>Loading ledger…</div></div>`);
  try {
    const [l, a] = await Promise.all([get(`/patients/${pid}/ledger`), get(`/patients/${pid}/appointments`)]);
    data = l; appts = a.appointments; loadedFor = pid;
    renderAll();
  } catch (err) {
    root.innerHTML = String(html`<div class="notice error">⚠ ${err.message}</div>`);
  }
}

function renderAll() {
  const canWrite = can('ledger.write');
  root.innerHTML = String(html`
    <div class="view-header">
      <div><h2>Treatment &amp; Financial Ledger</h2><p>Record chairside procedures, calculate exact balances, and schedule return visits.</p></div>
      <div class="view-actions"><button class="btn-secondary tall" data-action="print">Export Ledger PDF</button></div>
    </div>
    <div class="bento-2">
      <div class="stack">
        ${canWrite ? html`<form class="card" id="ledger-form" novalidate>${formHtml()}</form>` : html`<div class="card"><p class="card-sub">Your role can view but not edit the ledger.</p></div>`}
        <div class="card" id="appt-card">${apptHtml()}</div>
      </div>
      <div class="card" id="history-card">${historyHtml()}</div>
    </div>`);
  const form = root.querySelector('#ledger-form');
  if (form) { form.addEventListener('submit', (e) => { e.preventDefault(); save(); }); recalc(); }
}

function formHtml() {
  const e = editing;
  const procs = state.config.procedures;
  const today = todayISO();
  const dueCount = appts.filter((a) => a.status === 'scheduled' && a.date <= today).length;
  return html`
    <div class="card-top"><h3>${e ? 'Edit Ledger Entry' : 'New Ledger Entry'}</h3><span class="badge warm">Auto-balance</span></div>
    ${e ? html`<div class="edit-banner"><span>Editing the ${fmt.date(e.visitDate)} entry — the change is recorded in the audit trail.</span><button type="button" class="btn-secondary" data-action="cancel-edit">Cancel</button></div>` : ''}
    <div class="grid-2">
      <div class="field"><div class="field-label"><span>Visit date <span class="req">*</span></span></div><input type="date" class="input num" name="visitDate" value="${e ? e.visitDate : today}" max="${today}" /><div class="field-error"></div></div>
      <div class="field"><div class="field-label"><span>Patient age at visit</span><span class="muted">auto</span></div><input class="input num" id="ledger-age" readonly tabindex="-1" /></div>
    </div>
    <div class="field"><div class="field-label"><span>Procedure performed <span class="req">*</span></span></div>
      <input class="input" name="procedure" list="procedure-list" value="${e ? e.procedure : ''}" placeholder="e.g. Tooth #16 (MO) composite restoration" maxlength="200" />
      <datalist id="procedure-list">${procs.map((p) => html`<option value="${p.name}">${p.fee ? fmt.peso(p.fee * 100) : ''}</option>`)}</datalist>
      <div class="field-error"></div></div>
    <div class="grid-3">
      <div class="field"><div class="field-label"><span>Fee (₱) <span class="req">*</span></span></div><input class="input num" name="fee" inputmode="decimal" value="${e ? (e.feeCents / 100).toFixed(2) : ''}" placeholder="0.00" /><div class="field-error"></div></div>
      <div class="field"><div class="field-label"><span>Paid (₱)</span></div><input class="input num" name="paid" inputmode="decimal" value="${e ? (e.paidCents / 100).toFixed(2) : ''}" placeholder="0.00" /><div class="field-error"></div></div>
      <div class="field"><div class="field-label"><span>Balance</span></div><input class="input num dark" id="ledger-balance" readonly tabindex="-1" /></div>
    </div>
    <div class="ledger-note" id="ledger-note" aria-live="polite"></div>
    ${e ? '' : html`
      <div class="subhead">Next return visit (FR-6)</div>
      <div class="grid-3">
        <div class="field"><div class="field-label"><span>Return date</span></div><input type="date" class="input num" name="returnDate" min="${today}" /><div class="field-error"></div></div>
        <div class="field"><div class="field-label"><span>Time</span></div><input type="time" class="input num" name="returnTime" /><div class="field-error"></div></div>
        <div class="field"><div class="field-label"><span>Reason</span></div><input class="input" name="returnReason" placeholder="Follow-up procedure" maxlength="200" /><div class="field-error"></div></div>
      </div>
      ${dueCount ? html`<label class="check-row"><input type="checkbox" name="completeFollowUps" checked /> Mark ${dueCount} due follow-up${dueCount === 1 ? '' : 's'} as completed (patient came in)</label>` : ''}`}
    <button class="btn-primary" type="submit" style="width:100%;" id="ledger-save">${e ? 'Save Changes' : 'Save Entry & Schedule Return'}</button>`;
}

function historyHtml() {
  const t = data.totals;
  const canWrite = can('ledger.write');
  return html`
    <div class="card-top"><h3>Payment History</h3><span class="badge ${t.balanceCents > 0 ? 'red' : t.balanceCents < 0 ? 'blue' : 'green'} num">${t.balanceCents < 0 ? 'Credit' : 'Outstanding'}: ${fmt.peso(Math.abs(t.balanceCents))}</span></div>
    <div class="row small muted" style="margin:-6px 0 12px;"><span>Billed ${fmt.peso(t.feeCents)}</span>·<span>Paid ${fmt.peso(t.paidCents)}</span></div>
    ${data.entries.length ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Procedure</th><th>Fee</th><th>Paid</th><th>Balance</th>${canWrite ? html`<th></th>` : ''}</tr></thead>
      <tbody>${data.entries.map((e) => html`<tr class="${editing && editing.id === e.id ? 'selected' : ''}">
        <td data-label="Date" class="num">${fmt.date(e.visitDate)}${e.ageAtVisit != null ? html`<div class="muted small">age ${e.ageAtVisit}</div>` : ''}</td>
        <td data-label="Procedure"><strong>${e.procedure}</strong>${e.edited ? html`<div class="muted small">edited by ${e.updatedBy || '—'}</div>` : ''}</td>
        <td data-label="Fee" class="num">${fmt.peso(e.feeCents)}</td>
        <td data-label="Paid" class="num">${fmt.peso(e.paidCents)}</td>
        <td data-label="Balance" class="num" style="${e.runningBalanceCents > 0 ? 'color:var(--red-main);' : ''}" title="Entry: ${fmt.peso(e.entryBalanceCents)}">${fmt.peso(e.runningBalanceCents)}</td>
        ${canWrite ? html`<td data-label="Actions"><div class="actions"><button class="btn-secondary" data-edit="${e.id}">Edit</button><button class="btn-secondary danger" data-void="${e.id}">Void</button></div></td>` : ''}
      </tr>`)}</tbody></table></div>`
    : html`<div class="empty-state" style="padding:26px;"><p>No ledger entries yet.</p></div>`}
    <p class="small muted" style="margin-top:10px;">Balance column shows the running balance after each visit. Amounts are computed in exact centavos.</p>`;
}

function apptHtml() {
  const today = todayISO();
  const list = appts.filter((a) => a.status === 'scheduled');
  const canWrite = can('appointments.write');
  return html`
    <div class="card-top"><h3>Scheduled Return Visits</h3><span class="badge">${list.length}</span></div>
    ${list.length ? html`<div class="appt-list">${list.map((a) => html`<div class="appt-item">
      <div><strong class="num">${fmt.date(a.date)}${a.time ? ' · ' + fmt.time(a.time) : ''}</strong> ${a.date < today ? html`<span class="badge red">Overdue</span>` : a.date === today ? html`<span class="badge amber">Today</span>` : ''}
        <div class="small muted">${a.reason || 'Follow-up visit'}</div></div>
      ${canWrite ? html`<div class="row"><button class="btn-secondary" data-appt-done="${a.id}">Done</button><button class="btn-secondary" data-appt-move="${a.id}">Reschedule</button><button class="btn-secondary danger" data-appt-cancel="${a.id}">Cancel</button></div>` : ''}
    </div>`)}</div>` : html`<p class="card-sub">No upcoming visits. Add a return date when saving a ledger entry.</p>`}`;
}

// ------------------------------------------------------------------ live calculation
function val(name) { const el = root.querySelector(`[name="${name}"]`); return el ? el.value : ''; }

function recalc() {
  const note = root.querySelector('#ledger-note');
  const out = root.querySelector('#ledger-balance');
  const ageEl = root.querySelector('#ledger-age');
  if (!note) return null;
  const a = ageOn(state.patient.dateOfBirth, val('visitDate'));
  ageEl.value = a != null ? `${a} yrs` : '';
  const fee = parseAmount(val('fee'));
  const paid = parseAmount(val('paid') === '' ? '0' : val('paid'));
  note.className = 'ledger-note';
  if (val('fee') === '' ) { out.value = '—'; note.textContent = 'Enter the procedure fee (0 for a payment on account).'; return null; }
  if (!fee.ok || !paid.ok) {
    out.value = 'Invalid';
    note.classList.add('bad');
    note.textContent = `⚠ ${!fee.ok ? 'Fee: ' + fee.message : 'Paid: ' + paid.message} Negative or non-numeric amounts are rejected.`;
    return null;
  }
  const outstandingBefore = data.totals.balanceCents - (editing ? editing.feeCents - editing.paidCents : 0);
  const entryBal = fee.cents - paid.cents;
  const after = outstandingBefore + entryBal;
  out.value = fmt.peso(entryBal);
  if (after < 0) {
    note.classList.add('bad');
    note.textContent = `⚠ Overpayment flagged: payment exceeds the fee and the outstanding balance by ${fmt.peso(-after)}. You will be asked to confirm it as patient credit.`;
  } else if (paid.cents > fee.cents) {
    note.classList.add('warn');
    note.textContent = `! Payment exceeds this procedure's fee — ${fmt.peso(paid.cents - fee.cents)} is applied to the previous balance. Running balance after: ${fmt.peso(after)}.`;
  } else {
    note.textContent = `✓ Exact centavo balance: ${fmt.peso(fee.cents)} − ${fmt.peso(paid.cents)} = ${fmt.peso(entryBal)}. Running balance after this visit: ${fmt.peso(after)}.`;
  }
  return { fee: fee.cents, paid: paid.cents, after };
}

function onInput(e) {
  if (!e.target.closest('#ledger-form')) return;
  dirty.set('ledger', 'Ledger entry');
  const f = e.target.closest('.field');
  if (f) f.classList.remove('invalid');
  if (e.target.name === 'procedure' && !editing) {
    const p = state.config.procedures.find((x) => x.name === e.target.value);
    const feeEl = root.querySelector('[name="fee"]');
    if (p && !feeEl.value) feeEl.value = (p.fee).toFixed(2);
    const reason = root.querySelector('[name="returnReason"]');
    if (reason && !reason.dataset.touched) reason.value = e.target.value ? `${e.target.value} — follow-up` : '';
  }
  if (e.target.name === 'returnReason') e.target.dataset.touched = '1';
  recalc();
}

// ------------------------------------------------------------------ actions
async function save(acknowledgeOverpayment = false) {
  const form = root.querySelector('#ledger-form');
  clearFieldErrors(form);
  const calc = recalc();
  const fields = {};
  if (!val('procedure').trim()) fields.procedure = 'Describe the procedure performed.';
  if (!calc) {
    if (!parseAmount(val('fee')).ok) fields.fee = parseAmount(val('fee')).message;
    else fields.paid = parseAmount(val('paid')).message;
  }
  if (Object.keys(fields).length) { showFieldErrors(form, fields); toast('Fix the highlighted fields first', 'error'); return; }
  const body = { visitDate: val('visitDate'), procedure: val('procedure').trim(), fee: val('fee'), paid: val('paid') || '0', acknowledgeOverpayment };
  if (!editing) {
    if (val('returnDate')) body.nextReturn = { date: val('returnDate'), time: val('returnTime'), reason: val('returnReason').trim() };
    const cf = root.querySelector('[name="completeFollowUps"]');
    body.completeFollowUps = !!(cf && cf.checked);
  }
  const btn = root.querySelector('#ledger-save');
  btn.disabled = true;
  try {
    const pid = state.patient.id;
    const res = editing ? await put(`/ledger/${editing.id}`, body) : await post(`/patients/${pid}/ledger`, body);
    data = { entries: res.entries, totals: res.totals };
    const wasEdit = !!editing;
    editing = null;
    dirty.clear('ledger');
    const a = await get(`/patients/${pid}/appointments`);
    appts = a.appointments;
    renderAll();
    await refreshPatient();
    const parts = [wasEdit ? 'Ledger entry updated' : `Saved · balance ${fmt.peso(res.evaluation.entryBalanceCents)}`];
    if (res.appointment) parts.push(`return visit ${fmt.date(res.appointment.date)}`);
    if (res.completedFollowUps) parts.push(`${res.completedFollowUps} follow-up(s) completed`);
    toast(parts.join(' · '));
  } catch (err) {
    if (err.code === 'OVERPAYMENT_FLAGGED' && !acknowledgeOverpayment) {
      btn.disabled = false;
      if (await confirmDialog(err.message, { title: 'Overpayment flagged', confirmLabel: 'Record as patient credit' })) return save(true);
      return;
    }
    if (err.body.fields) showFieldErrors(form, err.body.fields);
    toastError(err);
  } finally {
    const b = root.querySelector('#ledger-save');
    if (b) b.disabled = false;
  }
}

async function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.action === 'go-directory') { location.hash = '#/directory'; return; }
  if (b.dataset.action === 'print') { window.open(`/print.html?type=ledger&id=${encodeURIComponent(state.patient.id)}`, '_blank', 'noopener'); return; }
  if (b.dataset.action === 'cancel-edit') { if (await dirty.confirmDiscard('cancel editing')) { editing = null; dirty.clear('ledger'); renderAll(); } return; }
  if (b.dataset.edit) {
    if (!(await dirty.confirmDiscard('edit another entry'))) return;
    editing = data.entries.find((x) => x.id === b.dataset.edit) || null;
    renderAll();
    root.querySelector('#ledger-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (b.dataset.void) return voidEntry(b.dataset.void);
  if (b.dataset.apptDone) return apptUpdate(b.dataset.apptDone, { status: 'completed' }, 'Visit marked as done');
  if (b.dataset.apptCancel) {
    if (await confirmDialog('Cancel this scheduled visit?', { confirmLabel: 'Cancel visit', danger: true })) apptUpdate(b.dataset.apptCancel, { status: 'cancelled' }, 'Visit cancelled');
    return;
  }
  if (b.dataset.apptMove) {
    const a = appts.find((x) => x.id === b.dataset.apptMove);
    const res = await openModal({
      title: 'Reschedule visit',
      body: String(html`<div class="grid-2"><div class="field"><div class="field-label"><span>Date</span></div><input type="date" class="input num" id="mv-date" min="${todayISO()}" value="${a.date < todayISO() ? todayISO() : a.date}" /></div>
        <div class="field"><div class="field-label"><span>Time</span></div><input type="time" class="input num" id="mv-time" value="${a.time || ''}" /></div></div>`),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', value: (d) => ({ date: d.querySelector('#mv-date').value, time: d.querySelector('#mv-time').value }) }],
    });
    if (res) apptUpdate(a.id, res, 'Visit rescheduled');
  }
}

async function voidEntry(id) {
  const e = data.entries.find((x) => x.id === id);
  const reason = await promptDialog({
    title: 'Void ledger entry', label: 'Reason (recorded in the audit trail)', confirmLabel: 'Void entry',
    hint: `${fmt.date(e.visitDate)} · ${e.procedure} · fee ${fmt.peso(e.feeCents)}, paid ${fmt.peso(e.paidCents)}. Voided entries stay recoverable for ${state.config.trashRetentionDays} days.`,
  });
  if (!reason) return;
  try {
    data = await del(`/ledger/${id}`, { reason });
    if (editing && editing.id === id) { editing = null; dirty.clear('ledger'); }
    renderAll();
    await refreshPatient();
    toast('Entry voided');
  } catch (err) { toastError(err); }
}

async function apptUpdate(id, body, msg) {
  try {
    await put(`/appointments/${id}`, body);
    appts = (await get(`/patients/${state.patient.id}/appointments`)).appointments;
    root.querySelector('#appt-card').innerHTML = String(apptHtml());
    await refreshPatient();
    toast(msg);
  } catch (err) { toastError(err); }
}
