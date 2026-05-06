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

// ---------- Debug Logger ----------

const _logList = document.getElementById('log-list');
const _logPanel = document.getElementById('log-panel');
const _logToggle = document.getElementById('log-toggle');
const _logEntries = [];

function dlog(level, ...args) {
  const time = new Date().toLocaleTimeString('id-ID', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const full = `[${time}] [${level.toUpperCase()}] ${msg}`;

  // Console
  if (level === 'error') console.error(full);
  else if (level === 'warn') console.warn(full);
  else console.log(full);

  // UI panel
  _logEntries.push({ time, level, msg });
  if (_logEntries.length > 200) _logEntries.shift();
  if (_logList) {
    const el = document.createElement('div');
    el.className = `log-entry log-entry--${level}`;
    el.innerHTML = `<span class="log-time">${time}</span>${msg.replace(/</g, '&lt;')}`;
    _logList.appendChild(el);
    el.scrollIntoView({ block: 'end' });
  }
}

// Log panel UI
if (_logToggle && _logPanel) {
  _logToggle.addEventListener('click', () => {
    _logPanel.hidden = !_logPanel.hidden;
  });
  document.getElementById('log-close').addEventListener('click', () => {
    _logPanel.hidden = true;
  });
  document.getElementById('log-clear').addEventListener('click', () => {
    _logEntries.length = 0;
    _logList.innerHTML = '';
  });
}

const audioEl = document.getElementById('audio');
const canvas = document.getElementById('visualizer');

const player = new Player(audioEl);
const playlist = new Playlist();
const visualizer = new Visualizer(canvas);
const library = new Library();
visualizer.stop(); // idle until play

dlog('info', `RetroPlayer started — iOS: ${player.isIOS} | UA: ${navigator.userAgent.substring(0, 60)}`);

let _errorSkipTimer = null;
let _networkRetryCount = 0;
let _networkRetryOnlineHandler = null;
const NETWORK_RETRY_DELAYS = [2000, 5000, 10000];
let _proxyAvailable = false;
let _loadGen = 0; // increments on every track load, used to ignore stale errors

function _cancelNetworkRetry() {
  if (_errorSkipTimer) {
    clearTimeout(_errorSkipTimer);
    _errorSkipTimer = null;
  }
  if (_networkRetryOnlineHandler) {
    window.removeEventListener('online', _networkRetryOnlineHandler);
    _networkRetryOnlineHandler = null;
  }
  _networkRetryCount = 0;
}

// ---------- Sleep Timer ----------

let _sleepTimerInterval = null;
let _sleepTimerEnd = 0;
let _sleepFadeInterval = null;
const SLEEP_OPTIONS = [5, 10, 15, 30, 60];

async function handleSleepToggle() {
  if (_sleepTimerInterval) {
    const ok = await ui.confirmModal({
      title: 'SLEEP TIMER',
      message: 'Cancel the active sleep timer?',
    });
    if (ok) cancelSleepTimer();
    return;
  }

  const minutes = await ui.selectModal({
    title: 'SLEEP TIMER',
    message: 'Stop playback after:',
    options: SLEEP_OPTIONS.map(m => ({ label: `${m} min`, value: m })),
  });

  if (minutes == null) return;
  startSleepTimer(minutes);
}

function startSleepTimer(minutes) {
  cancelSleepTimer();
  _sleepTimerEnd = Date.now() + minutes * 60 * 1000;

  ui.toast(`Sleep timer: ${minutes} min`, { duration: 3000 });
  dlog('info', `Sleep timer started: ${minutes} min`);

  _sleepTimerInterval = setInterval(() => {
    const remaining = _sleepTimerEnd - Date.now();
    if (remaining <= 0) {
      triggerSleepTimer();
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    ui.updateSleepTimer(true, `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`);
  }, 1000);

  ui.updateSleepTimer(true, `${String(minutes).padStart(2, '0')}:00`);
}

function triggerSleepTimer() {
  clearInterval(_sleepTimerInterval);
  _sleepTimerInterval = null;

  dlog('info', 'Sleep timer — fading out');
  ui.toast('Sleep timer — fading out...', { duration: 5000 });

  const originalVolume = player.volume;
  let step = 0;
  const steps = 50;

  _sleepFadeInterval = setInterval(() => {
    step++;
    player.setVolume(originalVolume * (1 - step / steps));

    if (step >= steps) {
      clearInterval(_sleepFadeInterval);
      _sleepFadeInterval = null;
      player.pause();
      player.setVolume(originalVolume);
      ui.updateVolume();
      ui.updateSleepTimer(false);
      ui.toast('Goodnight!', { duration: 5000 });
      dlog('info', 'Sleep timer done — paused');
    }
  }, 100);
}

function cancelSleepTimer() {
  if (_sleepTimerInterval) { clearInterval(_sleepTimerInterval); _sleepTimerInterval = null; }
  if (_sleepFadeInterval) { clearInterval(_sleepFadeInterval); _sleepFadeInterval = null; }
  ui.updateSleepTimer(false);
  ui.toast('Sleep timer cancelled');
  dlog('info', 'Sleep timer cancelled');
}

// ---------- Proxy auto-detect ----------
// If served via server.py, the /proxy endpoint exists and we can use it
// to bypass CORP/CSP restrictions on hosts like Google Drive.

(async function detectProxy() {
  try {
    const res = await fetch('/proxy?url=', { method: 'GET' });
    _proxyAvailable = res.status === 400;
    dlog('info', `Proxy: ${_proxyAvailable ? 'AVAILABLE' : 'NOT FOUND'} (status ${res.status})`);
  } catch (e) {
    _proxyAvailable = false;
    dlog('warn', `Proxy: detection failed — ${e.message}`);
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
    onStop:  () => { player.stop(); visualizer.stop(); _lyricsLines = null; ui.clearLyrics(); },
    onPrev:  () => doPrev(),
    onNext:  () => doNext(),
    onLoadFile: (file) => loadM3UFile(file),
    onLoadUrl:  (url)  => loadM3UFromUrl(url),
    onClear: () => { playlist.clear(); player.stop(); visualizer.stop(); _lyricsLines = null; ui.clearLyrics(); persist(); },
    onTrackClick: (i) => {
      _cancelNetworkRetry();
      playlist.playAt(i);
      tryPlayCurrent();
      ui.activateMobileTab('main'); // jump to NOW PLAYING on mobile
    },
    onPlayerError: () => handlePlayerError(),
    onPersist: () => persist(),
    onLibraryRefresh: () => refreshLibrary(),
    onLibraryLoad: (id) => loadFromLibrary(id),
    onLibraryDelete: (id) => deleteFromLibrary(id),
    onSleepToggle: () => handleSleepToggle(),
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

  // Only restore UI state — don't load audio yet to avoid auto-play
  // and errors on refresh. Audio loads when user actually hits Play.
  if (playlist.current) {
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
  _cancelNetworkRetry();
  if (playlist.isEmpty) return;
  const t = playlist.prev();
  if (t) tryPlayCurrent();
}

function doNext(autoAdvance = false) {
  _cancelNetworkRetry();
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
  _loadGen++;
  const gen = _loadGen;
  const t = playlist.current;
  if (!t) { dlog('warn', 'tryPlay: no current track'); return; }
  const originalUrl = t.url;
  const finalUrl = maybeProxy(t.url);
  const proxied = finalUrl !== originalUrl;
  dlog('info', `LOAD #${playlist.currentIndex} "${t.title}" ${proxied ? '[PROXIED]' : '[DIRECT]'} (gen=${gen})`);
  dlog('info', `  URL: ${originalUrl.substring(0, 120)}`);
  if (proxied) dlog('info', `  Proxy: ${finalUrl.substring(0, 120)}`);
  player.load(finalUrl);
  player.play().catch((err) => {
    if (gen !== _loadGen) return; // stale error from previous track
    dlog('error', `play() rejected: ${err.name} — ${err.message}`);
  });
  persist();
}

function handlePlayerError() {
  if (_errorSkipTimer) return;
  if (_networkRetryOnlineHandler) return;

  const err = player.audio.error;

  // Error code 1 (ABORTED) when switching tracks is normal — the browser
  // aborts the previous download when a new src is set. Ignore it.
  if (err && err.code === 1) {
    dlog('info', `ABORTED (track switch) — ignored`);
    return;
  }

  // Check if this error belongs to a stale load (user skipped quickly).
  // When audio.src doesn't match what we last loaded, it's from the old track.
  const audioSrc = player.audio.currentSrc || player.audio.src || '';
  const expectedUrl = playlist.current ? maybeProxy(playlist.current.url) : '';
  if (expectedUrl && audioSrc) {
    const audioFull = new URL(audioSrc, window.location.href).href;
    const expectFull = new URL(expectedUrl, window.location.href).href;
    if (audioFull !== expectFull) {
      dlog('info', `Stale error (src mismatch) — ignored`);
      return;
    }
  }

  const codes = {
    1: 'ABORTED',
    2: 'NETWORK',
    3: 'DECODE',
    4: 'SRC_NOT_SUPPORTED',
  };
  const codeName = err && codes[err.code] ? codes[err.code] : 'UNKNOWN';
  const track = playlist.current;
  dlog('error', `ERROR on #${playlist.currentIndex} "${track ? track.title : '?'}": ${codeName} (code ${err ? err.code : '?'})`);
  dlog('error', `  message: ${err && err.message ? err.message : '(none)'}`);
  dlog('error', `  audio.src: ${audioSrc.substring(0, 120)}`);
  dlog('error', `  networkState: ${player.audio.networkState} | readyState: ${player.audio.readyState} | online: ${navigator.onLine}`);

  // NETWORK errors: retry with backoff
  if (err && err.code === 2 && _networkRetryCount < NETWORK_RETRY_DELAYS.length) {
    const attempt = _networkRetryCount + 1;
    const maxAttempts = NETWORK_RETRY_DELAYS.length;

    // Browser offline — wait for connectivity
    if (!navigator.onLine) {
      dlog('warn', `OFFLINE — waiting for connection to resume`);
      ui.flashLcd('*** OFFLINE ***', 60000);
      ui.toast(
        `Connection lost — waiting to reconnect… (${track ? track.title : '?'})`,
        { type: 'error', duration: 6000 }
      );
      _networkRetryOnlineHandler = () => {
        window.removeEventListener('online', _networkRetryOnlineHandler);
        _networkRetryOnlineHandler = null;
        dlog('info', 'ONLINE — retrying after offline wait');
        ui.flashLcd('*** RECONNECTING ***', 2000);
        ui.toast('Back online — retrying…', { duration: 2500 });
        tryPlayCurrent();
      };
      window.addEventListener('online', _networkRetryOnlineHandler);
      return;
    }

    const delay = NETWORK_RETRY_DELAYS[_networkRetryCount];
    dlog('warn', `RETRY ${attempt}/${maxAttempts} in ${delay}ms — "${track ? track.title : '?'}"`);
    ui.flashLcd(`*** RETRY ${attempt}/${maxAttempts} ***`, delay);
    ui.toast(
      `Network error — retrying ${attempt}/${maxAttempts}… (${track ? track.title : '?'})`,
      { type: 'error', duration: delay }
    );

    _networkRetryCount++;
    _errorSkipTimer = setTimeout(() => {
      _errorSkipTimer = null;
      tryPlayCurrent();
    }, delay);
    return;
  }

  // Non-retryable errors OR retries exhausted: skip
  dlog('error', `SKIP — ${codeName} (retries exhausted or non-retryable) → next track`);
  _networkRetryCount = 0;

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

// Reset retry state when playback starts successfully
player.addEventListener('play', () => {
  _networkRetryCount = 0;
  const t = playlist.current;
  dlog('info', `PLAYING #${playlist.currentIndex} "${t ? t.title : '?'}"`);
});

player.addEventListener('pause', () => {
  dlog('info', `PAUSED at ${player.currentTime.toFixed(1)}s`);
});

// Auto-advance when track ends naturally
player.addEventListener('ended', () => {
  dlog('info', `ENDED #${playlist.currentIndex} — advancing`);
  doNext(true);
});

// ---------- Auto Lyrics (lrclib.net) ----------

const _lyricsCache = new Map();
let _currentLyricsTitle = null;
let _lyricsLines = null;

function parseLRC(lrc) {
  if (!lrc) return null;
  const parsed = [];
  for (const line of lrc.split('\n')) {
    const m = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)/);
    if (m) {
      const time = parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3]) / (m[3].length === 3 ? 1000 : 100);
      parsed.push({ time, text: m[4].trim() });
    }
  }
  parsed.sort((a, b) => a.time - b.time);
  return parsed.length > 0 ? parsed : null;
}

function cleanTitle(title) {
  if (!title) return '';
  return title
    .replace(/\.[^.]+$/, '')          // remove file extension
    .replace(/\[.*?\]/g, '')          // remove [tags]
    .replace(/\(.*?\)/g, '')          // remove (tags)
    .replace(/^\d+[\.\-\s]+/, '')     // remove leading track numbers
    .replace(/[_]/g, ' ')             // underscores to spaces
    .trim();
}

async function fetchLyrics(trackTitle) {
  if (!trackTitle) return;
  const cleaned = cleanTitle(trackTitle);
  if (!cleaned) return;

  if (_lyricsCache.has(cleaned)) {
    displayLyrics(cleaned, _lyricsCache.get(cleaned));
    return;
  }

  _currentLyricsTitle = cleaned;
  ui.setLyricsStatus('Searching lyrics...', 'loading');
  dlog('info', `Lyrics search: "${cleaned}"`);

  try {
    const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleaned)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = await res.json();

    if (_currentLyricsTitle !== cleaned) return; // stale

    if (!Array.isArray(results) || results.length === 0) {
      _lyricsCache.set(cleaned, { synced: null, plain: null });
      _lyricsLines = null;
      ui.setLyricsStatus('No lyrics found');
      ui.clearLyrics();
      dlog('info', 'Lyrics: not found');
      return;
    }

    const best = results.find(r => r.syncedLyrics) || results.find(r => r.plainLyrics) || results[0];
    const entry = {
      synced: parseLRC(best.syncedLyrics),
      plain: best.plainLyrics || null,
      artist: best.artistName || '',
      track: best.trackName || '',
    };
    _lyricsCache.set(cleaned, entry);
    displayLyrics(cleaned, entry);
    dlog('info', `Lyrics: found "${best.trackName}" by "${best.artistName}" [${entry.synced ? 'SYNCED' : 'PLAIN'}]`);
  } catch (err) {
    if (_currentLyricsTitle !== cleaned) return;
    dlog('warn', `Lyrics fetch failed: ${err.message}`);
    ui.setLyricsStatus('Lyrics fetch failed');
  }
}

function displayLyrics(title, entry) {
  if (entry.synced) {
    _lyricsLines = entry.synced;
    ui.renderSyncedLyrics(entry.synced);
    const info = entry.artist ? `${entry.track} — ${entry.artist}` : title;
    ui.setLyricsStatus(`\u266A ${info} [SYNCED]`, 'synced');
  } else if (entry.plain) {
    _lyricsLines = null;
    ui.renderPlainLyrics(entry.plain);
    ui.setLyricsStatus(`\u266A ${title} [PLAIN]`);
  } else {
    _lyricsLines = null;
    ui.clearLyrics();
    ui.setLyricsStatus('No lyrics found');
  }
}

// Auto-fetch lyrics when track plays
player.addEventListener('play', () => {
  const t = playlist.current;
  if (t && t.title) fetchLyrics(t.title);
});

// Sync lyrics highlight with playback
player.addEventListener('timeupdate', () => {
  if (_lyricsLines) ui.updateLyricsHighlight(player.currentTime);
});

// ---------- Media Session (lock screen / control center) ----------

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => {
    player.resumeContext();
    doPlay();
  });
  navigator.mediaSession.setActionHandler('pause', () => player.pause());
  navigator.mediaSession.setActionHandler('stop', () => { player.stop(); visualizer.stop(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => {
    player.resumeContext();
    doPrev();
  });
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    player.resumeContext();
    doNext();
  });
  // iOS lock screen shows seekbackward/seekforward by default instead of
  // prev/next track. Map them to prev/next so the buttons work as expected.
  try { navigator.mediaSession.setActionHandler('seekbackward', () => {
    player.resumeContext();
    doPrev();
  }); } catch {}
  try { navigator.mediaSession.setActionHandler('seekforward', () => {
    player.resumeContext();
    doNext();
  }); } catch {}
}

