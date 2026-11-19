'use strict';
// Turns raw OCR text from a registration form into FR-1 fields, and normalizes
// values returned by a model (dates, sex, split names). Staff always review the
// result before saving (NFR-S5).

const FIELD_LABELS = {
  lastName: ['last name', 'surname', 'family name', 'apelyido'],
  firstName: ['first name', 'given name', 'pangalan'],
  middleName: ['middle name', 'middle initial', 'm.i.', 'mi'],
  fullName: ["patient's name", 'patient name', 'full name', 'name of patient', 'name', 'pangalan ng pasyente'],
  dateOfBirth: ['date of birth', 'birth date', 'birthdate', 'birthday', 'b-day', 'bday', 'dob', 'kaarawan', 'petsa ng kapanganakan'],
  age: ['age', 'edad'],
  sex: ['sex', 'gender', 'kasarian'],
  address: ['home address', 'residential address', 'present address', 'address', 'tirahan'],
  contactNumber: ['contact number', 'contact no', 'contact #', 'mobile number', 'mobile no', 'cellphone number', 'cellphone no',
    'cell no', 'cp no', 'phone number', 'phone', 'telephone', 'tel no', 'contact'],
  allergies: ['allergies', 'allergy', 'allergic to', 'medical alerts', 'medical alert'],
  registrationDate: ['date of registration', 'registration date', 'date registered', 'date'],
};

const LABEL_LIST = Object.entries(FIELD_LABELS)
  .flatMap(([field, labels]) => labels.map((label) => ({ field, label })))
  .sort((a, b) => b.label.length - a.label.length);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LABEL_RE = new RegExp(`(?:^|[\\s|;,])(${LABEL_LIST.map((l) => escapeRe(l.label)).join('|')})\\s*(?:[:=\\-–]|\\.(?=\\s))\\s*`, 'gi');
const LABEL_START_RE = new RegExp(`^\\s*(${LABEL_LIST.map((l) => escapeRe(l.label)).join('|')})\\s*(?:[:=\\-–]|\\.(?=\\s))`, 'i');
const LABEL_ONLY_RE = new RegExp(`^\\s*(${LABEL_LIST.map((l) => escapeRe(l.label)).join('|')})\\s*:?\\s*$`, 'i');

function fieldForLabel(label) {
  const hit = LABEL_LIST.find((l) => l.label === label.toLowerCase());
  return hit ? hit.field : null;
}

const MONTHS = {
  jan: 1, january: 1, enero: 1, feb: 2, february: 2, pebrero: 2, mar: 3, march: 3, marso: 3, apr: 4, april: 4, abril: 4,
  may: 5, mayo: 5, jun: 6, june: 6, hunyo: 6, jul: 7, july: 7, hulyo: 7, aug: 8, august: 8, agosto: 8,
  sep: 9, sept: 9, september: 9, setyembre: 9, oct: 10, october: 10, oktubre: 10, nov: 11, november: 11, nobyembre: 11,
  dec: 12, december: 12, disyembre: 12,
};

function iso(y, m, d) {
  if (y < 100) y += y > (new Date().getFullYear() % 100) ? 1900 : 2000;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Parse common Philippine date spellings into YYYY-MM-DD (month-first for numeric dates). */
function parseDate(value) {
  const s = String(value || '').trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{2,4})/.exec(s);
  if (m) {
    let a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) [a, b] = [b, a]; // clearly day-first
    return iso(+m[3], a, b);
  }
  m = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{2,4})/.exec(s);
  if (m && MONTHS[m[1]]) return iso(+m[3], MONTHS[m[1]], +m[2]);
  m = /^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{2,4})/.exec(s);
  if (m && MONTHS[m[2]]) return iso(+m[3], MONTHS[m[2]], +m[1]);
  return null;
}

function parseSex(value) {
  const s = String(value || '').trim().toLowerCase();
  const checked = /[[(]\s*[x✓✔/]\s*[\])]\s*(male|female|m|f)\b/.exec(s);
  const v = checked ? checked[1] : s;
  if (/^(m|male|lalaki)\b/.test(v)) return 'Male';
  if (/^(f|female|babae)\b/.test(v)) return 'Female';
  return v ? 'Other' : '';
}

const PARTICLES = new Set(['de', 'del', 'dela', 'della', 'delos', 'de la', 'de los', 'san', 'sta', 'sta.', 'santa', 'santo', 'van', 'von', 'mc', 'la', 'los']);

/** Split "Mateo Lorenzo Dela Cruz" or "Dela Cruz, Mateo Lorenzo" into parts. */
function splitFullName(full) {
  const s = String(full || '').replace(/\s+/g, ' ').trim();
  if (!s) return {};
  if (s.includes(',')) {
    const [last, rest] = s.split(',', 2).map((x) => x.trim());
    const words = (rest || '').split(' ').filter(Boolean);
    if (words.length >= 2) return { lastName: last, firstName: words.slice(0, -1).join(' '), middleName: words[words.length - 1].replace(/\.$/, '') };
    return { lastName: last, firstName: words.join(' ') };
  }
  const words = s.split(' ');
  const merged = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const lower = w.toLowerCase();
    if (PARTICLES.has(lower) && i < words.length - 1) {
      const next = words[i + 1].toLowerCase();
      if ((lower === 'de') && (next === 'la' || next === 'los') && i < words.length - 2) {
        merged.push(`${w} ${words[i + 1]} ${words[i + 2]}`); i += 2; continue;
      }
      merged.push(`${w} ${words[i + 1]}`); i += 1; continue;
    }
    merged.push(w);
  }
  if (merged.length === 1) return { firstName: merged[0] };
  if (merged.length === 2) return { firstName: merged[0], lastName: merged[1] };
  return { firstName: merged.slice(0, -2).join(' '), middleName: merged[merged.length - 2].replace(/\.$/, ''), lastName: merged[merged.length - 1] };
}

