const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const execFileAsync = promisify(execFile);

function getAllowedPrefixes() {
  return [
    app.getPath('home'),
    '/Applications',
    '/System/Applications',
    '/System/Cryptexes/App/System/Applications',
    '/Volumes'
  ];
}

async function scanApplications(homePath) {
  const appDirs = [
    '/Applications',
    '/System/Applications',
    path.join(homePath, 'Applications')
  ];

  const applications = [];

  for (const dir of appDirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.endsWith('.app') && entry.isDirectory()) {
          const appPath = path.join(dir, entry.name);
          try {
            const stats = await fs.stat(appPath);
            applications.push({
              name: entry.name.replace(/\.app$/, ''),
              path: appPath,
              isDirectory: true,
              size: stats.size,
              modified: stats.mtime,
              extension: '.app',
              isApplication: true
            });
          } catch {
            // Skip apps we can't stat
          }
        }
      }
    } catch {
      // Directory doesn't exist or isn't accessible
    }
  }

  return applications;
}

async function getRecentFiles(homePath) {
  // Use mdfind to get recently accessed files
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateString = thirtyDaysAgo.toISOString().split('T')[0];

  // Use execFileAsync to avoid command injection
  const { stdout } = await execFileAsync('mdfind', [
    '-onlyin', homePath,
    `kMDItemLastUsedDate >= $time.iso(${dateString}T00:00:00Z)`
  ]);

  const filePaths = stdout.trim().split('\n').filter(p => p.length > 0);

  // Define file extensions we're interested in
  const supportedExtensions = [
    '.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma',
    '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
    '.jpg', '.jpeg', '.png', '.gif', '.svg', '.bmp', '.webp', '.ico', '.heic', '.heif',
    '.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.md',
    '.app', '.exe', '.dmg', '.pkg', '.deb', '.msi'
  ];

  // Process files in batches to avoid spawning too many processes
  const BATCH_SIZE = 15;
  const files = [];

  for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
    const batch = filePaths.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const stats = await fs.stat(filePath);

          // Skip directories (except .app bundles)
          if (stats.isDirectory() && !filePath.endsWith('.app')) {
            return null;
          }

          const fileName = path.basename(filePath);
          const extension = path.extname(filePath).toLowerCase();

          // Skip files with unsupported extensions
          if (!supportedExtensions.includes(extension) && extension !== '') {
            return null;
          }

          // Get last access time using mdls (safe argument passing)
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
              name: fileName,
              path: filePath,
              isDirectory: false,
              size: stats.size,
              modified: stats.mtime,
              lastAccessed: lastAccessed,
              extension: extension,
              isApplication: extension === '.app'
            };
          } catch (mdlsError) {
            // If mdls fails, fall back to file modification time
            return {
              name: fileName,
              path: filePath,
              isDirectory: false,
              size: stats.size,
              modified: stats.mtime,
              lastAccessed: stats.mtime,
              extension: extension,
              isApplication: extension === '.app'
            };
          }
        } catch (error) {
          // File might have been deleted or inaccessible
          return null;
        }
      })
    );
    files.push(...batchResults.filter(file => file !== null));
  }

  // Sort by last accessed date (newest first)
  files.sort((a, b) => {
    const aTime = new Date(a.lastAccessed);
    const bTime = new Date(b.lastAccessed);
    return bTime - aTime;
  });

  return files.slice(0, 50);
}

