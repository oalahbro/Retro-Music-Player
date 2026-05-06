/**
 * ui.js — DOM bindings + rendering.
 */

import { formatDuration } from './m3u-parser.js';
import { formatImported } from './library.js';

export class UI {
  constructor({ player, playlist, visualizer, library, callbacks }) {
    this.player = player;
    this.playlist = playlist;
    this.visualizer = visualizer;
    this.library = library;
    this.cb = callbacks;
    this._activeLibraryId = null;

    this.el = {
      audio: document.getElementById('audio'),
      lcdTime: document.getElementById('lcd-time'),
      lcdTitle: document.getElementById('lcd-title'),
      lcdBitrate: document.getElementById('lcd-bitrate'),
      lcdFreq: document.getElementById('lcd-freq'),
      lcdChannel: document.getElementById('lcd-channel'),
      btnPrev: document.getElementById('btn-prev'),
      btnPlay: document.getElementById('btn-play'),
      btnPause: document.getElementById('btn-pause'),
      btnStop: document.getElementById('btn-stop'),
      btnNext: document.getElementById('btn-next'),
      btnMute: document.getElementById('btn-mute'),
      btnShuffle: document.getElementById('btn-shuffle'),
      btnRepeat: document.getElementById('btn-repeat'),
      volume: document.getElementById('volume'),
      btnLoadFile: document.getElementById('btn-load-file'),
      btnLoadUrl: document.getElementById('btn-load-url'),
      btnClear: document.getElementById('btn-clear'),
      fileInput: document.getElementById('file-input'),
      playlist: document.getElementById('playlist'),
      playlistEmpty: document.getElementById('playlist-empty'),
      playlistCount: document.getElementById('playlist-count'),
      dropOverlay: document.getElementById('drop-overlay'),
      toastContainer: document.getElementById('toast-container'),
      mainWindow: document.getElementById('main-window'),
      playlistWindow: document.getElementById('playlist-window'),
      libraryWindow: document.getElementById('library-window'),
      libraryStatus: document.getElementById('library-status'),
      libraryList: document.getElementById('library-list'),
      libraryEmpty: document.getElementById('library-empty'),
      btnLibraryRefresh: document.getElementById('btn-library-refresh'),
      mobileTabs: document.getElementById('mobile-tabs'),
      modal: document.getElementById('modal'),
      modalTitle: document.getElementById('modal-title'),
      modalMessage: document.getElementById('modal-message'),
      modalInput: document.getElementById('modal-input'),
      modalOk: document.getElementById('modal-ok'),
      modalCancel: document.getElementById('modal-cancel'),
    };

    this._lastTitle = '';
    this._tempLcdTimer = null;
  }

  init() {
    this._bindTransport();
    this._bindControls();
    this._bindLoaders();
    this._bindLibrary();
    this._bindDragDrop();
    this._bindWindowDrag();
    this._bindPlayerEvents();
    this._bindPlaylistEvents();
    this._bindLibraryEvents();
    this._bindMobileTabs();
    this._bindModal();

    // Initialize default active tab on mobile
    this.activateMobileTab('main');

    this.renderPlaylist();
    this.renderLibrary();
    this.updateTransport();
    this.updateVolume();
    this.updateShuffleRepeat();
  }

  // ---------- Bindings ----------

  _bindTransport() {
    this.el.btnPrev.addEventListener('click', () => this.cb.onPrev());
    this.el.btnNext.addEventListener('click', () => this.cb.onNext());
    this.el.btnPlay.addEventListener('click', () => this.cb.onPlay());
    this.el.btnPause.addEventListener('click', () => this.cb.onPause());
    this.el.btnStop.addEventListener('click', () => this.cb.onStop());
  }

  _bindControls() {
    this.el.btnMute.addEventListener('click', () => {
      this.player.setMute(!this.player.muted);
      this.updateVolume();
      this.cb.onPersist();
    });

    this.el.volume.addEventListener('input', () => {
      const v = Number(this.el.volume.value) / 100;
      this.player.setVolume(v);
      if (v > 0 && this.player.muted) this.player.setMute(false);
      this.updateVolume();
      this.cb.onPersist();
    });

    this.el.btnShuffle.addEventListener('click', () => {
      this.playlist.toggleShuffle();
      this.cb.onPersist();
    });

    this.el.btnRepeat.addEventListener('click', () => {
      this.playlist.cycleRepeat();
      this.cb.onPersist();
    });
  }

