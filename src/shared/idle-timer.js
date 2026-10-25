// Fires onIdle once after timeoutMs without a poke(). Re-armed by the next poke().
class IdleTimer {
  constructor({ timeoutMs, onIdle, setTimeout = globalThis.setTimeout.bind(globalThis), clearTimeout = globalThis.clearTimeout.bind(globalThis) }) {
    this.timeoutMs = timeoutMs;
    this.onIdle = onIdle;
    this._setTimeout = setTimeout;
    this._clearTimeout = clearTimeout;
    this._timer = null;
  }

  poke() {
    this.stop();
    this._timer = this._setTimeout(() => {
      this._timer = null;
      this.onIdle();
    }, this.timeoutMs);
  }

  setTimeoutMs(ms) {
    this.timeoutMs = ms;
    if (this._timer !== null) this.poke();
  }

  stop() {
    if (this._timer !== null) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = IdleTimer;
}
if (typeof window !== 'undefined') {
  window.IdleTimer = IdleTimer;
}
