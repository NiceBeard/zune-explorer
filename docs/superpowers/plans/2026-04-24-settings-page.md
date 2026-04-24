# Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a proper settings experience as a top-level category, fix issue #12 (user-selectable library folders), consolidate cross-cutting preferences into a single versioned store with one-shot migration, and introduce a Zune-style boot/update splash.

**Architecture:** Main-process `preferences.js` module is the single source of truth for `preferences.json`. Renderer reads via IPC, subscribes to changes, and owns a new `SettingsView` with drill-down navigation. Library folder paths move from hardcoded (`~/Music`, `~/Movies`, `~/Pictures`) to preferences-driven. Rescan deltas are computed from old/new folder lists rather than re-scanning unchanged folders. BootSplash overlays the renderer once per install/upgrade.

**Tech Stack:** Electron (Node 18+ in main, Chromium in renderer), plain JS (no TS), `node:test` for unit tests on main-process modules, manual acceptance testing for renderer UI.

**Spec:** `docs/superpowers/specs/2026-04-24-settings-page-design.md`

**Branch:** `feat/settings-page`

---

## File structure

**Create:**
- `src/main/preferences.js` — preferences store module (singleton). API: `load()`, `get(dotPath)`, `update(patch)`, `reset(section?)`, `subscribe(cb)`.
- `src/main/preferences-migrations.js` — `detectInstallType()` + `importLegacyFiles()` + schema version migrations.
- `src/shared/path-utils.js` — pure path helpers (`isUnderPrefix`, `isUnderAnyPrefix`, `computeAddedPaths`, `computeRemovedPaths`). Shared between main and renderer, testable.
- `src/assets/js/settings-view.js` — `SettingsView` class, drill stack, per-page renderers.
- `src/assets/js/boot-splash.js` — `BootSplash` class (Zune-style vertical-bar animation).
- `tests/preferences.test.js`
- `tests/preferences-migrations.test.js`
- `tests/path-utils.test.js`

**Modify:**
- `package.json` — add `test` script.
- `src/main/main.js` — wire preferences init into boot sequence; IPC handlers for preferences, pick-folder, clear-metadata-cache, clear-device-cache, get-app-version.
- `src/main/preload.js` — new `electronAPI.preferences*` + `pickFolder` + `onFirstRun` + cache-clear helpers.
- `src/main/podcast-manager.js` — read `downloadDirectory` from central preferences; remove local storage for this one field.
- `src/assets/js/renderer.js` — register 'settings' category; read library folders from preferences in `scanMediaFiles`; mount `SettingsView` + `BootSplash`; behavior-change toast trigger.
- `src/renderer/index.html` — add settings menu item; add boot-splash root element.
- `src/assets/css/styles.css` — settings drill-list styles; boot-splash styles.

**Delete (at runtime — not in repo):**
- `userData/pull-destination.json` (removed by migration after successful import)

---

## Task 1: Bootstrap test infrastructure

**Files:**
- Modify: `package.json`
- Create: `tests/sanity.test.js`

- [ ] **Step 1: Add test script to `package.json`**

Open `package.json`. Add to the `scripts` block:

```json
"test": "node --test tests/"
```

- [ ] **Step 2: Create `tests/sanity.test.js`**

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('sanity: node:test runs', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: Run the test**

Run: `npm test`
Expected: `# pass 1` with exit code 0.

- [ ] **Step 4: Commit**

```bash
git add package.json tests/sanity.test.js
git commit -m "chore: add node:test infrastructure"
```

---

## Task 2: path-utils shared module + tests

**Files:**
- Create: `src/shared/path-utils.js`
- Create: `tests/path-utils.test.js`

- [ ] **Step 1: Write failing tests**

`tests/path-utils.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isUnderPrefix,
  isUnderAnyPrefix,
  computeAddedPaths,
  computeRemovedPaths,
} = require('../src/shared/path-utils');

test('isUnderPrefix: exact match is under itself', () => {
  assert.equal(isUnderPrefix('/a/b', '/a/b'), true);
});

test('isUnderPrefix: sub-path is under prefix', () => {
  assert.equal(isUnderPrefix('/a/b/c', '/a/b'), true);
});

test('isUnderPrefix: sibling is not under', () => {
  assert.equal(isUnderPrefix('/a/bc', '/a/b'), false);
});

test('isUnderPrefix: parent is not under child', () => {
  assert.equal(isUnderPrefix('/a', '/a/b'), false);
});

test('isUnderPrefix: trailing slash on prefix normalized', () => {
  assert.equal(isUnderPrefix('/a/b/c', '/a/b/'), true);
});

test('isUnderAnyPrefix: matches one of several', () => {
  assert.equal(isUnderAnyPrefix('/music/rock', ['/other', '/music']), true);
});

test('isUnderAnyPrefix: empty list returns false', () => {
  assert.equal(isUnderAnyPrefix('/a', []), false);
});

test('computeAddedPaths: returns new list minus old', () => {
  assert.deepEqual(computeAddedPaths(['/a'], ['/a', '/b']), ['/b']);
});

test('computeRemovedPaths: returns old list minus new', () => {
  assert.deepEqual(computeRemovedPaths(['/a', '/b'], ['/a']), ['/b']);
});

test('computeAddedPaths: no changes returns empty', () => {
  assert.deepEqual(computeAddedPaths(['/a'], ['/a']), []);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- tests/path-utils.test.js`
Expected: FAIL — `Cannot find module '../src/shared/path-utils'`.

- [ ] **Step 3: Implement the module**

`src/shared/path-utils.js`:

```javascript
function normalize(p) {
  if (!p) return p;
  return p.endsWith('/') || p.endsWith('\\') ? p.slice(0, -1) : p;
}

function isUnderPrefix(p, prefix) {
  const np = normalize(p);
  const npr = normalize(prefix);
  if (np === npr) return true;
  return np.startsWith(npr + '/') || np.startsWith(npr + '\\');
}

function isUnderAnyPrefix(p, prefixes) {
  return prefixes.some((pref) => isUnderPrefix(p, pref));
}

function computeAddedPaths(oldList, newList) {
  const oldSet = new Set(oldList.map(normalize));
  return newList.filter((p) => !oldSet.has(normalize(p)));
}

function computeRemovedPaths(oldList, newList) {
  const newSet = new Set(newList.map(normalize));
  return oldList.filter((p) => !newSet.has(normalize(p)));
}

module.exports = {
  isUnderPrefix,
  isUnderAnyPrefix,
  computeAddedPaths,
  computeRemovedPaths,
};
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test`
Expected: all 10 path-utils tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/shared/path-utils.js tests/path-utils.test.js
git commit -m "feat(shared): add path-utils module for prefix matching and list deltas"
```

---

## Task 3: Preferences module — load + defaults

**Files:**
- Create: `src/main/preferences.js`
- Create: `tests/preferences.test.js`

- [ ] **Step 1: Write failing tests**

`tests/preferences.test.js`:

```javascript
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function freshModule() {
  delete require.cache[require.resolve('../src/main/preferences')];
  return require('../src/main/preferences');
}

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prefs-test-'));
});

