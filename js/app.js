/**
 * app.js — entry point. Wires player + playlist + visualizer + UI + storage.
 */

import { Player } from './player.js';
import { Playlist } from './playlist.js';
import { Visualizer } from './visualizer.js';
import { Library } from './library.js';
import { UI } from './ui.js';
import { parseM3U } from './m3u-parser.js';
import { saveState, loadState, clearState } from './storage.js';

const audioEl = document.getElementById('audio');
const canvas = document.getElementById('visualizer');

const player = new Player(audioEl);
const playlist = new Playlist();
const visualizer = new Visualizer(canvas);
const library = new Library();
visualizer.stop(); // idle until play

let _errorSkipTimer = null;
let _proxyAvailable = false;

// ---------- Proxy auto-detect ----------
// If served via server.py, the /proxy endpoint exists and we can use it
// to bypass CORP/CSP restrictions on hosts like Google Drive.

(async function detectProxy() {
  try {
    const res = await fetch('/proxy?url=', { method: 'GET' });
    // server.py returns 400 ("Missing url parameter"); plain http.server returns 404.
    _proxyAvailable = res.status === 400;
    if (_proxyAvailable) {
      console.log('[app] proxy endpoint detected — cross-origin URLs will be routed through /proxy');
    } else {
      console.log('[app] no proxy endpoint — cross-origin URLs use direct loading (CORP-restricted hosts will fail)');
    }
  } catch {
    _proxyAvailable = false;
  }
})();

/**
 * Rewrite a cross-origin URL to go through the local proxy.
 * Same-origin URLs are returned as-is.
 */
function maybeProxy(url) {
  if (!_proxyAvailable) return url;
  try {
    const u = new URL(url, window.location.href);
    const here = window.location;
    if (u.origin === here.origin) return url;
    if (!/^https?:$/.test(u.protocol)) return url;
    return `/proxy?url=${encodeURIComponent(u.href)}`;
  } catch {
    return url;
  }
}

const ui = new UI({
  player, playlist, visualizer, library,
  callbacks: {
    onPlay:  () => doPlay(),
    onPause: () => player.pause(),
    onStop:  () => { player.stop(); visualizer.stop(); },
    onPrev:  () => doPrev(),
    onNext:  () => doNext(),
    onLoadFile: (file) => loadM3UFile(file),
    onLoadUrl:  (url)  => loadM3UFromUrl(url),
    onClear: () => { playlist.clear(); player.stop(); visualizer.stop(); persist(); },
    onTrackClick: (i) => {
      playlist.playAt(i);
      tryPlayCurrent();
      ui.activateMobileTab('main'); // jump to NOW PLAYING on mobile
    },
    onPlayerError: () => handlePlayerError(),
    onPersist: () => persist(),
    onLibraryRefresh: () => refreshLibrary(),
    onLibraryLoad: (id) => loadFromLibrary(id),
    onLibraryDelete: (id) => deleteFromLibrary(id),
  },
});

ui.init();

// ---------- Library init ----------

(async function initLibrary() {
  ui.setLibraryStatus('Connecting…', 'idle');
  const ok = await library.init();
  if (ok) {
    ui.setLibraryStatus('Online · LAN shared', 'online');
  } else {
    ui.setLibraryStatus('Offline (no server API)', 'offline');
  }
})();

// ---------- Restore from storage ----------

const saved = loadState();
if (saved) {
  if (Array.isArray(saved.tracks) && saved.tracks.length > 0) {
    playlist.load(saved.tracks, { autoplayIndex: -1 });
    if (typeof saved.currentIndex === 'number' && saved.currentIndex >= 0
        && saved.currentIndex < saved.tracks.length) {
      playlist.currentIndex = saved.currentIndex;
    }
  }
  if (typeof saved.volume === 'number') player.setVolume(saved.volume);
  if (typeof saved.muted === 'boolean') player.setMute(saved.muted);
  if (typeof saved.shuffle === 'boolean' && saved.shuffle !== playlist.shuffle) {
    playlist.toggleShuffle();
  }
  if (typeof saved.repeat === 'string') playlist.setRepeat(saved.repeat);

  // Pre-load current track src so user just hits Play
  if (playlist.current) {
    player.load(maybeProxy(playlist.current.url));
    ui.updateTitleFromCurrent();
    ui.renderPlaylist();
  }
  ui.updateVolume();
  ui.updateShuffleRepeat();
} else {
  // Default volume
  player.setVolume(0.8);
  ui.updateVolume();
}

// ---------- Actions ----------

function doPlay() {
  if (playlist.isEmpty) {
    ui.toast('No playlist loaded. Drop a .m3u file first.', { type: 'error' });
    return;
  }
  if (playlist.currentIndex < 0) {
    playlist.playAt(0);
    tryPlayCurrent();
    return;
  }

  const t = playlist.current;
  if (!t) return;

  // If audio src already matches current track (via proxy or direct), just
  // resume — don't reload (would reset currentTime to 0).
  const currentSrc = player.audio.currentSrc || player.audio.src;
  const expectedSrc = new URL(maybeProxy(t.url), window.location.href).href;
  if (currentSrc && currentSrc === expectedSrc) {
    player.play().catch((err) => console.warn('[app] resume failed:', err));
    return;
  }

  tryPlayCurrent();
}

