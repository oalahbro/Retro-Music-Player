/**
 * Player — wrapper around HTMLAudioElement with Web Audio AnalyserNode hookup.
 *
 * Emits events via EventTarget:
 *   'play', 'pause', 'ended', 'error', 'timeupdate', 'loadedmetadata', 'volumechange'
 */
export class Player extends EventTarget {
  constructor(audioEl) {
    super();
    this.audio = audioEl;
    // NOTE: crossOrigin is intentionally NOT set. Many real-world audio hosts
    // (Google Drive, etc.) send Cross-Origin-Resource-Policy: same-site which
    // blocks audio loading when crossOrigin="anonymous" is set. Without it,
    // playback works for all hosts but the AudioContext route is disabled
    // (visualizer falls back to sine-wave animation).

    this._audioCtx = null;
    this._analyser = null;
    this._sourceNode = null;
    this._analyserAvailable = false;

    const forward = (name) => () => this.dispatchEvent(new Event(name));
    this.audio.addEventListener('play', forward('play'));
    this.audio.addEventListener('pause', forward('pause'));
    this.audio.addEventListener('ended', forward('ended'));
    this.audio.addEventListener('timeupdate', forward('timeupdate'));
    this.audio.addEventListener('loadedmetadata', forward('loadedmetadata'));
    this.audio.addEventListener('volumechange', forward('volumechange'));
    this.audio.addEventListener('error', () => {
      this.dispatchEvent(new CustomEvent('error', {
        detail: this.audio.error,
      }));
    });
  }

  /** Load a new URL into the audio element (does not auto-play) */
  load(url) {
    this.audio.src = url;
    this.audio.load();
  }

  async play() {
    try {
      await this.audio.play();
    } catch (err) {
      // Autoplay policy or load error
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
    this.audio.volume = Math.max(0, Math.min(1, v));
  }

  setMute(muted) {
    this.audio.muted = !!muted;
  }

  get volume() { return this.audio.volume; }
  get muted() { return this.audio.muted; }
  get currentTime() { return this.audio.currentTime; }
  get duration() { return this.audio.duration; }
  get paused() { return this.audio.paused; }

  /**
   * Returns AnalyserNode if available, else null.
   * Only available after first play AND if CORS allows reading samples.
   */
  getAnalyser() {
    return this._analyser;
  }

  _initAudioContextLazy() {
    if (this._audioCtx) {
      // Resume if suspended (Chrome autoplay policy)
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

      this._sourceNode.connect(this._analyser);
      this._analyser.connect(this._audioCtx.destination);

      this._analyserAvailable = true;
    } catch (err) {
      // CORS or other failure — analyser unavailable, but audio still plays
      // through normal HTMLAudioElement path (we did not connect anything).
      console.warn('[player] AudioContext init failed:', err);
      this._analyser = null;
      this._analyserAvailable = false;
    }
  }
}