test('load: missing file writes defaults', async () => {
  const prefs = freshModule();
  const store = await prefs.load(tmpDir, { defaultHome: '/Users/test' });
  assert.equal(store.version, 1);
  assert.deepEqual(store.library.music, ['/Users/test/Music']);
  assert.deepEqual(store.library.videos, ['/Users/test/Movies']);
  assert.deepEqual(store.library.pictures, ['/Users/test/Pictures']);
  assert.equal(store.library.scanDesktopAndDownloads, false);

  const raw = await fs.readFile(path.join(tmpDir, 'preferences.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
});

test('load: valid existing file returned as-is', async () => {
  await fs.writeFile(
    path.join(tmpDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      library: { music: ['/a'], videos: ['/b'], pictures: ['/c'], scanDesktopAndDownloads: true },
      sync: { pullDestination: '/pull' },
      podcasts: { downloadDirectory: '/pods' },
      meta: { installedVersion: '1.4.0', firstRunAt: '2026-01-01T00:00:00Z' },
    })
  );
  const prefs = freshModule();
  const store = await prefs.load(tmpDir, { defaultHome: '/Users/test' });
  assert.deepEqual(store.library.music, ['/a']);
  assert.equal(store.library.scanDesktopAndDownloads, true);
  assert.equal(store.sync.pullDestination, '/pull');
});

test('load: missing nested keys get defaults merged in', async () => {
  await fs.writeFile(
    path.join(tmpDir, 'preferences.json'),
    JSON.stringify({ version: 1, library: { music: ['/a'] } })
  );
  const prefs = freshModule();
  const store = await prefs.load(tmpDir, { defaultHome: '/Users/test' });
  assert.deepEqual(store.library.music, ['/a']);
  assert.deepEqual(store.library.videos, ['/Users/test/Movies']);
  assert.equal(store.library.scanDesktopAndDownloads, false);
  assert.equal(store.sync.pullDestination, null);
});

test('get: returns value at dot path', async () => {
  const prefs = freshModule();
  await prefs.load(tmpDir, { defaultHome: '/Users/test' });
  assert.deepEqual(prefs.get('library.music'), ['/Users/test/Music']);
  assert.equal(prefs.get('library.scanDesktopAndDownloads'), false);
  assert.equal(prefs.get('sync.pullDestination'), null);
  assert.equal(prefs.get('nonexistent.path'), undefined);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- tests/preferences.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

`src/main/preferences.js`:

```javascript
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

module.exports = { load, get, SCHEMA_VERSION };
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test`
Expected: all 4 preferences tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/preferences.js tests/preferences.test.js
git commit -m "feat(preferences): add load/get with schema defaults and deep-merge"
```

---

## Task 4: Preferences module — update + subscribe + reset + malformed recovery

**Files:**
- Modify: `src/main/preferences.js`
- Modify: `tests/preferences.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/preferences.test.js`:

```javascript
test('update: deep merges patch and persists', async () => {
  const prefs = freshModule();
  await prefs.load(tmpDir, { defaultHome: '/Users/test' });
  await prefs.update({ library: { music: ['/new'] } });
  assert.deepEqual(prefs.get('library.music'), ['/new']);
  assert.deepEqual(prefs.get('library.videos'), ['/Users/test/Movies']);
  const fresh = freshModule();
  const store = await fresh.load(tmpDir, { defaultHome: '/Users/test' });
  assert.deepEqual(store.library.music, ['/new']);
});

test('subscribe: fires on update with path and newValue', async () => {
  const prefs = freshModule();
  await prefs.load(tmpDir, { defaultHome: '/Users/test' });
  const events = [];
  prefs.subscribe((evt) => events.push(evt));
  await prefs.update({ library: { scanDesktopAndDownloads: true } });
  assert.equal(events.length, 1);
  assert.equal(events[0].path, 'library.scanDesktopAndDownloads');
  assert.equal(events[0].newValue, true);
});

test('subscribe: fires once per leaf touched', async () => {
  const prefs = freshModule();
  await prefs.load(tmpDir, { defaultHome: '/Users/test' });
  const events = [];
  prefs.subscribe((evt) => events.push(evt));
  await prefs.update({
    library: { music: ['/x'] },
    sync: { pullDestination: '/y' },
  });
  const paths = events.map((e) => e.path).sort();
  assert.deepEqual(paths, ['library.music', 'sync.pullDestination']);
});

test('reset: section reset restores defaults for that section only', async () => {
  const prefs = freshModule();
  await prefs.load(tmpDir, { defaultHome: '/Users/test' });
  await prefs.update({
    library: { music: ['/x'] },
    sync: { pullDestination: '/y' },
  });
  await prefs.reset('library');
  assert.deepEqual(prefs.get('library.music'), ['/Users/test/Music']);
  assert.equal(prefs.get('sync.pullDestination'), '/y');
});

test('reset: full reset with no argument', async () => {
  const prefs = freshModule();
  await prefs.load(tmpDir, { defaultHome: '/Users/test' });
  await prefs.update({ sync: { pullDestination: '/y' } });
  await prefs.reset();
  assert.equal(prefs.get('sync.pullDestination'), null);
});

test('load: malformed JSON is preserved as .bad and defaults used', async () => {
  await fs.writeFile(path.join(tmpDir, 'preferences.json'), '{not json');
  const prefs = freshModule();
  const store = await prefs.load(tmpDir, { defaultHome: '/Users/test' });
  assert.equal(store.version, 1);
  const bad = await fs.readFile(path.join(tmpDir, 'preferences.json.bad'), 'utf-8');
  assert.equal(bad, '{not json');
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL — `prefs.update is not a function`.

- [ ] **Step 3: Extend the module**

In `src/main/preferences.js`, add these functions above `module.exports`:

```javascript
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
  scheduleWrite();
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
```

Update the exports line:

```javascript
module.exports = { load, get, update, reset, subscribe, SCHEMA_VERSION, _resetModule };
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test`
Expected: all 10 preferences tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/preferences.js tests/preferences.test.js
git commit -m "feat(preferences): add update, subscribe, reset, malformed-json recovery"
```

---

## Task 5: Preferences migrations — install-type detection + legacy imports

**Files:**
- Create: `src/main/preferences-migrations.js`
- Create: `tests/preferences-migrations.test.js`

- [ ] **Step 1: Write failing tests**

`tests/preferences-migrations.test.js`:

```javascript
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function fresh() {
  delete require.cache[require.resolve('../src/main/preferences-migrations')];
  return require('../src/main/preferences-migrations');
}

let tmpDir;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prefs-mig-'));
});

test('detectInstallType: empty userData is new', async () => {
  const m = fresh();
  const r = await m.detectInstallType(tmpDir);
  assert.equal(r.type, 'new');
});

test('detectInstallType: pins.json present is upgrade', async () => {
  await fs.writeFile(path.join(tmpDir, 'pins.json'), '[]');
  const m = fresh();
  const r = await m.detectInstallType(tmpDir);
  assert.equal(r.type, 'upgrade');
  assert.deepEqual(r.signals, ['pins.json']);
});

test('detectInstallType: pull-destination plus playlists is upgrade', async () => {
  await fs.writeFile(path.join(tmpDir, 'pull-destination.json'), '{}');
  await fs.mkdir(path.join(tmpDir, 'playlists'));
  await fs.writeFile(path.join(tmpDir, 'playlists', 'a.json'), '{}');
  const m = fresh();
  const r = await m.detectInstallType(tmpDir);
  assert.equal(r.type, 'upgrade');
  assert.deepEqual(r.signals.sort(), ['playlists/', 'pull-destination.json']);
});

test('importLegacyFiles: pull-destination becomes sync.pullDestination and file is deleted', async () => {
  await fs.writeFile(path.join(tmpDir, 'pull-destination.json'), JSON.stringify({ path: '/my/pulls' }));
  const m = fresh();
  const patch = await m.importLegacyFiles(tmpDir);
  assert.equal(patch.sync.pullDestination, '/my/pulls');
  await assert.rejects(fs.access(path.join(tmpDir, 'pull-destination.json')));
});

test('importLegacyFiles: no pull-destination yields empty sync patch', async () => {
  const m = fresh();
  const patch = await m.importLegacyFiles(tmpDir);
  assert.equal(patch.sync, undefined);
});

test('importLegacyFiles: corrupt pull-destination is left alone, no patch', async () => {
  await fs.writeFile(path.join(tmpDir, 'pull-destination.json'), '{corrupt');
  const m = fresh();
  const patch = await m.importLegacyFiles(tmpDir);
  assert.equal(patch.sync, undefined);
  await fs.access(path.join(tmpDir, 'pull-destination.json'));
});

test('importLegacyFiles: podcast preferences downloadDirectory becomes podcasts.downloadDirectory', async () => {
  await fs.mkdir(path.join(tmpDir, 'podcasts'));
  await fs.writeFile(
    path.join(tmpDir, 'podcasts', 'preferences.json'),
    JSON.stringify({ downloadDirectory: '/pods/dl' })
  );
  const m = fresh();
  const patch = await m.importLegacyFiles(tmpDir);
  assert.equal(patch.podcasts.downloadDirectory, '/pods/dl');
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- tests/preferences-migrations.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

`src/main/preferences-migrations.js`:

```javascript
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test`
Expected: all 7 migration tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/preferences-migrations.js tests/preferences-migrations.test.js
git commit -m "feat(preferences): add install-type detection and legacy-file import"
```

---

## Task 6: Main process — preferences init + IPC + first-run signal

**Files:**
- Modify: `src/main/main.js`

- [ ] **Step 1: Require the new modules**

Near the top of `src/main/main.js` (after existing requires), add:

```javascript
const preferences = require('./preferences');
const { detectInstallType, importLegacyFiles } = require('./preferences-migrations');
```

- [ ] **Step 2: Wire into boot sequence**

Find the `app.whenReady().then(async () => { ... })` block. Immediately after the existing cache inits (e.g., `metadataCache = new MetadataCache(...)`), add:

```javascript
const userDataDir = app.getPath('userData');
const install = await detectInstallType(userDataDir);
const prefFile = path.join(userDataDir, 'preferences.json');
const hadPreferencesFile = await fs.access(prefFile).then(() => true).catch(() => false);

await preferences.load(userDataDir, { defaultHome: app.getPath('home') });

let firstRunPayload = null;
if (!hadPreferencesFile) {
  const legacyPatch = await importLegacyFiles(userDataDir);
  if (Object.keys(legacyPatch).length > 0) {
    await preferences.update(legacyPatch);
  }
  await preferences.update({
    meta: { installedVersion: app.getVersion(), firstRunAt: new Date().toISOString() },
  });
  firstRunPayload = { type: install.type, version: app.getVersion() };
}

preferences.subscribe((evt) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('preferences-changed', evt);
  }
});
```

- [ ] **Step 3: Emit first-run after window is ready**

After `mainWindow` is created (wherever the app currently listens for `ready-to-show` or `did-finish-load`), add:

```javascript
mainWindow.webContents.once('did-finish-load', () => {
  if (firstRunPayload) {
    mainWindow.webContents.send('first-run', firstRunPayload);
  }
});
```

- [ ] **Step 4: Add IPC handlers**

Add these handlers (a good place is near the existing `pick-pull-destination` cluster):

```javascript
ipcMain.handle('preferences-load', async () => {
  const current = preferences.get('');
  if (current !== undefined) return { success: true, preferences: current };
  const loaded = await preferences.load(app.getPath('userData'), { defaultHome: app.getPath('home') });
  return { success: true, preferences: loaded };
});

ipcMain.handle('preferences-update', async (_evt, patch) => {
  try {
    if (patch && patch.library) {
      for (const cat of ['music', 'videos', 'pictures']) {
        if (Array.isArray(patch.library[cat]) && patch.library[cat].length === 0) {
          return { success: false, error: `library.${cat} cannot be empty` };
        }
      }
    }
    await preferences.update(patch);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('preferences-reset', async (_evt, section) => {
  try {
    await preferences.reset(section);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('pick-folder', async (_evt, title) => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Choose folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || r.filePaths.length === 0) return { success: false, canceled: true };
  return { success: true, path: r.filePaths[0] };
});

ipcMain.handle('get-app-version', async () => app.getVersion());

ipcMain.handle('clear-metadata-cache', async () => {
  try {
    if (metadataCache && typeof metadataCache.clear === 'function') {
      await metadataCache.clear();
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('clear-device-cache', async () => {
  try {
    if (deviceCache && typeof deviceCache.clear === 'function') {
      await deviceCache.clear();
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
```

- [ ] **Step 5: Note on `preferences.get('')`**

The current `get('')` returns undefined because `''.split('.')` is `['']`. To return the full store, either:
- call `get()` with no argument and update the module to return the whole state when called without args, OR
- in the handler above, access internal state via a new export.

**Update `src/main/preferences.js`**: change the `get` function to:

```javascript
function get(dotPath) {
  if (!state) return undefined;
  if (dotPath === undefined || dotPath === null || dotPath === '') {
    const copy = { ...state };
    delete copy.__defaultHome;
    return copy;
  }
  const parts = dotPath.split('.');
  let cur = state;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}
```

Re-run `npm test` to make sure preferences tests still pass.

- [ ] **Step 6: Smoke test**

Run: `npm start`. App launches. Close.

- [ ] **Step 7: Commit**

```bash
git add src/main/main.js src/main/preferences.js
git commit -m "feat(main): wire preferences load/migrate/IPC and first-run signal"
```

---

## Task 7: Preload — expose preferences + folder picker + first-run

**Files:**
- Modify: `src/main/preload.js`

- [ ] **Step 1: Add new electronAPI entries**

Inside the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, append:

```javascript
preferencesLoad: () => ipcRenderer.invoke('preferences-load'),
preferencesUpdate: (patch) => ipcRenderer.invoke('preferences-update', patch),
preferencesReset: (section) => ipcRenderer.invoke('preferences-reset', section),
onPreferencesChanged: (cb) => {
  const handler = (_e, evt) => cb(evt);
  ipcRenderer.on('preferences-changed', handler);
  return handler;
},
offPreferencesChanged: (h) => ipcRenderer.removeListener('preferences-changed', h),
onFirstRun: (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on('first-run', handler);
  return handler;
},
offFirstRun: (h) => ipcRenderer.removeListener('first-run', h),
pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
getAppVersion: () => ipcRenderer.invoke('get-app-version'),
clearMetadataCache: () => ipcRenderer.invoke('clear-metadata-cache'),
clearDeviceCache: () => ipcRenderer.invoke('clear-device-cache'),
```

- [ ] **Step 2: Smoke test**

Run: `npm start`. Open DevTools; verify `window.electronAPI.preferencesLoad` is a function.

Close.

- [ ] **Step 3: Commit**

```bash
git add src/main/preload.js
git commit -m "feat(preload): expose preferences, folder picker, first-run, cache clears"
```

---

## Task 8: Renderer — cache preferences on boot + subscribe

**Files:**
- Modify: `src/assets/js/renderer.js`

- [ ] **Step 1: Add preferences fields to ZuneExplorer constructor**

In the `constructor()`, after the other field assignments, add:

```javascript
this.preferences = null;
this._prefChangeHandler = null;
this.settingsView = null;
```

- [ ] **Step 2: Load preferences in init()**

In `async init()`, before the first call that depends on preferences (specifically before `await this.scanFileSystem()`), add:

```javascript
const prefResult = await window.electronAPI.preferencesLoad();
if (prefResult && prefResult.success) {
  this.preferences = prefResult.preferences;
} else {
  console.error('Failed to load preferences; using empty defaults');
  this.preferences = {
    library: { music: [], videos: [], pictures: [], scanDesktopAndDownloads: false },
    sync: { pullDestination: null },
    podcasts: { downloadDirectory: null },
    meta: {},
  };
}

this._prefChangeHandler = window.electronAPI.onPreferencesChanged((evt) => {
  this._onPreferenceChanged(evt);
});
```

- [ ] **Step 3: Add the handler method**

Add to the class, near other lifecycle methods:

```javascript
_onPreferenceChanged(evt) {
  const parts = evt.path.split('.');
  let cur = this.preferences;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]]) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const oldValue = cur[parts[parts.length - 1]];
  cur[parts[parts.length - 1]] = evt.newValue;

  if (evt.path.startsWith('library.')) {
    this._handleLibraryPrefChange(evt.path, oldValue, evt.newValue);
  }
  if (this.settingsView && this.settingsView.isOpen) {
    this.settingsView.refresh();
  }
}

_handleLibraryPrefChange(_path, _oldValue, _newValue) {
  // Implemented in Task 10
}
```

- [ ] **Step 4: Smoke test**

Run: `npm start`. App launches normally. Close.

- [ ] **Step 5: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(renderer): load preferences on init and subscribe to changes"
```

---

## Task 9: Renderer — read library folders from preferences

**Files:**
- Modify: `src/assets/js/renderer.js`

- [ ] **Step 1: Rewrite `scanMediaFiles`**

Replace the existing `scanMediaFiles` method with:

```javascript
async scanMediaFiles() {
  const lib = this.preferences?.library || {};
  const categoryDirs = {
    music: lib.music || [],
    videos: lib.videos || [],
    pictures: lib.pictures || [],
  };

  for (const [category, dirs] of Object.entries(categoryDirs)) {
    for (const dir of dirs) {
      await this.scanDirectoryRecursive(dir, category);
    }
  }

  if (lib.scanDesktopAndDownloads) {
    const sep = this.platform === 'win32' ? '\\' : '/';
    const commonDirs = [
      `${this.homePath}${sep}Desktop`,
      `${this.homePath}${sep}Downloads`,
    ];
    for (const dir of commonDirs) {
      await this.scanDirectoryForMedia(dir);
    }
  }
}
```

- [ ] **Step 2: Smoke test**

Run: `npm start`.
- Music/Videos/Pictures from `~/Music`/`~/Movies`/`~/Pictures` still appear.
- Desktop/Downloads media no longer appears (the new default).

Close.

- [ ] **Step 3: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(renderer): read library folders from preferences (fixes #12)"
```

---

## Task 10: Rescan delta logic

**Files:**
- Modify: `src/main/preload.js`
- Modify: `src/assets/js/renderer.js`

- [ ] **Step 1: Expose path-utils to the renderer**

In `src/main/preload.js`, at the top alongside other requires:

```javascript
const pathUtils = require('../shared/path-utils');
```

Outside the existing `contextBridge.exposeInMainWorld('electronAPI', ...)`, add:

```javascript
contextBridge.exposeInMainWorld('pathUtils', pathUtils);
```

- [ ] **Step 2: Implement `_handleLibraryPrefChange`**

Replace the stub in renderer.js:

```javascript
async _handleLibraryPrefChange(prefPath, oldValue, newValue) {
  const { computeAddedPaths, computeRemovedPaths, isUnderPrefix, isUnderAnyPrefix } = window.pathUtils;

  const categoryMatch = /^library\.(music|videos|pictures)$/.exec(prefPath);
  if (categoryMatch) {
    const category = categoryMatch[1];
    const added = computeAddedPaths(oldValue || [], newValue || []);
    const removed = computeRemovedPaths(oldValue || [], newValue || []);
    const stillCovered = newValue || [];

    if (removed.length) {
      this.categorizedFiles[category] = this.categorizedFiles[category].filter((f) => {
        for (const rp of removed) {
          if (isUnderPrefix(f.path, rp) && !isUnderAnyPrefix(f.path, stillCovered)) return false;
        }
        return true;
      });
      if (category === 'music') {
        for (const [tPath] of this.musicLibrary.tracks) {
          for (const rp of removed) {
            if (isUnderPrefix(tPath, rp) && !isUnderAnyPrefix(tPath, stillCovered)) {
              this.musicLibrary.tracks.delete(tPath);
              break;
            }
          }
        }
      }
    }

    for (const dir of added) {
      await this.scanDirectoryRecursive(dir, category);
    }

    if (added.length || removed.length) {
      this.showToast?.(`rescanning ${category}…`);
      if (category === 'music') await this.scanMusicLibrary();
      this._refreshCurrentView();
    }
    return;
  }

  if (prefPath === 'library.scanDesktopAndDownloads') {
    const sep = this.platform === 'win32' ? '\\' : '/';
    const dirs = [`${this.homePath}${sep}Desktop`, `${this.homePath}${sep}Downloads`];
    if (newValue) {
      for (const dir of dirs) await this.scanDirectoryForMedia(dir);
      this.showToast?.('rescanning desktop & downloads…');
      await this.scanMusicLibrary();
    } else {
      const keep = [
        ...(this.preferences.library.music || []),
        ...(this.preferences.library.videos || []),
        ...(this.preferences.library.pictures || []),
      ];
      for (const category of ['music', 'videos', 'pictures']) {
        this.categorizedFiles[category] = this.categorizedFiles[category].filter((f) => {
          for (const dir of dirs) {
            if (isUnderPrefix(f.path, dir) && !isUnderAnyPrefix(f.path, keep)) return false;
          }
          return true;
        });
      }
      for (const [tPath] of this.musicLibrary.tracks) {
        for (const dir of dirs) {
          if (isUnderPrefix(tPath, dir) && !isUnderAnyPrefix(tPath, keep)) {
            this.musicLibrary.tracks.delete(tPath);
            break;
          }
        }
      }
    }
    this._refreshCurrentView();
  }
}

_refreshCurrentView() {
  if (!this.currentCategory) return;
  if (this.currentCategory === 'music') this.renderMusicView?.();
  else if (this.currentCategory === 'videos' || this.currentCategory === 'pictures') this.renderCategoryContent?.();
}
```

- [ ] **Step 3: Smoke test**

Run: `npm start`. Open DevTools. Verify `window.pathUtils.isUnderPrefix('/a/b', '/a')` returns `true`.

Close.

- [ ] **Step 4: Commit**

```bash
git add src/main/preload.js src/assets/js/renderer.js
git commit -m "feat(renderer): compute rescan deltas on library preference changes"
```

---

## Task 11: BootSplash component

**Files:**
- Create: `src/assets/js/boot-splash.js`
- Modify: `src/assets/css/styles.css`
- Modify: `src/renderer/index.html`

- [ ] **Step 1: Add HTML root**

In `src/renderer/index.html`, near the opening `<body>`:

```html
<div class="boot-splash" id="boot-splash" style="display:none">
  <div class="boot-splash-bar" id="boot-splash-bar"></div>
  <div class="boot-splash-message" id="boot-splash-message"></div>
</div>
```

And load the component (match the path-style used by other `<script>` tags):

```html
<script src="../assets/js/boot-splash.js"></script>
```

Place it before `renderer.js` so the class is defined when the renderer starts.

- [ ] **Step 2: Add CSS**

Append to `src/assets/css/styles.css`:

```css
/* Boot / Update splash ------------------------------------------------ */
.boot-splash {
  position: fixed;
  inset: 0;
  background: #000;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  transition: opacity 300ms ease-out;
}
.boot-splash.fading { opacity: 0; pointer-events: none; }

.boot-splash-bar {
  width: 10vw;
  min-width: 32px;
  max-width: 72px;
  height: 0;
  max-height: 40vh;
  background: #EC008C;
  transition:
    height 2s cubic-bezier(0.25, 0.1, 0.25, 1),
    background-color 2s linear;
}
.boot-splash-bar.active { height: 40vh; }

.boot-splash-message {
  margin-top: 32px;
  font-size: 28px;
  font-weight: 100;
  color: rgba(255, 255, 255, 0.7);
  text-transform: lowercase;
  letter-spacing: 1px;
}
```

- [ ] **Step 3: Implement the component**

`src/assets/js/boot-splash.js`:

```javascript
/* global document */
class BootSplash {
  constructor() {
    this.root = document.getElementById('boot-splash');
    this.bar = document.getElementById('boot-splash-bar');
    this.messageEl = document.getElementById('boot-splash-message');
  }

  async show({ message, task, minDurationMs = 2000, fadeMs = 300 } = {}) {
    if (!this.root) return;
    this.messageEl.textContent = message || '';
    this.root.style.display = 'flex';
    this.root.classList.remove('fading');
    void this.bar.offsetHeight;

    const stops = ['#EC008C', '#F58220', '#00ADA7', '#2B3990'];
    const stopDuration = minDurationMs / (stops.length - 1);
    this.bar.classList.add('active');

    for (let i = 1; i < stops.length; i++) {
      await new Promise((r) => setTimeout(r, stopDuration));
      this.bar.style.backgroundColor = stops[i];
    }

    if (task && typeof task.then === 'function') {
      try { await task; } catch (err) { console.warn('BootSplash task failed', err); }
    }

    this.root.classList.add('fading');
    await new Promise((r) => setTimeout(r, fadeMs));
    this.root.style.display = 'none';
    this.bar.classList.remove('active');
    this.bar.style.backgroundColor = '';
  }
}

window.BootSplash = BootSplash;
```

- [ ] **Step 4: Smoke test**

Run: `npm start`. In DevTools:

```javascript
const s = new BootSplash();
s.show({ message: 'test splash' });
```

Expected: black overlay with vertical bar growing and cycling through four colors; fades out.

Close.

- [ ] **Step 5: Commit**

```bash
git add src/assets/js/boot-splash.js src/assets/css/styles.css src/renderer/index.html
git commit -m "feat(renderer): add zune-style boot splash component"
```

---

## Task 12: BootSplash integration + behavior-change toast

**Files:**
- Modify: `src/assets/js/renderer.js`

- [ ] **Step 1: Listen for first-run after preferences load**

In `async init()`, after preferences are loaded but before `scanFileSystem()`:

```javascript
const firstRun = await new Promise((resolve) => {
  const handler = (payload) => {
    window.electronAPI.offFirstRun(handler);
    resolve(payload);
  };
  window.electronAPI.onFirstRun(handler);
  setTimeout(() => {
    window.electronAPI.offFirstRun(handler);
    resolve(null);
  }, 500);
});

if (firstRun) {
  const splash = new window.BootSplash();
  const message = firstRun.type === 'new'
    ? 'welcome to zune explorer'
    : `updated to v${firstRun.version}`;
  await splash.show({ message });

  if (firstRun.type === 'upgrade' && !this.preferences.meta?.behaviorChangeToastShown) {
    setTimeout(() => {
      this.showToast?.('desktop & downloads are no longer scanned by default. re-enable in settings → library.');
    }, 500);
    await window.electronAPI.preferencesUpdate({ meta: { behaviorChangeToastShown: true } });
  }
}
```

- [ ] **Step 2: Manual test — simulated upgrade**

```bash
cp -R "$HOME/Library/Application Support/zune-explorer" /tmp/zune-backup
rm "$HOME/Library/Application Support/zune-explorer/preferences.json" 2>/dev/null || true
npm start
```

Expected: boot splash with "updated to v1.4" (or current version); after dismiss, toast about Desktop/Downloads appears.

Close. On next launch without the `rm`, no splash, no toast.

Restore if needed: `rm -rf "$HOME/Library/Application Support/zune-explorer" && mv /tmp/zune-backup "$HOME/Library/Application Support/zune-explorer"`.

- [ ] **Step 3: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(renderer): boot splash and behavior-change toast on first run"
```

---

## Task 13: Settings category — menu item + dispatcher

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/assets/js/renderer.js`

- [ ] **Step 1: Add menu item**

In `src/renderer/index.html`, after the applications menu item:

```html
<button class="menu-item" data-category="settings">
    <span class="menu-text">settings</span>
    <span class="menu-subs">preferences</span>
</button>
```

- [ ] **Step 2: Register the category**

In `src/assets/js/renderer.js` constructor:

```javascript
this.categories = ['music', 'videos', 'pictures', 'podcasts', 'documents', 'applications', 'settings'];
```

Also extend `this.categorizedFiles`:

```javascript
this.categorizedFiles = {
    music: [],
    videos: [],
    pictures: [],
    podcasts: [],
    documents: [],
    applications: [],
    settings: [],
};
```

- [ ] **Step 3: Dispatch from `selectCategory`**

Find `selectCategory(index)` and add a settings branch in its if/else chain:

```javascript
if (this.currentCategory === 'music') {
    this.musicDrillDown = null;
    this.renderMusicView();
} else if (this.currentCategory === 'podcasts') {
    if (this.podcastPanel) this.podcastPanel.render();
} else if (this.currentCategory === 'documents') {
    this.renderRootView();
} else if (this.currentCategory === 'settings') {
    if (!this.settingsView) this.settingsView = new window.SettingsView(this);
    this.settingsView.render();
} else {
    this.renderCategoryContent();
}
```

- [ ] **Step 4: Add a stub SettingsView**

Create `src/assets/js/settings-view.js`:

```javascript
/* global document */
class SettingsView {
  constructor(explorer) {
    this.explorer = explorer;
    this.isOpen = false;
    this.stack = [];
  }

  render() {
    this.isOpen = true;
    const fileDisplay = document.getElementById('file-display');
    const contentPanel = document.getElementById('content-panel');
    contentPanel.classList.add('hero-mode');
    fileDisplay.innerHTML = '';
    const view = document.createElement('div');
    view.className = 'category-view settings-view';
    const hero = document.createElement('div');
    hero.className = 'hero-header';
    hero.textContent = 'settings';
    view.appendChild(hero);
    const list = document.createElement('div');
    list.className = 'settings-list';
    list.innerHTML = '<div class="settings-row placeholder">coming soon…</div>';
    view.appendChild(list);
    fileDisplay.appendChild(view);
  }

  refresh() { if (this.isOpen) this.render(); }
}

window.SettingsView = SettingsView;
```

Load in `src/renderer/index.html` before `renderer.js`:

```html
<script src="../assets/js/settings-view.js"></script>
```

- [ ] **Step 5: Smoke test**

Run: `npm start`. The left menu now has a 7th item, "settings". Clicking it shows a hero "settings" + "coming soon…" placeholder.

Close.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/index.html src/assets/js/renderer.js src/assets/js/settings-view.js
git commit -m "feat(renderer): register settings category with stub SettingsView"
```

---

## Task 14: SettingsView — drill stack framework + styles

**Files:**
- Modify: `src/assets/js/settings-view.js`
- Modify: `src/assets/css/styles.css`
- Modify: `src/assets/js/renderer.js`

- [ ] **Step 1: Replace settings-view.js**

```javascript
/* global document */
class SettingsView {
  constructor(explorer) {
    this.explorer = explorer;
    this.isOpen = false;
    this.stack = [];
    this._appVersion = null;
    (async () => {
      try { this._appVersion = await window.electronAPI.getAppVersion(); } catch {}
    })();
  }

  render() {
    this.isOpen = true;
    this.stack = [{ title: 'settings', buildItems: () => this._rootItems() }];
    this._draw();
  }

  refresh() { if (this.isOpen) this._draw(); }

  push(pageDescriptor) {
    this.stack.push(pageDescriptor);
    this._draw();
  }

  pop() {
    if (this.stack.length <= 1) {
      this.isOpen = false;
      this.explorer.showMenu?.();
      return;
    }
    this.stack.pop();
    this._draw();
  }

  _draw() {
    const fileDisplay = document.getElementById('file-display');
    const contentPanel = document.getElementById('content-panel');
    contentPanel.classList.add('hero-mode');
    fileDisplay.innerHTML = '';

    const page = this.stack[this.stack.length - 1];
    const view = document.createElement('div');
    view.className = 'category-view settings-view';

    const hero = document.createElement('div');
    hero.className = 'hero-header';
    hero.textContent = page.title;
    view.appendChild(hero);

    const content = document.createElement('div');
    content.className = 'category-content settings-content';

    const list = document.createElement('div');
    list.className = 'settings-list';
    for (const item of page.buildItems()) {
      list.appendChild(this._renderItem(item));
    }
    content.appendChild(list);
    view.appendChild(content);
    fileDisplay.appendChild(view);
  }

  _renderItem(item) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    if (item.disabled) row.classList.add('disabled');

    if (item.kind === 'nav' || item.kind === 'action') {
      row.textContent = item.label;
      if (!item.disabled) row.addEventListener('click', () => item.onClick());
    } else if (item.kind === 'toggle') {
      const label = document.createElement('span');
      label.className = 'settings-row-label';
      label.textContent = item.label;
      row.appendChild(label);
      const toggle = document.createElement('span');
      toggle.className = 'settings-toggle' + (item.value ? ' on' : '');
      row.appendChild(toggle);
      row.addEventListener('click', () => item.onToggle(!item.value));
    } else if (item.kind === 'info') {
      const label = document.createElement('span');
      label.className = 'settings-row-label';
      label.textContent = item.label;
      row.appendChild(label);
      const val = document.createElement('span');
      val.className = 'settings-row-value';
      val.textContent = item.value || '';
      row.appendChild(val);
    } else if (item.kind === 'placeholder') {
      row.textContent = item.label;
      row.classList.add('placeholder');
    }
    return row;
  }

  _rootItems() {
    return [{ kind: 'placeholder', label: 'coming soon…' }];
  }
}

window.SettingsView = SettingsView;
```

- [ ] **Step 2: Add styles**

Append to `src/assets/css/styles.css`:

```css
/* Settings drill-down --------------------------------------------------- */
.settings-content { position: relative; z-index: 1; margin-top: 130px; }
.settings-list {
  display: flex;
  flex-direction: column;
  margin-left: 8px;
  max-width: 720px;
}
.settings-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 12px;
  font-size: 22px;
  font-weight: 300;
  color: #fff;
  cursor: pointer;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  user-select: none;
}
.settings-row:hover { background: rgba(255, 255, 255, 0.03); }
.settings-row.disabled { opacity: 0.35; cursor: not-allowed; }
.settings-row.disabled:hover { background: transparent; }
.settings-row.placeholder { opacity: 0.4; font-style: italic; cursor: default; }
.settings-row-value { font-size: 14px; opacity: 0.55; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-row-label { flex: 1; }
.settings-toggle {
  width: 40px; height: 20px; border: 1px solid #444; border-radius: 12px;
  position: relative; transition: background 200ms;
}
.settings-toggle::before {
  content: ''; width: 16px; height: 16px; background: #555; border-radius: 50%;
  position: absolute; top: 1px; left: 1px; transition: transform 200ms, background 200ms;
}
.settings-toggle.on { background: #ff6900; border-color: #ff6900; }
.settings-toggle.on::before { transform: translateX(20px); background: #fff; }
```

- [ ] **Step 3: Hook back button to pop**

Find the back button click handler in `renderer.js`. Add, at the top of the handler:

```javascript
if (this.settingsView && this.settingsView.isOpen) {
  this.settingsView.pop();
  return;
}
```

- [ ] **Step 4: Smoke test**

Run: `npm start`. Click settings; verify hero and placeholder. Click back button; verify return to menu.

Close.

- [ ] **Step 5: Commit**

```bash
git add src/assets/js/settings-view.js src/assets/css/styles.css src/assets/js/renderer.js
git commit -m "feat(renderer): SettingsView drill-stack framework and styles"
```

---

## Task 15: Settings root — 5-item list

**Files:**
- Modify: `src/assets/js/settings-view.js`

- [ ] **Step 1: Replace `_rootItems`**

```javascript
_rootItems() {
  return [
    { kind: 'nav', label: 'library',  onClick: () => this.push({ title: 'library',  buildItems: () => this._libraryItems()  }) },
    { kind: 'nav', label: 'sync',     onClick: () => this.push({ title: 'sync',     buildItems: () => this._syncItems()     }) },
    { kind: 'nav', label: 'podcasts', onClick: () => this.push({ title: 'podcasts', buildItems: () => this._podcastsItems() }) },
    { kind: 'nav', label: 'data',     onClick: () => this.push({ title: 'data',     buildItems: () => this._dataItems()     }) },
    { kind: 'nav', label: 'about',    onClick: () => this.push({ title: 'about',    buildItems: () => this._aboutItems()    }) },
  ];
}

_libraryItems()  { return [{ kind: 'placeholder', label: 'library — pending' }]; }
_syncItems()     { return [{ kind: 'placeholder', label: 'sync — pending' }]; }
_podcastsItems() { return [{ kind: 'placeholder', label: 'podcasts — pending' }]; }
_dataItems()     { return [{ kind: 'placeholder', label: 'data — pending' }]; }
_aboutItems()    { return [{ kind: 'placeholder', label: 'about — pending' }]; }
```

- [ ] **Step 2: Smoke test**

Run: `npm start`. settings shows 5 items; each navigates into a placeholder page; back returns to root.

Close.

- [ ] **Step 3: Commit**

```bash
git add src/assets/js/settings-view.js
git commit -m "feat(renderer): SettingsView root list with 5 navigable sections"
```

---

## Task 16: Library drill + folder lists + folder leaf

**Files:**
- Modify: `src/assets/js/settings-view.js`

- [ ] **Step 1: Replace `_libraryItems` with full logic**

```javascript
_libraryItems() {
  const prefs = this.explorer.preferences;
  return [
    {
      kind: 'nav',
      label: 'music folders',
      onClick: () => this.push({ title: 'music folders', buildItems: () => this._folderListItems('music') }),
    },
    {
      kind: 'nav',
      label: 'video folders',
      onClick: () => this.push({ title: 'video folders', buildItems: () => this._folderListItems('videos') }),
    },
    {
      kind: 'nav',
      label: 'picture folders',
      onClick: () => this.push({ title: 'picture folders', buildItems: () => this._folderListItems('pictures') }),
    },
    {
      kind: 'toggle',
      label: 'scan desktop and downloads',
      value: !!prefs?.library?.scanDesktopAndDownloads,
      onToggle: async (newVal) => {
        await window.electronAPI.preferencesUpdate({ library: { scanDesktopAndDownloads: newVal } });
      },
    },
  ];
}

_folderListItems(category) {
  const list = this.explorer.preferences?.library?.[category] || [];
  const items = list.map((folderPath) => ({
    kind: 'nav',
    label: folderPath,
    onClick: () => this.push({
      title: folderPath.split(/[/\\]/).pop() || folderPath,
      buildItems: () => this._folderLeafItems(category, folderPath),
    }),
  }));
  items.push({
    kind: 'action',
    label: '+ add folder',
    onClick: async () => {
      const r = await window.electronAPI.pickFolder(`Choose a ${category} folder`);
      if (r && r.success) {
        const cur = this.explorer.preferences.library[category] || [];
        if (cur.includes(r.path)) return;
        await window.electronAPI.preferencesUpdate({
          library: { [category]: [...cur, r.path] },
        });
      }
    },
  });
  return items;
}

_folderLeafItems(category, folderPath) {
  const list = this.explorer.preferences?.library?.[category] || [];
  const isLast = list.length <= 1;
  return [
    { kind: 'info', label: 'path', value: folderPath },
    {
      kind: 'action',
      label: 'reveal in finder',
      onClick: () => window.electronAPI.showItemInFolder?.(folderPath),
    },
    {
      kind: 'action',
      label: isLast ? 'remove (last folder — disabled)' : 'remove from library',
      disabled: isLast,
      onClick: async () => {
        if (isLast) return;
        const confirmed = await this.explorer.showConfirmModal?.(
          'Remove folder',
          `Stop scanning ${folderPath}?`
        );
        if (!confirmed) return;
        const next = list.filter((p) => p !== folderPath);
        await window.electronAPI.preferencesUpdate({ library: { [category]: next } });
        this.pop();
      },
    },
  ];
}
```

- [ ] **Step 2: Smoke test**

Run: `npm start`.
- settings → library → music folders: shows existing folders + "+ add folder"
- Add a folder: picker opens, then list shows new folder and toast "rescanning music…"
- Click a folder: leaf page shows path, reveal, remove
- With one folder left, remove is disabled
- Remove a folder: confirm modal, then pops back to folder list; those tracks disappear from the library
- Back to library, toggle "scan desktop and downloads" on: Desktop/Downloads media appears; toggle off: disappears

Close.

- [ ] **Step 3: Commit**

```bash
git add src/assets/js/settings-view.js
git commit -m "feat(settings): library drill with folder lists, add/remove, desktop-toggle"
```

---

## Task 17: Sync leaf

**Files:**
- Modify: `src/assets/js/settings-view.js`

- [ ] **Step 1: Replace `_syncItems`**

```javascript
_syncItems() {
  const dest = this.explorer.preferences?.sync?.pullDestination;
  return [
    { kind: 'info', label: 'pull destination', value: dest || '(not set)' },
    {
      kind: 'action',
      label: dest ? 'change destination' : 'choose destination',
      onClick: async () => {
        const r = await window.electronAPI.pickFolder('Choose pull destination');
        if (r && r.success) {
          await window.electronAPI.preferencesUpdate({ sync: { pullDestination: r.path } });
        }
      },
    },
    {
      kind: 'action',
      label: 'clear destination',
      disabled: !dest,
      onClick: async () => {
        if (!dest) return;
        await window.electronAPI.preferencesUpdate({ sync: { pullDestination: null } });
      },
    },
  ];
}
```

- [ ] **Step 2: Smoke test + commit**

Run: `npm start`. settings → sync. Verify display, change, clear.

```bash
git add src/assets/js/settings-view.js
git commit -m "feat(settings): sync leaf for pull destination"
```

---

## Task 18: Podcasts leaf

**Files:**
- Modify: `src/assets/js/settings-view.js`

- [ ] **Step 1: Replace `_podcastsItems`**

```javascript
_podcastsItems() {
  const dir = this.explorer.preferences?.podcasts?.downloadDirectory;
  return [
    { kind: 'info', label: 'download directory', value: dir || '(not set)' },
    {
      kind: 'action',
      label: dir ? 'change directory' : 'choose directory',
      onClick: async () => {
        const r = await window.electronAPI.pickFolder('Choose podcast download directory');
        if (r && r.success) {
          await window.electronAPI.preferencesUpdate({ podcasts: { downloadDirectory: r.path } });
        }
      },
    },
  ];
}
```

- [ ] **Step 2: Smoke test + commit**

Run: `npm start`. settings → podcasts. Verify + change.

```bash
git add src/assets/js/settings-view.js
git commit -m "feat(settings): podcasts leaf for download directory"
```

---

## Task 19: Podcast-manager refactor to use central preferences

**Files:**
- Modify: `src/main/podcast-manager.js`
- Modify: `src/main/main.js`

- [ ] **Step 1: Inspect current handling**

Run: `grep -n "downloadDirectory" src/main/podcast-manager.js`

Note every place it reads or writes `downloadDirectory`.

- [ ] **Step 2: Accept an injected getter**

Edit `podcast-manager.js`. In the constructor add an options argument:

```javascript
constructor(userDataDir, options = {}) {
  // ...existing init
  this._getDownloadDirectory = (options && options.getDownloadDirectory) || (() => null);
  // ...existing init
}
```

Every read of `this.preferences.downloadDirectory` (or equivalent) becomes `this._getDownloadDirectory() || <fallback>`.

Every write of `downloadDirectory` into its own preferences file: **remove**. The central store is the writer now.

Keep any OTHER keys the podcast preferences file contains (subscriptions, etc.) untouched. Only stop reading/writing `downloadDirectory` from/to it.

- [ ] **Step 3: Pass the getter in main.js**

In `main.js`, where `podcastManager = new PodcastManager(...)`:

```javascript
podcastManager = new PodcastManager(app.getPath('userData'), {
  getDownloadDirectory: () => preferences.get('podcasts.downloadDirectory'),
});
```

- [ ] **Step 4: Redirect the old pick-download-directory IPC**

Check the existing handler:

```bash
grep -n "podcast-pick-download-directory" src/main/main.js
```

Replace its body with a version that updates preferences instead of podcast-manager state:

```javascript
ipcMain.handle('podcast-pick-download-directory', async () => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose podcast download directory',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || r.filePaths.length === 0) return { success: false };
  await preferences.update({ podcasts: { downloadDirectory: r.filePaths[0] } });
  return { success: true, directory: r.filePaths[0] };
});
```

- [ ] **Step 5: Smoke test**

Run: `npm start`. Navigate to podcasts. Verify:
- Downloading an episode works; file lands in the directory configured in central preferences
- settings → podcasts → change directory → download lands in the new directory

Close.

- [ ] **Step 6: Commit**

```bash
git add src/main/podcast-manager.js src/main/main.js
git commit -m "refactor(podcast): read download directory from central preferences"
```

---

## Task 20: Data section — clear caches

**Files:**
- Modify: `src/assets/js/settings-view.js`
- Possibly modify: `src/main/metadata-cache.js`, `src/main/zune/zune-manager.js` (add `.clear()` if missing)

- [ ] **Step 1: Replace `_dataItems`**

```javascript
_dataItems() {
  return [
    {
      kind: 'action',
      label: 'clear metadata cache',
      onClick: async () => {
        const ok = await this.explorer.showConfirmModal?.(
          'Clear metadata cache',
          'Album art and enriched metadata will be re-downloaded as needed. Continue?'
        );
        if (!ok) return;
        const r = await window.electronAPI.clearMetadataCache();
        this.explorer.showToast?.(r && r.success ? 'metadata cache cleared' : 'failed to clear metadata cache');
      },
    },
    {
      kind: 'action',
      label: 'clear device cache',
      onClick: async () => {
        const ok = await this.explorer.showConfirmModal?.(
          'Clear device cache',
          'Cached Zune device browse data will be re-fetched on next connect. Continue?'
        );
        if (!ok) return;
        const r = await window.electronAPI.clearDeviceCache();
        this.explorer.showToast?.(r && r.success ? 'device cache cleared' : 'failed to clear device cache');
      },
    },
  ];
}
```

- [ ] **Step 2: Ensure `.clear()` methods exist**

Inspect:

```bash
grep -n "class MetadataCache\|clear" src/main/metadata-cache.js
grep -rn "class DeviceCache\|clear" src/main/zune/
```

If `MetadataCache` has no `clear()`, add one that empties the in-memory Map and overwrites the on-disk JSON file with `{}`:

```javascript
async clear() {
  this.cache = new Map();
  try { await fs.writeFile(this.cachePath, '{}'); } catch {}
}
```

Mirror for `DeviceCache` (look at its internal state — probably a Map or object, and a JSON file at a known path).

- [ ] **Step 3: Smoke test**

Run: `npm start`. settings → data → clear metadata cache → confirm → toast. Browse music and verify album art re-fetches.

Close.

- [ ] **Step 4: Commit**

```bash
git add src/assets/js/settings-view.js src/main/metadata-cache.js src/main/zune/
git commit -m "feat(settings): data section with cache clear actions"
```

---

## Task 21: About section + openExternal helper

**Files:**
- Modify: `src/assets/js/settings-view.js`
- Modify: `src/main/main.js`
- Modify: `src/main/preload.js`

- [ ] **Step 1: Replace `_aboutItems`**

```javascript
_aboutItems() {
  return [
    { kind: 'info', label: 'version', value: this._appVersion || 'loading…' },
    {
      kind: 'action',
      label: 'github repo',
      onClick: () => window.electronAPI.openExternal?.('https://github.com/NiceBeard/zune-explorer'),
    },
    { kind: 'info', label: 'author',  value: 'NiceBeard' },
    { kind: 'info', label: 'license', value: 'MIT' },
  ];
}
```

- [ ] **Step 2: Add `openExternal` IPC**

Check: `grep -n "openExternal" src/main/main.js src/main/preload.js`

If not present, add to `main.js`:

```javascript
ipcMain.handle('open-external', async (_evt, url) => {
  const { shell } = require('electron');
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { success: false };
    await shell.openExternal(url);
    return { success: true };
  } catch {
    return { success: false };
  }
});
```

Add to `preload.js`:

```javascript
openExternal: (url) => ipcRenderer.invoke('open-external', url),
```

- [ ] **Step 3: Smoke test + commit**

Run: `npm start`. settings → about. Verify version matches `package.json`; github row opens browser.

```bash
git add src/assets/js/settings-view.js src/main/main.js src/main/preload.js
git commit -m "feat(settings): about section with version, repo link, credits"
```

---

## Task 22: Verify live-refresh end-to-end

**Files:** none — validation-only

- [ ] **Step 1: Manual test**

Run: `npm start`. Navigate to settings → library → music folders.

In a second terminal:

```bash
python3 -c "
import json, os
p = os.path.expanduser('~/Library/Application Support/zune-explorer/preferences.json')
d = json.load(open(p))
d['library']['music'].append('/tmp/test-external-edit')
json.dump(d, open(p, 'w'), indent=2)
"
```

This writes the file externally — note that `preferences-changed` is emitted only on updates through the module. External edits bypass the subscriber chain. **Expected behavior: the UI does NOT pick up the external edit.** Add a note to the implementation that preferences should only be edited via IPC; external edits require app restart.

Instead: use the in-app UI to add a folder and watch the list redraw in real time. This is the supported path.

- [ ] **Step 2: Fix if UI redraw via IPC update is broken**

If adding a folder through the UI does not redraw the list:
- Check DevTools console for errors
- Check that `preferences.subscribe` fires in main (add a `console.log` temporarily)
- Check that the renderer's `onPreferencesChanged` handler is invoked
- Check that `settingsView.refresh()` is called and `_draw()` runs

Only commit if there is a fix.

```bash
git add -A
git commit -m "fix(renderer): ensure settings view refreshes on preference changes"
```

---

## Task 23: Manual acceptance — issue #12 runbook

**Files:** none — validation task

- [ ] **Step 1: Fresh install**

```bash
mv "$HOME/Library/Application Support/zune-explorer" /tmp/zune-explorer-backup
```

Launch. Verify:
- Boot splash: "welcome to zune explorer"
- No behavior-change toast
- Music/Videos/Pictures limited to `~/Music`/`~/Movies`/`~/Pictures`
- settings → library → music folders shows exactly one entry
- Adding a folder makes its music appear

Restore: `rm -rf "$HOME/Library/Application Support/zune-explorer" && mv /tmp/zune-explorer-backup "$HOME/Library/Application Support/zune-explorer"`

- [ ] **Step 2: Simulated upgrade**

```bash
rm "$HOME/Library/Application Support/zune-explorer/preferences.json"
```

Launch. Verify:
- Boot splash: "updated to v…"
- Behavior-change toast appears
- Old `pull-destination.json` absorbed into `preferences.json` (check `settings → sync`)
- Old file deleted from userData
- Podcast download directory preserved via central store

- [ ] **Step 3: Issue #12 primary scenarios**

- [ ] Add a custom music folder → tracks appear
- [ ] Remove the original `~/Music` while custom folder remains → `~/Music` tracks disappear; custom remains
- [ ] Cannot remove last folder (button disabled)
- [ ] Toggle scanDesktopAndDownloads on → Desktop/Downloads media appears; off → disappears
- [ ] Nested case: add `~/Music/Rock` as separate folder, remove `~/Music` → Rock tracks remain

- [ ] **Step 4: Regression sanity**

- [ ] Pins still work
- [ ] Playlists load and edit
- [ ] Zune sync still works
- [ ] Podcast download and playback still work
- [ ] No new DevTools console errors

---

## Self-review checklist

- **Spec coverage:** Every numbered item in the spec's "In scope (v1)" maps to at least one task (Library/Sync/Podcasts/Data/About → Tasks 16-21; issue #12 → Tasks 9, 10, 16; boot splash → Tasks 11-12; migration → Tasks 5-6; behavior-change toast → Task 12).
- **Placeholders:** none — every step has concrete code or commands.
- **Type consistency:** `preferences.update(patch)`, `preferences.get(dotPath)`, `electronAPI.pickFolder(title)`, `onPreferencesChanged(cb)` are identical everywhere they appear.
- **Testability:** preferences module, migrations, path-utils → `node:test`. UI validated via manual runbook (Task 23).
