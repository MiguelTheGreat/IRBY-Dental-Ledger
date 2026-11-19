'use strict';
// Generates PNG application icons (512x512 and 192x192) for Electron, electron-builder,
// macOS .app bundles, Windows .exe, and the Web App Manifest using pure Node (zlib).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const TABLE = crcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Signed distance to a rounded rectangle centered at (cx, cy) with half-size (hx, hy) and radius r
function sdRoundRect(x, y, cx, cy, hx, hy, r) {
  const qx = Math.abs(x - cx) - hx + r;
  const qy = Math.abs(y - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Signed distance to a segment from (ax, ay) to (bx, by)
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

// Draws a crisp rounded-square clinic icon (#3E2F27 dark espresso background, subtle warm inner border,
// and clean white "IR" monogram + molar crown emblem).
function renderIconPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const s = size / 512;

  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    const ny = y / s;

    for (let x = 0; x < size; x++) {
      const nx = x / s;
      const dBg = sdRoundRect(nx, ny, 256, 256, 236, 236, 104);

      if (dBg > 1.0) {
        // Transparent outside rounded rect
        const i = row + 1 + x * 4;
        raw[i] = 0; raw[i + 1] = 0; raw[i + 2] = 0; raw[i + 3] = 0;
        continue;
      }

      // Antialiased alpha at outer edge
      const alpha = Math.max(0, Math.min(1, 0.5 - dBg));

      // Subtle warm gradient background (#47362D top -> #352720 bottom)
      const grad = ny / 512;
      let r = 74 * (1 - grad) + 52 * grad;
      let g = 56 * (1 - grad) + 39 * grad;
      let b = 47 * (1 - grad) + 32 * grad;

      // Subtle inner gold/cream border ring
      const dRing = Math.abs(sdRoundRect(nx, ny, 256, 256, 212, 212, 84)) - 2.5;
      if (dRing < 1.0) {
        const ra = Math.max(0, Math.min(1, 0.5 - dRing)) * 0.22;
        r = r * (1 - ra) + 225 * ra;
        g = g * (1 - ra) + 198 * ra;
        b = b * (1 - ra) + 172 * ra;
      }

      // Draw bold "I" and "R" glyphs in normalized 512x512 coords
      const stroke = 23;
      // Letter "I": vertical stem from (158, 170) to (158, 342) + top/bottom serifs
      let dGlyph = sdSegment(nx, ny, 158, 172, 158, 340) - stroke;

      // Letter "R":
      // Left stem: (242, 172) to (242, 340)
      dGlyph = Math.min(dGlyph, sdSegment(nx, ny, 242, 172, 242, 340) - stroke);
      // Top bar: (242, 172) to (312, 172)
      dGlyph = Math.min(dGlyph, sdSegment(nx, ny, 242, 172, 312, 172) - stroke);
      // Mid bar: (242, 254) to (312, 254)
      dGlyph = Math.min(dGlyph, sdSegment(nx, ny, 242, 254, 312, 254) - stroke);
      // Bowl arc: center (312, 213), radius 41, for nx >= 310
      if (nx >= 308) {
        const dBowl = Math.abs(Math.hypot(nx - 312, ny - 213) - 41) - stroke;
        dGlyph = Math.min(dGlyph, dBowl);
      }
      // Diagonal leg of R: (298, 252) to (356, 340)
      dGlyph = Math.min(dGlyph, sdSegment(nx, ny, 298, 252, 356, 340) - stroke);

      if (dGlyph < 1.0) {
        const ga = Math.max(0, Math.min(1, 0.5 - dGlyph));
        r = r * (1 - ga) + 248 * ga;
        g = g * (1 - ga) + 244 * ga;
        b = b * (1 - ga) + 239 * ga;
      }

      // Small accent pill bar underneath ("DENTAL LEDGER" underline)
      const dBar = sdSegment(nx, ny, 186, 396, 326, 396) - 6.5;
      if (dBar < 1.0) {
        const ba = Math.max(0, Math.min(1, 0.5 - dBar)) * 0.75;
        r = r * (1 - ba) + 212 * ba;
        g = g * (1 - ba) + 163 * ba;
        b = b * (1 - ba) + 115 * ba;
      }

      const i = row + 1 + x * 4;
      raw[i] = Math.round(Math.max(0, Math.min(255, r)));
      raw[i + 1] = Math.round(Math.max(0, Math.min(255, g)));
      raw[i + 2] = Math.round(Math.max(0, Math.min(255, b)));
      raw[i + 3] = Math.round(Math.max(0, Math.min(255, alpha * 255)));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderIconIco(sizes = [16, 32, 48, 64, 128, 256]) {
  const pngs = sizes.map((sz) => ({ size: sz, data: renderIconPng(sz) }));
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type: 1 = ICO
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  let offset = 6 + count * 16;

  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // Color palette
    entry[3] = 0; // Reserved
    entry.writeUInt16LE(1, 4);  // Color planes
    entry.writeUInt16LE(32, 6); // Bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngs.map((p) => p.data)]);
}

function main() {
  const root = path.resolve(__dirname, '..');
  const iconsDir = path.join(root, 'public', 'icons');
  const buildDir = path.join(root, 'build');
  fs.mkdirSync(iconsDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });

  const png512 = renderIconPng(512);
  const png192 = renderIconPng(192);
  const ico = renderIconIco();

  fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), png512);
  fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), png192);
  fs.writeFileSync(path.join(buildDir, 'icon.png'), png512);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log('Generated public/icons/icon-512.png, public/icons/icon-192.png, build/icon.png, and build/icon.ico');
}

if (require.main === module) main();
module.exports = { renderIconPng, renderIconIco };
