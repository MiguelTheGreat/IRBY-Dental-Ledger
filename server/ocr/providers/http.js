'use strict';
// Sends the image bytes to a model server, e.g. ocr-model/server.py:
//   POST OCR_HTTP_URL   (body = raw image, Content-Type = image/jpeg|png|webp)
//   -> 200 application/json  { "text": "...", "fields": {...}, "confidence": {...} }

module.exports = (opts) => {
  const url = opts.httpUrl;
  const healthUrl = opts.httpHealthUrl || new URL('/health', url).toString();
  const headers = opts.httpAuth ? { Authorization: opts.httpAuth } : {};
  return {
    description: `Model server at ${url}`,
    async status() {
      try {
        const res = await fetch(healthUrl, { headers, signal: AbortSignal.timeout(2000) });
        const body = await res.json().catch(() => ({}));
        return { ready: res.ok && body.ready !== false, detail: body.detail || `Health check ${res.status} at ${healthUrl}` };
      } catch (err) {
        return { ready: false, detail: `Model server not reachable at ${healthUrl} (${err.cause ? err.cause.code || err.message : err.message}). Start it with: python ocr-model/server.py` };
      }
    },
    async recognize(buffer, { mime }) {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': mime, ...headers },
          body: buffer,
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (err) {
        throw new opts.OcrError(502, 'OCR_UNAVAILABLE', `Cannot reach the OCR model server at ${url}: ${err.cause ? err.cause.code || err.message : err.message}`);
      }
      const type = res.headers.get('content-type') || '';
      if (!res.ok) {
        const msg = (await res.text().catch(() => '')).slice(0, 300);
        throw new opts.OcrError(502, 'OCR_FAILED', `OCR model server returned ${res.status}${msg ? ': ' + msg : ''}`);
      }
      return type.includes('json') ? res.json() : { text: await res.text() };
    },
  };
};
