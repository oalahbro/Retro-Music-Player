/**
 * Visualizer — bar-style frequency analyzer drawn on a canvas.
 * Falls back to a static sine-wave animation if AnalyserNode is unavailable
 * (typically due to CORS on the audio source).
 */
export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyser = null;
    this._raf = null;
    this._dataArray = null;
    this._fallbackPhase = 0;
    this._barCount = 16;
    this._barPeaks = new Array(this._barCount).fill(0);
    this._isPlaying = false;
  }

  setAnalyser(analyser) {
    this.analyser = analyser;
    if (analyser) {
      this._dataArray = new Uint8Array(analyser.frequencyBinCount);
    }
  }

  start() {
    if (this._raf) return;
    this._isPlaying = true;
    const tick = () => {
      this._draw();
      this._raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    this._isPlaying = false;
    // keep RAF running briefly so peaks settle, then stop
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    this._drawIdle();
  }

  _draw() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (this.analyser && this._dataArray) {
      this.analyser.getByteFrequencyData(this._dataArray);
      this._drawBars(w, h);
    } else {
      this._drawFallback(w, h);
    }
  }

  _drawBars(w, h) {
    const ctx = this.ctx;
    const bins = this._dataArray;
    const barCount = this._barCount;
    const barWidth = Math.floor(w / barCount) - 1;
    const gap = 1;

    // Sample bins logarithmically for a more musical look
    const totalBins = bins.length;

    for (let i = 0; i < barCount; i++) {
      // Use a curve so low frequencies aren't squished
      const t1 = Math.pow(i / barCount, 1.6);
      const t2 = Math.pow((i + 1) / barCount, 1.6);
      const startBin = Math.floor(t1 * totalBins);
      const endBin = Math.max(startBin + 1, Math.floor(t2 * totalBins));

      let sum = 0;
      for (let b = startBin; b < endBin; b++) sum += bins[b];
      const value = sum / (endBin - startBin); // 0..255

      const targetH = (value / 255) * h;

      // Peak hold + falloff
      if (targetH > this._barPeaks[i]) {
        this._barPeaks[i] = targetH;
      } else {
        this._barPeaks[i] = Math.max(0, this._barPeaks[i] - 1.5);
      }

      const barH = this._barPeaks[i];
      const x = i * (barWidth + gap);
      const y = h - barH;

      // Gradient: green → yellow → red
      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, '#00ff66');
      grad.addColorStop(0.6, '#ffff00');
      grad.addColorStop(1, '#ff5050');

      ctx.fillStyle = grad;
      ctx.fillRect(x, y, barWidth, barH);

      // Peak marker (small bright tip)
      if (barH > 1) {
        ctx.fillStyle = '#aaffaa';
        ctx.fillRect(x, y, barWidth, 1);
      }
    }
  }

  _drawFallback(w, h) {
    const ctx = this.ctx;
    this._fallbackPhase += 0.06;

    if (!this._isPlaying) {
      this._drawIdle();
      return;
    }

    ctx.strokeStyle = '#00ff66';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = '#00ff66';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const y =
        h / 2 +
        Math.sin(x * 0.08 + this._fallbackPhase) * (h * 0.3) +
        Math.sin(x * 0.03 - this._fallbackPhase * 0.6) * (h * 0.1);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  _drawIdle() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#006633';
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }
}
