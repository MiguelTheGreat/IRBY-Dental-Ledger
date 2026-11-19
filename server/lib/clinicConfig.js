'use strict';
// Loads the JSON files in /config and validates them, so a bad edit is reported
// clearly at startup instead of breaking the chart at runtime (NFR-M2).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SHAPES = ['circle', 'square', 'diamond', 'triangle', 'triangle-down', 'hexagon', 'pentagon', 'octagon',
  'star', 'x', 'plus', 'check', 'ring', 'ring-double', 'bar', 'x-circle', 'x-square', 'square-inset'];
const FILLS = ['solid', 'outline', 'crosshatch', 'hatch', 'dots', 'dashed'];
const SCOPES = ['surface', 'tooth'];

function readJson(dir, name) {
  const file = path.join(dir, name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read config/${name}: ${err.message}`);
  }
}

function validateSymbols(cfg) {
  const problems = [];
  const categories = new Set((cfg.categories || []).map((c) => c.id));
  const codes = new Set();
  const keys = new Set();
  if (!Array.isArray(cfg.symbols) || !cfg.symbols.length) problems.push('"symbols" must be a non-empty array');
  for (const [i, s] of (cfg.symbols || []).entries()) {
    const where = `symbols[${i}] (${s.code || '?'})`;
    if (!s.code || typeof s.code !== 'string' || s.code.length > 4) problems.push(`${where}: code must be 1-4 characters`);
    if (codes.has(s.code)) problems.push(`${where}: duplicate code`);
    codes.add(s.code);
    if (!s.name) problems.push(`${where}: name is required`);
    if (!categories.has(s.category)) problems.push(`${where}: unknown category "${s.category}"`);
    if (!SCOPES.includes(s.scope)) problems.push(`${where}: scope must be one of ${SCOPES.join(', ')}`);
    if (!SHAPES.includes(s.shape)) problems.push(`${where}: shape must be one of ${SHAPES.join(', ')}`);
    if (!FILLS.includes(s.fill)) problems.push(`${where}: fill must be one of ${FILLS.join(', ')}`);
    if (!/^#[0-9a-f]{6}$/i.test(s.color || '')) problems.push(`${where}: color must be #RRGGBB`);
    if (s.key != null) {
      if (!/^[0-9]$/.test(s.key)) problems.push(`${where}: key must be a single digit`);
      if (keys.has(s.key)) problems.push(`${where}: duplicate shortcut key ${s.key}`);
      keys.add(s.key);
    }
  }
  if (problems.length) throw new Error('config/pda-symbols.json is invalid:\n  - ' + problems.join('\n  - '));
  return cfg;
}

function loadClinicConfig(configDir) {
  const pda = validateSymbols(readJson(configDir, 'pda-symbols.json'));
  const consent = readJson(configDir, 'consent.json');
  if (!consent.version || !consent.text) throw new Error('config/consent.json needs "version" and "text"');
  consent.sha256 = crypto.createHash('sha256').update(consent.text).digest('hex');
  const procedures = readJson(configDir, 'procedures.json');
  const clinic = readJson(configDir, 'clinic.json');
  const views = (clinic.chart && clinic.chart.photoViews) || [];
  if (!views.length) throw new Error('config/clinic.json needs chart.photoViews');
  return {
    pda,
    symbolByCode: new Map(pda.symbols.map((s) => [s.code, s])),
    consent,
    procedures: procedures.procedures || [],
    clinic,
    photoViewIds: new Set(views.map((v) => v.id)),
  };
}

// Valid FDI tooth numbers: permanent 11-18, 21-28, 31-38, 41-48; primary 51-55 ... 81-85.
const VALID_TEETH = new Set();
for (const q of [1, 2, 3, 4]) for (let t = 1; t <= 8; t++) VALID_TEETH.add(q * 10 + t);
for (const q of [5, 6, 7, 8]) for (let t = 1; t <= 5; t++) VALID_TEETH.add(q * 10 + t);

module.exports = { loadClinicConfig, validateSymbols, VALID_TEETH, SHAPES, FILLS };
