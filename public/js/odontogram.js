// Interactive 52-tooth PDA Dental Record Chart (Odontogram).
// Integrates with /api/patients/:id/chart/marks (encrypted SQLite chart_marks).
import { esc } from './ui.js';
import { toothLabel, toothName } from './teeth.js';

// code, name, group ('c' = Condition, 'r' = Restorations & Prosthetics, 's' = Surgery), scope ('surface' | 'tooth')
export const ODONTO_CODES = [
  ['D',  'Decayed (caries, indicated for filling)', 'c', 'surface'],
  ['M',  'Missing due to caries',                   'c', 'tooth'],
  ['F',  'Filled',                                  'c', 'surface'],
  ['I',  'Caries indicated for extraction',         'c', 'tooth'],
  ['RF', 'Root fragment',                           'c', 'tooth'],
  ['MO', 'Missing due to other causes',             'c', 'tooth'],
  ['Im', 'Impacted tooth',                          'c', 'tooth'],
  ['J',  'Jacket crown',                            'r', 'tooth'],
  ['A',  'Amalgam filling',                         'r', 'surface'],
  ['AB', 'Abutment',                                'r', 'tooth'],
  ['P',  'Pontic',                                  'r', 'tooth'],
  ['In', 'Inlay',                                   'r', 'surface'],
  ['Fx', 'Fixed cure composite',                    'r', 'surface'],
  ['S',  'Sealants',                                'r', 'surface'],
  ['Rm', 'Removable denture',                       'r', 'tooth'],
  ['X',  'Extraction due to caries',                's', 'tooth'],
  ['XO', 'Extraction due to other causes',          's', 'tooth'],
  ['\u2713', 'Present teeth',                       's', 'tooth'],
  ['Cm', 'Congenitally missing',                    's', 'tooth'],
  ['Sp', 'Supernumerary',                           's', 'tooth'],
];

export const ODONTO_BY_CODE = Object.fromEntries(ODONTO_CODES.map((c) => [c[0], c]));

// Map alternate PDA codes from photo chart if present
const CODE_ALIAS = { Rf: 'RF', JC: 'J', Am: 'A', Ab: 'AB', Co: 'Fx', PRES: '\u2713' };
export const normalizeOdontoCode = (code) => CODE_ALIAS[code] || code;

export const ODONTO_GROUPS = [
  ['c', 'Condition'],
  ['r', 'Restorations & Prosthetics'],
  ['s', 'Surgery'],
];

export const SURF_ORDER = ['M', 'O', 'D', 'F', 'L'];

export const ODONTO_ROWS = [
  { id: 'ut', teeth: [55, 54, 53, 52, 51, 61, 62, 63, 64, 65], upper: true, temp: true, label: 'Temporary teeth' },
  { id: 'up', teeth: [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28], upper: true, temp: false, label: 'Permanent teeth' },
  { id: 'lp', teeth: [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38], upper: false, temp: false },
  { id: 'lt', teeth: [85, 84, 83, 82, 81, 71, 72, 73, 74, 75], upper: false, temp: true, label: 'Temporary teeth' },
];

export const KEEP_SURFACES_ON_TOOTH_CODE = new Set(['\u2713', 'Cm', 'Sp', 'Rm', 'J', 'AB', 'P', 'Im']);

function colorVar(code) {
  const norm = normalizeOdontoCode(code);
  const entry = ODONTO_BY_CODE[norm];
  if (!entry) return 'var(--brown-700)';
  return 'var(--' + ({ c: 'cond', r: 'rest', s: 'surg' })[entry[2]] + ')';
}

const P = (a, r) => [
  (r * Math.cos((a * Math.PI) / 180)).toFixed(2),
  (r * Math.sin((a * Math.PI) / 180)).toFixed(2),
];

function wedge(a0, a1, r0, r1) {
  const [x0, y0] = P(a0, r1);
  const [x1, y1] = P(a1, r1);
  const [x2, y2] = P(a1, r0);
  const [x3, y3] = P(a0, r0);
  return `M${x0} ${y0}A${r1} ${r1} 0 0 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 0 0 ${x3} ${y3}Z`;
}

