'use strict';
// Builds the Windows release:
//   1. "IRBY Dental Ledger.exe"        native app window (desktop/windows-native.cs, csc.exe)
//   2. build/release/payload.zip       the app files the installer unpacks (see PAYLOAD below)
//   3. "IRBY Dental Ledger Setup.exe"  GUI installer (desktop/windows-installer.cs) with the payload embedded
//
// Run on Windows after `npm install`:  node scripts/build-win-app.js
// Only production dependencies go into the payload (`npm ls --omit=dev`), never data/, .env,
// tests, the Android project or a developer's ocr-model/.venv. The installer sets up the OCR's
// Python itself (desktop/windows-installer.cs, SetupOcrAsync).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync, execSync } = require('node:child_process');
const { renderIconPng, renderIconIco } = require('./make-icons');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const RELEASE_DIR = path.join(BUILD_DIR, 'release');
const PAYLOAD_ZIP = path.join(RELEASE_DIR, 'payload.zip');
const ICO_FILE = path.join(BUILD_DIR, 'icon.ico');
const EXE_OUT = path.join(ROOT, 'IRBY Dental Ledger.exe');
const SETUP_OUT = path.join(ROOT, 'IRBY Dental Ledger Setup.exe');
const GITHUB_FILE_LIMIT = 95 * 1024 * 1024; // GitHub rejects files over 100 MB; keep a margin

// What the installed app needs, relative to the project root.
const PAYLOAD = {
  files: [
    'IRBY Dental Ledger.exe', 'package.json', 'package-lock.json', '.env.example', 'README.md',
    'Install-Node-Windows.bat', 'runtime/node.exe',
  ],
  dirs: ['server', 'public', 'config', 'scripts', 'ocr-model', 'build/webview2'],
  buildFiles: ['build/icon.ico', 'build/icon.png'],
};
const SKIP_DIR_NAMES = new Set(['.venv', '__pycache__', 'node_modules', '.git', 'release']);
const SKIP_FILE = /\.(pyc|pyo|log|db|db-wal|db-shm|bak)$/i;

function ensureIcons() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const basePng = path.join(BUILD_DIR, 'icon.png');
  if (!fs.existsSync(basePng)) {
    fs.writeFileSync(basePng, renderIconPng(512));
  }
  if (!fs.existsSync(ICO_FILE)) {
    fs.writeFileSync(ICO_FILE, renderIconIco());
  }
}

function findCsc() {
  const winDir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Could not find Windows C# compiler (csc.exe) under ' + winDir);
}

function findWebView2Dir() {
  const candidates = [
    path.join(BUILD_DIR, 'webview2'),
    'C:\\Program Files\\Microsoft Office\\root\\Office16\\ADDINS\\Microsoft Power Query for Excel Integrated\\bin',
  ];
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'Microsoft.Web.WebView2.Core.dll')) &&
      fs.existsSync(path.join(dir, 'Microsoft.Web.WebView2.WinForms.dll')) &&
      fs.existsSync(path.join(dir, 'WebView2Loader.dll'))
    ) {
      return dir;
    }
  }
  throw new Error('Could not find WebView2 assemblies in build/webview2.');
}

function buildWinExe() {
  const csc = findCsc();
  const wvDir = findWebView2Dir();
  const csSrc = path.join(ROOT, 'desktop', 'windows-native.cs');

  const coreDll = path.join(wvDir, 'Microsoft.Web.WebView2.Core.dll');
  const winFormsDll = path.join(wvDir, 'Microsoft.Web.WebView2.WinForms.dll');
  const loaderDll = path.join(wvDir, 'WebView2Loader.dll');

  execFileSync(
    csc,
    [
      '/nologo',
      '/target:winexe',
      '/platform:x64',
      '/optimize+',
      `/out:${EXE_OUT}`,
      `/win32icon:${ICO_FILE}`,
      `/r:${coreDll}`,
      `/r:${winFormsDll}`,
      `/resource:${coreDll},Microsoft.Web.WebView2.Core.dll`,
      `/resource:${winFormsDll},Microsoft.Web.WebView2.WinForms.dll`,
      `/resource:${loaderDll},WebView2Loader.dll`,
      csSrc,
    ],
    { stdio: 'inherit' }
  );
}