async function getAppIcon(appPath) {
  const appName = path.basename(appPath, '.app');

  // Get the app icon using the app's icon file
  const iconPath = path.join(appPath, 'Contents', 'Resources');

  // Check if Resources directory exists
  try {
    await fs.access(iconPath);
  } catch {
    return { success: false, error: 'Resources directory not found' };
  }

  // Try common icon file names (comprehensive list)
  const iconNames = [
    'AppIcon.icns',
    'app.icns',
    'icon.icns',
    'Icon.icns',
    'application.icns',
    'Application.icns',
    'App.icns',
    `${appName}.icns`,
    `${appName.toLowerCase()}.icns`,
    'document.icns',
    'Document.icns'
  ];

  let foundIconPath = null;

  for (const iconName of iconNames) {
    const fullIconPath = path.join(iconPath, iconName);
    try {
      await fs.access(fullIconPath);
      foundIconPath = fullIconPath;
      break;
    } catch {
      // Icon file doesn't exist, try next
    }
  }

  // Try to read Info.plist for icon name
  if (!foundIconPath) {
    try {
      const plistPath = path.join(appPath, 'Contents', 'Info.plist');
      const plistContent = await fs.readFile(plistPath, 'utf8');

      // Look for various icon keys in the plist
      const iconFileMatch = plistContent.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/);
      const iconNameMatch = plistContent.match(/<key>CFBundleIconName<\/key>\s*<string>([^<]+)<\/string>/);

      // Also look for newer CFBundleIcons structure
      const bundleIconsMatch = plistContent.match(/<key>CFBundleIcons<\/key>\s*<dict>[\s\S]*?<key>CFBundlePrimaryIcon<\/key>\s*<dict>[\s\S]*?<key>CFBundleIconName<\/key>\s*<string>([^<]+)<\/string>/);

      const iconCandidates = [];
      if (iconFileMatch) iconCandidates.push(iconFileMatch[1]);
      if (iconNameMatch) iconCandidates.push(iconNameMatch[1]);
      if (bundleIconsMatch) iconCandidates.push(bundleIconsMatch[1]);

      for (let iconFileName of iconCandidates) {
        // Try both with and without .icns extension
        const variations = [];
        if (iconFileName.endsWith('.icns')) {
          variations.push(iconFileName);
          variations.push(iconFileName.slice(0, -5)); // Remove .icns
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
            // Icon variation doesn't exist, try next
          }
        }

        if (foundIconPath) break;
      }
    } catch (error) {
      // Couldn't read plist, continue to fallback
    }
  }

  // Last resort: try to find any .icns file in the Resources folder
  if (!foundIconPath) {
    try {
      const files = await fs.readdir(iconPath);
      const icnsFiles = files.filter(file => file.endsWith('.icns'));

      if (icnsFiles.length > 0) {
        // Prefer files with 'icon' or 'app' in the name
        const preferredIcon = icnsFiles.find(file =>
          file.toLowerCase().includes('icon') ||
          file.toLowerCase().includes('app')
        ) || icnsFiles[0];

        foundIconPath = path.join(iconPath, preferredIcon);
      }
    } catch (error) {
      // Error reading Resources directory
    }
  }

  // Convert the .icns file to a data URL using nativeImage
  if (foundIconPath) {
    // First try with nativeImage
    try {
      const image = nativeImage.createFromPath(foundIconPath);
      if (!image.isEmpty()) {
        const buffer = image.toPNG();
        const base64 = buffer.toString('base64');
        const dataUrl = `data:image/png;base64,${base64}`;
        return { success: true, iconDataUrl: dataUrl };
      }
    } catch (error) {
      // nativeImage failed, try sips fallback
    }

    // Fallback: Use macOS sips command to convert .icns to PNG
    try {
      const tempPngPath = path.join(app.getPath('temp'), `icon_${crypto.randomUUID()}.png`);

      // Use execFileAsync to avoid command injection
      await execFileAsync('sips', [
        '-s', 'format', 'png',
        foundIconPath,
        '--out', tempPngPath,
        '--resampleWidth', '64'
      ]);

      // Read the converted PNG file
      const pngBuffer = await fs.readFile(tempPngPath);
      const base64 = pngBuffer.toString('base64');
      const dataUrl = `data:image/png;base64,${base64}`;

      // Clean up temp file
      try {
        await fs.unlink(tempPngPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }

      return { success: true, iconDataUrl: dataUrl };
    } catch (sipsError) {
      console.error(`Error converting icon for ${appName}:`, sipsError);
    }
  }

  return { success: false, error: 'No icon found' };
}

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

module.exports = {
  getAllowedPrefixes,
  scanApplications,
  getRecentFiles,
  getAppIcon,
  getExternalVolumes
};
