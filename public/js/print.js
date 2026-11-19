// Print view for the photo chart and the ledger. Opens in its own tab and
// uses the browser's "Save as PDF" printer (no server-side PDF library needed).
import { get } from './api.js';
import { html, raw, fmt, hasAlert } from './ui.js';
import { setSymbols, glyph, symbolFor } from './symbols.js';
import { toothLabel, toothName, formatSurfaces, ORDER } from './teeth.js';

const params = new URLSearchParams(location.search);
const type = params.get('type');
const id = params.get('id');
const notation = params.get('notation') === 'Universal' ? 'Universal' : 'FDI';
const doc = document.getElementById('doc');

document.getElementById('print-btn').addEventListener('click', () => window.print());

function header(title, cfg, p, me) {
  return html`
    <header class="doc-head">
      <div><h1>${title}</h1><div class="clinic">${cfg.clinic.name}${cfg.clinic.address ? ' · ' + cfg.clinic.address : ''}${cfg.clinic.phone ? ' · ' + cfg.clinic.phone : ''}</div></div>
      <div class="clinic" style="text-align:right;">Printed ${fmt.dateTime(Date.now())}<br/>by ${me.user.displayName} (${me.user.roleLabel})</div>
    </header>
    <div class="patient">
      ${p.hasPortrait ? html`<img src="/api/patients/${p.id}/portrait" alt="" />` : ''}
      <div>
        <div class="name">${p.fullName}</div>
        <div class="meta">${p.id} · ${p.sex} · born ${fmt.date(p.dateOfBirth)} (${p.age ?? '—'} yrs) · registered ${fmt.date(p.registeredOn)}</div>
        <div class="meta">${p.address}${p.contactNumber ? ' · ' + p.contactNumber : ''}</div>
        ${hasAlert(p.allergies) ? html`<div class="alert">⚠ Allergies / alerts: ${p.allergies}</div>` : ''}
      </div>
    </div>`;
}

async function renderChart(cfg, p, me) {
  const { photos, marks } = await get(`/patients/${encodeURIComponent(id)}/chart`);
  const views = new Map(cfg.clinic.chart.photoViews.map((v) => [v.id, v.label]));
  const sorted = [...marks].sort((a, b) => ORDER.indexOf(a.tooth) - ORDER.indexOf(b.tooth) || a.createdAt - b.createdAt);
  const used = cfg.pda.symbols.filter((s) => marks.some((m) => m.condition === s.code));
  doc.innerHTML = String(html`
    ${header('Dental Chart — Intraoral Photos & Findings', cfg, p, me)}
    <h2>Findings (${marks.length}) · ${notation} numbering</h2>
    ${sorted.length ? html`<table><thead><tr><th>Tooth</th><th>Surfaces</th><th>Condition</th><th>Photo</th><th>Note</th><th>Recorded</th></tr></thead>
      <tbody>${sorted.map((m) => {
        const ph = photos.find((x) => x.id === m.photoId);
        return html`<tr><td><strong>#${toothLabel(m.tooth, notation)}</strong><br/><span style="color:#6F6860">${toothName(m.tooth)}</span></td>
          <td>${formatSurfaces(m.surfaces, m.tooth) || 'whole tooth'}</td>
          <td><span style="display:inline-flex; gap:6px; align-items:center;">${raw(glyph(m.condition, 16))}<strong>${m.condition}</strong> ${symbolFor(m.condition).name}</span></td>
          <td>${ph ? views.get(ph.view) || ph.view : '—'}</td><td>${m.note || ''}</td><td>${fmt.dateTime(m.createdAt)}<br/>${m.createdBy || ''}</td></tr>`;
      })}</tbody></table>` : html`<p>No findings recorded.</p>`}
    ${used.length ? html`<h2>Legend (PDA symbols used)</h2><div class="legend">${used.map((s) => html`<div>${raw(glyph(s, 16))}<strong>${s.code}</strong> ${s.name}</div>`)}</div>` : ''}
    <h2>Photos (${photos.length})</h2>
    ${photos.map((ph) => html`<div class="photo"><div class="frame">
        <img src="/api/chart/photos/${ph.id}/image" alt="" />
        ${marks.filter((m) => m.photoId === ph.id && m.x != null).map((m) => html`<div class="pin" style="left:${m.x * 100}%; top:${m.y * 100}%;">${raw(glyph(m.condition, 18))}<span>${toothLabel(m.tooth, notation)}${m.surfaces.length ? ' ' + formatSurfaces(m.surfaces, m.tooth) : ''} · ${m.condition}</span></div>`)}
      </div><div class="cap">${views.get(ph.view) || ph.view} · ${fmt.date(ph.takenOn)}${ph.label ? ' · ' + ph.label : ''}</div></div>`)}
    <div class="sign"><div>Attending dentist (signature over printed name)</div><div>PRC license no. / date</div></div>
    <footer>Confidential patient record — handle in accordance with the Data Privacy Act of 2012 (RA 10173).</footer>`);
}

