/**
 * storage.js — debounced localStorage persistence for player state.
 */

const KEY = 'mp.state.v1';
const DEBOUNCE_MS = 300;

let _timer = null;
let _pending = null;

/**
 * Save state. Debounced — multiple calls within 300ms collapse to one write.
 */
export function saveState(state) {
  _pending = state;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(_pending));
    } catch (err) {
      console.warn('[storage] save failed:', err);
    }
    _timer = null;
    _pending = null;
  }, DEBOUNCE_MS);
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    console.warn('[storage] load failed:', err);
    return null;
  }
}

export function clearState() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
    _pending = null;
  }
  try { localStorage.removeItem(KEY); } catch {}
}
