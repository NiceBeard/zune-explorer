# Windows Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Zune Explorer run on Windows with full feature parity — recent files, application scanning, app icons, and a custom title bar that preserves the immersive Zune aesthetic.

**Architecture:** Extract all macOS-specific code from `main.js` into `platform-darwin.js`, create a matching `platform-win32.js` with Windows equivalents, and have `main.js` pick the right module at startup via `process.platform`. The renderer gets a custom title bar (hidden on macOS) and a new `scan-applications` IPC call so platform-specific app discovery stays in the main process.

**Tech Stack:** Electron (cross-platform APIs: `shell.readShortcutLink`, `app.getFileIcon`, `nativeImage`), Node.js `fs`/`path`

---

### Task 1: Create platform-darwin.js

Extract all macOS-specific logic from `src/main/main.js` into a platform module.

**Files:**
- Create: `src/main/platform-darwin.js`

**Step 1: Create the macOS platform module**

Create `src/main/platform-darwin.js` with the following exports, moved from `main.js`:

```javascript
const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const { app, nativeImage } = require('electron');
const crypto = require('crypto');
const execFileAsync = promisify(execFile);

function getAllowedPrefixes() {
  return [
    app.getPath('home'),
    '/Applications',
    '/System/Applications',
    '/System/Cryptexes/App/System/Applications'
  ];
}

async function scanApplications(homePath) {
  const dirs = [
    '/Applications',
    '/System/Applications',
    `${homePath}/Applications`
  ];
  const apps = [];

  for (const dir of dirs) {
    try {
      const files = await fs.readdir(dir, { withFileTypes: true });
      for (const file of files) {
        if (file.isDirectory() && file.name.endsWith('.app')) {
          const filePath = path.join(dir, file.name);
          try {
            const stats = await fs.stat(filePath);
            apps.push({
              name: file.name.replace('.app', ''),
              path: filePath,
              isDirectory: true,
              size: stats.size,
              modified: stats.mtime,
              extension: '.app',
              isApplication: true
            });
          } catch {
            // Skip inaccessible apps
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  return apps;
}

async function getRecentFiles(homePath) {
  // Move the entire get-recent-files handler body from main.js lines 341-449
  // (mdfind + mdls logic)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateString = thirtyDaysAgo.toISOString().split('T')[0];

  const { stdout } = await execFileAsync('mdfind', [
    '-onlyin', homePath,
    `kMDItemLastUsedDate >= $time.iso(${dateString}T00:00:00Z)`
  ]);

  const filePaths = stdout.trim().split('\n').filter(p => p.length > 0);

  const supportedExtensions = [
    '.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma',
    '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
    '.jpg', '.jpeg', '.png', '.gif', '.svg', '.bmp', '.webp', '.ico', '.heic', '.heif',
    '.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.md',
    '.app', '.exe', '.dmg', '.pkg', '.deb', '.msi'
  ];

  const BATCH_SIZE = 15;
  const files = [];

  for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
    const batch = filePaths.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const stats = await fs.stat(filePath);
          if (stats.isDirectory() && !filePath.endsWith('.app')) return null;

          const fileName = path.basename(filePath);
          const extension = path.extname(filePath).toLowerCase();
          if (!supportedExtensions.includes(extension) && extension !== '') return null;

          try {
            const { stdout: mdlsOutput } = await execFileAsync('mdls', [
              '-name', 'kMDItemLastUsedDate', '-raw', filePath
            ]);

            let lastAccessed = stats.mtime;
            if (mdlsOutput && mdlsOutput !== '(null)') {
              const dateMatch = mdlsOutput.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
              if (dateMatch) {
                lastAccessed = new Date(dateMatch[1] + ' +0000');
              }
            }

            return {
              name: fileName, path: filePath, isDirectory: false,
              size: stats.size, modified: stats.mtime, lastAccessed,
              extension, isApplication: extension === '.app'
            };
          } catch {
            return {
              name: fileName, path: filePath, isDirectory: false,
              size: stats.size, modified: stats.mtime, lastAccessed: stats.mtime,
              extension, isApplication: extension === '.app'
            };
          }
        } catch {
          return null;
        }
      })
    );
    files.push(...batchResults.filter(f => f !== null));
  }

  files.sort((a, b) => new Date(b.lastAccessed) - new Date(a.lastAccessed));
  return files.slice(0, 50);
}

async function getAppIcon(appPath) {
  // Move the entire get-app-icon handler body from main.js lines 176-339
  // (.icns hunting + nativeImage + sips fallback)
  const appName = path.basename(appPath, '.app');
  const iconPath = path.join(appPath, 'Contents', 'Resources');

  try {
    await fs.access(iconPath);
  } catch {
    return { success: false, error: 'Resources directory not found' };
  }

  const iconNames = [
    'AppIcon.icns', 'app.icns', 'icon.icns', 'Icon.icns',
    'application.icns', 'Application.icns', 'App.icns',
    `${appName}.icns`, `${appName.toLowerCase()}.icns`,
    'document.icns', 'Document.icns'
  ];

  let foundIconPath = null;

  for (const iconName of iconNames) {
    const fullIconPath = path.join(iconPath, iconName);
    try {
      await fs.access(fullIconPath);
      foundIconPath = fullIconPath;
      break;
    } catch {
      // try next
    }
  }

  // Try Info.plist for icon name
  if (!foundIconPath) {
    try {
      const plistPath = path.join(appPath, 'Contents', 'Info.plist');
      const plistContent = await fs.readFile(plistPath, 'utf8');

      const iconFileMatch = plistContent.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/);
      const iconNameMatch = plistContent.match(/<key>CFBundleIconName<\/key>\s*<string>([^<]+)<\/string>/);
      const bundleIconsMatch = plistContent.match(/<key>CFBundleIcons<\/key>\s*<dict>[\s\S]*?<key>CFBundlePrimaryIcon<\/key>\s*<dict>[\s\S]*?<key>CFBundleIconName<\/key>\s*<string>([^<]+)<\/string>/);

      const iconCandidates = [];
      if (iconFileMatch) iconCandidates.push(iconFileMatch[1]);
      if (iconNameMatch) iconCandidates.push(iconNameMatch[1]);
      if (bundleIconsMatch) iconCandidates.push(bundleIconsMatch[1]);

      for (let iconFileName of iconCandidates) {
        const variations = [];
        if (iconFileName.endsWith('.icns')) {
          variations.push(iconFileName);
          variations.push(iconFileName.slice(0, -5));
        } else {
          variations.push(iconFileName);
          variations.push(iconFileName + '.icns');
        }

        for (const variation of variations) {
          const plistIconPath = path.join(iconPath, variation);
          try {
            await fs.access(plistIconPath);
            foundIconPath = plistIconPath;
            break;
          } catch {
            // try next
          }
        }
        if (foundIconPath) break;
      }
    } catch {
      // Couldn't read plist
    }
  }

  // Last resort: any .icns in Resources
  if (!foundIconPath) {
    try {
      const files = await fs.readdir(iconPath);
      const icnsFiles = files.filter(f => f.endsWith('.icns'));
      if (icnsFiles.length > 0) {
        const preferredIcon = icnsFiles.find(f =>
          f.toLowerCase().includes('icon') || f.toLowerCase().includes('app')
        ) || icnsFiles[0];
        foundIconPath = path.join(iconPath, preferredIcon);
      }
    } catch {
      // skip
    }
  }

  if (foundIconPath) {
    // Try nativeImage first
    try {
      const image = nativeImage.createFromPath(foundIconPath);
      if (!image.isEmpty()) {
        const buffer = image.toPNG();
        const base64 = buffer.toString('base64');
        return { success: true, iconDataUrl: `data:image/png;base64,${base64}` };
      }
    } catch {
      // fall through to sips
    }

    // Fallback: sips
    try {
      const tempPngPath = path.join(app.getPath('temp'), `icon_${crypto.randomUUID()}.png`);
      await execFileAsync('sips', [
        '-s', 'format', 'png', foundIconPath,
        '--out', tempPngPath, '--resampleWidth', '64'
      ]);
      const pngBuffer = await fs.readFile(tempPngPath);
      const base64 = pngBuffer.toString('base64');
      try { await fs.unlink(tempPngPath); } catch { /* ignore */ }
      return { success: true, iconDataUrl: `data:image/png;base64,${base64}` };
    } catch {
      // give up
    }
  }

  return { success: false, error: 'No icon found' };
}

module.exports = { getAllowedPrefixes, scanApplications, getRecentFiles, getAppIcon };
```

