'use strict';
// Builds a native Windows application executable ("IRBY Dental Ledger.exe") using
// Windows's built-in C# compiler (csc.exe) and pure-Node ICO generation.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { renderIconPng, renderIconIco } = require('./make-icons');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const ICO_FILE = path.join(BUILD_DIR, 'icon.ico');
const EXE_OUT = path.join(ROOT, 'IRBY Dental Ledger.exe');
const SETUP_OUT = path.join(ROOT, 'IRBY Dental Ledger Setup.exe');

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

function buildInstallerExe() {
  const csc = findCsc();
  const installerSrc = path.join(ROOT, 'desktop', 'windows-installer.cs');
  const scratchZip = path.join(
    require('node:os').homedir(),
    '.gemini',
    'antigravity',
    'brain',
    'bfee04cb-4337-418f-aa13-cd313c759ba3',
    'scratch',
    'payload.zip'
  );

  const args = [
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    `/out:${SETUP_OUT}`,
    `/win32icon:${ICO_FILE}`,
    '/r:System.IO.Compression.dll',
    '/r:System.IO.Compression.FileSystem.dll',
  ];

  if (fs.existsSync(scratchZip)) {
    args.push(`/resource:${scratchZip},payload.zip`);
  }

  args.push(installerSrc);

  execFileSync(csc, args, { stdio: 'inherit' });
}

function main() {
  if (process.platform !== 'win32') {
    console.log('Windows native .exe builder skipped (not running on Windows).');
    return;
  }
  console.log('Building Windows icon (build/icon.ico)...');
  ensureIcons();
  console.log('Compiling native Windows application ("IRBY Dental Ledger.exe")...');
  buildWinExe();
  console.log('Compiling custom Windows GUI installer ("IRBY Dental Ledger Setup.exe")...');
  buildInstallerExe();
  console.log('Done! Created:\n  - ' + EXE_OUT + '\n  - ' + SETUP_OUT);
}

if (require.main === module) main();