function doPrev() {
  if (playlist.isEmpty) return;
  const t = playlist.prev();
  if (t) tryPlayCurrent();
}

function doNext(autoAdvance = false) {
  if (playlist.isEmpty) return;
  const t = playlist.next(autoAdvance);
  if (t) {
    tryPlayCurrent();
  } else {
    // End of playlist
    player.stop();
    visualizer.stop();
    ui.flashLcd('-- END --', 2500);
  }
}

function tryPlayCurrent() {
  const t = playlist.current;
  if (!t) return;
  player.load(maybeProxy(t.url));
  player.play().catch((err) => {
    console.warn('[app] play() rejected:', err);
  });
  persist();
}

function handlePlayerError() {
  if (_errorSkipTimer) return;

  const err = player.audio.error;
  const codes = {
    1: 'ABORTED',
    2: 'NETWORK',
    3: 'DECODE',
    4: 'SRC_NOT_SUPPORTED',
  };
  const codeName = err && codes[err.code] ? codes[err.code] : 'UNKNOWN';
  const track = playlist.current;
  console.warn(
    `[app] audio error on track #${playlist.currentIndex}:`,
    codeName,
    err && err.message ? err.message : '',
    track ? track.url : ''
  );

  ui.flashLcd(`*** ERR ${codeName} ***`, 2000);
  ui.toast(
    `Track skipped: ${track ? track.title : '?'} (${codeName})`,
    { type: 'error', duration: 3500 }
  );

  // Mark item visually as error
  const items = document.querySelectorAll('.playlist__item');
  if (items[playlist.currentIndex]) {
    items[playlist.currentIndex].classList.add('is-error');
  }

  _errorSkipTimer = setTimeout(() => {
    _errorSkipTimer = null;
    doNext(true);
  }, 2000);
}

// Auto-advance when track ends naturally
player.addEventListener('ended', () => doNext(true));

// ---------- Loading ----------

function _nameFromFile(filename) {
  if (!filename) return 'Untitled';
  return filename.replace(/\.[^.]+$/, '') || filename;
}

function _nameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last).replace(/\.[^.]+$/, '');
    return u.hostname;
  } catch {
    return url.slice(0, 60);
  }
}

async function loadM3UFile(file) {
  try {
    const text = await file.text();
    const tracks = parseM3U(text);
    if (tracks.length === 0) {
      ui.toast('No tracks found in file.', { type: 'error' });
      return;
    }
    playlist.load(tracks);
    ui.toast(`Loaded ${tracks.length} track${tracks.length === 1 ? '' : 's'} from ${file.name}`);
    persist();
    await autoSaveToLibrary(_nameFromFile(file.name), tracks);
  } catch (err) {
    ui.toast('Failed to read file: ' + err.message, { type: 'error' });
  }
}

async function loadM3UFromUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const tracks = parseM3U(text, url);
    if (tracks.length === 0) {
      ui.toast('No tracks found at URL.', { type: 'error' });
      return;
    }
    playlist.load(tracks);
    ui.toast(`Loaded ${tracks.length} tracks from URL`);
    persist();
    await autoSaveToLibrary(_nameFromUrl(url), tracks);
  } catch (err) {
    ui.toast('Failed to fetch URL: ' + err.message + ' (CORS?)', { type: 'error' });
  }
}

async function autoSaveToLibrary(name, tracks) {
  if (!library.available) return;
  const entry = await library.save(name, tracks);
  if (entry) {
    ui.setActiveLibraryId(entry.id);
    ui.toast(`Saved "${entry.name}" to library`, { duration: 2500 });
  }
}

async function refreshLibrary() {
  if (!library.available) {
    ui.setLibraryStatus('Offline (no server API)', 'offline');
    return;
  }
  await library.refresh();
  ui.setLibraryStatus('Online · LAN shared', 'online');
}

async function loadFromLibrary(id) {
  const data = await library.load(id);
  if (!data || !Array.isArray(data.tracks)) {
    ui.toast('Failed to load saved playlist', { type: 'error' });
    return;
  }
  playlist.load(data.tracks);
  ui.setActiveLibraryId(id);
  ui.activateMobileTab('playlist'); // jump to playlist on mobile
  ui.toast(`Loaded "${data.name || ''}" (${data.tracks.length} tracks)`);
  persist();
}

async function deleteFromLibrary(id) {
  const ok = await library.remove(id);
  if (!ok) {
    ui.toast('Failed to delete', { type: 'error' });
    return;
  }
  if (ui._activeLibraryId === id) ui.setActiveLibraryId(null);
  ui.toast('Deleted from library');
}

// ---------- Persistence ----------

let _persistThrottle = 0;
function persist() {
  // The storage layer already debounces; just call it
  saveState({
    tracks: playlist.tracks,
    currentIndex: playlist.currentIndex,
    volume: player.volume,
    muted: player.muted,
    shuffle: playlist.shuffle,
    repeat: playlist.repeat,
  });
}

// Expose for debugging
window.__retroPlayer = { player, playlist, visualizer, ui, clearState };
