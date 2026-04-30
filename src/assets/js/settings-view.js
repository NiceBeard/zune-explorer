/* global document */
class SettingsView {
  constructor(explorer) {
    this.explorer = explorer;
    this.isOpen = false;
    this.stack = [];
    this._appVersion = null;
    (async () => {
      try { this._appVersion = await window.electronAPI.getAppVersion(); } catch {}
    })();
  }

  render() {
    this.isOpen = true;
    this.stack = [{ title: 'settings', buildItems: () => this._rootItems() }];
    this._draw();
  }

  refresh() { if (this.isOpen) this._draw(); }

  push(pageDescriptor) {
    this.stack.push(pageDescriptor);
    this._draw();
  }

  pop() {
    if (this.stack.length <= 1) {
      this.isOpen = false;
      this.explorer.showMenu?.();
      return;
    }
    this.stack.pop();
    this._draw();
  }

  _draw() {
    const fileDisplay = document.getElementById('file-display');
    const contentPanel = document.getElementById('content-panel');
    contentPanel.classList.add('hero-mode');
    fileDisplay.innerHTML = '';

    const page = this.stack[this.stack.length - 1];
    const view = document.createElement('div');
    view.className = 'category-view settings-view';

    const hero = document.createElement('div');
    hero.className = 'hero-header';
    hero.textContent = page.title;
    view.appendChild(hero);

    const content = document.createElement('div');
    content.className = 'category-content settings-content';

    const list = document.createElement('div');
    list.className = 'settings-list';
    for (const item of page.buildItems()) {
      list.appendChild(this._renderItem(item));
    }
    content.appendChild(list);
    view.appendChild(content);
    fileDisplay.appendChild(view);
  }

  _renderItem(item) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    if (item.disabled) row.classList.add('disabled');

    if (item.kind === 'nav' || item.kind === 'action') {
      row.textContent = item.label;
      if (!item.disabled) row.addEventListener('click', () => item.onClick());
    } else if (item.kind === 'toggle') {
      const label = document.createElement('span');
      label.className = 'settings-row-label';
      label.textContent = item.label;
      row.appendChild(label);
      const toggle = document.createElement('span');
      toggle.className = 'settings-toggle' + (item.value ? ' on' : '');
      row.appendChild(toggle);
      row.addEventListener('click', () => item.onToggle(!item.value));
    } else if (item.kind === 'info') {
      const label = document.createElement('span');
      label.className = 'settings-row-label';
      label.textContent = item.label;
      row.appendChild(label);
      const val = document.createElement('span');
      val.className = 'settings-row-value';
      val.textContent = item.value || '';
      row.appendChild(val);
    } else if (item.kind === 'placeholder') {
      row.textContent = item.label;
      row.classList.add('placeholder');
    }
    return row;
  }

  _rootItems() {
    return [
      { kind: 'nav', label: 'library',  onClick: () => this.push({ title: 'library',  buildItems: () => this._libraryItems()  }) },
      { kind: 'nav', label: 'sync',     onClick: () => this.push({ title: 'sync',     buildItems: () => this._syncItems()     }) },
      { kind: 'nav', label: 'podcasts', onClick: () => this.push({ title: 'podcasts', buildItems: () => this._podcastsItems() }) },
      { kind: 'nav', label: 'data',     onClick: () => this.push({ title: 'data',     buildItems: () => this._dataItems()     }) },
      { kind: 'nav', label: 'about',    onClick: () => this.push({ title: 'about',    buildItems: () => this._aboutItems()    }) },
    ];
  }

  _libraryItems() {
    const prefs = this.explorer.preferences;
    return [
      {
        kind: 'nav',
        label: 'music folders',
        onClick: () => this.push({ title: 'music folders', buildItems: () => this._folderListItems('music') }),
      },
      {
        kind: 'nav',
        label: 'video folders',
        onClick: () => this.push({ title: 'video folders', buildItems: () => this._folderListItems('videos') }),
      },
      {
        kind: 'nav',
        label: 'picture folders',
        onClick: () => this.push({ title: 'picture folders', buildItems: () => this._folderListItems('pictures') }),
      },
      {
        kind: 'toggle',
        label: 'scan desktop and downloads',
        value: !!prefs?.library?.scanDesktopAndDownloads,
        onToggle: async (newVal) => {
          await window.electronAPI.preferencesUpdate({ library: { scanDesktopAndDownloads: newVal } });
        },
      },
    ];
  }

  _folderListItems(category) {
    const list = this.explorer.preferences?.library?.[category] || [];
    const items = list.map((folderPath) => ({
      kind: 'nav',
      label: folderPath,
      onClick: () => this.push({
        title: folderPath.split(/[/\\]/).pop() || folderPath,
        buildItems: () => this._folderLeafItems(category, folderPath),
      }),
    }));
    items.push({
      kind: 'action',
      label: '+ add folder',
      onClick: async () => {
        const r = await window.electronAPI.pickFolder(`Choose a ${category} folder`);
        if (r && r.success) {
          const cur = this.explorer.preferences.library[category] || [];
          if (cur.includes(r.path)) return;
          await window.electronAPI.preferencesUpdate({
            library: { [category]: [...cur, r.path] },
          });
        }
      },
    });
    return items;
  }

  _folderLeafItems(category, folderPath) {
    const list = this.explorer.preferences?.library?.[category] || [];
    const isLast = list.length <= 1;
    return [
      { kind: 'info', label: 'path', value: folderPath },
      {
        kind: 'action',
        label: 'reveal in finder',
        onClick: () => window.electronAPI.showItemInFolder?.(folderPath),
      },
      {
        kind: 'action',
        label: isLast ? 'remove (last folder — disabled)' : 'remove from library',
        disabled: isLast,
        onClick: async () => {
          if (isLast) return;
          const confirmed = await this.explorer.showConfirmModal?.(
            'Remove folder',
            `Stop scanning ${folderPath}?`
          );
          if (!confirmed) return;
          const next = list.filter((p) => p !== folderPath);
          await window.electronAPI.preferencesUpdate({
            library: { [category]: next },
          });
          this.pop();
        },
      },
    ];
  }

  _syncItems() {
    const dest = this.explorer.preferences?.sync?.pullDestination;
    return [
      { kind: 'info', label: 'pull destination', value: dest || '(not set)' },
      {
        kind: 'action',
        label: dest ? 'change destination' : 'choose destination',
        onClick: async () => {
          const r = await window.electronAPI.pickFolder('Choose pull destination');
          if (r && r.success) {
            await window.electronAPI.preferencesUpdate({ sync: { pullDestination: r.path } });
          }
        },
      },
      {
        kind: 'action',
        label: 'clear destination',
        disabled: !dest,
        onClick: async () => {
          if (!dest) return;
          await window.electronAPI.preferencesUpdate({ sync: { pullDestination: null } });
        },
      },
    ];
  }
  _podcastsItems() {
    const dir = this.explorer.preferences?.podcasts?.downloadDirectory;
    return [
      { kind: 'info', label: 'download directory', value: dir || '(not set)' },
      {
        kind: 'action',
        label: dir ? 'change directory' : 'choose directory',
        onClick: async () => {
          const r = await window.electronAPI.pickFolder('Choose podcast download directory');
          if (r && r.success) {
            await window.electronAPI.preferencesUpdate({ podcasts: { downloadDirectory: r.path } });
          }
        },
      },
    ];
  }
  _dataItems()     { return [{ kind: 'placeholder', label: 'data — pending' }]; }
  _aboutItems()    { return [{ kind: 'placeholder', label: 'about — pending' }]; }
}

window.SettingsView = SettingsView;
