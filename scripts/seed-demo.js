'use strict';
// Loads demo accounts and sample patients so the app can be evaluated right away.
//   npm run seed:demo                 sample clinic data (refuses if accounts already exist)
//   npm run seed:demo -- --bulk 10000 also adds N synthetic patients (performance testing)
// Run it while the server is stopped (or restart the server afterwards).
// DEMO ONLY: change these passwords or delete the accounts before real clinic use.
const { createApp } = require('../server/app');
const { todayISO, addDays } = require('../server/lib/dates');
const { renderDemoArch, positionOf, WIDTH, HEIGHT } = require('./demo-image');

const DEMO_USERS = [
  { username: 'admin', displayName: 'Clinic Administrator', role: 'admin', password: 'Irby#Clinic-Root26' },
  { username: 'dr.bautista', displayName: 'Dr. Ana Bautista', role: 'dentist', password: 'Bautista#Dental26' },
  { username: 'm.santos', displayName: 'Maria Santos', role: 'frontdesk', password: 'Santos#FrontDesk26' },
];

const FIRST = ['Mateo', 'Clara', 'Antonio', 'Katrina', 'Roberto', 'Isabel', 'Jose', 'Andrea', 'Miguel', 'Patricia', 'Rafael', 'Carmela',
  'Gabriel', 'Bea', 'Paolo', 'Kristine', 'Juan', 'Angelica', 'Marco', 'Liza', 'Emmanuel', 'Joy', 'Christian', 'Rowena'];
const MIDDLE = ['Lorenzo', 'Villanueva', 'Garcia', 'Mendoza', 'Pascual', 'Ramos', 'Aquino', 'Torres', 'Navarro', 'Cruz', 'Bautista', 'Flores'];
const LAST = ['Dela Cruz', 'Santos', 'Reyes', 'Garcia', 'Mendoza', 'Bautista', 'Villanueva', 'Ramos', 'Castillo', 'Aquino', 'Fernandez',
  'Lopez', 'Gonzales', 'Torres', 'Delos Santos', 'Navarro', 'Pascual', 'Soriano', 'Manalo', 'Salazar', 'Tolentino', 'Domingo', 'Mercado', 'Aguilar'];
const CITIES = ['Makati City', 'Pasig City', 'Quezon City', 'Taguig City', 'Mandaluyong City', 'Bacoor, Cavite', 'Antipolo, Rizal', 'Marikina City'];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