**Step 2: Commit**

```bash
git add src/main/platform-darwin.js
git commit -m "feat: extract macOS platform module from main.js"
```

---

### Task 2: Create platform-win32.js

Implement Windows equivalents for all platform-specific features.

**Files:**
- Create: `src/main/platform-win32.js`

**Step 1: Create the Windows platform module**

Create `src/main/platform-win32.js`:

```javascript
const path = require('path');
const fs = require('fs').promises;
const { app, shell, nativeImage } = require('electron');

function getAllowedPrefixes() {
  return [
    app.getPath('home'),
    process.env.PROGRAMFILES || 'C:\\Program Files',
    process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
    path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu')
  ];
}

async function scanApplications() {
  const dirs = [
    path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ];
  const apps = [];
  const seen = new Set();

  for (const dir of dirs) {
    await scanStartMenuDir(dir, apps, seen);
  }

  return apps;
}

async function scanStartMenuDir(dir, apps, seen) {
  try {
    const files = await fs.readdir(dir, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dir, file.name);
      if (file.isDirectory()) {
        await scanStartMenuDir(filePath, apps, seen);
      } else if (file.name.endsWith('.lnk')) {
        try {
          const shortcut = shell.readShortcutLink(filePath);
          if (shortcut.target &&
              shortcut.target.toLowerCase().endsWith('.exe') &&
              !seen.has(shortcut.target.toLowerCase())) {
            seen.add(shortcut.target.toLowerCase());
            try {
              const stats = await fs.stat(shortcut.target);
              apps.push({
                name: file.name.replace('.lnk', ''),
                path: shortcut.target,
                isDirectory: false,
                size: stats.size,
                modified: stats.mtime,
                extension: '.exe',
                isApplication: true
              });
            } catch {
              // Target exe doesn't exist or inaccessible
            }
          }
        } catch {
          // Couldn't resolve shortcut
        }
      }
    }
  } catch {
    // Directory doesn't exist or inaccessible
  }
}

async function getRecentFiles() {
  const recentPath = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Recent');

  const supportedExtensions = [
    '.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma',
    '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
    '.jpg', '.jpeg', '.png', '.gif', '.svg', '.bmp', '.webp', '.ico',
    '.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.md',
    '.exe', '.msi'
  ];

  const files = [];

  try {
    const entries = await fs.readdir(recentPath, { withFileTypes: true });
    const lnkFiles = entries.filter(e => !e.isDirectory() && e.name.endsWith('.lnk'));

    for (const entry of lnkFiles) {
      try {
        const lnkPath = path.join(recentPath, entry.name);
        const shortcut = shell.readShortcutLink(lnkPath);

        if (!shortcut.target) continue;

        const targetPath = shortcut.target;
        const extension = path.extname(targetPath).toLowerCase();
        if (!supportedExtensions.includes(extension)) continue;

        const stats = await fs.stat(targetPath);
        if (stats.isDirectory()) continue;

        // Use the .lnk file's mtime as a proxy for "last accessed"
        const lnkStats = await fs.stat(lnkPath);

        files.push({
          name: path.basename(targetPath),
          path: targetPath,
          isDirectory: false,
          size: stats.size,
          modified: stats.mtime,
          lastAccessed: lnkStats.mtime,
          extension,
          isApplication: extension === '.exe'
        });
      } catch {
        // Skip unresolvable shortcuts
      }
    }
  } catch {
    // Recent folder inaccessible
  }

  files.sort((a, b) => new Date(b.lastAccessed) - new Date(a.lastAccessed));
  return files.slice(0, 50);
}

async function getAppIcon(appPath) {
  try {
    const icon = await app.getFileIcon(appPath, { size: 'large' });
    if (!icon.isEmpty()) {
      const buffer = icon.toPNG();
      const base64 = buffer.toString('base64');
      return { success: true, iconDataUrl: `data:image/png;base64,${base64}` };
    }
  } catch {
    // Fall through
  }

  return { success: false, error: 'No icon found' };
}

module.exports = { getAllowedPrefixes, scanApplications, getRecentFiles, getAppIcon };
```