  _bindLoaders() {
    this.el.btnLoadFile.addEventListener('click', () => this.el.fileInput.click());
    this.el.fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) this.cb.onLoadFile(file);
      this.el.fileInput.value = '';
    });

    this.el.btnLoadUrl.addEventListener('click', async () => {
      const url = await this.promptModal({
        title: 'LOAD M3U FROM URL',
        message: 'Paste an .m3u/.m3u8 playlist URL:',
        placeholder: 'https://example.com/playlist.m3u',
      });
      if (url && url.trim()) this.cb.onLoadUrl(url.trim());
    });

    this.el.btnClear.addEventListener('click', async () => {
      if (this.playlist.isEmpty) return;
      const ok = await this.confirmModal({
        title: 'CLEAR PLAYLIST',
        message: 'Remove all tracks from the current playlist?',
      });
      if (ok) this.cb.onClear();
    });

    this.el.playlist.addEventListener('click', (e) => {
      const item = e.target.closest('.playlist__item');
      if (!item) return;
      const idx = Number(item.dataset.index);
      if (!Number.isNaN(idx)) this.cb.onTrackClick(idx);
    });
  }

  _bindDragDrop() {
    let dragDepth = 0;

    const isFileDrag = (e) =>
      e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

    window.addEventListener('dragenter', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth++;
      this.el.dropOverlay.hidden = false;
    });

    window.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('dragleave', (e) => {
      if (!isFileDrag(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) this.el.dropOverlay.hidden = true;
    });

    window.addEventListener('drop', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth = 0;
      this.el.dropOverlay.hidden = true;
      const file = e.dataTransfer.files[0];
      if (file) this.cb.onLoadFile(file);
    });
  }

  _bindWindowDrag() {
    // Skip on mobile — accidental drags from tab area are jarring on touch.
    const mq = window.matchMedia('(max-width: 720px)');
    if (mq.matches) return;
    [this.el.mainWindow, this.el.playlistWindow, this.el.libraryWindow].forEach((win) => {
      if (!win) return;
      const handle = win.querySelector('[data-drag-handle]');
      if (!handle) return;
      this._makeDraggable(win, handle);
    });
  }

  _bindLibrary() {
    if (!this.el.btnLibraryRefresh) return;
    this.el.btnLibraryRefresh.addEventListener('click', () => {
      this.cb.onLibraryRefresh();
    });

    this.el.libraryList.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('.library-item__delete');
      if (delBtn) {
        const item = delBtn.closest('.library-item');
        const id = item && item.dataset.id;
        if (!id) return;
        const ok = await this.confirmModal({
          title: 'DELETE PLAYLIST',
          message: `Permanently delete "${item.dataset.name || ''}" from the library?`,
        });
        if (ok) this.cb.onLibraryDelete(id);
        return;
      }

      const item = e.target.closest('.library-item');
      if (!item) return;
      const id = item.dataset.id;
      if (id) this.cb.onLibraryLoad(id);
    });
  }

  _bindLibraryEvents() {
    if (!this.library) return;
    this.library.addEventListener('change', () => this.renderLibrary());
  }

  // ---------- Mobile tabs ----------

  _bindMobileTabs() {
    if (!this.el.mobileTabs) return;
    this.el.mobileTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.mobile-tab');
      if (!btn) return;
      const target = btn.dataset.tab;
      if (target) this.activateMobileTab(target);
    });
  }

  activateMobileTab(name) {
    const map = {
      main: this.el.mainWindow,
      playlist: this.el.playlistWindow,
      library: this.el.libraryWindow,
    };
    if (!map[name]) return;
    Object.entries(map).forEach(([key, win]) => {
      if (!win) return;
      win.classList.toggle('is-active-tab', key === name);
    });
    if (this.el.mobileTabs) {
      const tabs = this.el.mobileTabs.querySelectorAll('.mobile-tab');
      tabs.forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
    }
  }

  // ---------- Modal (prompt / confirm) ----------

  _bindModal() {
    if (!this.el.modal) return;
    this.el.modal.addEventListener('click', (e) => {
      if (e.target.dataset.modalClose !== undefined) {
        this._resolveModal(null);
      }
    });
    this.el.modalCancel.addEventListener('click', () => this._resolveModal(null));
    this.el.modalOk.addEventListener('click', () => {
      const value = this._modalMode === 'prompt' ? this.el.modalInput.value : true;
      this._resolveModal(value);
    });
    this.el.modalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.el.modalOk.click();
      } else if (e.key === 'Escape') {
        this._resolveModal(null);
      }
    });
  }

  _resolveModal(value) {
    if (!this.el.modal || this.el.modal.hidden) return;
    this.el.modal.hidden = true;
    document.body.style.overflow = '';
    if (this._modalResolver) {
      this._modalResolver(value);
      this._modalResolver = null;
    }
  }

  promptModal({ title = 'INPUT', message = '', placeholder = '', defaultValue = '' } = {}) {
    return new Promise((resolve) => {
      this._modalMode = 'prompt';
      this._modalResolver = resolve;
      this.el.modalTitle.textContent = title;
      this.el.modalMessage.textContent = message;
      this.el.modalInput.placeholder = placeholder;
      this.el.modalInput.value = defaultValue;
      this.el.modalInput.hidden = false;
      this.el.modalCancel.hidden = false;
      this.el.modalCancel.textContent = 'CANCEL';
      this.el.modalOk.textContent = 'OK';
      this.el.modal.hidden = false;
      document.body.style.overflow = 'hidden';
      // Focus input after layout
      setTimeout(() => this.el.modalInput.focus(), 50);
    });
  }

  confirmModal({ title = 'CONFIRM', message = 'Are you sure?' } = {}) {
    return new Promise((resolve) => {
      this._modalMode = 'confirm';
      this._modalResolver = (v) => resolve(v === true);
      this.el.modalTitle.textContent = title;
      this.el.modalMessage.textContent = message;
      this.el.modalInput.hidden = true;
      this.el.modalCancel.hidden = false;
      this.el.modalOk.textContent = 'YES';
      this.el.modalCancel.textContent = 'NO';
      this.el.modal.hidden = false;
      document.body.style.overflow = 'hidden';
      setTimeout(() => this.el.modalOk.focus(), 50);
    });
  }

  _makeDraggable(win, handle) {
    let dragging = false;
    let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.window__title-controls')) return;
      dragging = true;
      handle.setPointerCapture(e.pointerId);

      // Switch from flex layout to absolute positioning on first drag
      if (!win.style.position || win.style.position !== 'absolute') {
        const rect = win.getBoundingClientRect();
        win.style.position = 'absolute';
        win.style.left = rect.left + 'px';
        win.style.top = rect.top + 'px';
        win.style.margin = '0';
      }

      startX = e.clientX;
      startY = e.clientY;
      baseLeft = parseFloat(win.style.left) || 0;
      baseTop = parseFloat(win.style.top) || 0;
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      win.style.left = (baseLeft + dx) + 'px';
      win.style.top = Math.max(0, baseTop + dy) + 'px';
    });

    const stop = () => { dragging = false; };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  _bindPlayerEvents() {
    this.player.addEventListener('play', () => {
      this.updateTransport();
      this.visualizer.start();
      // Hook analyser if newly available
      const an = this.player.getAnalyser();
      if (an) this.visualizer.setAnalyser(an);
    });
    this.player.addEventListener('pause', () => {
      this.updateTransport();
    });
    this.player.addEventListener('ended', () => {
      this.updateTransport();
    });
    this.player.addEventListener('timeupdate', () => {
      this.updateTime();
      this.cb.onPersist();
    });
    this.player.addEventListener('loadedmetadata', () => {
      this.updateMeta();
    });
    this.player.addEventListener('volumechange', () => {
      this.updateVolume();
    });
    this.player.addEventListener('error', () => {
      this.cb.onPlayerError();
    });
  }

  _bindPlaylistEvents() {
    this.playlist.addEventListener('change', (e) => {
      const reason = e.detail && e.detail.reason;
      this.renderPlaylist();
      this.updateShuffleRepeat();
      if (reason === 'load' || reason === 'clear') {
        this.updateTitleFromCurrent();
      }
    });
  }

  // ---------- Rendering ----------

  renderPlaylist() {
    const list = this.el.playlist;
    const tracks = this.playlist.tracks;

    list.innerHTML = '';

    if (tracks.length === 0) {
      this.el.playlistEmpty.hidden = false;
      this.el.playlist.style.display = 'none';
    } else {
      this.el.playlistEmpty.hidden = true;
      this.el.playlist.style.display = '';
    }

    const frag = document.createDocumentFragment();
    tracks.forEach((track, i) => {
      const li = document.createElement('li');
      li.className = 'playlist__item';
      if (i === this.playlist.currentIndex) li.classList.add('is-current');
      li.dataset.index = i;

      const idx = document.createElement('span');
      idx.className = 'playlist__index';
      idx.textContent = String(i + 1).padStart(2, '0') + '.';

      const title = document.createElement('span');
      title.className = 'playlist__title';
      title.textContent = track.title || track.url;

      const dur = document.createElement('span');
      dur.className = 'playlist__duration';
      dur.textContent = track.duration > 0 ? formatDuration(track.duration) : '';

      li.append(idx, title, dur);
      frag.appendChild(li);
    });
    list.appendChild(frag);

    this.el.playlistCount.textContent =
      `${tracks.length} track${tracks.length === 1 ? '' : 's'}`;

    // Scroll current into view
    const current = list.querySelector('.is-current');
    if (current) current.scrollIntoView({ block: 'nearest' });

    this.updateTitleFromCurrent();
  }

  updateTransport() {
    const playing = !this.player.paused;
    this.el.btnPlay.classList.toggle('is-active', playing);
    this.el.btnPause.classList.toggle('is-active', !playing && this.player.currentTime > 0);
  }

  updateTime() {
    if (this._tempLcdTimer) return; // don't overwrite temp messages
    const t = this.player.currentTime || 0;
    this.el.lcdTime.textContent = formatDuration(t);
  }

  updateMeta() {
    const d = this.player.duration;
    if (isFinite(d) && d > 0) {
      // Estimate bitrate is hard without raw data; we just show duration label
      this.el.lcdBitrate.textContent = '128';
      this.el.lcdFreq.textContent = '44';
    }
  }

  updateVolume() {
    const v = this.player.volume;
    const muted = this.player.muted;
    if (Number(this.el.volume.value) !== Math.round(v * 100)) {
      this.el.volume.value = String(Math.round(v * 100));
    }
    this.el.btnMute.textContent = muted || v === 0 ? '🔇' : v < 0.5 ? '🔉' : '🔊';
  }

  updateShuffleRepeat() {
    this.el.btnShuffle.classList.toggle('is-on', this.playlist.shuffle);
    const repeatBtn = this.el.btnRepeat;
    repeatBtn.classList.toggle('is-on', this.playlist.repeat !== 'off');
    repeatBtn.dataset.mode = this.playlist.repeat;
    repeatBtn.title = `Repeat: ${this.playlist.repeat}`;
  }

  updateTitleFromCurrent() {
    const t = this.playlist.current;
    const text = t ? t.title : '*** NO PLAYLIST LOADED ***';
    this.setLcdTitle(text);
  }

  setLcdTitle(text) {
    this._lastTitle = text;
    const el = this.el.lcdTitle;
    el.textContent = text;
    // Disable scrolling for short titles that fit
    requestAnimationFrame(() => {
      const overflows = el.scrollWidth > el.parentElement.clientWidth;
      el.classList.toggle('no-scroll', !overflows);
    });
  }

  /** Show a temporary message in the LCD time area for `ms` milliseconds. */
  flashLcd(text, ms = 2000) {
    if (this._tempLcdTimer) clearTimeout(this._tempLcdTimer);
    this.el.lcdTime.textContent = text;
    this._tempLcdTimer = setTimeout(() => {
      this._tempLcdTimer = null;
      this.updateTime();
    }, ms);
  }

  setLibraryStatus(text, kind = 'idle') {
    if (!this.el.libraryStatus) return;
    this.el.libraryStatus.textContent = text;
    this.el.libraryStatus.classList.toggle('is-online', kind === 'online');
    this.el.libraryStatus.classList.toggle('is-offline', kind === 'offline');
  }

  setActiveLibraryId(id) {
    this._activeLibraryId = id || null;
    this.renderLibrary();
  }

  renderLibrary() {
    if (!this.el.libraryList || !this.library) return;
    const items = this.library.items;
    const list = this.el.libraryList;
    list.innerHTML = '';

    if (!this.library.available) {
      this.el.libraryEmpty.hidden = true;
      list.style.display = 'none';
      return;
    }

    if (items.length === 0) {
      this.el.libraryEmpty.hidden = false;
      list.style.display = 'none';
      return;
    }
    this.el.libraryEmpty.hidden = true;
    list.style.display = '';

    const frag = document.createDocumentFragment();
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'library-item';
      if (it.id === this._activeLibraryId) li.classList.add('is-active');
      li.dataset.id = it.id;
      li.dataset.name = it.name || '';

      const main = document.createElement('div');
      main.className = 'library-item__main';

      const name = document.createElement('div');
      name.className = 'library-item__name';
      name.textContent = it.name || 'Untitled';

      const meta = document.createElement('div');
      meta.className = 'library-item__meta';
      const dateStr = formatImported(it.importedAt);
      meta.textContent = `${it.trackCount || 0} tracks${dateStr ? ' · ' + dateStr : ''}`;

      main.append(name, meta);

      const del = document.createElement('button');
      del.className = 'library-item__delete';
      del.textContent = '×';
      del.title = 'Delete';

      li.append(main, del);
      frag.appendChild(li);
    }
    list.appendChild(frag);
  }

  toast(message, { type = 'info', duration = 4000 } = {}) {
    const div = document.createElement('div');
    div.className = 'toast' + (type === 'error' ? ' toast--error' : '');
    div.textContent = message;
    this.el.toastContainer.appendChild(div);
    setTimeout(() => {
      div.remove();
    }, duration);
  }
}