async function main() {
  const args = process.argv.slice(2);
  const bulkIdx = args.indexOf('--bulk');
  const bulk = bulkIdx >= 0 ? Number(args[bulkIdx + 1]) || 0 : 0;
  const { ctx, close } = createApp({ backupsEnabled: false });
  const s = ctx.services;
  try {
    if (s.auth.countUsers() > 0 && !args.includes('--force')) {
      console.log('Accounts already exist - demo seed skipped (use --force to add demo data anyway).');
      return;
    }
    const users = {};
    for (const u of DEMO_USERS) {
      const existing = s.auth.listUsers().find((x) => x.username === u.username);
      users[u.role] = existing || await s.auth.createUser(u, null);
    }
    const desk = { ...users.frontdesk, ip: 'seed' };
    const doc = { ...users.dentist, ip: 'seed' };
    const consent = { accepted: true, version: ctx.clinic.consent.version };
    const today = todayISO();

    const samples = [
      { p: ['Dela Cruz', 'Mateo', 'Lorenzo', '1992-04-12', 'Male', 'Unit 14B, Salcedo Village, Makati City, Metro Manila', '+63 917 550 0192', 'Penicillin'], reg: addDays(today, -400),
        ledger: [[-390, 'Oral prophylaxis (cleaning)', 1200, 1200], [-200, '#26 Amalgam replacement', 1800, 1800], [-12, 'Tooth #16 (MO) composite restoration', 2000, 500]],
        next: [0, 'Tooth #16 composite check & prophylaxis', '10:30'] },
      { p: ['Santos', 'Clara', 'Villanueva', '1997-03-03', 'Female', '22 Mabini St., Brgy. San Antonio, Pasig City', '0918 221 8840', 'None'], reg: addDays(today, -300),
        ledger: [[-21, 'Root canal treatment (molar) #36 - stage 1', 12000, 9600]], next: [-6, 'Tooth #36 root canal obturation review', '14:00'] },
      { p: ['Reyes', 'Antonio', 'Garcia', '1980-07-21', 'Male', 'Blk 5 Lot 9, Camella Homes, Bacoor, Cavite', '0998-412-3309', 'Latex; hypertension'], reg: addDays(today, -150),
        ledger: [[-7, 'Surgical extraction #48', 8000, 8000]], next: [0, 'Post-extraction suture removal (#48)', '15:30'] },
      { p: ['Dela Cruz', 'Katrina', 'Mendoza', '1999-11-30', 'Female', '88 Kalayaan Ave., Quezon City', '0927 111 2040', ''], reg: addDays(today, -90),
        ledger: [[-80, 'Consultation & oral examination', 500, 500]], next: [3, '6-month recall & cleaning', '09:00'] },
      { p: ['Delacruz', 'Roberto', 'Pascual', '1974-01-15', 'Male', '15 Sampaguita St., Marikina City', '0917 845 6612', 'Diabetic (type 2)'], reg: addDays(today, -500),
        ledger: [[-120, 'Removable partial denture', 9000, 5800]], next: [6, 'Denture adjustment', null] },
      { p: ['Villanueva', 'Isabel', 'Ramos', '2016-05-09', 'Female', '3 Acacia Lane, Taguig City', '0919 330 7788', ''], reg: addDays(today, -60),
        ledger: [[-55, 'Pit and fissure sealant (per tooth) x4', 3200, 3200]], next: null },
    ];
    let created = 0;
    for (const smp of samples) {
      const [lastName, firstName, middleName, dateOfBirth, sex, address, contactNumber, allergies] = smp.p;
      const pat = s.patients.create({ profile: { lastName, firstName, middleName, dateOfBirth, sex, address, contactNumber, allergies }, registrationDate: smp.reg, consent }, desk);
      created++;
      smp.ledger.forEach(([d, procedure, fee, paid], i) => {
        const visitDate = addDays(today, d);
        const last = i === smp.ledger.length - 1;
        const nextReturn = last && smp.next ? { date: addDays(today, smp.next[0]), reason: smp.next[1], time: smp.next[2] || '' } : null;
        s.ledger.create(pat.id, { visitDate, procedure, fee: String(fee), paid: String(paid), nextReturn }, i % 2 ? doc : desk);
      });
      if (smp.p[0] === 'Dela Cruz' && smp.p[1] === 'Mateo') {
        const photo = s.chart.addPhoto(pat.id, { buffer: renderDemoArch(), view: 'upper-occlusal', label: 'Demo illustration (replace with a real intraoral photo)', takenOn: addDays(today, -12), width: WIDTH, height: HEIGHT }, doc);
        const marks = [[16, ['M', 'O'], 'Co'], [26, ['O'], 'Am'], [14, ['D'], 'D'], [18, [], 'M'], [21, [], 'JC'], [24, ['O'], 'S']];
        for (const [tooth, surfaces, condition] of marks) {
          s.chart.addMark(pat.id, { tooth, surfaces, condition, photoId: photo.id, ...positionOf(tooth) }, doc);
        }
        s.chart.addMark(pat.id, { tooth: 36, surfaces: ['O'], condition: 'D', note: 'Seen on bitewing; lower photo pending' }, doc);
      }
    }
    if (bulk > 0) {
      const r = rng(42);
      const pick = (a) => a[Math.floor(r() * a.length)];
      for (let i = 0; i < bulk; i++) {
        const y = 1950 + Math.floor(r() * 70), m = 1 + Math.floor(r() * 12), d = 1 + Math.floor(r() * 28);
        s.patients.create({ profile: {
          lastName: pick(LAST), firstName: pick(FIRST), middleName: pick(MIDDLE), dateOfBirth: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
          sex: r() < 0.5 ? 'Male' : 'Female', address: `${1 + Math.floor(r() * 300)} ${pick(LAST)} St., ${pick(CITIES)}`, contactNumber: `09${Math.floor(100000000 + r() * 899999999)}`, allergies: r() < 0.1 ? 'Penicillin' : '',
        }, registrationDate: addDays(today, -Math.floor(r() * 900)), consent }, desk);
        created++;
        if ((i + 1) % 1000 === 0) console.log(`  ... ${i + 1} synthetic patients`);
      }
    }
    console.log(`Seeded ${created} patients and ${DEMO_USERS.length} demo accounts:`);
    for (const u of DEMO_USERS) console.log(`  ${u.role.padEnd(9)} ${u.username.padEnd(12)} ${u.password}`);
    console.log('DEMO ONLY - change these passwords or deactivate the accounts before real use.');
  } finally {
    close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { DEMO_USERS };
