const fs = require('node:fs/promises');
const path = require('node:path');

const FILENAME = 'preferences.json';
const SCHEMA_VERSION = 1;

let state = null;
let storeDir = null;
let subscribers = [];
let writeTimer = null;

function defaultPrefs(defaultHome) {
  return {
    version: SCHEMA_VERSION,
    library: {
      music: [path.join(defaultHome, 'Music')],
      videos: [path.join(defaultHome, 'Movies')],
      pictures: [path.join(defaultHome, 'Pictures')],
      scanDesktopAndDownloads: false,
    },
    sync: { pullDestination: null },
    podcasts: { downloadDirectory: null },
    meta: {
      installedVersion: null,
      firstRunAt: null,
      behaviorChangeToastShown: false,
    },
  };
}

function deepMergeDefaults(loaded, defaults) {
  const out = {};
  for (const key of Object.keys(defaults)) {
    const dv = defaults[key];
    const lv = loaded ? loaded[key] : undefined;
    if (lv === undefined) {
      out[key] = dv;
    } else if (dv && typeof dv === 'object' && !Array.isArray(dv)) {
      out[key] = deepMergeDefaults(lv, dv);
    } else {
      out[key] = lv;
    }
  }
  return out;
}

async function readFileSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    try { await fs.rename(filePath, filePath + '.bad'); } catch {}
    return null;
  }
}

async function writeNow() {
  if (!state || !storeDir) return;
  const filePath = path.join(storeDir, FILENAME);
  const copy = { ...state };
  delete copy.__defaultHome;
  const raw = JSON.stringify(copy, null, 2);
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, raw);
  await fs.rename(tmp, filePath);
}

function scheduleWrite(ms = 200) {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeNow().catch((err) => console.error('preferences: write failed', err));
  }, ms);
}

async function load(userDataDir, { defaultHome }) {
  storeDir = userDataDir;
  const filePath = path.join(storeDir, FILENAME);
  const loaded = await readFileSafe(filePath);
  const defaults = defaultPrefs(defaultHome);
  if (loaded === null) {
    state = defaults;
    await writeNow();
  } else {
    state = deepMergeDefaults(loaded, defaults);
  }
  state.__defaultHome = defaultHome;
  return state;
}

function get(dotPath) {
  if (!state) return undefined;
  const parts = dotPath.split('.');
  let cur = state;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function collectLeafPaths(patch, prefix = '') {
  const out = [];
  for (const key of Object.keys(patch)) {
    const v = patch[key];
    const p = prefix ? `${prefix}.${key}` : key;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...collectLeafPaths(v, p));
    } else {
      out.push({ path: p, newValue: v });
    }
  }
  return out;
}

function deepMerge(target, src) {
  for (const key of Object.keys(src)) {
    const sv = src[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      deepMerge(target[key], sv);
    } else {
      target[key] = sv;
    }
  }
}

async function update(patch) {
  if (!state) throw new Error('preferences not loaded');
  const events = collectLeafPaths(patch);
  deepMerge(state, patch);
  await writeNow();
  for (const evt of events) {
    for (const cb of subscribers) {
      try { cb(evt); } catch (err) { console.error('preferences subscriber threw', err); }
    }
  }
}

async function reset(section) {
  if (!state || !storeDir) throw new Error('preferences not loaded');
  const home = state.__defaultHome || require('node:os').homedir();
  const defaults = defaultPrefs(home);
  if (section) {
    state[section] = defaults[section];
  } else {
    state = defaults;
    state.__defaultHome = home;
  }
  await writeNow();
}

function subscribe(cb) {
  subscribers.push(cb);
  return () => { subscribers = subscribers.filter((s) => s !== cb); };
}

function _resetModule() {
  state = null;
  storeDir = null;
  subscribers = [];
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
}

module.exports = { load, get, update, reset, subscribe, SCHEMA_VERSION, _resetModule };