async function renderLedger(cfg, p, me) {
  const { entries, totals } = await get(`/patients/${encodeURIComponent(id)}/ledger`);
  const rows = [...entries].reverse(); // chronological
  doc.innerHTML = String(html`
    ${header('Treatment & Financial Ledger', cfg, p, me)}
    <h2>Statement of account</h2>
    <table><thead><tr><th>Date</th><th>Age</th><th>Procedure</th><th class="num">Fee</th><th class="num">Paid</th><th class="num">Balance</th></tr></thead>
      <tbody>${rows.map((e) => html`<tr><td>${fmt.date(e.visitDate)}</td><td>${e.ageAtVisit ?? ''}</td><td>${e.procedure}</td>
        <td class="num">${fmt.peso(e.feeCents)}</td><td class="num">${fmt.peso(e.paidCents)}</td><td class="num">${fmt.peso(e.runningBalanceCents)}</td></tr>`)}</tbody>
      <tfoot><tr><td colspan="3">Totals</td><td class="num">${fmt.peso(totals.feeCents)}</td><td class="num">${fmt.peso(totals.paidCents)}</td><td class="num">${fmt.peso(totals.balanceCents)}</td></tr></tfoot>
    </table>
    <p style="margin-top:12px; font-weight:700;">${totals.balanceCents > 0 ? `Outstanding balance: ${fmt.peso(totals.balanceCents)}` : totals.balanceCents < 0 ? `Patient credit: ${fmt.peso(-totals.balanceCents)}` : 'Account fully paid.'}</p>
    ${p.nextAppointment ? html`<p>Next return visit: <strong>${fmt.date(p.nextAppointment.date)}${p.nextAppointment.time ? ' ' + fmt.time(p.nextAppointment.time) : ''}</strong>${p.nextAppointment.reason ? ' — ' + p.nextAppointment.reason : ''}</p>` : ''}
    <div class="sign"><div>Received by (clinic staff)</div><div>Patient / guardian</div></div>
    <footer>Confidential patient record — handle in accordance with the Data Privacy Act of 2012 (RA 10173).</footer>`);
}

(async () => {
  try {
    const [me, cfg, p] = await Promise.all([get('/auth/me'), get('/config'), get(`/patients/${encodeURIComponent(id)}`)]);
    setSymbols(cfg.pda);
    if (type === 'ledger') await renderLedger(cfg, p, me);
    else await renderChart(cfg, p, me);
    document.title = `${p.id} ${type === 'ledger' ? 'Ledger' : 'Chart'} — IRBY Dental`;
    await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
    if (params.get('autoprint') !== '0') setTimeout(() => window.print(), 300);
  } catch (err) {
    doc.innerHTML = String(html`<p>Cannot load this document: ${err.message}. Sign in to the app first, then try again.</p>`);
  }
})();
