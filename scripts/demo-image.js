'use strict';
// Draws a simple illustrated "upper occlusal" arch as a PNG so the demo chart has
// a photo to pin findings on. Pure Node (zlib) - no image libraries needed.
const zlib = require('node:zlib');

const W = 800, H = 600;
const CX = 400, CY = 560, RX = 300, RY = 430;
// Patient's right (Q1) on the viewer's left, as in a frontal/occlusal mirror view.
const TEETH = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
const ANGLES = [166, 155, 143, 131, 121, 112, 104, 96.5, 83.5, 76, 68, 59, 49, 37, 25, 14];
const SIZES = [34, 38, 40, 28, 27, 25, 21, 24, 24, 21, 25, 27, 28, 40, 38, 34];

function toothPositions() {
  return TEETH.map((t, i) => {
    const a = (ANGLES[i] * Math.PI) / 180;
    return { tooth: t, x: CX + RX * Math.cos(a), y: CY - RY * Math.sin(a), r: SIZES[i] };
  });
}

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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function render() {
  const teeth = toothPositions();
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      // background: dark oral cavity with vignette
      const v = 1 - Math.min(1, Math.hypot(x - CX, y - 300) / 650);
      let r = 70 + 40 * v, g = 22 + 14 * v, b = 28 + 14 * v;
      const ex = (x - CX) / (RX + 60), ey = (y - CY) / (RY + 60);
      const outer = ex * ex + ey * ey;
      const ix = (x - CX) / (RX - 70), iy = (y - CY) / (RY - 70);
      const inner = ix * ix + iy * iy;
      if (outer < 1 && y < CY - 20) { r = 201; g = 112; b = 112; }          // gingiva
      if (inner < 1 && y < CY - 20) { r = 222; g = 150; b = 146; }          // palate
      if (inner < 1 && y < CY - 20 && Math.abs(x - CX) < 6) { r = 205; g = 128; b = 126; } // palatal raphe
      for (const t of teeth) {
        const d = Math.hypot(x - t.x, (y - t.y) * 1.08);
        if (d < t.r) {
          const shade = 1 - (d / t.r) * 0.22;
          r = 246 * shade; g = 240 * shade; b = 226 * shade;
          if (t.r > 30 && Math.abs(Math.hypot(x - t.x, y - t.y) - t.r * 0.42) < 1.6) { r *= 0.86; g *= 0.84; b *= 0.8; } // fissure ring
        }
      }
      const i = row + 1 + x * 3;
      raw[i] = Math.max(0, Math.min(255, r)); raw[i + 1] = Math.max(0, Math.min(255, g)); raw[i + 2] = Math.max(0, Math.min(255, b));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Normalized (0..1) pin position for a tooth in the demo image. */
function positionOf(tooth) {
  const t = toothPositions().find((p) => p.tooth === tooth);
  return t ? { x: t.x / W, y: t.y / H } : null;
}

module.exports = { renderDemoArch: render, positionOf, WIDTH: W, HEIGHT: H };