**Step 2: Commit**

```bash
git add src/main/platform-win32.js
git commit -m "feat: add Windows platform module"
```

---

### Task 3: Refactor main.js to use platform modules

Replace all inline macOS code with platform module calls. Add new IPC handlers. Make BrowserWindow config platform-conditional.

**Files:**
- Modify: `src/main/main.js`

**Step 1: Rewrite main.js**

Replace the entire contents of `src/main/main.js` with:

```javascript
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;

// Simple dev mode detection
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// Load platform-specific module
const platform = require(`./platform-${process.platform === 'win32' ? 'win32' : 'darwin'}.js`);

let mainWindow;

// Path validation: restrict file operations to allowed directories
function isAllowedPath(filePath) {
  const resolved = path.resolve(filePath);
  const allowedPrefixes = platform.getAllowedPrefixes();
  return allowedPrefixes.some(prefix =>
    resolved === prefix || resolved.startsWith(prefix + path.sep)
  );
}

function createWindow() {
  const isWin = process.platform === 'win32';

  const windowOptions = {
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js')
    },
    frame: false,
    backgroundColor: '#000000',
    show: false
  };

  if (!isWin) {
    windowOptions.titleBarStyle = 'hidden';
    windowOptions.vibrancy = 'dark';
    windowOptions.visualEffectState = 'active';
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Prevent navigation to arbitrary URLs
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  // Prevent opening new windows
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// --- IPC handlers ---

ipcMain.handle('get-platform', () => {
  return process.platform;
});

// Window control handlers (for custom title bar on Windows)
ipcMain.handle('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.handle('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});
ipcMain.handle('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('get-directory-contents', async (event, dirPath) => {
  if (!isAllowedPath(dirPath)) {
    return { success: false, error: 'Access denied: path outside allowed directories' };
  }

  try {
    const files = await fs.readdir(dirPath, { withFileTypes: true });
    const fileData = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(dirPath, file.name);
        const stats = await fs.stat(filePath);
        return {
          name: file.name,
          path: filePath,
          isDirectory: file.isDirectory(),
          size: stats.size,
          modified: stats.mtime,
          extension: file.isDirectory() ? '' : path.extname(file.name).toLowerCase()
        };
      })
    );
    return { success: true, files: fileData };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-home-directory', async () => {
  return app.getPath('home');
});

ipcMain.handle('open-file', async (event, filePath) => {
  if (!isAllowedPath(filePath)) {
    return { success: false, error: 'Access denied: path outside allowed directories' };
  }

  try {
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('show-item-in-folder', async (event, filePath) => {
  if (!isAllowedPath(filePath)) {
    return { success: false, error: 'Access denied: path outside allowed directories' };
  }

  shell.showItemInFolder(filePath);
  return { success: true };
});

ipcMain.handle('delete-file', async (event, filePath) => {
  if (!isAllowedPath(filePath)) {
    return { success: false, error: 'Access denied: path outside allowed directories' };
  }

  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      message: 'Are you sure you want to delete this item?',
      detail: `This will permanently delete: ${path.basename(filePath)}`
    });

    if (result.response === 1) {
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        await fs.rm(filePath, { recursive: true });
      } else {
        await fs.unlink(filePath);
      }
      return { success: true };
    }
    return { success: false, cancelled: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-app-icon', async (event, appPath) => {
  if (!isAllowedPath(appPath)) {
    return { success: false, error: 'Access denied: path outside allowed directories' };
  }

  try {
    return await platform.getAppIcon(appPath);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-recent-files', async () => {
  try {
    const homePath = app.getPath('home');
    const files = await platform.getRecentFiles(homePath);
    return { success: true, files };
  } catch (error) {
    console.error('Error getting recent files:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('scan-applications', async () => {
  try {
    const homePath = app.getPath('home');
    const apps = await platform.scanApplications(homePath);
    return { success: true, applications: apps };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
```

