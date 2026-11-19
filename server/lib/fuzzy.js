'use strict';
// FR-2 / NFR-P2: typo-tolerant patient search (up to 2 character errors).
// Uses optimal-string-alignment distance (Levenshtein + adjacent transposition).

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  const n = normalize(text);
  return n ? n.split(' ') : [];
}

/** Bounded OSA distance; returns max + 1 as soon as the bound is exceeded. */
function distance(a, b, max = Infinity) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prevPrev = new Array(lb + 1).fill(0);
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = prev[j] + 1;
      if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
      if (prev[j - 1] + cost < v) v = prev[j - 1] + cost;
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] && prevPrev[j - 2] + 1 < v) {
        v = prevPrev[j - 2] + 1;
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prevPrev; prevPrev = prev; prev = cur; cur = t;
  }
  return prev[lb];
}

/** Allowed typos for a query token of a given length. */
function allowedErrors(len) {
  if (len <= 2) return 0;
  if (len === 3) return 1;
  return 2;
}

/** Build the searchable form of a name once (cached per patient). */
function buildIndex(name) {
  const tokens = tokenize(name);
  const terms = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) {
    terms.push(tokens[i] + tokens[i + 1]); // "dela cruz" also indexed as "delacruz"
    if (i < tokens.length - 2) terms.push(tokens[i] + tokens[i + 1] + tokens[i + 2]);
  }
  return { tokens, terms: [...new Set(terms)] };
}

/** Cost of matching one query token against the indexed terms (Infinity = no match). */
function tokenCost(q, terms) {
  const max = allowedErrors(q.length);
  let best = Infinity;
  for (const t of terms) {
    if (t === q) return 0;
    if (t.startsWith(q)) { best = Math.min(best, 0.1); continue; }
    if (max === 0) continue;
    const d = distance(q, t, max);
    if (d <= max && d < best) best = d;
    if (t.length > q.length) {
      // Typo inside a partially typed name ("mtae" -> "mateo")
      const dp = distance(q, t.slice(0, q.length), max) + 0.2;
      if (dp <= max + 0.2 && dp < best) best = dp;
    }
  }
  return best;
}

/**
 * Score an index against a query. Lower is better; null means "no match".
 * Total integer errors across tokens may not exceed 2.
 */
function score(query, index) {
  const qTokens = tokenize(query);
  if (!qTokens.length) return 0;
  let total = 0;
  for (const q of qTokens) {
    const c = tokenCost(q, index.terms);
    if (!Number.isFinite(c)) {
      // Last chance: the user typed a compound without spaces, or with an extra space
      const compact = qTokens.join('');
      const cc = tokenCost(compact, index.terms);
      return Number.isFinite(cc) && Math.floor(cc) <= 2 ? cc + 0.05 : null;
    }
    total += c;
  }
  return Math.floor(total) <= 2 ? total : null;
}

module.exports = { normalize, tokenize, distance, allowedErrors, buildIndex, tokenCost, score };
