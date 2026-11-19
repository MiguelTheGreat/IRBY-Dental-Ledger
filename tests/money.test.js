'use strict';
// FR-5 / NFR-P5 / NFR-S4: integer-centavo ledger arithmetic.
// `npm run test:critical` requires 100% line/branch/function coverage of server/lib/money.js from this file.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, formatPeso, evaluateEntry, withRunningBalance, totals, MAX_CENTS } = require('../server/lib/money');

const err = (input) => parseAmount(input).error;
const cents = (input) => {
  const r = parseAmount(input);
  assert.equal(r.ok, true, `expected ${JSON.stringify(input)} to parse, got ${r.error}`);
  return r.cents;
};

describe('money: parseAmount', () => {
  it('FR-5: parses plain numbers and numeric strings into integer centavos', () => {
    assert.equal(cents(2000), 200000);
    assert.equal(cents(500), 50000);
    assert.equal(cents(0), 0);
    assert.equal(cents(12.34), 1234);
    assert.equal(cents('2000'), 200000);
    assert.equal(cents('0'), 0);
    assert.equal(cents('  750  '), 75000);
  });

  it('FR-5: accepts thousands separators, peso sign and PHP prefix', () => {
    assert.equal(cents('2,000.50'), 200050);
    assert.equal(cents('₱1,500'), 150000);
    assert.equal(cents('PHP 99.9'), 9990);
    assert.equal(cents('php99.99'), 9999);
    assert.equal(cents('₱ 1 000'), 100000);
  });

  it('FR-5: accepts a leading decimal point and pads one decimal place', () => {
    assert.equal(cents('.5'), 50);
    assert.equal(cents('.05'), 5);
    assert.equal(cents('1.5'), 150);
  });

  it('NFR-S4: empty input is REQUIRED', () => {
    assert.equal(err(null), 'REQUIRED');
    assert.equal(err(undefined), 'REQUIRED');
    assert.equal(err(''), 'REQUIRED');
    assert.equal(err('   '), 'REQUIRED');
    assert.equal(parseAmount(null).ok, false);
    assert.match(parseAmount(null).message, /required/i);
  });

  it('NFR-S4: non-finite and exponent numbers are NOT_NUMERIC', () => {
    assert.equal(err(Number.NaN), 'NOT_NUMERIC');
    assert.equal(err(Number.POSITIVE_INFINITY), 'NOT_NUMERIC');
    assert.equal(err(1e21), 'NOT_NUMERIC');
    assert.equal(err(1e-7), 'NOT_NUMERIC');
    assert.match(parseAmount(1e21).message, /plain number/);
  });

  it('NFR-S4: non-string, non-number types are NOT_NUMERIC', () => {
    assert.equal(err(true), 'NOT_NUMERIC');
    assert.equal(err({}), 'NOT_NUMERIC');
    assert.equal(err([100]), 'NOT_NUMERIC');
  });

  it('NFR-S4: negative amounts are rejected', () => {
    assert.equal(err(-5), 'NEGATIVE');
    assert.equal(err('-5'), 'NEGATIVE');
    assert.equal(err('₱-1,000'), 'NEGATIVE');
    assert.match(parseAmount(-1).message, /negative/);
  });

  it('NFR-S4: text, too many decimals and bare symbols are NOT_NUMERIC', () => {
    assert.equal(err('abc'), 'NOT_NUMERIC');
    assert.equal(err('12abc'), 'NOT_NUMERIC');
    assert.equal(err('1.234'), 'NOT_NUMERIC');
    assert.equal(err('1.2.3'), 'NOT_NUMERIC');
    assert.equal(err('.'), 'NOT_NUMERIC');
    assert.equal(err('5.'), 'NOT_NUMERIC');
    assert.equal(err('₱'), 'NOT_NUMERIC');
    assert.equal(err('PHP'), 'NOT_NUMERIC');
    // Floating-point noise must never be silently rounded into the ledger.
    assert.equal(err(0.1 + 0.2), 'NOT_NUMERIC');
  });

  it('NFR-S4: amounts above PHP 100,000,000.00 are TOO_LARGE', () => {
    assert.equal(MAX_CENTS, 10_000_000_000);
    assert.equal(cents('100000000'), MAX_CENTS);
    assert.equal(cents('100,000,000.00'), MAX_CENTS);
    assert.equal(err('100000000.01'), 'TOO_LARGE');
    assert.equal(err('99999999999999999999'), 'TOO_LARGE'); // not a safe integer
    assert.match(parseAmount('100000001').message, /too large/);
  });
});