/** "DELA CRUZ" -> "Dela Cruz" (forms are often filled in capitals). */
function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/^[_\s:.-]+|[_\s]+$/g, '').trim();
}

/** Extract label/value pairs from raw OCR text. */
function parseRegistrationText(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const only = LABEL_ONLY_RE.exec(line);
    if (only) {
      const next = (lines.slice(i + 1).find((l) => l.trim()) || '').trim();
      const field = fieldForLabel(only[1]);
      // A blank label takes the next line, unless that line is itself labelled ("Contact No: ...")
      if (field && next && !LABEL_ONLY_RE.test(next) && !LABEL_START_RE.test(next) && !out[field]) out[field] = clean(next);
      continue;
    }
    const matches = [...line.matchAll(LABEL_RE)];
    for (let k = 0; k < matches.length; k++) {
      const m = matches[k];
      const start = m.index + m[0].length;
      const end = k + 1 < matches.length ? matches[k + 1].index : line.length;
      const field = fieldForLabel(m[1]);
      const value = clean(line.slice(start, end));
      if (field && value && !out[field]) out[field] = value;
    }
  }
  return out;
}

const ALIASES = {
  lastName: ['lastName', 'last_name', 'surname', 'family_name'],
  firstName: ['firstName', 'first_name', 'given_name', 'givenName'],
  middleName: ['middleName', 'middle_name', 'middle_initial'],
  fullName: ['fullName', 'full_name', 'name', 'patient_name'],
  dateOfBirth: ['dateOfBirth', 'date_of_birth', 'dob', 'birthdate', 'birth_date', 'birthday'],
  sex: ['sex', 'gender'],
  address: ['address', 'home_address', 'residential_address'],
  contactNumber: ['contactNumber', 'contact_number', 'contact', 'phone', 'mobile', 'mobile_number'],
  allergies: ['allergies', 'allergy', 'medical_alerts'],
  registrationDate: ['registrationDate', 'registration_date', 'date_registered'],
};

const FORM_FIELDS = ['lastName', 'firstName', 'middleName', 'dateOfBirth', 'sex', 'address', 'contactNumber', 'allergies', 'registrationDate'];

function pickAliases(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [field, keys] of Object.entries(ALIASES)) {
    for (const k of keys) {
      const v = obj[k];
      if (v != null && typeof v === 'object' && 'value' in v) { out[field] = v; break; }
      if (v != null && String(v).trim() !== '') { out[field] = v; break; }
    }
  }
  return out;
}

/** Normalize any provider output into { fields, confidence, text }. */
function normalizeResult(raw) {
  const result = typeof raw === 'string' ? { text: raw } : (raw || {});
  const text = typeof result.text === 'string' ? result.text
    : Array.isArray(result.lines) ? result.lines.map((l) => (typeof l === 'string' ? l : l.text || '')).join('\n') : '';

  const confidence = {};
  const explicit = pickAliases(result.fields || result);
  // Allow { field: { value, confidence } } shapes
  for (const [k, v] of Object.entries(explicit)) {
    if (v && typeof v === 'object' && 'value' in v) {
      if (typeof v.confidence === 'number') confidence[k] = v.confidence;
      explicit[k] = v.value;
    }
  }
  const parsed = parseRegistrationText(text);
  const merged = { ...parsed, ...explicit };

  if (merged.fullName && (!merged.lastName || !merged.firstName)) {
    const split = splitFullName(merged.fullName);
    for (const k of ['lastName', 'firstName', 'middleName']) if (!merged[k] && split[k]) merged[k] = split[k];
  }
  const fields = {};
  for (const f of FORM_FIELDS) {
    if (merged[f] == null || String(merged[f]).trim() === '') continue;
    let v = clean(merged[f]);
    if (f === 'dateOfBirth' || f === 'registrationDate') v = parseDate(v) || '';
    if (f === 'sex') v = parseSex(v);
    if (f === 'middleName') v = v.replace(/\.$/, '');
    if (['lastName', 'firstName', 'middleName'].includes(f) && v === v.toUpperCase()) v = titleCase(v);
    if (v) fields[f] = v;
  }
  const rawConf = result.confidence;
  if (rawConf && typeof rawConf === 'object') {
    for (const [k, v] of Object.entries(pickAliases(rawConf))) if (typeof v === 'number') confidence[k] = v;
  }
  const overall = typeof rawConf === 'number' ? rawConf : null;
  for (const f of Object.keys(fields)) {
    if (confidence[f] == null && overall != null) confidence[f] = overall;
    if (confidence[f] != null) confidence[f] = Math.max(0, Math.min(1, confidence[f] > 1 ? confidence[f] / 100 : confidence[f]));
  }
  return { fields, confidence, text };
}

module.exports = { parseRegistrationText, normalizeResult, parseDate, parseSex, splitFullName, FORM_FIELDS };