**Step 2: Verify on macOS**

Run: `npm start`

Expected: App launches and works exactly as before — menu loads, categories work, files display, recent files populate. No visual changes.

**Step 3: Commit**

```bash
git add src/main/main.js
git commit -m "refactor: use platform modules in main.js, add cross-platform IPC handlers"
```

---

### Task 4: Update preload.js

Expose the new IPC channels to the renderer.

**Files:**
- Modify: `src/main/preload.js`

**Step 1: Add new IPC exposures**

Replace the contents of `src/main/preload.js` with:

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDirectoryContents: (path) => ipcRenderer.invoke('get-directory-contents', path),
  getHomeDirectory: () => ipcRenderer.invoke('get-home-directory'),
  openFile: (path) => ipcRenderer.invoke('open-file', path),
  showItemInFolder: (path) => ipcRenderer.invoke('show-item-in-folder', path),
  deleteFile: (path) => ipcRenderer.invoke('delete-file', path),
  getAppIcon: (path) => ipcRenderer.invoke('get-app-icon', path),
  getRecentFiles: () => ipcRenderer.invoke('get-recent-files'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  scanApplications: () => ipcRenderer.invoke('scan-applications'),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close')
});
```

**Step 2: Commit**

```bash
git add src/main/preload.js
git commit -m "feat: expose platform, app scanning, and window control IPC channels"
```

---

### Task 5: Add custom title bar

Add a Windows-only title bar with minimize, maximize, and close buttons. Hidden on macOS via CSS.

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/assets/css/styles.css`

