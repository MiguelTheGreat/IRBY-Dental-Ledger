// Client mirror of server/lib/money.js for instant balance display (NFR-P5).
// The server re-validates every amount; this only drives the live preview.

export function parseAmount(input) {
  if (input === null || input === undefined || String(input).trim() === '') return { ok: false, error: 'REQUIRED', message: 'Amount is required.' };
  const text = String(input).trim().replace(/^(₱|php)\s*/i, '').replace(/[,\s]/g, '');
  if (text.startsWith('-')) return { ok: false, error: 'NEGATIVE', message: 'Negative amounts are not allowed.' };
  const m = /^(\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m || (m[1] === '' && m[2] === undefined)) return { ok: false, error: 'NOT_NUMERIC', message: 'Enter a number with at most 2 decimals.' };
  const cents = (m[1] === '' ? 0 : Number(m[1])) * 100 + (m[2] === undefined ? 0 : Number(m[2].padEnd(2, '0')));
  if (!Number.isSafeInteger(cents) || cents > 10_000_000_000) return { ok: false, error: 'TOO_LARGE', message: 'Amount is too large.' };
  return { ok: true, cents };
}
