'use strict';
// Example in-process adapter for OCR_PROVIDER=module (OCR_MODULE=ocr-model/js-provider.example.js).
// Use this when your model runs from JavaScript (e.g. tesseract.js, onnxruntime-node, a cloud SDK).
// Copy this file, implement recognize(), and point OCR_MODULE at your copy.
//
// Example with tesseract.js (npm install tesseract.js; first run downloads language data,
// set langPath to a local folder for offline clinics):
//
//   const { createWorker } = require('tesseract.js');
//   let worker;
//   async function getWorker() { return worker || (worker = await createWorker('eng')); }
//   exports.recognize = async (buffer) => {
//     const { data } = await (await getWorker()).recognize(buffer);
//     return { text: data.text, confidence: data.confidence / 100 };
//   };

/** @returns {Promise<{ text?: string, fields?: object, confidence?: number|object }>} */
exports.recognize = async (buffer, { mime }) => {
  throw new Error(`No JavaScript OCR model implemented yet (received ${buffer.length} bytes of ${mime}). Edit ${__filename}.`);
};

exports.status = async () => ({ ready: false, detail: 'Example adapter - implement recognize() in ocr-model/js-provider.example.js' });
