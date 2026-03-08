const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const platform = require('./platform-' + (process.platform === 'win32' ? 'win32' : 'darwin') + '.js');
const { ZuneManager } = require('./zune/zune-manager');
const { DeviceCache } = require('./zune/device-cache');
const { MetadataCache } = require('./metadata-cache.js');
const musicbrainz = require('./musicbrainz.js');

const execFileAsync = promisify(execFile);
const ffmpegPath = require('ffmpeg-static');

const zuneManager = new ZuneManager();
let deviceCache = null; // initialized after app.whenReady
let metadataCache;

// Simple dev mode detection
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

let mainWindow;

// Path validation: restrict file operations to allowed directories
function isAllowedPath(filePath) {
  const resolved = path.resolve(filePath);
  const allowedPrefixes = platform.getAllowedPrefixes();
  return allowedPrefixes.some(prefix => {
    const base = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
    return resolved === prefix || resolved.startsWith(base);
  });
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

  deviceCache = new DeviceCache(app.getPath('userData'));
  metadataCache = new MetadataCache(app.getPath('userData'));
  zuneManager.metadataCache = metadataCache;

  // Start Zune USB detection
  zuneManager.start();

  // Forward Zune events to renderer
  zuneManager.on('status', (status) => {
    if (mainWindow) mainWindow.webContents.send('zune-status', status);
  });
  zuneManager.on('transfer-progress', (progress) => {
    if (mainWindow) mainWindow.webContents.send('zune-transfer-progress', progress);
  });
  zuneManager.on('browse-progress', (data) => {
    if (mainWindow) mainWindow.webContents.send('zune-browse-progress', data);
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
    const fileData = (await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(dirPath, file.name);
        try {
          const stats = await fs.stat(filePath);
          return {
            name: file.name,
            path: filePath,
            isDirectory: stats.isDirectory(),
            size: stats.size,
            modified: stats.mtime,
            extension: stats.isDirectory() ? '' : path.extname(file.name).toLowerCase()
          };
        } catch {
          return null;
        }
      })
    )).filter(Boolean);
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

ipcMain.handle('get-special-folders', async () => {
  const names = ['desktop', 'documents', 'downloads', 'music', 'videos', 'pictures', 'home'];
  const result = {};
  for (const name of names) {
    try { result[name] = app.getPath(name); } catch { /* not available */ }
  }
  return result;
});

