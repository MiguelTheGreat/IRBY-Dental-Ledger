// Renders PDA chart symbols from config/pda-symbols.json (NFR-M2). Each symbol is
// distinguishable by shape and pattern as well as colour (NFR-U4).
import { esc } from './ui.js';

let uid = 0;
let byCode = new Map();

export function setSymbols(pda) {
  byCode = new Map(pda.symbols.map((s) => [s.code, s]));
}
export const symbolFor = (code) => byCode.get(code) || { code, name: code, shape: 'circle', fill: 'outline', color: '#57524C', scope: 'tooth' };

function polygon(n, r = 9.5, rot = -90) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = ((rot + (360 / n) * i) * Math.PI) / 180;
    pts.push(`${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

function star() {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 4.2 : 10;
    const a = ((-90 + 36 * i) * Math.PI) / 180;
    pts.push(`${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** SVG markup for a symbol. size in px. */
export function glyph(symbolOrCode, size = 26) {
  const s = typeof symbolOrCode === 'string' ? symbolFor(symbolOrCode) : symbolOrCode;
  const c = esc(s.color);
  const id = `pf${++uid}`;
  let defs = '';
  let fill = c;
  let stroke = c;
  let dash = '';
  switch (s.fill) {
    case 'outline': fill = '#FFFFFF'; break;
    case 'crosshatch':
      defs = `<pattern id="${id}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="#EAF2F8"/><path d="M0 0V4M0 0H4" stroke="${c}" stroke-width="1.6"/></pattern>`;
      fill = `url(#${id})`; break;
    case 'hatch':
      defs = `<pattern id="${id}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="#FFFFFF"/><path d="M0 0V4" stroke="${c}" stroke-width="1.8"/></pattern>`;
      fill = `url(#${id})`; break;
    case 'dots':
      defs = `<pattern id="${id}" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#FFFFFF"/><circle cx="2" cy="2" r="1.1" fill="${c}"/></pattern>`;
      fill = `url(#${id})`; break;
    case 'dashed': fill = '#FFFFFF'; dash = ' stroke-dasharray="3 2"'; break;
    default: break;
  }
  const area = `fill="${fill}" stroke="${stroke}" stroke-width="2"${dash}`;
  const line = `fill="none" stroke="${c}" stroke-width="3.4" stroke-linecap="round"${dash}`;
  let body;
  switch (s.shape) {
    case 'circle': body = `<circle cx="12" cy="12" r="9" ${area}/>`; break;
    case 'square': body = `<rect x="3.5" y="3.5" width="17" height="17" rx="2" ${area}/>`; break;
    case 'diamond': body = `<polygon points="12,2 22,12 12,22 2,12" ${area}/>`; break;
    case 'triangle': body = `<polygon points="12,2.5 21.5,20.5 2.5,20.5" ${area}/>`; break;
    case 'triangle-down': body = `<polygon points="2.5,3.5 21.5,3.5 12,21.5" ${area}/>`; break;
    case 'hexagon': body = `<polygon points="${polygon(6, 9.8, 0)}" ${area}/>`; break;
    case 'pentagon': body = `<polygon points="${polygon(5)}" ${area}/>`; break;
    case 'octagon': body = `<polygon points="${polygon(8, 9.8, 22.5)}" ${area}/>`; break;
    case 'star': body = `<polygon points="${star()}" ${area}/>`; break;
    case 'bar': body = `<rect x="2" y="8" width="20" height="8" rx="2" ${area}/>`; break;
    case 'ring': body = `<circle cx="12" cy="12" r="8" fill="#FFFFFF" stroke="${c}" stroke-width="3"${dash}/>`; break;
    case 'ring-double': body = `<circle cx="12" cy="12" r="9.2" fill="#FFFFFF" stroke="${c}" stroke-width="2"/><circle cx="12" cy="12" r="4.6" fill="none" stroke="${c}" stroke-width="2"/>`; break;
    case 'square-inset': body = `<rect x="3" y="3" width="18" height="18" rx="2" fill="#FFFFFF" stroke="${c}" stroke-width="2"/><rect x="8" y="8" width="8" height="8" fill="${c}"/>`; break;
    case 'x': body = `<circle cx="12" cy="12" r="11" fill="#FFFFFF"/><path d="M5 5L19 19M19 5L5 19" ${line}/>`; break;
    case 'plus': body = `<circle cx="12" cy="12" r="11" fill="#FFFFFF"/><path d="M12 4V20M4 12H20" ${line}/>`; break;
    case 'check': body = `<circle cx="12" cy="12" r="11" fill="#FFFFFF"/><path d="M5 12.5L10 17.5L19 6.5" ${line}/>`; break;
    case 'x-circle': body = `<circle cx="12" cy="12" r="9.5" fill="#FFFFFF" stroke="${c}" stroke-width="2"/><path d="M7.5 7.5L16.5 16.5M16.5 7.5L7.5 16.5" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`; break;
    case 'x-square': body = `<rect x="2.5" y="2.5" width="19" height="19" rx="2" fill="#FFFFFF" stroke="${c}" stroke-width="2"/><path d="M7 7L17 17M17 7L7 17" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`; break;
    default: body = `<circle cx="12" cy="12" r="9" ${area}/>`;
  }
  return `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`;
}

export const isGoneCondition = (code) => ['M', 'MO', 'X', 'XO'].includes(code);
