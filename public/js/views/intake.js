// FR-1 patient registration (PDA Patient Information Record, portrait <= 500 KB,
// mandatory consent) and FR-8 OCR scanning (RapidOCR + Keras document classifier).
// OCR output is never saved without staff review (NFR-S5).
import { get, post, put, del, upload, download } from '../api.js';
import {
  html, fmt, toast, toastError, todayISO, ageOn, initials, showFieldErrors, clearFieldErrors,
  dirty, confirmDialog, openModal,
} from '../ui.js';
import { state, can, setActivePatient, clearPatient, emit } from '../state.js';
import { captureImage, pickFiles, loadBitmap, drawToCanvas, encodeUnder, blobToDataUrl, prepareClinicalPhoto } from '../camera.js';

const CORE_FIELDS = ['lastName', 'firstName', 'middleName', 'dateOfBirth', 'sex', 'address', 'contactNumber', 'allergies', 'registrationDate'];
const PDA_EXTRA_FIELDS = [
  'nickname', 'religion', 'nationality', 'occupation', 'homeNo', 'officeNo', 'faxNo',
  'dentalInsurance', 'effectiveDate', 'email', 'guardianName', 'guardianOccupation',
  'referredBy', 'consultationReason',
  'previousDentist', 'lastDentalVisit',
  'physicianName', 'physicianSpecialty', 'physicianAddress', 'physicianPhone',
  'bleedingTime', 'bloodType', 'bloodPressure',
];
const ALL_TEXT_FIELDS = [...CORE_FIELDS, ...PDA_EXTRA_FIELDS];

const LABELS = {
  lastName: 'Last name', firstName: 'First name', middleName: 'Middle name',
  dateOfBirth: 'Birthdate', sex: 'Sex', nickname: 'Nickname',
  religion: 'Religion', nationality: 'Nationality',
  address: 'Home address', occupation: 'Occupation',
  homeNo: 'Home no.', officeNo: 'Office no.', faxNo: 'Fax no.',
  dentalInsurance: 'Dental insurance', effectiveDate: 'Effective date',
  contactNumber: 'Cel / Mobile no.', email: 'Email address',
  guardianName: "Parent / Guardian's name", guardianOccupation: 'Guardian occupation',
  referredBy: 'Referred by', consultationReason: 'Reason for dental consultation',
  previousDentist: 'Previous dentist (Dr.)', lastDentalVisit: 'Last dental visit',
  physicianName: 'Name of physician (Dr.)', physicianSpecialty: 'Specialty, if applicable',
  physicianAddress: 'Office address', physicianPhone: 'Office number',
  bleedingTime: 'Bleeding time', bloodType: 'Blood type', bloodPressure: 'Blood pressure',
  allergies: 'Allergies / medical alerts summary', registrationDate: 'Registration date',
};

const YES_NO_QUESTIONS = [
  { key: 'goodHealth', num: '1', label: 'Are you in good health?' },
  { key: 'underMedicalTreatment', num: '2', label: 'Are you under medical treatment now?', detailKey: 'medicalTreatmentCondition', detailPlaceholder: 'If so, what is the condition being treated?' },
  { key: 'seriousIllness', num: '3', label: 'Have you ever had serious illness or surgical operation?', detailKey: 'seriousIllnessDetails', detailPlaceholder: 'If so, what illness or operation?' },
  { key: 'hospitalized', num: '4', label: 'Have you ever been hospitalized?', detailKey: 'hospitalizedDetails', detailPlaceholder: 'If so, when and why?' },
  { key: 'takingMedication', num: '5', label: 'Are you taking any prescription/non-prescription medication?', detailKey: 'medicationDetails', detailPlaceholder: 'If so, please specify' },
  { key: 'usesTobacco', num: '6', label: 'Do you use tobacco products?' },
  { key: 'usesAlcoholDrugs', num: '7', label: 'Do you use alcohol, cocaine or other dangerous drugs?' },
  { key: 'allergic', num: '8', label: 'Are you allergic to any of the following?' },
];

