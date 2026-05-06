/**
 * library.js — saved-playlist library backed by /api/playlists.
 *
 * Emits 'change' (CustomEvent) whenever the visible list changes
 * (loaded, item added/removed). UI subscribes and re-renders.
 */
export class Library extends EventTarget {
  constructor() {
    super();
    this.items = []; // { id, name, trackCount, importedAt }
    this.available = false; // server detected on init
  }

  /**
   * Probe the server. Sets `available` flag and loads list.
   * Returns true if API is reachable.
   */
  async init() {
    try {
      const res = await fetch('/api/playlists');
      if (!res.ok) {
        this.available = false;
        return false;
      }
      const data = await res.json();
      this.items = Array.isArray(data.playlists) ? data.playlists : [];
      this.available = true;
      this._emit();
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  async refresh() {
    if (!this.available) return;
    try {
      const res = await fetch('/api/playlists');
      if (!res.ok) return;
      const data = await res.json();
      this.items = Array.isArray(data.playlists) ? data.playlists : [];
      this._emit();
    } catch {
      /* ignore transient errors */
    }
  }

  /**
   * Save a new playlist server-side. Returns the index entry on success.
   */
  async save(name, tracks) {
    if (!this.available) return null;
    try {
      const res = await fetch('/api/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, tracks }),
      });
      if (!res.ok) return null;
      const entry = await res.json();
      this.items.unshift(entry);
      this._emit();
      return entry;
    } catch {
      return null;
    }
  }

  async load(id) {
    if (!this.available) return null;
    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async remove(id) {
    if (!this.available) return false;
    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) return false;
      this.items = this.items.filter((it) => it.id !== id);
      this._emit();
      return true;
    } catch {
      return false;
    }
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }
}

/** Format an importedAt timestamp (ms since epoch) as YYYY-MM-DD HH:MM */
export function formatImported(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
