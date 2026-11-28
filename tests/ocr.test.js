'use strict';
// FR-8 OCR document scanner: parser + every provider adapter (mock, http, command, module).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../server/config');
const { createOcr, OcrError } = require('../server/ocr');
const { parseRegistrationText, normalizeResult, parseDate, parseSex, splitFullName, FORM_FIELDS } = require('../server/ocr/parser');
const { splitArgs } = require('../server/ocr/providers/command');
const { tmpDir, rmDir, PNG, JPEG } = require('./helpers');

const thisYear = new Date().getFullYear();

/** OCR config shaped like loadConfig().ocr, with overrides. */
function ocrConfig(over = {}) {
  return { ...loadConfig({ env: { OCR_PROVIDER: 'mock' } }).ocr, mockDelayMs: 0, timeoutMs: 3000, ...over };
}

async function rejectsWith(promise, code, status) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof OcrError, `expected OcrError, got ${err && err.constructor.name}: ${err && err.message}`);
    assert.equal(err.code, code);
    if (status) assert.equal(err.status, status);
    return true;
  });
}

describe('OCR parser: parseDate', () => {
  it('FR-8: ISO and slash/dot/dash numeric dates (month first)', () => {
    assert.equal(parseDate('1980-07-21'), '1980-07-21');
    assert.equal(parseDate('1980/7/1'), '1980-07-01');
    assert.equal(parseDate('04/12/1992'), '1992-04-12');
    assert.equal(parseDate('4.12.1992'), '1992-04-12');
    assert.equal(parseDate('04-12-1992'), '1992-04-12');
    assert.equal(parseDate('04 12 1992'), '1992-04-12');
  });

  it('FR-8: swaps to day-first when the first number cannot be a month', () => {
    assert.equal(parseDate('25/12/1990'), '1990-12-25');
    assert.equal(parseDate('13/13/1990'), null);
  });

  it('FR-8: two-digit years pivot on the current year', () => {
    assert.equal(parseDate('04/12/92'), '1992-04-12');
    assert.equal(parseDate('04/12/05'), '2005-04-12');
    const next = String((thisYear + 1) % 100).padStart(2, '0');
    assert.equal(parseDate(`01/01/${next}`), `19${next}-01-01`);
  });

  it('FR-8: English and Filipino month names, with ordinals', () => {
    assert.equal(parseDate('March 3, 1997'), '1997-03-03');
    assert.equal(parseDate('Sept. 9 2001'), '2001-09-09');
    assert.equal(parseDate('March 3rd, 1997'), '1997-03-03');
    assert.equal(parseDate('Hunyo 12, 1998'), '1998-06-12');
    assert.equal(parseDate('12 Disyembre 1985'), '1985-12-12');
    assert.equal(parseDate('21st of nothing'), null);
    assert.equal(parseDate('Smarch 3, 1997'), null);
    assert.equal(parseDate('3 Smarch 1997'), null);
  });

  it('FR-8: rejects impossible and unreadable dates', () => {
    assert.equal(parseDate('02/30/2000'), null);
    assert.equal(parseDate('2001-02-29'), null);
    assert.equal(parseDate('soon'), null);
    assert.equal(parseDate(''), null);
    assert.equal(parseDate(null), null);
  });
});