function surfaceMap(tooth, upper) {
  const q = Math.floor(tooth / 10);
  const mesialRight = [1, 4, 5, 8].includes(q);
  return {
    top: upper ? 'F' : 'L',
    bottom: upper ? 'L' : 'F',
    right: mesialRight ? 'M' : 'D',
    left: mesialRight ? 'D' : 'M',
  };
}

/**
 * Derive per-tooth odontogram state from backend chart_marks array.
 * Returns Map<number, { code: string|null, codeMarkIds: string[], s: Record<string, string>, sMarks: Record<string, object[]> }>
 */
export function buildOdontoMap(marks) {
  const map = new Map();
  const getTooth = (t) => {
    let st = map.get(t);
    if (!st) {
      st = { code: null, codeMarkIds: [], s: {}, sMarks: {} };
      map.set(t, st);
    }
    return st;
  };

  for (const m of marks) {
    const st = getTooth(m.tooth);
    const code = normalizeOdontoCode(m.condition);
    const info = ODONTO_BY_CODE[code];
    const hasSurfaces = Array.isArray(m.surfaces) && m.surfaces.length > 0;

    if (hasSurfaces && (!info || info[3] === 'surface')) {
      for (const l of m.surfaces) {
        if (SURF_ORDER.includes(l)) {
          st.s[l] = code;
          (st.sMarks[l] = st.sMarks[l] || []).push(m);
        }
      }
    } else if (!hasSurfaces) {
      st.code = code;
      st.codeMarkIds.push(m.id);
    } else {
      // Surface-scoped code saved without surfaces -> show in tooth box as fallback
      st.code = code;
      st.codeMarkIds.push(m.id);
    }
  }
  return map;
}

function toothSVG(tooth, upper, st, notation) {
  const map = surfaceMap(tooth, upper);
  const faded = st.code && st.code !== '\u2713' && st.code !== 'Cm' && st.code !== 'Sp';
  const label = toothLabel(tooth, notation);
  let h = `<svg viewBox="-19 -19 38 38" role="img" aria-label="Tooth ${esc(label)} (${esc(toothName(tooth))})" data-odonto-tooth="${tooth}">`;
  h += `<g opacity="${faded ? 0.25 : 1}">`;
  const sides = [
    ['top', -135, -45],
    ['right', -45, 45],
    ['bottom', 45, 135],
    ['left', 135, 225],
  ];
  for (const [name, a0, a1] of sides) {
    const letter = map[name];
    const code = st.s[letter];
    h += `<path class="odonto-seg" data-odonto-surface="${letter}" d="${wedge(a0, a1, 7, 16)}"${
      code ? ` style="fill:${colorVar(code)};fill-opacity:.42"` : ''
    }><title>#${esc(label)} ${letter}${code ? ': ' + esc(code) : ''}</title></path>`;
  }
  h += `<circle class="odonto-seg" data-odonto-surface="O" r="7"${
    st.s.O ? ` style="fill:${colorVar(st.s.O)};fill-opacity:.42"` : ''
  }><title>#${esc(label)} O${st.s.O ? ': ' + esc(st.s.O) : ''}</title></circle>`;
  h += '<circle class="odonto-ring" r="16"/></g>';

  if (st.code) {
    const big = st.code.length > 1 ? 11 : 15;
    if (st.code === 'X' || st.code === 'XO') {
      h += `<path d="M-14 -14L14 14M14 -14L-14 14" stroke="${colorVar(st.code)}" stroke-width="3" stroke-linecap="round" pointer-events="none"/>`;
    }
    if (st.code !== 'X') {
      h += `<text class="odonto-tx" style="fill:${colorVar(st.code)};font-size:${big}px;font-weight:800">${esc(st.code)}</text>`;
    }
  }
  return h + '</svg>';
}

function boxes(st) {
  const t = st.code ? `<span style="color:${colorVar(st.code)}">${esc(st.code)}</span>` : '';
  const parts = SURF_ORDER.filter((l) => st.s[l]).map(
    (l) => `<span style="color:${colorVar(st.s[l])}" title="${l}">${esc(st.s[l])}</span>`
  );
  return `<div class="odonto-bx t">${t}</div><div class="odonto-bx">${parts.join('\u00b7')}</div>`;
}