ipcMain.handle('get-external-volumes', async () => {
  try {
    const volumes = await platform.getExternalVolumes();
    return { success: true, volumes };
  } catch (error) {
    return { success: false, error: error.message, volumes: [] };
  }
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

// Device cache IPC
ipcMain.handle('zune-cache-load', async (event, deviceKey) => {
  try {
    const data = await deviceCache.load(deviceKey);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-cache-save', async (event, deviceKey, cacheData) => {
  try {
    await deviceCache.save(deviceKey, cacheData);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-cache-invalidate', async (event, deviceKey) => {
  try {
    await deviceCache.invalidate(deviceKey);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Pull file from device — converts WMA to MP3, embeds metadata + album art
const WMA_EXTENSIONS = new Set(['.wma']);

ipcMain.handle('fix-extensionless-files', async (event, filePaths) => {
  const renamed = [];
  for (const filePath of filePaths) {
    if (!isAllowedPath(filePath)) continue;
    if (path.extname(filePath) !== '') continue; // already has extension
    try {
      const buf = Buffer.alloc(12);
      const fh = await fs.open(filePath, 'r');
      await fh.read(buf, 0, 12, 0);
      await fh.close();

      let ext = null;
      // MP3: ID3 header or MPEG sync word
      if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ext = '.mp3';       // ID3
      else if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) ext = '.mp3';             // MPEG sync
      // FLAC
      else if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) ext = '.flac';
      // OGG
      else if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) ext = '.ogg';
      // M4A/AAC (ftyp box)
      else if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) ext = '.m4a';
      // WAV (RIFF)
      else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) ext = '.wav';
      // WMA (ASF header)
      else if (buf[0] === 0x30 && buf[1] === 0x26 && buf[2] === 0xB2 && buf[3] === 0x75) ext = '.wma';

      if (ext) {
        const newPath = filePath + ext;
        await fs.rename(filePath, newPath);
        renamed.push({ oldPath: filePath, newPath });
      }
    } catch {
      // Skip files we can't read or rename
    }
  }
  return { success: true, renamed };
});

ipcMain.handle('pick-pull-destination', async () => {
  const settingsPath = path.join(app.getPath('userData'), 'pull-destination.json');
  let defaultPath;
  try {
    const data = await fs.readFile(settingsPath, 'utf-8');
    defaultPath = JSON.parse(data).path;
  } catch {
    defaultPath = app.getPath('music');
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose destination folder',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, cancelled: true };
  }

  const chosen = result.filePaths[0];

  // Remember for next time
  try {
    await fs.writeFile(settingsPath, JSON.stringify({ path: chosen }));
  } catch {
    // Non-critical — just won't remember next time
  }

  return { success: true, path: chosen };
});

ipcMain.handle('zune-pull-file', async (event, handle, filename, destDir, metadata) => {
  try {
    const data = await zuneManager.getFile(handle);
    if (!data || data.length === 0) {
      console.error(`zune-pull-file: handle ${handle} returned empty data (0 bytes)`);
      return { success: false, error: 'Device returned empty file (0 bytes)' };
    }
    let ext = path.extname(filename).toLowerCase();
    let baseName = path.basename(filename, ext);
    // Zune filenames sometimes lack an extension — default to .mp3
    if (!ext) ext = '.mp3';

    // Use title as filename if available (ZMDB filenames can be cryptic)
    if (metadata?.title) {
      baseName = metadata.title.replace(/[<>:"/\\|?*]/g, '_');
      if (metadata?.artist) baseName = `${metadata.artist.replace(/[<>:"/\\|?*]/g, '_')} - ${baseName}`;
    }

    // Save raw file to temp location first
    const tempRaw = path.join(os.tmpdir(), `zune-pull-${Date.now()}-${baseName}${ext}`);
    await fs.writeFile(tempRaw, data);

    let finalPath;

    if (WMA_EXTENSIONS.has(ext)) {
      // Convert WMA → MP3 via ffmpeg
      const mp3Name = baseName + '.mp3';
      finalPath = path.join(destDir, mp3Name);

      const ffArgs = ['-i', tempRaw];

      // Embed album art if available (base64 data URL → temp file)
      let tempArt = null;
      const albumArt = metadata?.albumArt;
      if (albumArt && albumArt.startsWith('data:image/')) {
        try {
          const match = albumArt.match(/^data:image\/(\w+);base64,(.+)$/);
          if (match) {
            const artExt = match[1] === 'jpeg' ? 'jpg' : match[1];
            tempArt = path.join(os.tmpdir(), `zune-art-${Date.now()}.${artExt}`);
            await fs.writeFile(tempArt, Buffer.from(match[2], 'base64'));
            ffArgs.push('-i', tempArt);
          }
        } catch (_) { /* art embedding is best-effort */ }
      }

      ffArgs.push(
        '-c:a', 'libmp3lame',
        '-b:a', '320k',
        '-ar', '44100',
        '-ac', '2',
      );

      // Map audio from input 0, art from input 1 (if present)
      if (tempArt) {
        ffArgs.push(
          '-map', '0:a',
          '-map', '1:0',
          '-c:v', 'copy',
          '-id3v2_version', '3',
          '-metadata:s:v', 'title=Album cover',
          '-metadata:s:v', 'comment=Cover (front)',
        );
      }

      // Embed text metadata
      if (metadata?.title) ffArgs.push('-metadata', `title=${metadata.title}`);
      if (metadata?.artist) ffArgs.push('-metadata', `artist=${metadata.artist}`);
      if (metadata?.album) ffArgs.push('-metadata', `album=${metadata.album}`);
      if (metadata?.genre) ffArgs.push('-metadata', `genre=${metadata.genre}`);
      if (metadata?.trackNumber) ffArgs.push('-metadata', `track=${metadata.trackNumber}`);

      ffArgs.push('-y', finalPath);

      await execFileAsync(ffmpegPath, ffArgs);

      // Clean up temp files
      await fs.unlink(tempRaw).catch(() => {});
      if (tempArt) await fs.unlink(tempArt).catch(() => {});
    } else {
      // MP3/AAC — just move to destination (already playable)
      finalPath = path.join(destDir, baseName + ext);
      await fs.rename(tempRaw, finalPath).catch(async () => {
        // rename fails across filesystems, fall back to copy+delete
        await fs.copyFile(tempRaw, finalPath);
        await fs.unlink(tempRaw).catch(() => {});
      });
    }

    const finalStats = await fs.stat(finalPath);
    return { success: true, path: finalPath, size: finalStats.size };
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

ipcMain.handle('zune-install-driver', async () => {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Only applicable on Windows' };
  }

  const infPath = app.isPackaged
    ? path.join(process.resourcesPath, 'zune-winusb.inf')
    : path.join(__dirname, '../../build-resources/zune-winusb.inf');

  // Verify the .inf file actually exists before attempting installation
  try {
    await fs.access(infPath);
  } catch {
    return { success: false, error: `Driver file not found: ${infPath}` };
  }

  // Write the install script to a temp file to avoid quoting hell
  const tmpScript = path.join(os.tmpdir(), 'zune-driver-install.ps1');
  const tmpLog = path.join(os.tmpdir(), 'zune-driver-install.log');
  // Build the script as an array of lines so the PowerShell here-string
  // closing "@ is guaranteed to start at column 0 (required by PS syntax).
  const scriptLines = [
    `$infSrc = "${infPath}"`,
    `$log    = "${tmpLog.replace(/\\/g, '\\\\')}"`,
    `$hwids  = @("USB\\VID_045E&PID_063E", "USB\\VID_045E&PID_0710")`,
    ``,
    `# Work in a temp directory so we can write the .cat alongside the .inf`,
    `$workDir = Join-Path $env:TEMP "zune-driver-pkg"`,
    `New-Item -ItemType Directory -Force -Path $workDir | Out-Null`,
    `$inf = Join-Path $workDir "zune-winusb.inf"`,
    `$cat = Join-Path $workDir "zune-winusb.cat"`,
    `Copy-Item $infSrc $inf -Force`,
    ``,
    `# 1. Create a self-signed code-signing cert (Zadig does the same thing)`,
    `$cert = New-SelfSignedCertificate \``,
    `    -Subject "CN=Zune Explorer Driver" \``,
    `    -Type CodeSigningCert \``,
    `    -KeyUsage DigitalSignature \``,
    `    -CertStoreLocation "Cert:\\LocalMachine\\My" \``,
    `    -NotAfter (Get-Date).AddYears(10)`,
    ``,
    `# 2. Trust the cert so Windows accepts driver packages signed with it`,
    `foreach ($store in @("Root", "TrustedPublisher")) {`,
    `    $s = New-Object System.Security.Cryptography.X509Certificates.X509Store($store, "LocalMachine")`,
    `    $s.Open("ReadWrite"); $s.Add($cert); $s.Close()`,
    `}`,
    ``,
    `# 3. Create and sign the catalog file`,
    `New-FileCatalog -Path $inf -CatalogFilePath $cat -CatalogVersion 1 | Out-Null`,
    `Set-AuthenticodeSignature -FilePath $cat -Certificate $cert | Out-Null`,
    ``,
    `# 4. Stage + install the signed package`,
    `$out = pnputil /add-driver $inf /install 2>&1 | Out-String`,
    `Add-Content $log "pnputil: $out"`,
    ``,
    `# 5. Force-update any currently connected Zune from MTP to WinUSB`,
    `Add-Type -TypeDefinition @"`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public class ZuneSetupApi {`,
    `    public const uint INSTALLFLAG_FORCE = 0x00000001;`,
    `    [DllImport("setupapi.dll", CharSet = CharSet.Auto, SetLastError = true)]`,
    `    public static extern bool UpdateDriverForPlugAndPlayDevices(`,
    `        IntPtr hwndParent, string hardwareId, string fullInfPath,`,
    `        uint installFlags, ref bool bRebootRequired);`,
    `}`,
    `"@`,
    ``,
    `$reboot = $false`,
    `foreach ($hwid in $hwids) {`,
    `    [ZuneSetupApi]::UpdateDriverForPlugAndPlayDevices(`,
    `        [IntPtr]::Zero, $hwid, $inf,`,
    `        [ZuneSetupApi]::INSTALLFLAG_FORCE, [ref]$reboot) | Out-Null`,
    `}`,
    `Add-Content $log "done"`,
  ];
  const scriptContent = scriptLines.join('\r\n');

  try {
    await fs.writeFile(tmpScript, scriptContent, 'utf8');

    // Run the script elevated via UAC
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${tmpScript}' -Verb RunAs -Wait`
    ], { timeout: 60000 });

    // Read back the log written by the elevated script
    const log = await fs.readFile(tmpLog, 'utf8').catch(() => '(no log output)');
    console.log('zune-install-driver log:\n', log);
    if (log.includes('invalid') || log.includes('error') || log.includes('Error')) {
      return { success: false, error: log.trim() };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    await fs.unlink(tmpScript).catch(() => {});
    await fs.unlink(tmpLog).catch(() => {});
  }
});

// Metadata enrichment
ipcMain.handle('metadata-search', async (event, album, artist) => {
  try {
    const results = await musicbrainz.searchReleases(album, artist);
    return { success: true, results };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('metadata-thumbnail', async (event, mbid) => {
  try {
    const dataUrl = await musicbrainz.getThumbnail(mbid);
    return { success: true, dataUrl };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('metadata-fetch', async (event, mbid) => {
  try {
    const release = await musicbrainz.getRelease(mbid);
    const albumArt = await musicbrainz.getCoverArt(mbid);
    const result = { ...release, albumArt };
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('metadata-cache-get', async (event, artist, album) => {
  const data = await metadataCache.get(artist, album);
  return { success: true, data };
});

ipcMain.handle('metadata-cache-set', async (event, artist, album, data) => {
  await metadataCache.set(artist, album, data);
  return { success: true };
});

ipcMain.handle('metadata-cache-get-all', async () => {
  const data = await metadataCache.getAll();
  return { success: true, data };
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
