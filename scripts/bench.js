'use strict';
// Performance & accuracy checks for the SRS non-functional requirements, run on a
// throwaway database:  npm run bench  [-- --records 10000]
//   NFR-P1  registration save incl. 500 KB portrait  p95 <= 200 ms (10,000 records)
//   NFR-P2  search + sort p95 <= 300 ms; typo queries: intended patient in top 5 >= 95%
//   NFR-P5  ledger arithmetic matches a BigInt reference in 100% of 1,000 cases
//   NFR-P6  dashboard with 500 pending follow-ups builds in <= 2 s
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createApp } = require('../server/app');
const { parseAmount, evaluateEntry } = require('../server/lib/money');
const { todayISO, addDays } = require('../server/lib/dates');

const args = process.argv.slice(2);
const N = Number(args[args.indexOf('--records') + 1]) || 10000;

const FIRST = ['Mateo', 'Clara', 'Antonio', 'Katrina', 'Roberto', 'Isabel', 'Jose', 'Andrea', 'Miguel', 'Patricia', 'Rafael', 'Carmela', 'Gabriel',
  'Beatriz', 'Paolo', 'Kristine', 'Juan', 'Angelica', 'Marco', 'Liza', 'Emmanuel', 'Joy', 'Christian', 'Rowena', 'Leonardo', 'Ma. Teresa', 'Ramon', 'Jasmine'];
const LAST = ['Dela Cruz', 'Santos', 'Reyes', 'Garcia', 'Mendoza', 'Bautista', 'Villanueva', 'Ramos', 'Castillo', 'Aquino', 'Fernandez', 'Lopez',
  'Gonzales', 'Torres', 'Delos Santos', 'Navarro', 'Pascual', 'Soriano', 'Manalo', 'Salazar', 'Tolentino', 'Domingo', 'Mercado', 'Aguilar', 'Macaraeg', 'Dimaculangan'];
const MIDDLE = ['Lorenzo', 'Villanueva', 'Garcia', 'Mendoza', 'Pascual', 'Ramos', 'Aquino', 'Torres', 'Navarro', 'Cruz'];

let seed = 7;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };

function typo(word, edits) {
  let w = word.toLowerCase();
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let e = 0; e < edits; e++) {
    const i = 1 + Math.floor(rand() * Math.max(1, w.length - 2));
    const op = Math.floor(rand() * 4);
    if (op === 0) w = w.slice(0, i) + w.slice(i + 1);                                     // deletion
    else if (op === 1) w = w.slice(0, i) + pick(letters) + w.slice(i);                    // insertion
    else if (op === 2) w = w.slice(0, i) + pick(letters) + w.slice(i + 1);                // substitution
    else if (i < w.length - 1) w = w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);      // transposition
  }
  return w;
}

