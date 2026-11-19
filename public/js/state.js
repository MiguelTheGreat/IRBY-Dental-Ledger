// Shared client state + a tiny event bus. Only the active patient's ID is kept
// in sessionStorage; no patient data is stored in the browser.
import { get } from './api.js';
import { dirty } from './ui.js';

export const state = {
  user: null,
  permissions: new Set(),
  config: null,
  patient: null,
  view: 'dashboard',
  idleMinutes: 10,
};

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}
export function emit(event, data) {
  for (const fn of listeners.get(event) || []) {
    try { fn(data); } catch (err) { console.error(`[${event}]`, err); }
  }
}

export const can = (perm) => state.permissions.has(perm);

const KEY = 'irby.activePatient';

/** Make a patient active. Asks before discarding unsaved edits (NFR-S2). */
export async function setActivePatient(id, { skipGuard = false } = {}) {
  if (state.patient && state.patient.id === id) return state.patient;
  if (!skipGuard && !(await dirty.confirmDiscard('switch patients'))) return null;
  const detail = await get(`/patients/${encodeURIComponent(id)}`);
  state.patient = detail;
  try { sessionStorage.setItem(KEY, id); } catch { /* storage unavailable */ }
  emit('patient', detail);
  return detail;
}

export async function refreshPatient() {
  if (!state.patient) return null;
  const detail = await get(`/patients/${encodeURIComponent(state.patient.id)}`);
  state.patient = detail;
  emit('patient:updated', detail);
  return detail;
}

export function clearPatient() {
  state.patient = null;
  try { sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  emit('patient', null);
}

export function rememberedPatientId() {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}