const _artworkThemes = [
  { bg: '#0a0a0a', accent: '#00FF66', dim: '#006633', label: 'NEON GREEN' },
  { bg: '#0a0a1a', accent: '#00BFFF', dim: '#005580', label: 'CYBER BLUE' },
  { bg: '#1a0a0a', accent: '#FF4060', dim: '#801020', label: 'HOT PINK' },
  { bg: '#0a0a0a', accent: '#FFD700', dim: '#806B00', label: 'GOLD' },
  { bg: '#0f0a1a', accent: '#BF5FFF', dim: '#5F2F80', label: 'PURPLE HAZE' },
  { bg: '#0a1210', accent: '#00FFAA', dim: '#00804A', label: 'MINT' },
  { bg: '#1a0f0a', accent: '#FF8C00', dim: '#804600', label: 'ORANGE GLOW' },
  { bg: '#0a0a14', accent: '#5F9FFF', dim: '#2F4F80', label: 'COOL BLUE' },
  { bg: '#140a0a', accent: '#FF5555', dim: '#802A2A', label: 'RED ALERT' },
  { bg: '#0a140a', accent: '#7FFF00', dim: '#408000', label: 'CHARTREUSE' },
];

const _artworkIcons = [
  // play triangle
  (ctx, cx, cy, s, col) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.4, cy - s * 0.5);
    ctx.lineTo(cx - s * 0.4, cy + s * 0.5);
    ctx.lineTo(cx + s * 0.5, cy);
    ctx.closePath();
    ctx.fill();
  },
  // music note
  (ctx, cx, cy, s, col) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(cx - s * 0.2, cy + s * 0.3, s * 0.18, s * 0.13, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - s * 0.05, cy - s * 0.5, s * 0.06, s * 0.82);
    ctx.beginPath();
    ctx.moveTo(cx + s * 0.01, cy - s * 0.5);
    ctx.quadraticCurveTo(cx + s * 0.45, cy - s * 0.55, cx + s * 0.35, cy - s * 0.2);
    ctx.lineTo(cx + s * 0.28, cy - s * 0.22);
    ctx.quadraticCurveTo(cx + s * 0.38, cy - s * 0.48, cx + s * 0.01, cy - s * 0.42);
    ctx.closePath();
    ctx.fill();
  },
  // double notes (beamed)
  (ctx, cx, cy, s, col) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(cx - s * 0.3, cy + s * 0.35, s * 0.15, s * 0.1, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + s * 0.25, cy + s * 0.25, s * 0.15, s * 0.1, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - s * 0.17, cy - s * 0.45, s * 0.05, s * 0.82);
    ctx.fillRect(cx + s * 0.38, cy - s * 0.55, s * 0.05, s * 0.82);
    ctx.save();
    ctx.translate(cx - s * 0.17, cy - s * 0.45);
    ctx.rotate(-0.1);
    ctx.fillRect(0, 0, s * 0.6, s * 0.08);
    ctx.fillRect(0, s * 0.14, s * 0.6, s * 0.08);
    ctx.restore();
  },
  // headphones
  (ctx, cx, cy, s, col) => {
    ctx.strokeStyle = col;
    ctx.lineWidth = s * 0.07;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy - s * 0.05, s * 0.4, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.roundRect(cx - s * 0.5, cy + s * 0.05, s * 0.2, s * 0.38, s * 0.06);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(cx + s * 0.3, cy + s * 0.05, s * 0.2, s * 0.38, s * 0.06);
    ctx.fill();
  },
  // vinyl record
  (ctx, cx, cy, s, col) => {
    ctx.strokeStyle = col;
    ctx.lineWidth = s * 0.04;
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.48, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.35, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.08, 0, Math.PI * 2);
    ctx.fill();
  },
  // equalizer bars
  (ctx, cx, cy, s, col) => {
    ctx.fillStyle = col;
    const barW = s * 0.12;
    const gap = s * 0.06;
    const total = barW * 5 + gap * 4;
    const startX = cx - total / 2;
    const heights = [0.6, 0.9, 0.5, 0.8, 0.4];
    heights.forEach((h, i) => {
      const x = startX + i * (barW + gap);
      const barH = s * h;
      ctx.fillRect(x, cy + s * 0.45 - barH, barW, barH);
    });
  },
];

