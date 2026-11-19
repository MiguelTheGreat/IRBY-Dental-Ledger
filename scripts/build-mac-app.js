'use strict';
// Builds a native macOS application bundle ("IRBY Dental Ledger.app") using
// macOS's built-in swiftc, sips, and iconutil. Zero external downloads required.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { renderIconPng } = require('./make-icons');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const ICONSET_DIR = path.join(BUILD_DIR, 'AppIcon.iconset');
const ICNS_FILE = path.join(BUILD_DIR, 'icon.icns');
const APP_DIR = path.join(ROOT, 'IRBY Dental Ledger.app');

function buildIcns() {
  fs.mkdirSync(ICONSET_DIR, { recursive: true });
  const basePng = path.join(BUILD_DIR, 'icon.png');
  if (!fs.existsSync(basePng)) {
    fs.writeFileSync(basePng, renderIconPng(512));
  }

  const sizes = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];

  for (const [px, filename] of sizes) {
    const out = path.join(ICONSET_DIR, filename);
    execFileSync('sips', ['-z', String(px), String(px), basePng, '--out', out], { stdio: 'ignore' });
  }

  execFileSync('iconutil', ['-c', 'icns', ICONSET_DIR, '-o', ICNS_FILE]);
  fs.rmSync(ICONSET_DIR, { recursive: true, force: true });
}

function buildAppBundle() {
  const contentsDir = path.join(APP_DIR, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');

  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  if (fs.existsSync(ICNS_FILE)) {
    fs.copyFileSync(ICNS_FILE, path.join(resourcesDir, 'AppIcon.icns'));
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>IRBY Dental Ledger</string>
  <key>CFBundleExecutable</key>
  <string>IRBYDentalLedger</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.irbyclinic.dental-ledger</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>IRBY Dental Ledger</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${pkg.version}</string>
  <key>CFBundleVersion</key>
  <string>${pkg.version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSCameraUsageDescription</key>
  <string>IRBY Dental Ledger uses the camera to capture patient portraits, intraoral chart photos, and paper registration forms for OCR.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), plist);

  const objcSrc = path.join(ROOT, 'desktop', 'macos-native.m');
  const binOut = path.join(macosDir, 'IRBYDentalLedger');
  execFileSync('clang', [
    '-O2',
    '-fobjc-arc',
    '-framework', 'Cocoa',
    '-framework', 'WebKit',
    objcSrc,
    '-o', binOut,
  ], { stdio: 'inherit' });
  fs.chmodSync(binOut, 0o755);
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('macOS native .app builder skipped (not running on macOS).');
    return;
  }
  console.log('Building macOS icon (build/icon.icns)...');
  buildIcns();
  console.log('Compiling native macOS application ("IRBY Dental Ledger.app")...');
  buildAppBundle();
  console.log('Done! Created: ' + APP_DIR);
}

if (require.main === module) main();