// ---------------------------------------------------------------- payload

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIR_NAMES.has(ent.name)) walk(full, out);
    } else if (ent.isFile() && !SKIP_FILE.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Production packages only (the old payload shipped electron-builder by accident). */
function productionPackageDirs() {
  const out = execSync('npm ls --omit=dev --all --parseable',
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const dirs = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((d) => path.resolve(d) !== ROOT && fs.existsSync(d));
  if (!dirs.length) throw new Error('npm ls found no production packages - run `npm install` first.');
  return dirs;
}

function payloadFiles() {
  const files = [];
  for (const f of [...PAYLOAD.files, ...PAYLOAD.buildFiles]) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) throw new Error(`Payload file missing: ${f}`);
    files.push(full);
  }
  for (const d of PAYLOAD.dirs) {
    const full = path.join(ROOT, d);
    if (!fs.existsSync(full)) throw new Error(`Payload folder missing: ${d}`);
    walk(full, files);
  }
  for (const pkg of productionPackageDirs()) walk(pkg, files); // nested node_modules are listed on their own
  const unique = [...new Set(files)];
  return unique.map((f) => ({ file: f, name: path.relative(ROOT, f).split(path.sep).join('/') }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Minimal deterministic ZIP writer (deflate, UTF-8 names, fixed timestamps). */
function writeZip(outFile, entries) {
  const DOS_TIME = 0;                                  // 00:00:00
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
  const fd = fs.openSync(outFile, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const e of entries) {
      const data = fs.readFileSync(e.file);
      const crc = zlib.crc32(data) >>> 0;
      let method = 8;
      let body = zlib.deflateRawSync(data, { level: 9 });
      if (body.length >= data.length) { method = 0; body = data; }
      const name = Buffer.from(e.name, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(DOS_TIME, 10);
      local.writeUInt16LE(DOS_DATE, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      fs.writeSync(fd, local);
      fs.writeSync(fd, name);
      fs.writeSync(fd, body);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(method, 10);
      cd.writeUInt16LE(DOS_TIME, 12);
      cd.writeUInt16LE(DOS_DATE, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(body.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(name.length, 28);
      cd.writeUInt32LE(offset, 42);
      central.push(cd, name);
      offset += local.length + name.length + body.length;
      if (offset > 0xffffffff || central.length / 2 > 0xffff) throw new Error('Payload too large for a ZIP without ZIP64');
    }
    const cdBuf = Buffer.concat(central);
    fs.writeSync(fd, cdBuf);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeSync(fd, end);
  } finally {
    fs.closeSync(fd);
  }
}

function buildPayload() {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const entries = payloadFiles();
  const banned = entries.filter((e) => /^(data|tests|android|docs)\/|^\.env$|(^|\/)\.venv\/|\.apk$|Setup\.exe$/i.test(e.name));
  if (banned.length) throw new Error('Refusing to package: ' + banned.slice(0, 5).map((e) => e.name).join(', '));
  writeZip(PAYLOAD_ZIP, entries);
  return entries.length;
}

function buildInstallerExe() {
  const csc = findCsc();
  const installerSrc = path.join(ROOT, 'desktop', 'windows-installer.cs');
  execFileSync(
    csc,
    [
      '/nologo',
      '/target:winexe',
      '/platform:x64',
      '/optimize+',
      `/out:${SETUP_OUT}`,
      `/win32icon:${ICO_FILE}`,
      '/r:System.IO.Compression.dll',
      '/r:System.IO.Compression.FileSystem.dll',
      `/resource:${PAYLOAD_ZIP},payload.zip`,
      installerSrc,
    ],
    { stdio: 'inherit' }
  );
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

function main() {
  if (process.platform !== 'win32') {
    console.log('Windows native .exe builder skipped (not running on Windows).');
    return;
  }
  console.log('Building Windows icon (build/icon.ico)...');
  ensureIcons();
  console.log('Compiling native Windows application ("IRBY Dental Ledger.exe")...');
  buildWinExe();
  console.log('Packing installer payload (build/release/payload.zip)...');
  const count = buildPayload();
  console.log(`  ${count} files, ${mb(fs.statSync(PAYLOAD_ZIP).size)}`);
  console.log('Compiling Windows GUI installer ("IRBY Dental Ledger Setup.exe")...');
  buildInstallerExe();
  const setupSize = fs.statSync(SETUP_OUT).size;
  if (setupSize > GITHUB_FILE_LIMIT) {
    throw new Error(`Setup.exe is ${mb(setupSize)}: too large to commit to GitHub (100 MB limit).`);
  }
  console.log('Done! Created:\n  - ' + EXE_OUT + ' (' + mb(fs.statSync(EXE_OUT).size) + ')\n  - ' + SETUP_OUT + ' (' + mb(setupSize) + ')');
}

if (require.main === module) main();

module.exports = { payloadFiles, writeZip };