function generateArtwork(title) {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const theme = _artworkThemes[Math.floor(Math.random() * _artworkThemes.length)];
  const iconFn = _artworkIcons[Math.floor(Math.random() * _artworkIcons.length)];

  // Background gradient
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.7);
  grad.addColorStop(0, theme.bg === '#0a0a0a' ? '#1a1a1a' : theme.bg);
  grad.addColorStop(1, '#000');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Border
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 5;
  ctx.strokeRect(8, 8, size - 16, size - 16);
  ctx.strokeStyle = theme.dim;
  ctx.lineWidth = 1;
  ctx.strokeRect(20, 20, size - 40, size - 40);

  // "RETROPLAYER" label
  ctx.fillStyle = theme.dim;
  ctx.font = '600 22px "Press Start 2P", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('RETROPLAYER', size / 2, 56);

  // Random icon with glow
  ctx.shadowColor = theme.accent;
  ctx.shadowBlur = 25;
  iconFn(ctx, size / 2, 220, 160, theme.accent);
  ctx.shadowBlur = 0;

  // Track title
  ctx.fillStyle = theme.accent;
  ctx.font = '600 24px monospace';
  ctx.textAlign = 'center';
  const words = (title || 'Unknown').split(/\s+/);
  let lines = []; let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > size - 60) {
      lines.push(line); line = w;
    } else { line = test; }
  }
  if (line) lines.push(line);
  lines = lines.slice(0, 3);
  const startY = 370;
  lines.forEach((l, i) => ctx.fillText(l, size / 2, startY + i * 32));

  // Scanline effect
  ctx.fillStyle = 'rgba(0,0,0,0.1)';
  for (let y = 0; y < size; y += 4) {
    ctx.fillRect(0, y, size, 2);
  }

  return c.toDataURL('image/png');
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = playlist.current;
  if (!t) return;
  const artworkUrl = generateArtwork(t.title || 'Unknown Track');
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title || 'Unknown Track',
    artist: 'RetroPlayer',
    album: `Track ${playlist.currentIndex + 1} of ${playlist.tracks.length}`,
    artwork: [
      { src: artworkUrl, sizes: '512x512', type: 'image/png' },
    ],
  });
}

player.addEventListener('play', updateMediaSession);

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
    dlog('info', `Loading M3U file: ${file.name} (${(file.size / 1024).toFixed(1)}KB)`);
    const text = await file.text();
    const tracks = parseM3U(text);
    if (tracks.length === 0) {
      dlog('warn', 'M3U parsed but 0 tracks found');
      ui.toast('No tracks found in file.', { type: 'error' });
      return;
    }
    dlog('info', `M3U loaded: ${tracks.length} tracks`);
    tracks.forEach((t, i) => dlog('info', `  [${i}] ${t.title} → ${t.url.substring(0, 80)}`));
    playlist.load(tracks);
    ui.toast(`Loaded ${tracks.length} track${tracks.length === 1 ? '' : 's'} from ${file.name}`);
    persist();
    await autoSaveToLibrary(_nameFromFile(file.name), tracks);
  } catch (err) {
    dlog('error', `M3U file error: ${err.message}`);
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