function row(name, value, target, ok) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${String(value).padStart(12)}   target ${target}`);
  return ok;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irby-bench-'));
  const { ctx, close } = createApp({ dataDir: dir, backupsEnabled: false });
  const s = ctx.services;
  const results = [];
  try {
    const admin = await s.auth.createUser({ username: 'bench', displayName: 'Bench', role: 'admin', password: 'perf-check-password-123' }, null);
    const actor = { ...admin, ip: 'bench' };
    const consent = { accepted: true, version: ctx.clinic.consent.version };
    const today = todayISO();
    console.log(`\nIRBY Dental Ledger benchmark — ${N.toLocaleString()} records, Node ${process.version}, ${os.cpus().length} CPU, ${os.platform()}\n`);

    const people = [];
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const y = 1950 + Math.floor(rand() * 70);
      const profile = { lastName: pick(LAST), firstName: pick(FIRST), middleName: pick(MIDDLE), dateOfBirth: `${y}-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`,
        sex: rand() < 0.5 ? 'Male' : 'Female', address: `${i} Rizal St., Quezon City`, contactNumber: '', allergies: '' };
      const p = s.patients.create({ profile, consent }, actor);
      people.push({ id: p.id, ...profile });
    }
    console.log(`  (setup) created ${N.toLocaleString()} encrypted patient records in ${((performance.now() - t0) / 1000).toFixed(1)} s\n`);

    // NFR-P1
    const saves = [];
    for (let i = 0; i < 100; i++) {
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(480 * 1024)]);
      const body = { profile: { lastName: pick(LAST), firstName: pick(FIRST), middleName: '', dateOfBirth: '1990-01-01', sex: 'Female', address: 'Bench', contactNumber: '', allergies: '' },
        consent, portrait: `data:image/jpeg;base64,${jpeg.toString('base64')}` };
      const a = performance.now();
      s.patients.create(body, actor);
      saves.push(performance.now() - a);
    }
    results.push(row('NFR-P1 registration save + 480 KB portrait p95', `${p95(saves).toFixed(1)} ms`, '<= 200 ms', p95(saves) <= 200));

    // NFR-P2 latency
    const lat = [];
    const sorts = ['', 'name', 'lastVisit', 'nextAppointment', 'balance'];
    for (let i = 0; i < 200; i++) {
      const who = pick(people);
      const a = performance.now();
      s.patients.search({ q: i % 4 === 0 ? '' : `${who.firstName} ${typo(who.lastName.replace(/\s/g, ''), 1)}`, sort: sorts[i % sorts.length], limit: 50 });
      lat.push(performance.now() - a);
    }
    results.push(row('NFR-P2 search + sort p95', `${p95(lat).toFixed(1)} ms`, '<= 300 ms', p95(lat) <= 300));

    // NFR-P2 accuracy: unique target (full name) with 1-2 typos
    let hits = 0;
    for (let i = 0; i < 200; i++) {
      const who = pick(people);
      const edits = 1 + (i % 2);
      const surname = who.lastName.split(' ').pop();
      const q = `${who.firstName} ${who.middleName} ${typo(surname, edits)}`;
      const r = s.patients.search({ q, limit: 5 });
      const exact = people.filter((p) => p.firstName === who.firstName && p.middleName === who.middleName && p.lastName === who.lastName).map((p) => p.id);
      if (r.items.some((it) => exact.includes(it.id))) hits++;
    }
    results.push(row('NFR-P2 typo queries with intended patient in top 5', `${(hits / 2).toFixed(1)} %`, '>= 95 %', hits / 200 >= 0.95));

    // NFR-P5 arithmetic
    let ok = 0;
    for (let i = 0; i < 1000; i++) {
      const fee = (Math.floor(rand() * 5_000_000) / 100).toFixed(2);
      const paid = (Math.floor(rand() * 5_000_000) / 100).toFixed(2);
      const f = parseAmount(fee), p = parseAmount(paid);
      const ref = BigInt(fee.replace('.', '')) - BigInt(paid.replace('.', ''));
      if (f.ok && p.ok && BigInt(evaluateEntry({ feeCents: f.cents, paidCents: p.cents }).entryBalanceCents) === ref) ok++;
    }
    const ex = evaluateEntry({ feeCents: parseAmount('2000').cents, paidCents: parseAmount('500').cents });
    results.push(row('NFR-P5 ledger arithmetic vs BigInt reference', `${ok}/1000`, '1000/1000', ok === 1000));
    results.push(row('FR-5 example: fee 2,000 - paid 500', `₱${(ex.entryBalanceCents / 100).toFixed(2)}`, '₱1500.00', ex.entryBalanceCents === 150000));

    // NFR-P6 dashboard with 500 pending follow-ups
    for (let i = 0; i < 500; i++) {
      const who = people[i];
      s.ledger.create(who.id, { visitDate: addDays(today, -30), procedure: 'Bench procedure', fee: '1000', paid: '500', nextReturn: { date: addDays(today, -(i % 20)), reason: 'Recall' } }, actor);
    }
    const a = performance.now();
    const dash = s.dashboard.build();
    const dashMs = performance.now() - a;
    results.push(row(`NFR-P6 dashboard build (${dash.followUps.length} follow-ups)`, `${dashMs.toFixed(1)} ms`, '<= 2000 ms', dashMs <= 2000 && dash.followUps.length >= 500));

    const passed = results.filter(Boolean).length;
    console.log(`\n  ${passed}/${results.length} checks passed. (Server-side timings; add network + browser time when measuring on the reference device.)\n`);
    process.exitCode = passed === results.length ? 0 : 1;
  } finally {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
