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
      const base64 = pic.data.toString('base64');
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
