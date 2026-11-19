'use strict';
// Loads a JavaScript OCR adapter in-process, e.g. OCR_MODULE=ocr-model/js-provider.example.js
// The module exports:  recognize(buffer, { mime }) -> Promise<{ text?, fields?, confidence? }>
//                      status() -> Promise<{ ready: boolean, detail?: string }>   (optional)
const path = require('node:path');

module.exports = (opts) => {
  const file = path.resolve(opts.root, opts.modulePath);
  let mod;
  let loadError = null;
  try {
    mod = require(file);
    if (typeof mod.recognize !== 'function') throw new Error('module does not export recognize(buffer, { mime })');
  } catch (err) {
    loadError = err;
  }
  return {
    description: `JS module: ${opts.modulePath}`,
    async status() {
      if (loadError) return { ready: false, detail: `Cannot load ${opts.modulePath}: ${loadError.message}` };
      return mod.status ? mod.status() : { ready: true };
    },
    async recognize(buffer, meta) {
      if (loadError) throw loadError;
      return mod.recognize(buffer, meta);
    },
  };
};
