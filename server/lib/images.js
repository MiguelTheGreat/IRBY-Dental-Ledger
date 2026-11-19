'use strict';
// Minimal image sniffing so uploads are checked by content, not just by header.

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Decode a data URL ("data:image/jpeg;base64,...") into { mime, buffer } or null. */
function decodeDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z+.-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const buffer = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  const mime = sniffImage(buffer);
  return mime ? { mime, buffer } : null;
}

module.exports = { sniffImage, decodeDataUrl };