const WOMEN_QUESTIONS = [
  { key: 'pregnant', label: 'Are you pregnant?' },
  { key: 'nursing', label: 'Are you nursing?' },
  { key: 'birthControl', label: 'Are you taking birth control pills?' },
];

const ALLERGY_OPTIONS = [
  { key: 'localAnesthetic', label: 'Local Anesthetic (ex. Lidocaine)' },
  { key: 'penicillin', label: 'Penicillin / Antibiotics' },
  { key: 'sulfaDrugs', label: 'Sulfa drugs' },
  { key: 'aspirin', label: 'Aspirin' },
  { key: 'latex', label: 'Latex' },
  { key: 'other', label: 'Other' },
];

const MEDICAL_CONDITIONS = [
  ['highBloodPressure', 'High Blood Pressure'],
  ['heartDisease', 'Heart Disease'],
  ['cancerTumors', 'Cancer / Tumors'],
  ['lowBloodPressure', 'Low Blood Pressure'],
  ['heartMurmur', 'Heart Murmur'],
  ['anemia', 'Anemia'],
  ['epilepsy', 'Epilepsy / Convulsions'],
  ['hepatitisLiver', 'Hepatitis / Liver Disease'],
  ['angina', 'Angina'],
  ['hivAids', 'AIDS or HIV Infection'],
  ['rheumaticFever', 'Rheumatic Fever'],
  ['asthma', 'Asthma'],
  ['std', 'Sexually Transmitted disease'],
  ['hayFeverAllergies', 'Hay Fever / Allergies'],
  ['emphysema', 'Emphysema'],
  ['stomachUlcers', 'Stomach Troubles / Ulcers'],
  ['respiratoryProblems', 'Respiratory Problems'],
  ['bleedingProblems', 'Bleeding Problems'],
  ['faintingSeizure', 'Fainting Seizure'],
  ['hepatitisJaundice', 'Hepatitis / Jaundice'],
  ['bloodDiseases', 'Blood Diseases'],
  ['rapidWeightLoss', 'Rapid Weight Loss'],
  ['tuberculosis', 'Tuberculosis'],
  ['headInjuries', 'Head Injuries'],
  ['radiationTherapy', 'Radiation Therapy'],
  ['swollenAnkles', 'Swollen ankles'],
  ['arthritis', 'Arthritis / Rheumatism'],
  ['jointReplacement', 'Joint Replacement / Implant'],
  ['kidneyDisease', 'Kidney disease'],
  ['otherCondition', 'Other'],
  ['heartSurgery', 'Heart Surgery'],
  ['diabetes', 'Diabetes'],
  ['heartAttack', 'Heart Attack'],
  ['chestPain', 'Chest pain'],
  ['thyroidProblem', 'Thyroid Problem'],
  ['stroke', 'Stroke'],
];

const DOC_TYPE_LABELS = {
  form: 'Dental / Registration Form',
  document: 'Document',
  invoice: 'Invoice / Receipt',
  real_life: 'Non-document Photo',
};

let root;
let mode = 'new';           // 'new' | 'edit'
let editingId = null;
let portrait = null;        // pending { dataUrl, bytes }
let oversized = null;       // rejected File awaiting "compress automatically"
let autofilled = new Map(); // field -> confidence (unconfirmed OCR values)
let ocrReview = new Set();  // fields the OCR model asks staff to check closely
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

// Flatten patient record (including nested dentalHistory & medicalHistory) for rendering
function flattenValues(raw = {}) {
  const dh = raw.dentalHistory || {};
  const mh = raw.medicalHistory || {};
  return {
    ...raw,
    previousDentist: raw.previousDentist ?? dh.previousDentist ?? '',
    lastDentalVisit: raw.lastDentalVisit ?? dh.lastDentalVisit ?? '',
    physicianName: raw.physicianName ?? mh.physicianName ?? '',
    physicianSpecialty: raw.physicianSpecialty ?? mh.physicianSpecialty ?? '',
    physicianAddress: raw.physicianAddress ?? mh.physicianAddress ?? '',
    physicianPhone: raw.physicianPhone ?? mh.physicianPhone ?? '',
    bleedingTime: raw.bleedingTime ?? mh.bleedingTime ?? '',
    bloodType: raw.bloodType ?? mh.bloodType ?? '',
    bloodPressure: raw.bloodPressure ?? mh.bloodPressure ?? '',
    allergyOther: mh.allergyOther ?? '',
    conditionOther: mh.conditionOther ?? '',
    _questions: mh.questions || {},
    _allergyItems: new Set(mh.allergyItems || []),
    _conditions: new Set(mh.conditions || []),
  };
}

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

