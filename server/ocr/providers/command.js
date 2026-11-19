'use strict';
// Runs a local program per scan, e.g. OCR_COMMAND="python ocr-model/infer.py {image}".
// The program receives a temporary image path ({image}; appended if absent) and must
// print one JSON object to stdout. The temp file is deleted right after (it is PHI).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function splitArgs(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function run(argv, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`exited with code ${code}: ${stderr.trim().slice(-400)}`));
      resolve(stdout);
    });
  });
}

function parseJson(stdout) {
  const s = stdout.trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const start = s.lastIndexOf('\n{');
  if (start >= 0) return JSON.parse(s.slice(start + 1));
  throw new Error('did not print JSON on stdout');
}

module.exports = (opts) => {
  const argv = splitArgs(opts.command);
  const ext = { 'image/png': '.png', 'image/webp': '.webp' };
  return {
    description: `Local command: ${opts.command}`,
    async status() {
      const args = argv.filter((a) => a !== '{image}').concat('--health');
      try {
        const out = await run(args, opts.root, 8000);
        const body = parseJson(out);
        return { ready: body.ready !== false, detail: body.detail || 'Command responded to --health' };
      } catch (err) {
        return { ready: false, detail: `"${args.join(' ')}" failed: ${err.message}` };
      }
    },
    async recognize(buffer, { mime }) {
      const file = path.join(os.tmpdir(), `irby-scan-${crypto.randomUUID()}${ext[mime] || '.jpg'}`);
      fs.writeFileSync(file, buffer, { mode: 0o600 });
      try {
        const args = argv.includes('{image}') ? argv.map((a) => (a === '{image}' ? file : a)) : [...argv, file];
        return parseJson(await run(args, opts.root, opts.timeoutMs));
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
  };
};

module.exports.splitArgs = splitArgs;
