/* global document */
class BootSplash {
  constructor() {
    this.root = document.getElementById('boot-splash');
    this.bar = document.getElementById('boot-splash-bar');
    this.messageEl = document.getElementById('boot-splash-message');
  }

  async show({ message, task, minDurationMs = 2000, fadeMs = 300 } = {}) {
    if (!this.root) return;
    this.messageEl.textContent = message || '';
    this.root.style.display = 'flex';
    this.root.classList.remove('fading');
    void this.bar.offsetHeight;

    const stops = ['#EC008C', '#F58220', '#00ADA7', '#2B3990'];
    const stopDuration = minDurationMs / (stops.length - 1);
    this.bar.classList.add('active');

    for (let i = 1; i < stops.length; i++) {
      await new Promise((r) => setTimeout(r, stopDuration));
      this.bar.style.backgroundColor = stops[i];
    }

    if (task && typeof task.then === 'function') {
      try { await task; } catch (err) { console.warn('BootSplash task failed', err); }
    }

    this.root.classList.add('fading');
    await new Promise((r) => setTimeout(r, fadeMs));
    this.root.style.display = 'none';
    this.bar.classList.remove('active');
    this.bar.style.backgroundColor = '';
  }
}

window.BootSplash = BootSplash;