describe('OCR parser: parseSex and splitFullName', () => {
  it('FR-8: reads sex values, Filipino words and ticked boxes', () => {
    assert.equal(parseSex('M'), 'Male');
    assert.equal(parseSex('male'), 'Male');
    assert.equal(parseSex('Lalaki'), 'Male');
    assert.equal(parseSex('F'), 'Female');
    assert.equal(parseSex('FEMALE'), 'Female');
    assert.equal(parseSex('babae'), 'Female');
    assert.equal(parseSex('[x] Male [ ] Female'), 'Male');
    assert.equal(parseSex('[ ] Male [x] Female'), 'Female');
    assert.equal(parseSex('( ✓ ) F'), 'Female');
    assert.equal(parseSex('non-binary'), 'Other');
    assert.equal(parseSex(''), '');
    assert.equal(parseSex(null), '');
  });

  it('FR-8: splits "Last, First Middle" names', () => {
    assert.deepEqual(splitFullName('Santos, Clara Villanueva'), { lastName: 'Santos', firstName: 'Clara', middleName: 'Villanueva' });
    assert.deepEqual(splitFullName('Reyes, Antonio G.'), { lastName: 'Reyes', firstName: 'Antonio', middleName: 'G' });
    assert.deepEqual(splitFullName('Reyes, Antonio'), { lastName: 'Reyes', firstName: 'Antonio' });
    assert.deepEqual(splitFullName('Reyes,'), { lastName: 'Reyes', firstName: '' });
  });

  it('FR-8: keeps Filipino surname particles together', () => {
    assert.deepEqual(splitFullName('Mateo Lorenzo Dela Cruz'), { firstName: 'Mateo', middleName: 'Lorenzo', lastName: 'Dela Cruz' });
    assert.deepEqual(splitFullName('Juan de la Cruz'), { firstName: 'Juan', lastName: 'de la Cruz' });
    assert.deepEqual(splitFullName('Ana Maria  Santos   Delos Reyes'), { firstName: 'Ana Maria', middleName: 'Santos', lastName: 'Delos Reyes' });
    assert.deepEqual(splitFullName('Pedro San Jose'), { firstName: 'Pedro', lastName: 'San Jose' });
    assert.deepEqual(splitFullName('Liza De'), { firstName: 'Liza', lastName: 'De' }); // trailing particle stays a word
  });

  it('FR-8: single names and empty input', () => {
    assert.deepEqual(splitFullName('Cher'), { firstName: 'Cher' });
    assert.deepEqual(splitFullName('Grace Lim'), { firstName: 'Grace', lastName: 'Lim' });
    assert.deepEqual(splitFullName(''), {});
    assert.deepEqual(splitFullName(null), {});
  });
});

