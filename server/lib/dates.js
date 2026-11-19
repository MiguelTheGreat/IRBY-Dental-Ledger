'use strict';
// Calendar-date helpers. Dates are stored as ISO "YYYY-MM-DD" strings in the
// clinic's local time zone (the server's time zone).

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n) { return String(n).padStart(2, '0'); }

function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayISO(now = new Date()) {
  return toISO(now);
}

function isValidISODate(s) {
  if (typeof s !== 'string') return false;
  const m = ISO.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

/** Whole years between date of birth and a reference date (FR-1 auto-calculated age). */
function ageOn(dobISO, onISO = todayISO()) {
  if (!isValidISODate(dobISO) || !isValidISODate(onISO)) return null;
  const [y1, m1, d1] = dobISO.split('-').map(Number);
  const [y2, m2, d2] = onISO.split('-').map(Number);
  let age = y2 - y1;
  if (m2 < m1 || (m2 === m1 && d2 < d1)) age -= 1;
  return age < 0 ? null : age;
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return toISO(new Date(y, m - 1, d + days));
}

function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function compactStamp(now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

module.exports = { todayISO, toISO, isValidISODate, ageOn, addDays, isValidTime, compactStamp };
