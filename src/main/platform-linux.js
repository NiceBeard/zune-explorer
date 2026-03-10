const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;

function getAllowedPrefixes() {
  const home = app.getPath('home');
  return [
    home,
    '/opt',
    '/usr/share/applications',
    '/mnt',
    '/media',
    '/run/media'
  ];
}

async function scanApplications(homePath) {
  const desktopDirs = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    path.join(homePath, '.local', 'share', 'applications')
  ];

  // Also check XDG_DATA_DIRS
  const xdgDataDirs = process.env.XDG_DATA_DIRS;
  if (xdgDataDirs) {
    for (const dir of xdgDataDirs.split(':')) {
      const appDir = path.join(dir, 'applications');
      if (!desktopDirs.includes(appDir)) {
        desktopDirs.push(appDir);
      }
    }
  }

  const seenExecs = new Set();
  const applications = [];

  for (const dir of desktopDirs) {
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith('.desktop')) continue;
        const desktopPath = path.join(dir, entry);
        try {
          const content = await fs.readFile(desktopPath, 'utf-8');

          // Skip entries that are hidden or of type other than Application
          if (/^\s*Hidden\s*=\s*true/mi.test(content)) continue;
          if (/^\s*NoDisplay\s*=\s*true/mi.test(content)) continue;
          const typeMatch = content.match(/^\s*Type\s*=\s*(.+)/m);
          if (typeMatch && typeMatch[1].trim() !== 'Application') continue;

          const nameMatch = content.match(/^\s*Name\s*=\s*(.+)/m);
          const execMatch = content.match(/^\s*Exec\s*=\s*(.+)/m);
          if (!nameMatch || !execMatch) continue;

          const appName = nameMatch[1].trim();
          // Extract the binary path (strip %u, %f, %U, %F and field codes)
          const execLine = execMatch[1].trim().replace(/%[a-zA-Z]/g, '').trim();
          const execBin = execLine.split(/\s+/)[0];

          if (seenExecs.has(execBin)) continue;
          seenExecs.add(execBin);

          let stats;
          try {
            stats = await fs.stat(desktopPath);
          } catch {
            continue;
          }

          applications.push({
            name: appName,
            path: desktopPath,
            isDirectory: false,
            size: stats.size,
            modified: stats.mtime,
            extension: '.desktop',
            isApplication: true
          });
        } catch {
          // Could not read desktop file, skip
        }
      }
    } catch {
      // Directory doesn't exist or isn't accessible
    }
  }

  return applications;
}

