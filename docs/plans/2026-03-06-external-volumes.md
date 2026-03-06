# External Volumes & Drive Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add external drive/volume discovery to the documents root view and fix Windows path restrictions so users can browse paths like `C:\music`.

**Architecture:** New `getExternalVolumes()` function in both platform modules discovers mounted volumes (macOS: `/Volumes/`, Windows: drive letters). `getAllowedPrefixes()` is updated to include volume roots. Renderer shows volume tiles below smart roots in the documents root view with blue folder icons.

**Tech Stack:** Node.js `fs`, Electron IPC, platform-specific volume discovery.

---

### Task 1: Add `getExternalVolumes()` to macOS platform module

**Files:**
- Modify: `src/main/platform-darwin.js`

**Step 1: Update `getAllowedPrefixes()` to include `/Volumes`**

Add `/Volumes` to the allowed prefixes array so users can browse any mounted volume:

```javascript
function getAllowedPrefixes() {
  return [
    app.getPath('home'),
    '/Applications',
    '/System/Applications',
    '/System/Cryptexes/App/System/Applications',
    '/Volumes'
  ];
}
```

**Step 2: Add `getExternalVolumes()` function**

Add before `module.exports`:

```javascript
async function getExternalVolumes() {
  const volumes = [];
  try {
    const entries = await fs.readdir('/Volumes', { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const volumePath = path.join('/Volumes', entry.name);
      // Skip the boot volume (symlink to /)
      try {
        const real = await fs.realpath(volumePath);
        if (real === '/') continue;
      } catch {
        continue;
      }
      volumes.push({
        name: entry.name,
        path: volumePath,
        kind: 'volume',
      });
    }
  } catch {
    // /Volumes not readable
  }
  return volumes;
}
```

**Step 3: Export the new function**

```javascript
module.exports = {
  getAllowedPrefixes,
  scanApplications,
  getRecentFiles,
  getAppIcon,
  getExternalVolumes
};
```

**Step 4: Commit**

```bash
git add src/main/platform-darwin.js
git commit -m "feat(volumes): add external volume discovery on macOS"
```

---

### Task 2: Add `getExternalVolumes()` to Windows platform module

**Files:**
- Modify: `src/main/platform-win32.js`

**Step 1: Update `getAllowedPrefixes()` to include detected drive roots**

Replace the existing `getAllowedPrefixes()` function. The new version dynamically discovers drive letters so paths like `C:\music` are allowed:

```javascript
function getAllowedPrefixes() {
  const home = app.getPath('home');
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  const specialFolders = ['desktop', 'documents', 'downloads', 'music', 'videos', 'pictures'].map(
    name => { try { return app.getPath(name); } catch { return null; } }
  ).filter(Boolean);

  // Include all detected drive roots so users can browse C:\music, D:\, etc.
  const driveRoots = [];
  for (let code = 65; code <= 90; code++) { // A-Z
    const drive = String.fromCharCode(code) + ':\\';
    try {
      require('fs').accessSync(drive);
      driveRoots.push(drive);
    } catch {
      // Drive doesn't exist
    }
  }

  return [
    home,
    ...specialFolders,
    ...driveRoots,
    programFiles,
    programFilesX86,
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(localAppData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs'
  ];
}
```

**Step 2: Add `getExternalVolumes()` function**

Add before `module.exports`:

```javascript
async function getExternalVolumes() {
  const volumes = [];
  for (let code = 65; code <= 90; code++) { // A-Z
    const letter = String.fromCharCode(code);
    const drivePath = letter + ':\\';
    try {
      await fs.access(drivePath);
      volumes.push({
        name: letter + ':',
        path: drivePath,
        kind: 'volume',
      });
    } catch {
      // Drive doesn't exist
    }
  }
  return volumes;
}
```

**Step 3: Export the new function**

```javascript
module.exports = {
  getAllowedPrefixes,
  scanApplications,
  getRecentFiles,
  getAppIcon,
  getExternalVolumes
};
```

**Step 4: Commit**

```bash
git add src/main/platform-win32.js
git commit -m "feat(volumes): add drive discovery and fix path restrictions on Windows"
```

---