function yesNoRow(q, questions) {
  const val = questions[q.key];
  const detailVal = q.detailKey ? (questions[q.detailKey] || '') : '';
  return html`<div class="pda-yn-row" data-yn="${q.key}">
    <div class="pda-yn-main">
      <span class="pda-yn-q">${q.num ? html`<strong>${q.num}.</strong> ` : ''}${q.label}</span>
      <div class="pda-yn-pills">
        <label><input type="radio" name="mh_q_${q.key}" value="yes" ${val === true ? 'checked' : ''} /> Yes</label>
        <label><input type="radio" name="mh_q_${q.key}" value="no" ${val === false ? 'checked' : ''} /> No</label>
      </div>
    </div>
    ${q.detailKey ? html`<div class="pda-yn-detail">
      <input class="input" type="text" name="mh_d_${q.detailKey}" value="${detailVal}" placeholder="${q.detailPlaceholder}" />
    </div>` : ''}
  </div>`;
}

function render(rawValues) {
  const values = flattenValues(rawValues);
  const cfg = state.config;
  const p = mode === 'edit' ? state.patient : null;
  const consentOk = p && p.consent && p.consent.current;
  const maxKb = Math.round(cfg.limits.portraitMaxBytes / 1024);
  const today = todayISO();
  const qMap = values._questions;

  root.innerHTML = String(html`
    <div class="view-header">
      <div>
        <h2>${mode === 'edit' ? 'Patient Information Record' : 'Patient Registration'}</h2>
        <p>${mode === 'edit' ? html`Editing <strong>${p.fullName}</strong> · <span class="num">${p.id}</span>` : 'Scan the Philippine Dental Association (PDA) Patient Information Record or enter details, then verify signed consent.'}</p>
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
          <h3>Patient Information Record</h3>
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

        <div class="grid-3">
          ${field('nickname', { placeholder: 'Preferred name' }, values)}
          ${field('religion', { placeholder: 'e.g. Roman Catholic' }, values)}
          ${field('nationality', { placeholder: 'e.g. Filipino' }, values)}
        </div>

        ${field('address', { required: true, placeholder: 'House no., street, barangay, city' }, values)}

        <div class="grid-3">
          ${field('contactNumber', { type: 'tel', placeholder: '09XX-XXX-XXXX' }, values)}
          ${field('homeNo', { type: 'tel', placeholder: '(02) XXXX-XXXX' }, values)}
          ${field('officeNo', { type: 'tel', placeholder: '(02) XXXX-XXXX' }, values)}
        </div>

        <div class="grid-3">
          ${field('email', { type: 'email', placeholder: 'patient@email.com' }, values)}
          ${field('faxNo', { type: 'tel', placeholder: 'Optional' }, values)}
          ${field('registrationDate', { type: 'date', required: true, attrs: `max="${today}"` }, { ...values, registrationDate: values.registrationDate || values.registeredOn || today })}
        </div>

        <div class="grid-3">
          ${field('occupation', { placeholder: 'Patient occupation' }, values)}
          ${field('dentalInsurance', { placeholder: 'HMO / Dental plan' }, values)}
          ${field('effectiveDate', { type: 'date' }, values)}
        </div>

        <div class="pda-sub-label">For Minors &amp; Referral</div>
        <div class="grid-2">
          ${field('guardianName', { placeholder: 'If patient is a minor' }, values)}
          ${field('guardianOccupation', { placeholder: 'Guardian occupation' }, values)}
        </div>
        <div class="grid-2">
          ${field('referredBy', { placeholder: 'Whom may we thank for referring you?' }, values)}
          ${field('consultationReason', { placeholder: 'Reason for dental consultation' }, values)}
        </div>

        <!-- DENTAL HISTORY -->
        <div class="pda-section">
          <div class="pda-section-head">
            <h4>Dental History</h4>
            <span class="badge">PDA Section 2</span>
          </div>
          <div class="grid-2">
            ${field('previousDentist', { placeholder: 'Dr. ...' }, values)}
            ${field('lastDentalVisit', { placeholder: 'e.g. November 2025' }, values)}
          </div>
        </div>

        <!-- MEDICAL HISTORY -->
        <div class="pda-section">
          <div class="pda-section-head">
            <h4>Medical History</h4>
            <span class="badge">PDA Section 3</span>
          </div>

          <div class="grid-2">
            ${field('physicianName', { placeholder: 'Dr. ...' }, values)}
            ${field('physicianSpecialty', { placeholder: 'e.g. Internal Medicine' }, values)}
          </div>
          <div class="grid-2">
            ${field('physicianAddress', { placeholder: 'Clinic / hospital address' }, values)}
            ${field('physicianPhone', { type: 'tel', placeholder: 'Office number' }, values)}
          </div>

          <div class="pda-yn-list">
            ${YES_NO_QUESTIONS.map((q) => yesNoRow(q, qMap))}
          </div>

          <div class="pda-sub-label">8. Allergy Checklist (syncs with Medical Alerts)</div>
          <div class="pda-check-grid">
            ${ALLERGY_OPTIONS.map((a) => html`
              <label class="pda-check-item" data-allergy="${a.key}">
                <input type="checkbox" name="mh_allergy" value="${a.key}" ${values._allergyItems.has(a.key) ? 'checked' : ''} />
                <span>${a.label}</span>
              </label>`)}
          </div>
          <div style="margin-top:8px;">
            <input class="input" type="text" name="mh_allergy_other" value="${values.allergyOther}" placeholder="If Other allergy, please specify…" />
          </div>
          <div style="margin-top:10px;">
            ${field('allergies', { type: 'textarea', placeholder: 'Summary shown in clinical alert bar (e.g. Penicillin / Antibiotics, Latex — or "None")' }, values)}
          </div>

          <div class="grid-3" style="margin-top:10px;">
            ${field('bleedingTime', { placeholder: 'e.g. 3 mins' }, values)}
            ${field('bloodType', { placeholder: 'e.g. O+' }, values)}
            ${field('bloodPressure', { placeholder: 'e.g. 120/80 mmHg' }, values)}
          </div>

          <div class="pda-sub-label">10. For Women Only</div>
          <div class="pda-yn-list">
            ${WOMEN_QUESTIONS.map((q) => yesNoRow(q, qMap))}
          </div>

          <div class="pda-sub-label">13. Do you have or have you had any of the following? Check which apply</div>
          <div class="pda-check-grid">
            ${MEDICAL_CONDITIONS.map(([key, label]) => html`
              <label class="pda-check-item" data-cond="${key}">
                <input type="checkbox" name="mh_cond" value="${key}" ${values._conditions.has(key) ? 'checked' : ''} />
                <span>${label}</span>
              </label>`)}
          </div>
          <div style="margin-top:8px;">
            <input class="input" type="text" name="mh_cond_other" value="${values.conditionOther}" placeholder="If Other medical condition, specify…" />
          </div>
        </div>

        <div class="consent-box" id="consent-card" data-field="consent" style="margin-top:18px;">
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
  if (!can('patients.write')) {
    root.querySelectorAll('#intake-form input, #intake-form select, #intake-form textarea').forEach((i) => { i.disabled = true; });
  }
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

let ocrPollTimer = null;

async function refreshOcrStatus() {
  try { state.config.ocr = await get('/ocr/status'); } catch { /* keep last */ }
  renderOcrStatus();
  const s = state.config.ocr || {};
  if (ocrPollTimer) { clearTimeout(ocrPollTimer); ocrPollTimer = null; }
  if (s.provider === 'http' && !s.ready) {
    ocrPollTimer = setTimeout(() => {
      if (root && root.closest('.view.active')) refreshOcrStatus();
    }, 3000);
  }
}

function renderOcrStatus() {
  const s = state.config.ocr || {};
  const badge = root.querySelector('#ocr-provider');
  if (!badge) return;
  const tone = s.ready ? (s.demo ? 'amber' : 'green') : (s.starting ? 'amber' : 'red');
  const label = s.ready ? (s.demo ? 'demo' : 'ready') : (s.starting ? 'starting…' : 'not ready');
  badge.className = `badge ${tone}`;
  badge.textContent = `${s.provider || '?'} • ${label}`;
  root.querySelector('#ocr-detail').textContent = s.ready
    ? (s.demo ? 'Demo provider: returns sample data so the review flow can be tested. Mount your model with OCR_PROVIDER.' : `${s.description}. ${s.detail || ''}`)
    : (s.starting ? `${s.detail || 'Starting local OCR engine…'} Ready in a few seconds.` : `${s.description || 'OCR'} is not ready: ${s.detail || 'unknown error'}`);
  const docTag = ocrInfo && ocrInfo.documentType
    ? ` · ${DOC_TYPE_LABELS[ocrInfo.documentType] || ocrInfo.documentType}${ocrInfo.documentConfidence != null ? ` (${Math.round(ocrInfo.documentConfidence * 100)}%)` : ''}`
    : '';
  root.querySelector('#ocr-last').textContent = ocrInfo
    ? `Last scan: ${ocrInfo.count} field(s) in ${(ocrInfo.tookMs / 1000).toFixed(1)} s${docTag}`
    : '';
}

function renderAutofill() {
  root.querySelectorAll('[data-af]').forEach((slot) => {
    const f = slot.dataset.af;
    const input = root.querySelector(`[name="${f}"]`);
    if (autofilled.has(f)) {
      const c = autofilled.get(f);
      const check = ocrReview.has(f);
      slot.innerHTML = String(html`<span class="af-tag${check ? ' check' : ''}" title="${check ? 'The scanner was unsure of this value (repaired, inferred or faint handwriting).' : ''}">Auto-filled${c != null ? ` · ${Math.round(c * 100)}% confidence` : ''}${check ? ' · check' : ''} <button type="button" data-confirm="${f}" title="Mark as reviewed">✓ Confirm</button></span>`);
      if (input) input.classList.add('ocr-highlight');
    } else {
      slot.innerHTML = '';
      if (input) input.classList.remove('ocr-highlight');
    }
  });
  const banner = root.querySelector('#ocr-banner');
  const docBadge = ocrInfo && ocrInfo.documentType
    ? html`<span class="badge ${ocrInfo.documentType === 'real_life' ? 'red' : 'green'}" style="margin-left:6px;">Classified: ${DOC_TYPE_LABELS[ocrInfo.documentType] || ocrInfo.documentType}${ocrInfo.documentConfidence != null ? ` · ${Math.round(ocrInfo.documentConfidence * 100)}%` : ''}</span>`
    : '';
  if (ocrInfo && autofilled.size) {
    banner.innerHTML = String(html`<div class="notice warn" style="margin-bottom:16px; justify-content:space-between; flex-wrap:wrap;">
      <div><strong>${autofilled.size} auto-filled field${autofilled.size === 1 ? '' : 's'} need review.</strong>${docBadge}
        <div style="margin-top:4px;">OCR (${ocrInfo.provider}) filled ${ocrInfo.count} field(s) in ${(ocrInfo.tookMs / 1000).toFixed(1)} s. Check each highlighted value against the paper form — edit it or tap ✓ Confirm.</div></div>
      <div class="row"><button class="btn-secondary" type="button" data-action="raw-text">Show scanned text</button>
        <button class="btn-secondary" type="button" data-action="confirm-all">I reviewed all — confirm</button></div></div>`);
  } else if (ocrInfo) {
    banner.innerHTML = String(html`<div class="notice ok" style="margin-bottom:16px; justify-content:space-between; flex-wrap:wrap;">
      <div>✓ All auto-filled fields reviewed.${docBadge} Complete the consent check and save.</div>
      <button class="btn-secondary" type="button" data-action="raw-text">Show scanned text</button></div>`);
  } else banner.innerHTML = '';
}

// ------------------------------------------------------------------ events
function val(name) {
  const el = root.querySelector(`[name="${name}"]`);
  return el ? el.value.trim() : '';
}

function syncAllergiesSummary() {
  const checked = [...root.querySelectorAll('input[name="mh_allergy"]:checked')].map((i) => i.value);
  const otherTxt = val('mh_allergy_other');
  const labelMap = Object.fromEntries(ALLERGY_OPTIONS.map((a) => [a.key, a.label]));
  const parts = checked.map((k) => (k === 'other' && otherTxt ? otherTxt : labelMap[k])).filter(Boolean);
  const el = root.querySelector('[name="allergies"]');
  if (el && parts.length) el.value = parts.join(', ');
}

function onInput(e) {
  const t = e.target;
  if (!t.name) return;
  if (t.name === 'consent') {
    if (t.checked) root.querySelector('#consent-card').classList.remove('error');
    markDirty();
    return;
  }
  if (t.name === 'mh_allergy' || t.name === 'mh_allergy_other') {
    syncAllergiesSummary();
    markDirty();
    return;
  }
  if (t.name.startsWith('mh_')) {
    markDirty();
    const row = t.closest('.pda-yn-row, .pda-check-item');
    if (row) row.classList.remove('ocr-highlight');
    return;
  }
  if (ALL_TEXT_FIELDS.includes(t.name)) {
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
    case 'confirm-all':
      autofilled.clear();
      root.querySelectorAll('.pda-yn-row.ocr-highlight, .pda-check-item.ocr-highlight').forEach((el) => el.classList.remove('ocr-highlight'));
      renderAutofill();
      toast('Auto-filled fields confirmed as reviewed');
      break;
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
function applyMedicalHistoryFromOcr(mh) {
  let count = 0;
  if (!mh || typeof mh !== 'object') return 0;

  // Yes/No questions & details
  if (mh.questions && typeof mh.questions === 'object') {
    for (const [k, v] of Object.entries(mh.questions)) {
      if (typeof v === 'boolean') {
        const radio = root.querySelector(`input[name="mh_q_${k}"][value="${v ? 'yes' : 'no'}"]`);
        if (radio) {
          radio.checked = true;
          const row = radio.closest('.pda-yn-row');
          if (row) row.classList.add('ocr-highlight');
          count++;
        }
      } else if (typeof v === 'string' && v.trim()) {
        const inp = root.querySelector(`input[name="mh_d_${k}"]`);
        if (inp) {
          inp.value = v.trim();
          const row = inp.closest('.pda-yn-row');
          if (row) row.classList.add('ocr-highlight');
          count++;
        }
      }
    }
  }

  // Q8 Allergy checkboxes
  if (Array.isArray(mh.allergyItems)) {
    root.querySelectorAll('input[name="mh_allergy"]').forEach((cb) => {
      const hit = mh.allergyItems.includes(cb.value);
      cb.checked = hit;
      const item = cb.closest('.pda-check-item');
      if (item) item.classList.toggle('ocr-highlight', hit);
      if (hit) count++;
    });
  }

  // Q13 Medical conditions checkboxes
  if (Array.isArray(mh.conditions)) {
    root.querySelectorAll('input[name="mh_cond"]').forEach((cb) => {
      const hit = mh.conditions.includes(cb.value);
      cb.checked = hit;
      const item = cb.closest('.pda-check-item');
      if (item) item.classList.toggle('ocr-highlight', hit);
      if (hit) count++;
    });
  }
  return count;
}

async function scan(source) {
  let blob;
  if (source === 'camera') blob = await captureImage({ title: 'Scan PDA registration form', mode: 'document', hint: 'Fit the whole Patient Information Record page inside the frame, in good light.' });
  else [blob] = await pickFiles({ accept: 'image/jpeg,image/png,image/webp' });
  if (!blob) return;
  const filledNow = CORE_FIELDS.filter((f) => f !== 'registrationDate' && val(f));
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
    ocrReview = new Set(Array.isArray(r.review) ? r.review : []);
    for (const [f, v] of Object.entries(r.fields || {})) {
      const el = root.querySelector(`[name="${f}"]`);
      if (!el || !v) continue;
      el.value = v;
      autofilled.set(f, r.confidence && r.confidence[f] != null ? r.confidence[f] : null);
      count++;
    }
    const mhCount = applyMedicalHistoryFromOcr(r.medicalHistory);
    count += mhCount;

    const dob = root.querySelector('[name="dateOfBirth"]').value;
    root.querySelector('#intake-age').value = ageOn(dob) != null ? `${ageOn(dob)} yrs` : '';
    ocrInfo = {
      provider: r.provider,
      tookMs: total,
      count,
      text: r.text,
      documentType: r.documentType || null,
      documentConfidence: r.documentConfidence != null ? r.documentConfidence : null,
    };
    markDirty();
    renderAutofill();
    renderOcrStatus();
    renderPortrait();
    status.textContent = count ? 'Auto-filled • Pending staff review' : 'Scan found no fields';
    if (r.documentType === 'real_life') {
      toast('Classifier flagged this image as a non-document photo — verify the scan.', 'warn');
    } else {
      toast(count ? `OCR filled ${count} field${count === 1 ? '' : 's'} — please review` : 'No form fields recognised. Type the details manually.', count ? 'ok' : 'warn');
    }
  } catch (err) {
    status.textContent = mode === 'edit' ? 'Saved record' : 'New record';
    toastError(err);
  }
}

// ------------------------------------------------------------------ save / delete
function collectProfilePayload() {
  const profile = {};
  for (const f of [...CORE_FIELDS.filter((k) => k !== 'registrationDate'),
    'nickname', 'religion', 'nationality', 'occupation', 'homeNo', 'officeNo', 'faxNo',
    'dentalInsurance', 'effectiveDate', 'email', 'guardianName', 'guardianOccupation',
    'referredBy', 'consultationReason']) {
    const v = val(f);
    if (v || CORE_FIELDS.includes(f)) profile[f] = v;
  }

  const previousDentist = val('previousDentist');
  const lastDentalVisit = val('lastDentalVisit');
  if (previousDentist || lastDentalVisit) {
    profile.dentalHistory = { previousDentist, lastDentalVisit };
  }

  const questions = {};
  for (const q of [...YES_NO_QUESTIONS, ...WOMEN_QUESTIONS]) {
    const checked = root.querySelector(`input[name="mh_q_${q.key}"]:checked`);
    if (checked) questions[q.key] = checked.value === 'yes';
    if (q.detailKey) {
      const dv = val(`mh_d_${q.detailKey}`);
      if (dv) questions[q.detailKey] = dv;
    }
  }
  const allergyItems = [...root.querySelectorAll('input[name="mh_allergy"]:checked')].map((i) => i.value);
  const conditions = [...root.querySelectorAll('input[name="mh_cond"]:checked')].map((i) => i.value);

  const medicalHistory = {
    physicianName: val('physicianName'),
    physicianSpecialty: val('physicianSpecialty'),
    physicianAddress: val('physicianAddress'),
    physicianPhone: val('physicianPhone'),
    bleedingTime: val('bleedingTime'),
    bloodType: val('bloodType'),
    bloodPressure: val('bloodPressure'),
    allergyOther: val('mh_allergy_other'),
    conditionOther: val('mh_cond_other'),
    questions,
    allergyItems,
    conditions,
  };
  const hasMh = Object.values(medicalHistory).some((v) =>
    Array.isArray(v) ? v.length > 0 : (typeof v === 'object' ? Object.keys(v).length > 0 : Boolean(v))
  );
  if (hasMh) profile.medicalHistory = medicalHistory;

  return profile;
}

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
    profile: collectProfilePayload(),
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
