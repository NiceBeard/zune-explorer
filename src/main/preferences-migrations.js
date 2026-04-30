const fs = require('node:fs/promises');
const path = require('node:path');

const SIGNAL_FILES = [
  'pins.json',
  'pull-destination.json',
  'now-playing.json',
  'metadata-cache.json',
];
const SIGNAL_DIRS = ['playlists'];

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function dirNotEmpty(p) {
  try {
    const entries = await fs.readdir(p);
    return entries.length > 0;
  } catch { return false; }
}

async function detectInstallType(userDataDir) {
  const signals = [];
  for (const f of SIGNAL_FILES) {
    if (await exists(path.join(userDataDir, f))) signals.push(f);
  }
  for (const d of SIGNAL_DIRS) {
    if (await dirNotEmpty(path.join(userDataDir, d))) signals.push(d + '/');
  }
  if (await exists(path.join(userDataDir, 'podcasts', 'preferences.json'))) {
    signals.push('podcasts/preferences.json');
  }
  return { type: signals.length > 0 ? 'upgrade' : 'new', signals };
}

async function readJsonSafe(p) {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function importLegacyFiles(userDataDir) {
  const patch = {};

  const pullPath = path.join(userDataDir, 'pull-destination.json');
  const pull = await readJsonSafe(pullPath);
  if (pull && typeof pull.path === 'string') {
    patch.sync = { pullDestination: pull.path };
    try { await fs.unlink(pullPath); } catch {}
  }

  const podPath = path.join(userDataDir, 'podcasts', 'preferences.json');
  const pod = await readJsonSafe(podPath);
  if (pod && typeof pod.downloadDirectory === 'string') {
    patch.podcasts = { downloadDirectory: pod.downloadDirectory };
    // Don't delete — podcast-manager may have other keys in it.
    // It's refactored in a later task to read from the central store.
  }

  return patch;
}

module.exports = { detectInstallType, importLegacyFiles };