export function renderToolbar(tool, editable) {
  if (!editable) {
    return `<div class="odonto-tools readonly"><div class="odonto-hint" style="margin:0;">Read-only view of the patient's 52-tooth PDA Dental Record Chart.</div></div>`;
  }
  let html = '<div class="odonto-tools" id="odonto-tools">';
  for (const [g, title] of ODONTO_GROUPS) {
    html += `<div class="odonto-grp"><b>${esc(title)}</b>`;
    for (const c of ODONTO_CODES.filter((x) => x[2] === g)) {
      const on = tool === c[0] ? ' on' : '';
      const tip = `${c[1]} (${c[3] === 'surface' ? 'surface' : 'whole tooth'})`;
      html += `<button type="button" class="odonto-chip ${g}${on}" data-odonto-tool="${esc(c[0])}" title="${esc(tip)}">${esc(c[0])}<small>${esc(c[1])}</small></button>`;
    }
    html += '</div>';
  }
  html += `<div class="odonto-grp"><b>Other</b><button type="button" class="odonto-chip k${tool === 'ERASE' ? ' on' : ''}" data-odonto-tool="ERASE" title="Tap a surface or tooth to remove its mark">Erase</button></div>`;
  html += '<p class="odonto-hint">Pick a code, then tap a tooth. Surface codes (D, F, A, In, Fx, S) paint the tapped surface; all other codes mark the whole tooth. Tap the same code again, or use Erase, to remove it.</p>';
  html += '</div>';
  return html;
}

export function renderOdontoChart(marks, notation) {
  const map = buildOdontoMap(marks);
  const empty = { code: null, codeMarkIds: [], s: {}, sMarks: {} };
  let out = '<div class="odonto-chart" id="odonto-chart">';

  ODONTO_ROWS.forEach((r, i) => {
    if (i === 2) out += '<div class="odonto-sep"></div>';
    out += '<div class="odonto-arch">';
    if (r.id === 'ut') out += '<div class="odonto-side"><span>RIGHT</span><span>LEFT</span></div>';
    if (r.label && r.upper) out += `<p class="odonto-lbl">${esc(r.label)}</p>`;
    out += '<div class="odonto-row">';
    const pad = r.temp ? 3 : 0;
    for (let k = 0; k < pad; k++) out += '<div class="odonto-tc sp"></div>';
    r.teeth.forEach((t, idx) => {
      const mid = idx === r.teeth.length / 2;
      const st = map.get(t) || empty;
      const num = `<div class="odonto-num num">${esc(toothLabel(t, notation))}</div>`;
      const svg = toothSVG(t, r.upper, st, notation);
      const bx = boxes(st);
      const inner = r.upper ? bx + num + svg : svg + num + bx;
      out += `<div class="odonto-tc${mid ? ' mid' : ''}" title="${esc(toothName(t))}">${inner}</div>`;
    });
    for (let k = 0; k < pad; k++) out += '<div class="odonto-tc sp"></div>';
    out += '</div>';
    if (r.label && !r.upper) out += `<p class="odonto-lbl">${esc(r.label)}</p>`;
    if (r.id === 'lt') out += '<div class="odonto-side"><span>RIGHT</span><span>LEFT</span></div>';
    out += '</div>';
  });

  out += '</div>';
  return out;
}

export function buildMarksJsonExport(patient, marks) {
  const map = buildOdontoMap(marks);
  const out = [];
  [...map.keys()].sort((a, b) => a - b).forEach((t) => {
    const st = map.get(t);
    if (st.code) {
      out.push({ tooth: t, surfaces: [], condition: st.code === '\u2713' ? 'PRES' : st.code });
    }
    const byCode = {};
    for (const l of SURF_ORDER) {
      if (st.s[l]) (byCode[st.s[l]] = byCode[st.s[l]] || []).push(l);
    }
    for (const c in byCode) out.push({ tooth: t, surfaces: byCode[c], condition: c });
  });
  return JSON.stringify({
    patient: patient ? {
      id: patient.id,
      name: patient.fullName,
      age: patient.age,
      sex: patient.sex,
      date: new Date().toISOString().slice(0, 10),
    } : null,
    marks: out,
  }, null, 2);
}
