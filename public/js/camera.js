// Camera capture + image utilities (NFR-PO3: works with any built-in camera,
// no external hardware). Live preview needs a secure context (HTTPS or
// localhost); otherwise the device camera app is opened through a file input.
import { openModal, closeModal, html, toast } from './ui.js';

export function pickFiles({ accept = 'image/*', capture = null, multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', capture);
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve([...(input.files || [])]); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

const canLiveCapture = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);

/**
 * Open a camera dialog. Resolves with a Blob/File, or null if cancelled.
 * mode: 'portrait' (front camera, round guide) | 'document' | 'photo'
 */
export async function captureImage({ title = 'Take photo', mode = 'photo', hint = '' } = {}) {
  const facing = mode === 'portrait' ? 'user' : 'environment';
  if (!canLiveCapture()) {
    const files = await pickFiles({ capture: facing });
    return files[0] || null;
  }
  let stream = null;
  let facingMode = facing;
  const stop = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };

  const start = async (dialog) => {
    stop();
    const video = dialog.querySelector('video');
    const msg = dialog.querySelector('.cam-msg');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: mode === 'portrait' ? 1280 : 3264 }, height: { ideal: mode === 'portrait' ? 960 : 2448 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      video.hidden = false;
      msg.hidden = true;
    } catch (err) {
      video.hidden = true;
      msg.hidden = false;
      msg.textContent = `Camera unavailable (${err.name || err.message}). Use "Choose file" instead.`;
    }
  };

  const result = await openModal({
    title,
    wide: true,
    body: String(html`${hint ? html`<p>${hint}</p>` : ''}
      <div class="camera-frame ${mode}"><video playsinline muted hidden></video><div class="cam-msg">Starting camera…</div></div>`),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Switch camera', handler: async (d) => { facingMode = facingMode === 'user' ? 'environment' : 'user'; await start(d); return false; } },
      { label: 'Choose file', handler: async () => { stop(); const f = await pickFiles(); closeModal(f[0] || null); return false; } },
      {
        label: 'Capture', kind: 'primary',
        handler: async (d) => {
          const video = d.querySelector('video');
          if (!stream || !video.videoWidth) { toast('Camera is not ready yet.', 'warn'); return false; }
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0);
          const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
          stop();
          closeModal(blob);
          return false;
        },
      },
    ],
    onMount: (d) => start(d),
    onClose: stop,
  });
  stop();
  return result || null;
}

export async function loadBitmap(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* fall back */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Draw an image scaled so its long edge is <= maxEdge; square=true crops the centre. */
export function drawToCanvas(bitmap, { maxEdge = 2000, square = false } = {}) {
  let sw = bitmap.width, sh = bitmap.height, sx = 0, sy = 0;
  if (square) { const s = Math.min(sw, sh); sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s; }
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Encode as JPEG no larger than maxBytes (lower quality first, then downscale). */
export async function encodeUnder(canvas, maxBytes) {
  let c = canvas;
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const q of [0.9, 0.8, 0.7, 0.6]) {
      const blob = await canvasToBlob(c, 'image/jpeg', q);
      if (blob.size <= maxBytes) return blob;
    }
    const next = document.createElement('canvas');
    next.width = Math.round(c.width * 0.75);
    next.height = Math.round(c.height * 0.75);
    next.getContext('2d').drawImage(c, 0, 0, next.width, next.height);
    c = next;
  }
  return canvasToBlob(c, 'image/jpeg', 0.5);
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Prepare a clinical photo for upload: fix orientation, cap size, JPEG. */
export async function prepareClinicalPhoto(blob, maxEdge = 2000) {
  const bmp = await loadBitmap(blob);
  const canvas = drawToCanvas(bmp, { maxEdge });
  const out = await canvasToBlob(canvas, 'image/jpeg', 0.86);
  return { blob: out, width: canvas.width, height: canvas.height };
}