describe('OCR parser: parseRegistrationText and normalizeResult', () => {
  it('FR-8: extracts several label/value pairs per line', () => {
    const out = parseRegistrationText('Last Name: DELA CRUZ    First Name: Mateo    Middle Name: Lorenzo\nDate of Birth: 04/12/1992   Sex: [x] Male [ ] Female');
    assert.equal(out.lastName, 'DELA CRUZ');
    assert.equal(out.firstName, 'Mateo');
    assert.equal(out.middleName, 'Lorenzo');
    assert.equal(out.dateOfBirth, '04/12/1992');
    assert.equal(out.sex, '[x] Male [ ] Female');
  });

  it('FR-8: reads a value printed on the line after its label', () => {
    const out = parseRegistrationText('Surname:\n\n  Bautista  \nAllergies\nNone\nAddress:\nSex:\nContact No: 0917 000 1111');
    assert.equal(out.lastName, 'Bautista');
    assert.equal(out.allergies, 'None');
    assert.equal(out.address, undefined); // next line is another label-only line
    assert.equal(out.contactNumber, '0917 000 1111');
  });

  it('FR-8: a blank label does not swallow the next labelled line', () => {
    const out = parseRegistrationText('Address:\nContact No: 0917 000 1111');
    assert.equal(out.contactNumber, '0917 000 1111');
    assert.equal(out.address, undefined);
  });

  it('FR-8: the first value for a field wins; blank values are ignored', () => {
    const out = parseRegistrationText('Sex: F\nGender: M\nAddress: ___\r\nAddress: 3 Acacia Lane');
    assert.equal(out.sex, 'F');
    assert.equal(out.address, '3 Acacia Lane');
    assert.deepEqual(parseRegistrationText(''), {});
    assert.deepEqual(parseRegistrationText(null), {});
  });

  it('FR-8: normalizes raw form text into registration fields', () => {
    const r = normalizeResult(`Name: SANTOS, CLARA VILLANUEVA
Birthdate: March 3, 1997
Gender: Female
Home Address: 22 Mabini St., Brgy. San Antonio, Pasig City
Mobile Number: 0918 221 8840
Allergies: None
Date of registration: 2026-01-15`);
    assert.deepEqual(r.fields, {
      lastName: 'Santos', firstName: 'Clara', middleName: 'Villanueva', dateOfBirth: '1997-03-03', sex: 'Female',
      address: '22 Mabini St., Brgy. San Antonio, Pasig City', contactNumber: '0918 221 8840', allergies: 'None', registrationDate: '2026-01-15',
    });
    assert.deepEqual(r.confidence, {});
    assert.match(r.text, /^Name:/);
  });

  it('FR-8: model fields (aliases, {value, confidence}) override parsed text', () => {
    const r = normalizeResult({
      text: 'Last Name: Wrong\nSex: F',
      fields: { last_name: { value: 'REYES', confidence: 0.97 }, given_name: 'antonio', middle_initial: 'G.', dob: '1980-07-21',
        gender: { value: 'M' }, phone: '0998-412-3309', medical_alerts: 'Latex', date_registered: 'not a date' },
      confidence: { given_name: 88, sex: 0.5 },
    });
    assert.equal(r.fields.lastName, 'Reyes');
    assert.equal(r.fields.firstName, 'antonio'); // not all-caps: left as typed
    assert.equal(r.fields.middleName, 'G');
    assert.equal(r.fields.dateOfBirth, '1980-07-21');
    assert.equal(r.fields.sex, 'Male');
    assert.equal(r.fields.contactNumber, '0998-412-3309');
    assert.equal(r.fields.allergies, 'Latex');
    assert.equal('registrationDate' in r.fields, false); // unparseable date dropped
    assert.equal(r.confidence.lastName, 0.97);
    assert.equal(r.confidence.firstName, 0.88); // percentages scaled to 0..1
    assert.equal(r.confidence.sex, 0.5);
  });

  it('FR-8: a full name fills missing name parts; overall confidence applies to every field', () => {
    const r = normalizeResult({ fields: { full_name: 'Mateo Lorenzo Dela Cruz', lastName: 'DELA CRUZ' }, confidence: 0.9 });
    assert.deepEqual(r.fields, { lastName: 'Dela Cruz', firstName: 'Mateo', middleName: 'Lorenzo' });
    assert.deepEqual(r.confidence, { lastName: 0.9, firstName: 0.9, middleName: 0.9 });
    assert.equal(r.text, '');
  });

  it('FR-8: accepts line arrays and top-level fields; tolerates empty output', () => {
    const r = normalizeResult({ lines: ['First Name: Grace', { text: 'Last Name: Lim' }, { box: [1, 2] }], sex: 'f', confidence: 140 });
    assert.equal(r.fields.firstName, 'Grace');
    assert.equal(r.fields.lastName, 'Lim');
    assert.equal(r.fields.sex, 'Female');
    assert.equal(r.confidence.sex, 1); // clamped
    assert.deepEqual(normalizeResult(null), { fields: {}, confidence: {}, text: '' });
    assert.deepEqual(normalizeResult({ fields: 'garbage' }).fields, {});
    assert.deepEqual(FORM_FIELDS, ['lastName', 'firstName', 'middleName', 'dateOfBirth', 'sex', 'address', 'contactNumber', 'allergies', 'registrationDate']);
  });

  it('FR-8: fieldsComplete stops printed labels of a blank form being parsed as values', () => {
    const text = 'Name:  Birthdate (mm/dd/yy):\nLast  First  Middle\nReligion:  Nationality:  Home No.:';
    const legacy = normalizeResult({ text });
    assert.ok(Object.keys(legacy.fields).length > 0); // the old text parser guesses from labels
    const model = normalizeResult({ text, fields: {}, fieldsComplete: true });
    assert.deepEqual(model.fields, {});
  });

  it('FR-8: keeps the model review list, only for fields that were returned', () => {
    const r = normalizeResult({
      fields: { email: 'maria.reyes@gmail.com', sex: 'F' },
      confidence: { email: 0.66, sex: 0.75 },
      review: ['email', 'sex', 'dateOfBirth', 42],
      fieldsComplete: true,
    });
    assert.deepEqual(r.review, ['email', 'sex']);
    assert.equal(r.fields.sex, 'Female');
    assert.equal(normalizeResult({ fields: { sex: 'M' } }).review, undefined);
  });
});

