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
