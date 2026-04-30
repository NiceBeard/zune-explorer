/* global document */
class SettingsView {
  constructor(explorer) {
    this.explorer = explorer;
    this.isOpen = false;
    this.stack = [];
  }

  render() {
    this.isOpen = true;
    const fileDisplay = document.getElementById('file-display');
    const contentPanel = document.getElementById('content-panel');
    contentPanel.classList.add('hero-mode');
    fileDisplay.innerHTML = '';
    const view = document.createElement('div');
    view.className = 'category-view settings-view';
    const hero = document.createElement('div');
    hero.className = 'hero-header';
    hero.textContent = 'settings';
    view.appendChild(hero);
    const list = document.createElement('div');
    list.className = 'settings-list';
    list.innerHTML = '<div class="settings-row placeholder">coming soon…</div>';
    view.appendChild(list);
    fileDisplay.appendChild(view);
  }

  refresh() { if (this.isOpen) this.render(); }
}

window.SettingsView = SettingsView;
