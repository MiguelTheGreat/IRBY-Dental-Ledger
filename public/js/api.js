// Thin fetch wrapper for the clinic API. All requests are same-origin and carry
// the session cookie; mutating requests add the CSRF header the server expects.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || `Request failed (${status})`);
    this.status = status;
    this.code = body && body.error;
    this.body = body || {};
  }
}

let unauthenticatedHandler = () => {};
export function onUnauthenticated(fn) { unauthenticatedHandler = fn; }

function qs(query) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function api(method, url, { body, query, raw, background = false } = {}) {
  const headers = { 'X-Requested-With': 'irby' };
  if (background) headers['X-Background'] = '1';
  let payload;
  if (raw) {
    payload = raw;
    headers['Content-Type'] = raw.type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(`/api${url}${qs(query)}`, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, { error: 'NETWORK', message: 'Cannot reach the clinic server. Check the local network connection.' });
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (res.status === 401 && !url.startsWith('/auth/login') && !url.startsWith('/setup')) unauthenticatedHandler(data);
  if (!res.ok) throw new ApiError(res.status, typeof data === 'object' ? data : { message: data });
  return data;
}

export const get = (url, opts) => api('GET', url, opts);
export const post = (url, body, opts = {}) => api('POST', url, { ...opts, body });
export const put = (url, body, opts = {}) => api('PUT', url, { ...opts, body });
export const del = (url, body, opts = {}) => api('DELETE', url, { ...opts, body });
export const upload = (url, blob, query) => api('POST', url, { raw: blob, query });

/** Trigger a browser download of an authenticated GET endpoint. */
export function download(url) {
  const a = document.createElement('a');
  a.href = `/api${url}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