describe('OCR adapter: createOcr + mock provider', () => {
  it('FR-8: rejects unknown providers', () => {
    assert.throws(() => createOcr(ocrConfig({ provider: 'tesseract9000' }), process.cwd()), /Unknown OCR_PROVIDER "tesseract9000"/);
  });

  it('FR-8: mock status is ready and cached', async () => {
    const ocr = createOcr(ocrConfig(), process.cwd());
    assert.equal(ocr.name, 'mock');
    assert.match(ocr.description, /demo/i);
    const s1 = await ocr.status();
    assert.equal(s1.ready, true);
    assert.equal(s1.demo, true);
    assert.equal(s1.provider, 'mock');
    assert.equal(await ocr.status(), s1);
  });

  it('FR-8: mock scans cycle through the sample forms', async () => {
    const ocr = createOcr(ocrConfig(), process.cwd());
    const a = await ocr.scan(PNG, 'image/png');
    assert.equal(a.provider, 'mock');
    assert.equal(typeof a.tookMs, 'number');
    assert.deepEqual({ ...a.fields, registrationDate: undefined }, {
      lastName: 'Dela Cruz', firstName: 'Mateo', middleName: 'Lorenzo', dateOfBirth: '1992-04-12', sex: 'Male',
      address: 'Unit 14B, Salcedo Village, Makati City, Metro Manila', contactNumber: '+63 917 550 0192', allergies: 'Penicillin',
      registrationDate: undefined,
    });
    assert.match(a.fields.registrationDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(a.confidence.lastName, 0.9);

    const b = await ocr.scan(JPEG, 'image/jpeg');
    assert.equal(b.fields.lastName, 'Santos');
    assert.equal(b.fields.firstName, 'Clara');
    assert.equal(b.fields.dateOfBirth, '1997-03-03');

    const c = await ocr.scan(JPEG, 'image/jpeg');
    assert.equal(c.fields.lastName, 'Reyes');
    assert.equal(c.fields.middleName, 'G');
    assert.equal(c.fields.sex, 'Male');
    assert.equal(c.fields.allergies, 'Latex allergy; hypertension');

    assert.equal((await ocr.scan(PNG, 'image/png')).fields.lastName, 'Dela Cruz'); // wraps around
  });
});

describe('OCR adapter: http provider', () => {
  let server, base, deadPort;
  const seen = [];
  before(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        seen.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], bytes: body.length });
        const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        switch (req.url) {
          case '/health': return json(200, { ready: true, detail: 'model loaded' });
          case '/predict': return json(200, { fields: { last_name: 'BAUTISTA', first_name: 'ANA', dob: '01/02/1990', gender: 'F' }, confidence: { last_name: 98 } });
          case '/text': res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Last Name: Lim\nFirst Name: Grace');
          case '/fail': res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('model crashed');
          case '/fail-empty': res.writeHead(503); return res.end();
          case '/sick/health': return json(503, { ready: false });
          case '/slow': return undefined; // never answers
          default: res.writeHead(404); return res.end();
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    const tmp = http.createServer();
    await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
    deadPort = tmp.address().port;
    await new Promise((r) => tmp.close(r));
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const make = (over) => createOcr(ocrConfig({ provider: 'http', httpHealthUrl: '', httpAuth: '', ...over }), process.cwd());

  it('FR-8: health check and scan against a model server (auth header passed through)', async () => {
    const ocr = make({ httpUrl: `${base}/predict`, httpAuth: 'Bearer test-token' });
    assert.match(ocr.description, /Model server at/);
    const st = await ocr.status();
    assert.equal(st.ready, true);
    assert.equal(st.detail, 'model loaded');
    const r = await ocr.scan(PNG, 'image/png');
    assert.deepEqual(r.fields, { lastName: 'Bautista', firstName: 'Ana', dateOfBirth: '1990-01-02', sex: 'Female' });
    assert.equal(r.confidence.lastName, 0.98);
    assert.equal(r.provider, 'http');
    const call = seen.find((s) => s.url === '/predict');
    assert.equal(call.auth, 'Bearer test-token');
    assert.equal(call.type, 'image/png');
    assert.equal(call.bytes, PNG.length);
  });

  it('FR-8: plain-text responses are parsed as form text', async () => {
    const ocr = make({ httpUrl: `${base}/text`, httpHealthUrl: `${base}/text` });
    const st = await ocr.status(); // non-JSON health body still counts as ready when HTTP 200
    assert.equal(st.ready, true);
    assert.match(st.detail, /Health check 200/);
    const r = await ocr.scan(JPEG, 'image/jpeg');
    assert.deepEqual(r.fields, { lastName: 'Lim', firstName: 'Grace' });
  });

  it('FR-8: server errors become OCR_FAILED (502)', async () => {
    await rejectsWith(make({ httpUrl: `${base}/fail` }).scan(PNG, 'image/png'), 'OCR_FAILED', 502);
    await assert.rejects(make({ httpUrl: `${base}/fail` }).scan(PNG, 'image/png'), /returned 500: model crashed/);
    await assert.rejects(make({ httpUrl: `${base}/fail-empty` }).scan(PNG, 'image/png'), /returned 503$/);
  });

  it('FR-8: unhealthy and unreachable servers report not ready', async () => {
    const sick = await make({ httpUrl: `${base}/predict`, httpHealthUrl: `${base}/sick/health` }).status();
    assert.equal(sick.ready, false);
    const dead = make({ httpUrl: `http://127.0.0.1:${deadPort}/predict` });
    const st = await dead.status();
    assert.equal(st.ready, false);
    assert.match(st.detail, /not reachable/);
    await rejectsWith(dead.scan(PNG, 'image/png'), 'OCR_UNAVAILABLE', 502);
  });

  it('NFR-P7: a server that never answers times out', async () => {
    await assert.rejects(make({ httpUrl: `${base}/slow`, timeoutMs: 150 }).scan(PNG, 'image/png'), (err) => {
      assert.ok(err instanceof OcrError);
      assert.ok(['OCR_TIMEOUT', 'OCR_UNAVAILABLE'].includes(err.code), err.code);
      return true;
    });
  });
});