async function getRecentFiles(homePath) {
  const supportedExtensions = [
    '.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma',
    '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
    '.jpg', '.jpeg', '.png', '.gif', '.svg', '.bmp', '.webp', '.ico', '.heic', '.heif',
    '.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.md',
    '.deb', '.AppImage'
  ];

  const files = [];

  // Try freedesktop recently-used.xbel
  const xbelPaths = [
    path.join(homePath, '.local', 'share', 'recently-used.xbel'),
    path.join(homePath, '.recently-used.xbel')
  ];

  let xbelContent = null;
  for (const xbelPath of xbelPaths) {
    try {
      xbelContent = await fs.readFile(xbelPath, 'utf-8');
      break;
    } catch {
      // Try next path
    }
  }

  if (xbelContent) {
    // Parse bookmark entries from the XBEL XML
    const bookmarkRegex = /<bookmark\s+href="([^"]+)"[^>]*modified="([^"]*)"[^>]*>/g;
    let match;

    while ((match = bookmarkRegex.exec(xbelContent)) !== null) {
      try {
        const fileUrl = match[1];
        const modified = match[2];

        // Only handle file:// URLs
        if (!fileUrl.startsWith('file://')) continue;

        const filePath = decodeURIComponent(fileUrl.replace('file://', ''));
        const extension = path.extname(filePath).toLowerCase();

        if (!supportedExtensions.includes(extension) && extension !== '') continue;

        let stats;
        try {
          stats = await fs.stat(filePath);
        } catch {
          continue; // File no longer exists
        }

        if (stats.isDirectory()) continue;

        files.push({
          name: path.basename(filePath),
          path: filePath,
          isDirectory: false,
          size: stats.size,
          modified: stats.mtime,
          lastAccessed: modified ? new Date(modified) : stats.mtime,
          extension: extension,
          isApplication: false
        });
      } catch {
        // Skip malformed entries
      }
    }
  }

  // Fallback: scan common directories for recently modified files
  if (files.length === 0) {
    const scanDirs = [
      path.join(homePath, 'Downloads'),
      path.join(homePath, 'Desktop'),
      path.join(homePath, 'Documents')
    ];

    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

    for (const dir of scanDirs) {
      try {
        const entries = await fs.readdir(dir);
        for (const entry of entries) {
          const filePath = path.join(dir, entry);
          try {
            const stats = await fs.stat(filePath);
            if (stats.isDirectory()) continue;
            if (stats.mtimeMs < thirtyDaysAgo) continue;

            const extension = path.extname(filePath).toLowerCase();
            if (!supportedExtensions.includes(extension) && extension !== '') continue;

            files.push({
              name: entry,
              path: filePath,
              isDirectory: false,
              size: stats.size,
              modified: stats.mtime,
              lastAccessed: stats.mtime,
              extension: extension,
              isApplication: false
            });
          } catch {
            // Skip inaccessible files
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }
  }

  // Sort by last accessed date (newest first) and limit to 50
  files.sort((a, b) => new Date(b.lastAccessed) - new Date(a.lastAccessed));
  return files.slice(0, 50);
}

async function getAppIcon(appPath) {
  // For .desktop files, try to extract the Icon field and look it up
  if (appPath.endsWith('.desktop')) {
    try {
      const content = await fs.readFile(appPath, 'utf-8');
      const iconMatch = content.match(/^\s*Icon\s*=\s*(.+)/m);
      if (!iconMatch) {
        return { success: false, error: 'No Icon field in desktop file' };
      }

      const iconValue = iconMatch[1].trim();

      // If it's an absolute path, try loading it directly
      if (iconValue.startsWith('/')) {
        return await loadIconFile(iconValue);
      }

      // Otherwise, search the icon theme hierarchy
      const iconDirs = getIconSearchPaths();
      const sizes = ['256x256', '128x128', '64x64', '48x48', '32x32', 'scalable'];
      const extensions = ['.png', '.svg', '.xpm'];

      for (const size of sizes) {
        for (const iconDir of iconDirs) {
          for (const ext of extensions) {
            const candidates = [
              path.join(iconDir, size, 'apps', iconValue + ext),
              path.join(iconDir, size, 'apps', iconValue + ext),
            ];
            for (const candidate of candidates) {
              const result = await loadIconFile(candidate);
              if (result.success) return result;
            }
          }
        }
      }

      // Try pixmaps as last resort
      const pixmapPaths = [
        `/usr/share/pixmaps/${iconValue}.png`,
        `/usr/share/pixmaps/${iconValue}.svg`,
        `/usr/share/pixmaps/${iconValue}.xpm`,
      ];
      for (const p of pixmapPaths) {
        const result = await loadIconFile(p);
        if (result.success) return result;
      }

      return { success: false, error: 'Icon not found in theme hierarchy' };
    } catch {
      return { success: false, error: 'Could not read desktop file' };
    }
  }

  // For regular executables, try Electron's built-in API
  try {
    const icon = await app.getFileIcon(appPath, { size: 'large' });
    if (icon.isEmpty()) {
      return { success: false, error: 'No icon found' };
    }
    const buffer = icon.toPNG();
    const base64 = buffer.toString('base64');
    return { success: true, iconDataUrl: `data:image/png;base64,${base64}` };
  } catch {
    return { success: false, error: 'No icon found' };
  }
}

function getIconSearchPaths() {
  const paths = [];

  // XDG data dirs
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '', '.local', 'share');
  const xdgDataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');

  const allDataDirs = [xdgDataHome, ...xdgDataDirs];

  // Common theme names in priority order
  const themes = ['hicolor'];

  // Try to detect the current theme from environment
  const gtkTheme = process.env.GTK_ICON_THEME;
  if (gtkTheme) {
    themes.unshift(gtkTheme);
  }

  for (const dataDir of allDataDirs) {
    for (const theme of themes) {
      paths.push(path.join(dataDir, 'icons', theme));
    }
  }

  return paths;
}

async function loadIconFile(iconPath) {
  try {
    await fs.access(iconPath);
  } catch {
    return { success: false, error: 'File not found' };
  }

  try {
    const ext = path.extname(iconPath).toLowerCase();

    if (ext === '.png') {
      const buffer = await fs.readFile(iconPath);
      const base64 = buffer.toString('base64');
      return { success: true, iconDataUrl: `data:image/png;base64,${base64}` };
    }

    if (ext === '.svg') {
      const buffer = await fs.readFile(iconPath);
      const base64 = buffer.toString('base64');
      return { success: true, iconDataUrl: `data:image/svg+xml;base64,${base64}` };
    }

    // For other formats, try Electron's nativeImage
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      const buffer = image.toPNG();
      const base64 = buffer.toString('base64');
      return { success: true, iconDataUrl: `data:image/png;base64,${base64}` };
    }

    return { success: false, error: 'Could not convert icon' };
  } catch {
    return { success: false, error: 'Error reading icon file' };
  }
}

async function getExternalVolumes() {
  const volumes = [];

  // Pseudo-filesystem types to exclude
  const excludeTypes = new Set([
    'sysfs', 'proc', 'devtmpfs', 'devpts', 'tmpfs', 'securityfs',
    'cgroup', 'cgroup2', 'pstore', 'debugfs', 'hugetlbfs', 'mqueue',
    'configfs', 'fusectl', 'tracefs', 'bpf', 'binfmt_misc',
    'autofs', 'efivarfs', 'overlay', 'squashfs', 'nsfs',
    'fuse.gvfsd-fuse', 'fuse.portal'
  ]);

  // System mount points to exclude
  const excludePaths = new Set(['/', '/boot', '/boot/efi', '/home', '/tmp', '/var', '/snap']);

  try {
    const mtab = await fs.readFile('/proc/mounts', 'utf-8');
    const lines = mtab.trim().split('\n');

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;

      const mountPoint = parts[1];
      const fsType = parts[2];

      if (excludeTypes.has(fsType)) continue;
      if (excludePaths.has(mountPoint)) continue;
      if (mountPoint.startsWith('/sys') || mountPoint.startsWith('/proc') || mountPoint.startsWith('/dev')) continue;
      if (mountPoint.startsWith('/snap/')) continue;

      // Only include mounts under /mnt, /media, or /run/media
      const isExternalMount = mountPoint.startsWith('/mnt/') ||
                              mountPoint.startsWith('/media/') ||
                              mountPoint.startsWith('/run/media/');
      if (!isExternalMount) continue;

      try {
        await fs.access(mountPoint);
        volumes.push({
          name: path.basename(mountPoint),
          path: mountPoint,
          kind: 'volume',
        });
      } catch {
        // Mount point not accessible
      }
    }
  } catch {
    // /proc/mounts not readable
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
