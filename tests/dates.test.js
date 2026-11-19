'use strict';
// Calendar-date helpers used by FR-1 (age), FR-5 (visit dates), FR-6 (return dates), TC-01 (backup names).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { todayISO, toISO, isValidISODate, ageOn, addDays, isValidTime, compactStamp } = require('../server/lib/dates');

describe('dates', () => {
  it('formats local dates as YYYY-MM-DD', () => {
    assert.equal(toISO(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(todayISO(new Date(2026, 10, 2, 23, 59)), '2026-11-02');
    assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(todayISO(), toISO(new Date()));
  });

  it('validates ISO dates including leap years', () => {
    assert.equal(isValidISODate('2026-11-02'), true);
    assert.equal(isValidISODate('2024-02-29'), true);
    assert.equal(isValidISODate('2026-02-29'), false);
    assert.equal(isValidISODate('2026-04-31'), false);
    assert.equal(isValidISODate('2026-13-01'), false);
    assert.equal(isValidISODate('2026-00-10'), false);
    assert.equal(isValidISODate('2026-01-00'), false);
    assert.equal(isValidISODate('1899-12-31'), false);
    assert.equal(isValidISODate('2201-01-01'), false);
    assert.equal(isValidISODate('2026-1-5'), false);
    assert.equal(isValidISODate('02/11/2026'), false);
    assert.equal(isValidISODate(20261102), false);
    assert.equal(isValidISODate(null), false);
  });

  it('FR-1: computes age in whole years', () => {
    assert.equal(ageOn('1992-04-12', '2026-04-11'), 33);
    assert.equal(ageOn('1992-04-12', '2026-04-12'), 34);
    assert.equal(ageOn('1992-04-12', '2026-11-02'), 34);
    assert.equal(ageOn('1992-12-31', '2026-01-01'), 33);
    assert.equal(ageOn('2026-11-02', '2026-11-02'), 0);
    assert.equal(ageOn('2024-02-29', '2025-02-28'), 0);
    assert.equal(ageOn('2024-02-29', '2025-03-01'), 1);
  });

  it('FR-1: age is null for invalid or future dates of birth', () => {
    assert.equal(ageOn('not-a-date', '2026-01-01'), null);
    assert.equal(ageOn('1990-01-01', 'bad'), null);
    assert.equal(ageOn('2030-01-01', '2026-01-01'), null);
    assert.equal(typeof ageOn('1990-01-01'), 'number'); // default reference date = today
  });

  it('adds days across month and year boundaries', () => {
    assert.equal(addDays('2026-11-02', 7), '2026-11-09');
    assert.equal(addDays('2026-12-30', 3), '2027-01-02');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2024-03-01', -1), '2024-02-29');
    assert.equal(addDays('2026-11-02', 0), '2026-11-02');
  });

  it('FR-6: validates 24-hour HH:MM times', () => {
    for (const t of ['00:00', '09:30', '14:30', '23:59']) assert.equal(isValidTime(t), true, t);
    for (const t of ['24:00', '9:30', '12:60', '12:5', '2pm', '', null, 930]) assert.equal(isValidTime(t), false, String(t));
  });

  it('TC-01: compact stamp for backup file names', () => {
    assert.equal(compactStamp(new Date(2026, 10, 2)), '20261102');
    assert.equal(compactStamp(new Date(2027, 0, 9)), '20270109');
    assert.match(compactStamp(), /^\d{8}$/);
  });
});