**Step 1: Add title bar HTML**

In `src/renderer/index.html`, add the title bar as the first child inside `<div class="zune-container">`, before the panoramic-container:

```html
<!-- Custom title bar (Windows only, hidden on macOS via CSS) -->
<div class="title-bar" id="title-bar">
    <div class="title-bar-drag"></div>
    <div class="title-bar-controls">
        <button class="title-bar-btn" id="minimize-btn">&#x2014;</button>
        <button class="title-bar-btn" id="maximize-btn">&#x25A1;</button>
        <button class="title-bar-btn close-btn" id="close-btn">&#x2715;</button>
    </div>
</div>
```

**Step 2: Add title bar CSS**

Append to `src/assets/css/styles.css`:

```css
/* Custom title bar (Windows only) */
.title-bar {
    display: none;
    height: 32px;
    background: var(--zune-dark);
    -webkit-app-region: drag;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 9999;
    justify-content: flex-end;
    align-items: center;
}

body.platform-win32 .title-bar {
    display: flex;
}

body.platform-win32 .zune-container {
    height: calc(100vh - 32px);
    margin-top: 32px;
}

.title-bar-drag {
    flex: 1;
    height: 100%;
}

.title-bar-controls {
    -webkit-app-region: no-drag;
    display: flex;
    height: 100%;
}

.title-bar-btn {
    width: 46px;
    height: 100%;
    border: none;
    background: transparent;
    color: var(--zune-text-secondary);
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s ease;
    -webkit-app-region: no-drag;
}

.title-bar-btn:hover {
    background: rgba(255, 255, 255, 0.1);
}

.title-bar-btn.close-btn:hover {
    background: #e81123;
    color: white;
}
```

**Step 3: Verify on macOS**

Run: `npm start`

Expected: No visual change — the title bar is hidden because `body` doesn't have the `platform-win32` class.

**Step 4: Commit**

