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
