/**
 * Player — wrapper around HTMLAudioElement with Web Audio API.
 *
 * - Desktop: AudioContext + GainNode for software volume + AnalyserNode for visualizer
 * - iOS: Native <audio> playback for background audio support. Volume is
 *   hardware-only (iOS Safari limitation — audio.volume is read-only).
 *
 * Emits events via EventTarget:
 *   'play', 'pause', 'ended', 'error', 'timeupdate', 'loadedmetadata', 'volumechange'
 */

const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class Player extends EventTarget {
  constructor(audioEl) {
    super();
    this.audio = audioEl;

    this._audioCtx = null;
    this._analyser = null;
    this._gainNode = null;
    this._sourceNode = null;
    this._analyserAvailable = false;
    this._volume = 0.8;
    this._muted = false;

    const forward = (name) => () => this.dispatchEvent(new Event(name));
    this.audio.addEventListener('play', forward('play'));
    this.audio.addEventListener('pause', forward('pause'));
    this.audio.addEventListener('ended', forward('ended'));
    this.audio.addEventListener('timeupdate', forward('timeupdate'));
    this.audio.addEventListener('loadedmetadata', forward('loadedmetadata'));
    this.audio.addEventListener('error', () => {
      this.dispatchEvent(new CustomEvent('error', {
        detail: this.audio.error,
      }));
    });
  }

  load(url) {
    this.audio.src = url;
    this.audio.load();
  }

  async play() {
    if (!_isIOS) {
      this._initAudioContextLazy();
    }
    try {
      await this.audio.play();
    } catch (err) {
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
      throw err;
    }
  }

  pause() { this.audio.pause(); }

  stop() {
    this.audio.pause();
    try { this.audio.currentTime = 0; } catch {}
  }

  setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    this._volume = v;
    this._applyVolume();
    this.dispatchEvent(new Event('volumechange'));
  }

  setMute(muted) {
    this._muted = !!muted;
    this._applyVolume();
    this.dispatchEvent(new Event('volumechange'));
  }

  _applyVolume() {
    const effectiveVol = this._muted ? 0 : this._volume;
    if (this._gainNode) {
      this._gainNode.gain.value = effectiveVol;
      try { this.audio.volume = 1; this.audio.muted = false; } catch {}
    } else {
      try {
        this.audio.volume = this._volume;
        this.audio.muted = this._muted;
      } catch {}
    }
  }

  get volume() { return this._volume; }
  get muted() { return this._muted; }
  get currentTime() { return this.audio.currentTime; }
  get duration() { return this.audio.duration; }
  get paused() { return this.audio.paused; }
  get isIOS() { return _isIOS; }

  getAnalyser() {
    return this._analyser;
  }

  resumeContext() {
    if (this._audioCtx && this._audioCtx.state !== 'running') {
      this._audioCtx.resume().catch(() => {});
    }
  }

  _initAudioContextLazy() {
    if (this._audioCtx) {
      if (this._audioCtx.state === 'suspended') {
        this._audioCtx.resume().catch(() => {});
      }
      return;
    }

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;

      this._audioCtx = new Ctx();
      this._sourceNode = this._audioCtx.createMediaElementSource(this.audio);
      this._analyser = this._audioCtx.createAnalyser();
      this._analyser.fftSize = 128;
      this._analyser.smoothingTimeConstant = 0.7;
      this._gainNode = this._audioCtx.createGain();
      this._gainNode.gain.value = this._muted ? 0 : this._volume;

      this._sourceNode.connect(this._analyser);
      this._analyser.connect(this._gainNode);
      this._gainNode.connect(this._audioCtx.destination);

      this._analyserAvailable = true;
    } catch (err) {
      console.warn('[player] AudioContext init failed:', err);
      this._analyser = null;
      this._gainNode = null;
      this._analyserAvailable = false;
    }
  }
}
