/* global document */
class BootSplash {
  constructor() {
    this.root = document.getElementById('boot-splash');
    this.bar = document.getElementById('boot-splash-bar');
    this.messageEl = document.getElementById('boot-splash-message');
  }

  async show({ message, minDurationMs = 5000, fadeMs = 300 } = {}) {
    if (!this.root) return;
    this.messageEl.textContent = message || '';
    this.root.style.display = 'flex';
    this.root.classList.remove('fading');
    void this.bar.offsetHeight;

    this.bar.classList.add('active');

    await new Promise((r) => setTimeout(r, minDurationMs));

    this.root.classList.add('fading');
    await new Promise((r) => setTimeout(r, fadeMs));
    this.root.style.display = 'none';
    this.bar.classList.remove('active');
  }
}

window.BootSplash = BootSplash;