```bash
git add src/renderer/index.html src/assets/css/styles.css
git commit -m "feat: add custom title bar for Windows, hidden on macOS"
```

---

### Task 6: Update renderer.js for cross-platform

Detect platform at init, wire up title bar buttons, replace `scanApplications` and `scanApplicationsInDirectory` with the new `scan-applications` IPC call.

**Files:**
- Modify: `src/assets/js/renderer.js`

**Step 1: Add platform detection in init()**

At the beginning of the `init()` method, before the `this.homePath` line, add:

```javascript
this.platform = await window.electronAPI.getPlatform();
if (this.platform === 'win32') {
    document.body.classList.add('platform-win32');
}
```

**Step 2: Wire up title bar buttons in setupEventListeners()**

At the end of the `setupEventListeners()` method, add:

```javascript
// Title bar controls (Windows)
const minimizeBtn = document.getElementById('minimize-btn');
const maximizeBtn = document.getElementById('maximize-btn');
const closeBtn = document.getElementById('close-btn');
if (minimizeBtn) {
    minimizeBtn.addEventListener('click', () => window.electronAPI.windowMinimize());
}
if (maximizeBtn) {
    maximizeBtn.addEventListener('click', () => window.electronAPI.windowMaximize());
}
if (closeBtn) {
    closeBtn.addEventListener('click', () => window.electronAPI.windowClose());
}
```

**Step 3: Replace scanApplications and scanApplicationsInDirectory**

Remove the `scanApplications()` method (the one that calls `scanApplicationsInDirectory` three times) and remove the `scanApplicationsInDirectory()` method entirely. Replace with:

```javascript
async scanApplications() {
    try {
        const result = await window.electronAPI.scanApplications();
        if (result.success) {
            this.categorizedFiles.applications = result.applications;
        }
    } catch (error) {
        console.error('Error scanning applications:', error);
    }
}
```

**Step 4: Update smart roots for Windows**

In the `init()` method, replace the hardcoded `smartRoots` array with platform-aware roots:

```javascript
if (this.platform === 'win32') {
    this.smartRoots = [
        { name: 'Desktop',   path: path.join(this.homePath, 'Desktop') },
        { name: 'Documents', path: path.join(this.homePath, 'Documents') },
        { name: 'Downloads', path: path.join(this.homePath, 'Downloads') },
        { name: 'Music',     path: path.join(this.homePath, 'Music') },
        { name: 'Videos',    path: path.join(this.homePath, 'Videos') },
        { name: 'Pictures',  path: path.join(this.homePath, 'Pictures') },
        { name: 'Home',      path: this.homePath },
    ];
} else {
    this.smartRoots = [
        { name: 'Desktop',   path: `${this.homePath}/Desktop` },
        { name: 'Documents', path: `${this.homePath}/Documents` },
        { name: 'Downloads', path: `${this.homePath}/Downloads` },
        { name: 'Music',     path: `${this.homePath}/Music` },
        { name: 'Movies',    path: `${this.homePath}/Movies` },
        { name: 'Pictures',  path: `${this.homePath}/Pictures` },
        { name: 'Home',      path: this.homePath },
    ];
}
```

Note: The renderer runs in a browser context without Node's `path` module. Use string concatenation (as already done for macOS) or template literals. On Windows, `this.homePath` already contains backslashes from Electron's `app.getPath('home')`, so `${this.homePath}\\Desktop` works. But since JavaScript string paths with forward slashes also work on Windows in Electron, the simpler approach is:

