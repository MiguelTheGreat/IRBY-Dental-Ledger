'use strict';
// FR-5 / NFR-P5 / NFR-S4: all ledger arithmetic uses integer centavos.
// This module must keep 100% test coverage (see `npm run test:critical`).

const MAX_CENTS = 10_000_000_000; // PHP 100,000,000.00 upper bound per amount

/**
 * Parse a peso amount into integer centavos.
 * Accepts numbers or strings such as "2000", "2,000.50", "₱1,500", "PHP 99.9".
 * Rejects empty, non-numeric, negative, more than 2 decimals and absurd values.
 */
function parseAmount(input) {
  if (input === null || input === undefined || (typeof input === 'string' && input.trim() === '')) {
    return { ok: false, error: 'REQUIRED', message: 'Amount is required.' };
  }
  let text;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, error: 'NOT_NUMERIC', message: 'Amount must be a number.' };
    text = String(input);
    if (/e/i.test(text)) return { ok: false, error: 'NOT_NUMERIC', message: 'Amount must be a plain number.' };
  } else if (typeof input === 'string') {
    text = input.trim().replace(/^(₱|php)\s*/i, '').replace(/[,\s]/g, '');
  } else {
    return { ok: false, error: 'NOT_NUMERIC', message: 'Amount must be a number.' };
  }
  if (text.startsWith('-')) return { ok: false, error: 'NEGATIVE', message: 'Amount cannot be negative.' };
  const m = /^(\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m || (m[1] === '' && m[2] === undefined)) {
    return { ok: false, error: 'NOT_NUMERIC', message: 'Amount must be a number with at most 2 decimal places.' };
  }
  const whole = m[1] === '' ? 0 : Number(m[1]);
  const frac = m[2] === undefined ? 0 : Number(m[2].padEnd(2, '0'));
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) {
    return { ok: false, error: 'TOO_LARGE', message: 'Amount is too large.' };
  }
  return { ok: true, cents };
}

function formatPeso(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}₱${whole}.${frac}`;
}

/**
 * Evaluate one ledger entry against the patient's outstanding balance.
 * - entryBalanceCents: fee - paid for this entry (can be negative when paying old balances)
 * - balanceAfterCents: patient's running balance after this entry
 * - flags: PAYMENT_EXCEEDS_FEE (paid > fee), OVERPAYMENT (patient would end up in credit)
 */
function evaluateEntry({ feeCents, paidCents, outstandingBeforeCents = 0 }) {
  const entryBalanceCents = feeCents - paidCents;
  const balanceAfterCents = outstandingBeforeCents + entryBalanceCents;
  const flags = [];
  if (paidCents > feeCents) flags.push('PAYMENT_EXCEEDS_FEE');
  if (balanceAfterCents < 0) flags.push('OVERPAYMENT');
  return { entryBalanceCents, balanceAfterCents, flags };
}

/** Chronological running balance. Entries need visitDate, createdAt, feeCents, paidCents. */
function withRunningBalance(entries) {
  const sorted = [...entries].sort((a, b) =>
    a.visitDate === b.visitDate ? a.createdAt - b.createdAt : (a.visitDate < b.visitDate ? -1 : 1));
  let running = 0;
  return sorted.map((e) => {
    running += e.feeCents - e.paidCents;
    return { ...e, entryBalanceCents: e.feeCents - e.paidCents, runningBalanceCents: running };
  });
}

function totals(entries) {
  let fee = 0, paid = 0;
  for (const e of entries) { fee += e.feeCents; paid += e.paidCents; }
  return { feeCents: fee, paidCents: paid, balanceCents: fee - paid };
}

module.exports = { parseAmount, formatPeso, evaluateEntry, withRunningBalance, totals, MAX_CENTS };
