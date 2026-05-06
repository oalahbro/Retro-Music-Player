/**
 * Playlist — in-memory state for the loaded tracks.
 *
 * Emits 'change' (CustomEvent with { reason }) whenever the visible state
 * changes (load, currentIndex change, shuffle/repeat toggle, etc.).
 */
export class Playlist extends EventTarget {
  constructor() {
    super();
    this.tracks = [];
    this.currentIndex = -1;
    this.shuffle = false;
    this.repeat = 'off'; // 'off' | 'all' | 'one'
    this._shuffleOrder = []; // array of indices
    this._shufflePos = -1;
  }

  load(tracks, { autoplayIndex = -1 } = {}) {
    this.tracks = Array.isArray(tracks) ? tracks.slice() : [];
    this.currentIndex = autoplayIndex >= 0 && autoplayIndex < this.tracks.length
      ? autoplayIndex
      : -1;
    if (this.shuffle) this._regenerateShuffle();
    this._emit('load');
  }

  clear() {
    this.tracks = [];
    this.currentIndex = -1;
    this._shuffleOrder = [];
    this._shufflePos = -1;
    this._emit('clear');
  }

  get current() {
    if (this.currentIndex < 0 || this.currentIndex >= this.tracks.length) return null;
    return this.tracks[this.currentIndex];
  }

  get isEmpty() { return this.tracks.length === 0; }

  playAt(index) {
    if (index < 0 || index >= this.tracks.length) return null;
    this.currentIndex = index;
    if (this.shuffle) {
      this._shufflePos = this._shuffleOrder.indexOf(index);
      if (this._shufflePos < 0) this._regenerateShuffle(index);
    }
    this._emit('play');
    return this.current;
  }

  /**
   * @param {boolean} [autoAdvance=false] When the previous track ended naturally.
   *   In that case repeat=one returns the same index again.
   */
  next(autoAdvance = false) {
    if (this.tracks.length === 0) return null;

    if (autoAdvance && this.repeat === 'one' && this.currentIndex >= 0) {
      this._emit('play');
      return this.current;
    }

    let nextIdx;

    if (this.shuffle) {
      this._shufflePos++;
      if (this._shufflePos >= this._shuffleOrder.length) {
        if (this.repeat === 'all') {
          this._regenerateShuffle();
          this._shufflePos = 0;
        } else {
          this._shufflePos = this._shuffleOrder.length - 1;
          return null; // end of playlist
        }
      }
      nextIdx = this._shuffleOrder[this._shufflePos];
    } else {
      nextIdx = this.currentIndex + 1;
      if (nextIdx >= this.tracks.length) {
        if (this.repeat === 'all') nextIdx = 0;
        else return null;
      }
    }

    this.currentIndex = nextIdx;
    this._emit('play');
    return this.current;
  }

  prev() {
    if (this.tracks.length === 0) return null;

    let prevIdx;

    if (this.shuffle) {
      this._shufflePos--;
      if (this._shufflePos < 0) {
        if (this.repeat === 'all') {
          this._shufflePos = this._shuffleOrder.length - 1;
        } else {
          this._shufflePos = 0;
          return null;
        }
      }
      prevIdx = this._shuffleOrder[this._shufflePos];
    } else {
      prevIdx = this.currentIndex - 1;
      if (prevIdx < 0) {
        if (this.repeat === 'all') prevIdx = this.tracks.length - 1;
        else return null;
      }
    }

    this.currentIndex = prevIdx;
    this._emit('play');
    return this.current;
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.shuffle) this._regenerateShuffle(this.currentIndex);
    this._emit('shuffle');
  }

  cycleRepeat() {
    this.repeat = this.repeat === 'off' ? 'all'
      : this.repeat === 'all' ? 'one'
      : 'off';
    this._emit('repeat');
  }

  setShuffle(on) {
    if (this.shuffle === !!on) return;
    this.toggleShuffle();
  }

  setRepeat(mode) {
    if (['off', 'all', 'one'].includes(mode)) {
      this.repeat = mode;
      this._emit('repeat');
    }
  }

  _regenerateShuffle(forceFirstIndex = -1) {
    const indices = this.tracks.map((_, i) => i);
    // Fisher-Yates
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    // If we want the current track to be the "first" of the new order
    if (forceFirstIndex >= 0) {
      const at = indices.indexOf(forceFirstIndex);
      if (at > 0) {
        [indices[0], indices[at]] = [indices[at], indices[0]];
      }
      this._shufflePos = 0;
    } else {
      this._shufflePos = -1;
    }
    this._shuffleOrder = indices;
  }

  _emit(reason) {
    this.dispatchEvent(new CustomEvent('change', { detail: { reason } }));
  }
}
