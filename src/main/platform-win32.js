const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;

function getAllowedPrefixes() {
  const home = app.getPath('home');
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

  return [
    home,
    programFiles,
    programFilesX86,
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(localAppData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs'
  ];
}

async function scanApplications(homePath) {
  const appData = process.env.APPDATA || path.join(homePath, 'AppData', 'Roaming');

  const startMenuDirs = [
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ];

  const seenTargets = new Set();
  const applications = [];

  for (const dir of startMenuDirs) {
    await scanDirectoryForLinks(dir, applications, seenTargets);
  }

  return applications;
}

async function scanDirectoryForLinks(dir, applications, seenTargets) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await scanDirectoryForLinks(fullPath, applications, seenTargets);
      continue;
    }

    if (!entry.name.endsWith('.lnk')) {
      continue;
    }

    try {
      const shortcut = shell.readShortcutLink(fullPath);
      const target = shortcut.target;

      if (!target || !target.toLowerCase().endsWith('.exe')) {
        continue;
      }

      // Deduplicate by target .exe path
      const normalizedTarget = target.toLowerCase();
      if (seenTargets.has(normalizedTarget)) {
        continue;
      }
      seenTargets.add(normalizedTarget);

      let stats;
      try {
        stats = await fs.stat(target);
      } catch {
        // Target doesn't exist, skip
        continue;
      }

      applications.push({
        name: entry.name.replace(/\.lnk$/i, ''),
        path: target,
        isDirectory: false,
        size: stats.size,
        modified: stats.mtime,
        extension: '.exe',
        isApplication: true
      });
    } catch {
      // Could not read shortcut, skip
    }
  }
}

async function getRecentFiles(homePath) {
  const appData = process.env.APPDATA || path.join(homePath, 'AppData', 'Roaming');
  const recentDir = path.join(appData, 'Microsoft', 'Windows', 'Recent');

  let entries;
  try {
    entries = await fs.readdir(recentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const supportedExtensions = [
    '.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma',
    '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
    '.jpg', '.jpeg', '.png', '.gif', '.svg', '.bmp', '.webp', '.ico', '.heic', '.heif',
    '.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.md',
    '.exe', '.msi'
  ];

  const files = [];

  for (const entry of entries) {
    if (!entry.name.endsWith('.lnk')) {
      continue;
    }

    const lnkPath = path.join(recentDir, entry.name);

    try {
      const shortcut = shell.readShortcutLink(lnkPath);
      const target = shortcut.target;

      if (!target) {
        continue;
      }

      const extension = path.extname(target).toLowerCase();
      if (!supportedExtensions.includes(extension) && extension !== '') {
        continue;
      }

      let targetStats;
      try {
        targetStats = await fs.stat(target);
      } catch {
        // Target file doesn't exist, skip
        continue;
      }

      // Skip directories
      if (targetStats.isDirectory()) {
        continue;
      }

      // Use .lnk file's mtime as lastAccessed proxy
      let lnkStats;
      try {
        lnkStats = await fs.stat(lnkPath);
      } catch {
        lnkStats = targetStats;
      }

      files.push({
        name: path.basename(target),
        path: target,
        isDirectory: false,
        size: targetStats.size,
        modified: targetStats.mtime,
        lastAccessed: lnkStats.mtime,
        extension: extension,
        isApplication: extension === '.exe'
      });
    } catch {
      // Could not read shortcut, skip
    }
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

module.exports = {
  getAllowedPrefixes,
  scanApplications,
  getRecentFiles,
  getAppIcon
};