### Task 3: Add IPC handler and preload exposure

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/main/preload.js`

**Step 1: Add IPC handler in main.js**

Add near the other IPC handlers (e.g. near `get-special-folders`):

```javascript
ipcMain.handle('get-external-volumes', async () => {
  try {
    const volumes = await platform.getExternalVolumes();
    return { success: true, volumes };
  } catch (error) {
    return { success: false, error: error.message, volumes: [] };
  }
});
```

**Step 2: Expose in preload.js**

Add to the `electronAPI` object, near `getSpecialFolders`:

```javascript
getExternalVolumes: () => ipcRenderer.invoke('get-external-volumes'),
```

**Step 3: Commit**

```bash
git add src/main/main.js src/main/preload.js
git commit -m "feat(volumes): add IPC handler for external volume discovery"
```

---

### Task 4: Render volume tiles in documents root view

**Files:**
- Modify: `src/assets/js/renderer.js`
- Modify: `src/assets/css/styles.css`

**Step 1: Add `externalVolumes` property and load on init**

In the constructor (near line 1653 where `smartRoots` is initialized), add:

```javascript
this.externalVolumes = [];
```

In the `init()` method, after `this.smartRoots` is populated (after the platform-specific block around line 1707), add:

```javascript
const volResult = await window.electronAPI.getExternalVolumes();
if (volResult.success) {
    this.externalVolumes = volResult.volumes;
}
```

**Step 2: Add volume tiles to the documents root grid view**

In the documents root rendering (the `else` branch starting around line 2049 that handles grid view), after the `this.smartRoots.forEach(...)` block and before `categoryView.appendChild(content)`, add:

```javascript
        if (this.externalVolumes.length > 0) {
            const volumeGrid = document.createElement('div');
            volumeGrid.className = 'category-content root-grid volume-grid';
            this.externalVolumes.forEach(vol => {
                const tile = document.createElement('div');
                tile.className = 'root-tile volume-tile';

                const icon = document.createElement('div');
                icon.className = 'root-tile-icon';
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('viewBox', '0 0 48 48');
                svg.setAttribute('fill', 'none');
                const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                p.setAttribute('d', 'M6 12C6 9.79 7.79 8 10 8H18L22 12H38C40.21 12 42 13.79 42 16V36C42 38.21 40.21 40 38 40H10C7.79 40 6 38.21 6 36V12Z');
                p.setAttribute('fill', 'rgba(74, 158, 255, 0.2)');
                p.setAttribute('stroke', '#4a9eff');
                p.setAttribute('stroke-width', '2');
                svg.appendChild(p);
                icon.appendChild(svg);

                const info = document.createElement('div');
                info.className = 'root-tile-info';

                const name = document.createElement('div');
                name.className = 'root-tile-name';
                name.textContent = vol.name;

                const detail = document.createElement('div');
                detail.className = 'root-tile-detail';
                detail.textContent = vol.path;

                info.appendChild(name);
                info.appendChild(detail);
                tile.appendChild(icon);
                tile.appendChild(info);

                tile.addEventListener('click', () => this.navigateToFolder(vol.path));
                volumeGrid.appendChild(tile);
            });
            categoryView.appendChild(volumeGrid);
        }
```

**Step 3: Also handle list view**

In the list view branch (around line 2039), after the `this.smartRoots.forEach(...)` block, add the same pattern for external volumes:

```javascript
            this.externalVolumes.forEach(vol => {
                const item = this.createFolderElement({
                    name: vol.name,
                    path: vol.path,
                    isDirectory: true
                });
                content.appendChild(item);
            });
```

**Step 4: Add CSS for volume tile hover color**

Add to `styles.css` after the `.root-tile:hover` rule:

```css
.volume-tile:hover {
    background: rgba(74, 158, 255, 0.1);
    border-color: rgba(74, 158, 255, 0.3);
}

.volume-grid {
    margin-top: 20px;
}
```

**Step 5: Commit**

```bash
git add src/assets/js/renderer.js src/assets/css/styles.css
git commit -m "feat(volumes): render external volume tiles in documents root view"
```

---

### Summary of Changes

| File | Change |
|------|--------|
| `src/main/platform-darwin.js` | Add `/Volumes` to allowed prefixes, add `getExternalVolumes()` |
| `src/main/platform-win32.js` | Add drive roots to allowed prefixes, add `getExternalVolumes()` |
| `src/main/main.js` | Add `get-external-volumes` IPC handler |
| `src/main/preload.js` | Expose `getExternalVolumes` |
| `src/assets/js/renderer.js` | Load volumes on init, render blue volume tiles below smart roots |
| `src/assets/css/styles.css` | Blue hover state for volume tiles, spacing for volume grid |
