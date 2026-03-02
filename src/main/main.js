const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const platform = require('./platform-' + (process.platform === 'win32' ? 'win32' : 'darwin') + '.js');
const { ZuneManager } = require('./zune/zune-manager');

const zuneManager = new ZuneManager();

// Simple dev mode detection
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

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
    backgroundColor: '#000000',
    show: false
  };

  if (process.platform === 'darwin') {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.vibrancy = 'dark';
    windowOptions.visualEffectState = 'active';
  } else {
    windowOptions.frame = false;
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
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  createWindow();

  // Start Zune USB detection
  zuneManager.start();

  // Forward Zune events to renderer
  zuneManager.on('status', (status) => {
    if (mainWindow) mainWindow.webContents.send('zune-status', status);
  });
  zuneManager.on('transfer-progress', (progress) => {
    if (mainWindow) mainWindow.webContents.send('zune-transfer-progress', progress);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  zuneManager.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC handlers for file system operations
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
    console.error('Error getting app icon:', error);
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

ipcMain.handle('get-platform', async () => {
  return process.platform;
});

ipcMain.handle('scan-applications', async () => {
  try {
    const homePath = app.getPath('home');
    const applications = await platform.scanApplications(homePath);
    return { success: true, applications };
  } catch (error) {
    console.error('Error scanning applications:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-audio-metadata', async (event, filePath) => {
  if (!isAllowedPath(filePath)) {
    return { success: false, error: 'Access denied' };
  }
  try {
    const { parseFile } = await import('music-metadata');
    const metadata = await parseFile(filePath);
    const result = {
      success: true,
      title: metadata.common.title || path.basename(filePath, path.extname(filePath)),
      artist: metadata.common.artist || 'Unknown Artist',
      album: metadata.common.album || 'Unknown Album',
      duration: metadata.format.duration || 0,
    };
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const pic = metadata.common.picture[0];
      const base64 = Buffer.from(pic.data).toString('base64');
      result.albumArt = `data:${pic.format};base64,${base64}`;
    } else {
      result.albumArt = null;
    }
    return result;
  } catch (error) {
    return {
      success: true,
      title: path.basename(filePath, path.extname(filePath)),
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      duration: 0,
      albumArt: null,
    };
  }
});

ipcMain.handle('batch-scan-audio-metadata', async (event, filePaths, options = {}) => {
  const { batchSize = 15, includeArt = true } = options;
  const validPaths = filePaths.filter(fp => isAllowedPath(fp));
  const total = validPaths.length;
  let scanned = 0;

  for (let i = 0; i < total; i += batchSize) {
    const batch = validPaths.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (filePath) => {
      try {
        const { parseFile } = await import('music-metadata');
        const metadata = await Promise.race([
          parseFile(filePath),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);
        const result = {
          path: filePath,
          title: metadata.common.title || path.basename(filePath, path.extname(filePath)),
          artist: metadata.common.artist || 'Unknown Artist',
          album: metadata.common.album || 'Unknown Album',
          albumArtist: metadata.common.albumartist || metadata.common.artist || 'Unknown Artist',
          genre: (metadata.common.genre && metadata.common.genre[0]) || 'Unknown',
          trackNumber: (metadata.common.track && metadata.common.track.no) || 0,
          year: metadata.common.year || 0,
          duration: metadata.format.duration || 0,
          albumArt: null
        };
        if (includeArt && metadata.common.picture && metadata.common.picture.length > 0) {
          const pic = metadata.common.picture[0];
          result.albumArt = `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}`;
        }
        return result;
      } catch (error) {
        return {
          path: filePath,
          title: path.basename(filePath, path.extname(filePath)),
          artist: 'Unknown Artist',
          album: 'Unknown Album',
          albumArtist: 'Unknown Artist',
          genre: 'Unknown',
          trackNumber: 0,
          year: 0,
          duration: 0,
          albumArt: null
        };
      }
    }));

    scanned += results.length;
    if (mainWindow) {
      mainWindow.webContents.send('music-scan-progress', { scanned, total, batch: results });
    }

    // Yield to event loop between batches
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  return { success: true, total: scanned };
});

ipcMain.handle('zune-get-status', async () => {
  return zuneManager.getCurrentStatus();
});

ipcMain.handle('zune-device-info', async () => {
  return zuneManager.getDeviceInfo();
});

ipcMain.handle('zune-send-files', async (event, filePaths) => {
  try {
    await zuneManager.sendFiles(filePaths);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-cancel-transfer', async () => {
  zuneManager.cancelTransfer();
  return { success: true };
});

ipcMain.handle('zune-browse-contents', async () => {
  try {
    const contents = await zuneManager.browseContents();
    return { success: true, contents };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-delete-objects', async (event, handles) => {
  try {
    const result = await zuneManager.deleteObjects(handles);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-probe-properties', async (event, handle) => {
  try {
    console.log(`\n=== PROBING OBJECT PROPERTIES (handle=${handle}) ===`);
    const results = await zuneManager.probeObjectProperties(handle);
    console.log('=== PROBE COMPLETE ===\n');
    return { success: true, results };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-probe-wmdrmpd', async () => {
  try {
    console.log('\n=== PROBING WMDRMPD COMMANDS ===');
    const results = await zuneManager.probeWmdrmpd();
    console.log('=== WMDRMPD PROBE COMPLETE ===\n');
    return { success: true, results };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-eject', async () => {
  try {
    await zuneManager.eject();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('window-minimize', async () => {
  if (mainWindow) {
    mainWindow.minimize();
  }
});

ipcMain.handle('window-maximize', async () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.handle('window-close', async () => {
  if (mainWindow) {
    mainWindow.close();
  }
});