```javascript
if (this.platform === 'win32') {
    this.smartRoots = [
        { name: 'Desktop',   path: `${this.homePath}\\Desktop` },
        { name: 'Documents', path: `${this.homePath}\\Documents` },
        { name: 'Downloads', path: `${this.homePath}\\Downloads` },
        { name: 'Music',     path: `${this.homePath}\\Music` },
        { name: 'Videos',    path: `${this.homePath}\\Videos` },
        { name: 'Pictures',  path: `${this.homePath}\\Pictures` },
        { name: 'Home',      path: this.homePath },
    ];
} else {
    this.smartRoots = [
        { name: 'Desktop',   path: `${this.homePath}/Desktop` },
        { name: 'Documents', path: `${this.homePath}/Documents` },
        { name: 'Downloads', path: `${this.homePath}/Downloads` },
        { name: 'Music',     path: `${this.homePath}/Music` },
        { name: 'Movies',    path: `${this.homePath}/Movies` },
        { name: 'Pictures',  path: `${this.homePath}/Pictures` },
        { name: 'Home',      path: this.homePath },
    ];
}
```

Note the difference: macOS has `Movies`, Windows has `Videos`.

**Step 5: Update scanMediaFiles for Windows paths**

In the `scanMediaFiles()` method, update the category directories to use the correct separator:

```javascript
async scanMediaFiles() {
    const sep = this.platform === 'win32' ? '\\' : '/';
    const categoryDirs = {
        music: [`${this.homePath}${sep}Music`],
        videos: [this.platform === 'win32' ? `${this.homePath}${sep}Videos` : `${this.homePath}${sep}Movies`],
        pictures: [`${this.homePath}${sep}Pictures`],
    };

    for (const [category, dirs] of Object.entries(categoryDirs)) {
        for (const dir of dirs) {
            await this.scanDirectoryRecursive(dir, category, 3);
        }
    }

    const commonDirs = [
        `${this.homePath}${sep}Desktop`,
        `${this.homePath}${sep}Downloads`,
    ];
    for (const dir of commonDirs) {
        await this.scanDirectoryForMedia(dir);
    }
}
```

**Step 6: Update breadcrumb display for Windows**

In the `updateHeader()` method, the path display uses `this.homePath` replacement. On Windows, the split character should be platform-aware. Update the breadcrumb logic:

```javascript
const folderName = this.currentPath === this.homePath
    ? 'Home'
    : this.currentPath.split(/[/\\]/).pop();
```

And for the breadcrumb path:

```javascript
const lastSep = Math.max(this.currentPath.lastIndexOf('/'), this.currentPath.lastIndexOf('\\'));
const parentPath = this.currentPath.substring(0, lastSep);
const displayPath = parentPath.replace(this.homePath, '~');
breadcrumb.textContent = displayPath || '~';
```

**Step 7: Verify on macOS**

Run: `npm start`

Expected: App works exactly as before. Applications load from the new `scan-applications` IPC. No visual changes.

**Step 8: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat: cross-platform renderer with title bar, platform-aware paths and app scanning"
```

---

### Task 7: Update build config and documentation

Add Windows build targets and update docs to reflect cross-platform support.

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Step 1: Update package.json Windows build target**

The `win` section in `package.json` already exists. Update it to include both NSIS installer and portable:

```json
"win": {
  "target": [
    {
      "target": "nsis",
      "arch": ["x64"]
    },
    {
      "target": "portable",
      "arch": ["x64"]
    }
  ],
  "icon": "build-resources/icon.png"
}
```

**Step 2: Update README.md**

Update the Requirements and Installation sections to mention Windows support. Add Windows-specific build instructions.

**Step 3: Update CLAUDE.md**

Add a note about the platform module architecture and Windows-specific paths.

**Step 4: Commit**

```bash
git add package.json README.md CLAUDE.md
git commit -m "docs: update build config and documentation for Windows support"
```

---

## Testing Notes

- **macOS testing:** All tasks can be verified on macOS after each commit. The refactoring should produce zero behavior changes on Mac.
- **Windows testing:** Requires a Windows machine or VM. Key things to test:
  - Application scanning finds Start Menu programs
  - Recent files populates from Windows Recent folder
  - App icons display for `.exe` files
  - Custom title bar shows with working minimize/maximize/close
  - File browsing uses correct path separators
  - Documents category smart roots use `Videos` instead of `Movies`
- **Cross-platform path handling:** The `path.sep` usage in `isAllowedPath` and separator-aware code in the renderer handles both `/` and `\`.