describe('OCR adapter: command provider', () => {
  let dir, script, seenLog;
  const node = `"${process.execPath}"`;
  before(() => {
    dir = tmpDir('irby-ocr-cmd-');
    script = path.join(dir, 'fake-model.js');
    seenLog = path.join(dir, 'seen.log');
    fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--health')) {
  if (args[0] === 'sick') { console.log(JSON.stringify({ ready: false, detail: 'weights missing' })); process.exit(0); }
  console.log(JSON.stringify({ ready: true })); process.exit(0);
}
const mode = args[0];
const file = args[args.length - 1];
fs.appendFileSync(path.join(__dirname, 'seen.log'), file + '|' + fs.readFileSync(file).length + '\\n');
if (mode === 'fail') { console.error('model exploded'); process.exit(3); }
if (mode === 'nojson') { console.log('hello there'); process.exit(0); }
if (mode === 'noisy') { console.log('loading weights...'); console.log(JSON.stringify({ text: 'Last Name: Garcia\\nFirst Name: Paolo' })); process.exit(0); }
console.log(JSON.stringify({ fields: { lastName: 'TAN', firstName: 'WEI', sex: 'male' }, confidence: 0.8 }));
`);
  });
  after(() => rmDir(dir));

  // Commands run with cwd = root. Keep it outside `dir` so Windows can delete `dir` afterwards.
  const make = (command, over) => createOcr(ocrConfig({ provider: 'command', command, ...over }), os.tmpdir());
  const lastSeen = () => fs.readFileSync(seenLog, 'utf8').trim().split('\n').pop().split('|');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('splits quoted command lines', () => {
    assert.deepEqual(splitArgs(`"C:\\Program Files\\nodejs\\node.exe" 'my script.js' --flag {image}`),
      ['C:\\Program Files\\nodejs\\node.exe', 'my script.js', '--flag', '{image}']);
    assert.deepEqual(splitArgs('python ocr-model/infer.py {image}'), ['python', 'ocr-model/infer.py', '{image}']);
    assert.deepEqual(splitArgs(''), []);
  });

  it('FR-8: runs the command with the image path and parses its JSON', async () => {
    const ocr = make(`${node} "${script}" ok {image}`);
    assert.match(ocr.description, /Local command/);
    const st = await ocr.status();
    assert.equal(st.ready, true);
    assert.match(st.detail, /--health/);
    const r = await ocr.scan(PNG, 'image/png');
    assert.deepEqual(r.fields, { lastName: 'Tan', firstName: 'Wei', sex: 'Male' });
    assert.equal(r.confidence.lastName, 0.8);
    const [file, bytes] = lastSeen();
    assert.match(path.basename(file), /^irby-scan-.+\.png$/);
    assert.equal(Number(bytes), PNG.length);
    assert.equal(fs.existsSync(file), false, 'temporary scan (PHI) must be deleted');
  });

  it('FR-8: appends the image path when {image} is absent; JPEG/WebP extensions', async () => {
    const ocr = make(`${node} "${script}" ok`);
    await ocr.scan(JPEG, 'image/jpeg');
    assert.match(lastSeen()[0], /\.jpg$/);
    await ocr.scan(PNG, 'image/webp');
    assert.match(lastSeen()[0], /\.webp$/);
  });

  it('FR-8: JSON after log lines on stdout is still found', async () => {
    const r = await make(`${node} "${script}" noisy {image}`).scan(PNG, 'image/png');
    assert.deepEqual(r.fields, { lastName: 'Garcia', firstName: 'Paolo' });
  });

  it('FR-8: non-zero exit, non-JSON output and missing programs become OCR_FAILED', async () => {
    await rejectsWith(make(`${node} "${script}" fail {image}`).scan(PNG, 'image/png'), 'OCR_FAILED', 502);
    await assert.rejects(make(`${node} "${script}" fail {image}`).scan(PNG, 'image/png'), /exited with code 3: model exploded/);
    await assert.rejects(make(`${node} "${script}" nojson {image}`).scan(PNG, 'image/png'), /did not print JSON/);
    const missing = make(`"${path.join(dir, 'no-such-program.exe')}" {image}`);
    await rejectsWith(missing.scan(PNG, 'image/png'), 'OCR_FAILED');
    const st = await missing.status();
    assert.equal(st.ready, false);
    assert.match(st.detail, /failed/);
  });

  it('FR-8: health output can report not ready', async () => {
    const st = await make(`${node} "${script}" sick {image}`).status();
    assert.equal(st.ready, false);
    assert.equal(st.detail, 'weights missing');
  });

  it('NFR-P7: a hung command is stopped at the timeout', async () => {
    const hang = path.join(dir, 'hang.js');
    const pidFile = path.join(dir, 'hang.pid');
    fs.writeFileSync(hang, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    await assert.rejects(make(`${node} "${hang}" {image}`, { timeoutMs: 500 }).scan(PNG, 'image/png'), (err) => {
      assert.ok(err instanceof OcrError);
      assert.ok(['OCR_TIMEOUT', 'OCR_FAILED'].includes(err.code), err.code);
      assert.match(err.message, /timed out|did not finish/);
      return true;
    });
    // The child must have been killed, not left running.
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(pid), false, 'hung OCR command is still running');
  });
});

describe('OCR adapter: module provider', () => {
  let dir;
  const write = (name, src) => { const f = path.join(dir, name); fs.writeFileSync(f, src); return f; };
  before(() => {
    dir = tmpDir('irby-ocr-mod-');
    write('good.js', `
exports.status = async () => ({ ready: true, detail: 'js model ok' });
exports.recognize = async (buf, { mime }) => ({ text: 'Last Name: RAMOS\\nFirst Name: LEA\\nSex: F\\nNote: ' + mime + ' ' + buf.length, confidence: 95 });`);
    write('nostatus.js', 'exports.recognize = () => "Surname: Cruz";');
    write('bad.js', 'exports.foo = 1;');
    write('hang.js', 'exports.recognize = () => new Promise(() => {});');
    write('throws.js', 'exports.recognize = async () => { throw new Error("model exploded"); };');
    write('status-throws.js', 'exports.recognize = async () => ({}); exports.status = async () => { throw new Error("GPU missing"); };');
  });
  after(() => rmDir(dir));

  const make = (file, over) => createOcr(ocrConfig({ provider: 'module', modulePath: file, ...over }), dir);

  it('FR-8: loads a JS adapter (path relative to the root) and scans', async () => {
    const ocr = make('good.js');
    assert.equal(ocr.description, 'JS module: good.js');
    assert.deepEqual(await ocr.status(), { provider: 'module', description: 'JS module: good.js', ready: true, detail: 'js model ok' });
    const r = await ocr.scan(PNG, 'image/png');
    assert.deepEqual(r.fields, { lastName: 'Ramos', firstName: 'Lea', sex: 'Female' });
    assert.equal(r.confidence.sex, 0.95);
    assert.match(r.text, new RegExp(`image/png ${PNG.length}$`));
  });

  it('FR-8: status() is optional; plain string results are accepted', async () => {
    const ocr = make(path.join(dir, 'nostatus.js'));
    assert.equal((await ocr.status()).ready, true);
    assert.deepEqual((await ocr.scan(PNG, 'image/png')).fields, { lastName: 'Cruz' });
  });

  it('FR-8: a module without recognize() or a missing file reports not ready and fails scans', async () => {
    const bad = make('bad.js');
    const st = await bad.status();
    assert.equal(st.ready, false);
    assert.match(st.detail, /does not export recognize/);
    await rejectsWith(bad.scan(PNG, 'image/png'), 'OCR_FAILED', 502);
    const missing = make('nowhere.js');
    assert.match((await missing.status()).detail, /Cannot load nowhere\.js/);
    await rejectsWith(missing.scan(PNG, 'image/png'), 'OCR_FAILED');
  });

  it('FR-8: provider exceptions become OCR_FAILED; status exceptions become not ready', async () => {
    await assert.rejects(make('throws.js').scan(PNG, 'image/png'), (err) => err.code === 'OCR_FAILED' && /model exploded/.test(err.message));
    const st = await make('status-throws.js').status();
    assert.equal(st.ready, false);
    assert.equal(st.detail, 'GPU missing');
  });

  it('NFR-P7: a provider that never resolves fails with OCR_TIMEOUT', async () => {
    const t0 = Date.now();
    await rejectsWith(make('hang.js', { timeoutMs: 60 }).scan(PNG, 'image/png'), 'OCR_TIMEOUT', 504);
    assert.ok(Date.now() - t0 < 2000);
  });
});
