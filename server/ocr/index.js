'use strict';
// FR-8 OCR document scanner: a small adapter layer so the team can mount any
// OCR model without touching the rest of the app.
//
//   OCR_PROVIDER=mock      built-in demo data (default)
//   OCR_PROVIDER=http      POST the image to your model server (OCR_HTTP_URL)
//   OCR_PROVIDER=command   run a local script with the image path (OCR_COMMAND)
//   OCR_PROVIDER=module    require a JS file exporting recognize() (OCR_MODULE)
//
// Every provider returns raw text and/or fields; normalizeResult() maps them to
// the registration form. See ocr-model/README.md for the contract.
const { normalizeResult } = require('./parser');

const PROVIDERS = {
  mock: () => require('./providers/mock'),
  http: () => require('./providers/http'),
  command: () => require('./providers/command'),
  module: () => require('./providers/module'),
};

class OcrError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new OcrError(504, 'OCR_TIMEOUT', `OCR did not finish within ${Math.round(ms / 1000)} s.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function createOcr(ocrConfig, root) {
  const name = ocrConfig.provider;
  if (!PROVIDERS[name]) {
    throw new Error(`Unknown OCR_PROVIDER "${name}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  const provider = PROVIDERS[name]()({ ...ocrConfig, root, OcrError });
  let statusCache = { at: 0, value: null };

  return {
    name,
    description: provider.description,
    async status() {
      if (Date.now() - statusCache.at < 15000 && statusCache.value) return statusCache.value;
      let value;
      try {
        value = provider.status ? await provider.status() : { ready: true };
      } catch (err) {
        value = { ready: false, detail: err.message };
      }
      value = { provider: name, description: provider.description, ...value };
      statusCache = { at: Date.now(), value };
      return value;
    },
    async scan(buffer, mime) {
      const started = Date.now();
      let raw;
      try {
        raw = await withTimeout(Promise.resolve(provider.recognize(buffer, { mime })), ocrConfig.timeoutMs);
      } catch (err) {
        if (err instanceof OcrError) throw err;
        throw new OcrError(502, 'OCR_FAILED', `OCR provider "${name}" failed: ${err.message}`);
      }
      const result = normalizeResult(raw);
      return { ...result, provider: name, tookMs: Date.now() - started };
    },
  };
}

module.exports = { createOcr, OcrError };
