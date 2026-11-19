// Tooth numbering helpers. Teeth are stored as FDI numbers and can be displayed
// in FDI or Universal notation (FR-3).

export const PERMANENT = [
  { q: 1, label: 'Upper right (Q1)', teeth: [18, 17, 16, 15, 14, 13, 12, 11] },
  { q: 2, label: 'Upper left (Q2)', teeth: [21, 22, 23, 24, 25, 26, 27, 28] },
  { q: 4, label: 'Lower right (Q4)', teeth: [48, 47, 46, 45, 44, 43, 42, 41] },
  { q: 3, label: 'Lower left (Q3)', teeth: [31, 32, 33, 34, 35, 36, 37, 38] },
];

export const PRIMARY = [
  { q: 5, label: 'Upper right (Q5)', teeth: [55, 54, 53, 52, 51] },
  { q: 6, label: 'Upper left (Q6)', teeth: [61, 62, 63, 64, 65] },
  { q: 8, label: 'Lower right (Q8)', teeth: [85, 84, 83, 82, 81] },
  { q: 7, label: 'Lower left (Q7)', teeth: [71, 72, 73, 74, 75] },
];

export const ORDER = [...PERMANENT, ...PRIMARY].flatMap((g) => g.teeth);

export function universal(fdi) {
  const q = Math.floor(fdi / 10), t = fdi % 10;
  switch (q) {
    case 1: return String(9 - t);
    case 2: return String(8 + t);
    case 3: return String(25 - t);
    case 4: return String(24 + t);
    case 5: return 'ABCDEFGHIJKLMNOPQRST'[5 - t];
    case 6: return 'ABCDEFGHIJKLMNOPQRST'[4 + t];
    case 7: return 'ABCDEFGHIJKLMNOPQRST'[15 - t];
    case 8: return 'ABCDEFGHIJKLMNOPQRST'[14 + t];
    default: return String(fdi);
  }
}

export const toothLabel = (fdi, notation) => (notation === 'Universal' ? universal(fdi) : String(fdi));

export const isPrimary = (fdi) => fdi >= 51;
export const isAnterior = (fdi) => fdi % 10 <= 3;

const PERM_NAMES = ['', 'central incisor', 'lateral incisor', 'canine', 'first premolar', 'second premolar', 'first molar', 'second molar', 'third molar'];
const PRIM_NAMES = ['', 'central incisor', 'lateral incisor', 'canine', 'first molar', 'second molar'];
const QUAD_NAMES = { 1: 'Upper right', 2: 'Upper left', 3: 'Lower left', 4: 'Lower right', 5: 'Upper right', 6: 'Upper left', 7: 'Lower left', 8: 'Lower right' };

export function toothName(fdi) {
  const q = Math.floor(fdi / 10), t = fdi % 10;
  return `${QUAD_NAMES[q]} ${isPrimary(fdi) ? 'primary ' : ''}${(isPrimary(fdi) ? PRIM_NAMES : PERM_NAMES)[t]}`;
}

/** Surface codes are stored as M, O, D, F, L; anterior teeth show I (incisal) and F (facial), posterior O and B (buccal). */
export function surfaceInfo(fdi) {
  const ant = fdi ? isAnterior(fdi) : false;
  return [
    { code: 'M', short: 'M', name: 'Mesial' },
    { code: 'O', short: ant ? 'I' : 'O', name: ant ? 'Incisal' : 'Occlusal' },
    { code: 'D', short: 'D', name: 'Distal' },
    { code: 'F', short: ant ? 'F' : 'B', name: ant ? 'Facial' : 'Buccal' },
    { code: 'L', short: 'L', name: 'Lingual' },
  ];
}

export function formatSurfaces(codes, fdi) {
  if (!codes || !codes.length) return '';
  const info = surfaceInfo(fdi);
  return codes.map((c) => (info.find((s) => s.code === c) || { short: c }).short).join('');
}