describe('money: formatPeso', () => {
  it('formats centavos as pesos with separators', () => {
    assert.equal(formatPeso(150000), '₱1,500.00');
    assert.equal(formatPeso(0), '₱0.00');
    assert.equal(formatPeso(5), '₱0.05');
    assert.equal(formatPeso(123456789), '₱1,234,567.89');
  });

  it('formats negative balances (patient credit) with a leading minus', () => {
    assert.equal(formatPeso(-1050), '-₱10.50');
    assert.equal(formatPeso(-100000000), '-₱1,000,000.00');
  });
});

describe('money: evaluateEntry', () => {
  it('FR-5: fee 2000 - paid 500 = 1500', () => {
    const fee = parseAmount('2000');
    const paid = parseAmount(500);
    const ev = evaluateEntry({ feeCents: fee.cents, paidCents: paid.cents });
    assert.deepEqual(ev, { entryBalanceCents: 150000, balanceAfterCents: 150000, flags: [] });
  });

  it('FR-5: outstanding balance is carried into balanceAfterCents', () => {
    const ev = evaluateEntry({ feeCents: 120000, paidCents: 20000, outstandingBeforeCents: 50000 });
    assert.equal(ev.entryBalanceCents, 100000);
    assert.equal(ev.balanceAfterCents, 150000);
    assert.deepEqual(ev.flags, []);
  });

  it('NFR-S4: paying an old balance flags PAYMENT_EXCEEDS_FEE but not OVERPAYMENT', () => {
    const ev = evaluateEntry({ feeCents: 0, paidCents: 150000, outstandingBeforeCents: 150000 });
    assert.equal(ev.entryBalanceCents, -150000);
    assert.equal(ev.balanceAfterCents, 0);
    assert.deepEqual(ev.flags, ['PAYMENT_EXCEEDS_FEE']);
  });

  it('NFR-S4: paying beyond fee + outstanding flags OVERPAYMENT', () => {
    const ev = evaluateEntry({ feeCents: 100000, paidCents: 200000, outstandingBeforeCents: 50000 });
    assert.equal(ev.balanceAfterCents, -50000);
    assert.deepEqual(ev.flags, ['PAYMENT_EXCEEDS_FEE', 'OVERPAYMENT']);
  });

  it('NFR-S4: an existing credit plus an unpaid fee can still end in credit (OVERPAYMENT only)', () => {
    const ev = evaluateEntry({ feeCents: 10000, paidCents: 0, outstandingBeforeCents: -30000 });
    assert.equal(ev.balanceAfterCents, -20000);
    assert.deepEqual(ev.flags, ['OVERPAYMENT']);
  });
});

describe('money: withRunningBalance and totals', () => {
  const entries = [
    { id: 'c', visitDate: '2026-03-10', createdAt: 30, feeCents: 50000, paidCents: 50000 },
    { id: 'a', visitDate: '2026-01-05', createdAt: 10, feeCents: 200000, paidCents: 50000 },
    { id: 'b2', visitDate: '2026-02-01', createdAt: 25, feeCents: 0, paidCents: 100000 },
    { id: 'b1', visitDate: '2026-02-01', createdAt: 20, feeCents: 120000, paidCents: 0 },
    { id: 'd', visitDate: '2025-12-31', createdAt: 99, feeCents: 1000, paidCents: 1000 },
  ];

  it('FR-5: sorts chronologically (visit date, then creation time) and accumulates', () => {
    const out = withRunningBalance(entries);
    assert.deepEqual(out.map((e) => e.id), ['d', 'a', 'b1', 'b2', 'c']);
    assert.deepEqual(out.map((e) => e.entryBalanceCents), [0, 150000, 120000, -100000, 0]);
    assert.deepEqual(out.map((e) => e.runningBalanceCents), [0, 150000, 270000, 170000, 170000]);
  });

  it('does not mutate its input', () => {
    const copy = structuredClone(entries);
    withRunningBalance(entries);
    assert.deepEqual(entries, copy);
    assert.equal('runningBalanceCents' in entries[0], false);
  });

  it('handles an empty ledger', () => {
    assert.deepEqual(withRunningBalance([]), []);
    assert.deepEqual(totals([]), { feeCents: 0, paidCents: 0, balanceCents: 0 });
  });

  it('FR-5: totals sum fees, payments and balance', () => {
    assert.deepEqual(totals(entries), { feeCents: 371000, paidCents: 201000, balanceCents: 170000 });
    assert.deepEqual(totals([{ feeCents: 200000, paidCents: 50000 }]), { feeCents: 200000, paidCents: 50000, balanceCents: 150000 });
  });
});
