const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { PodcastDeviceSync } = require('../src/main/zune/podcast-sync');
const { ObjectFormat, ObjectProperty } = require('../src/main/zune/mtp-constants');

const ROOT = 0xFFFFFFFF;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-sync-test-'));
const episodeFile = path.join(tmp, 'ep.mp3');
fs.writeFileSync(episodeFile, Buffer.alloc(1234, 7));

// Minimal in-memory device: folders, created objects, and a call log.
class FakeMtp {
  constructor({ folders = [], failSendObject = false } = {}) {
    this.objects = new Map(); // handle -> { parent, format, filename, size }
    for (const f of folders) this.objects.set(f.handle, { parent: f.parent, format: ObjectFormat.Association, filename: f.name, size: 0 });
    this.next = 0x100;
    this.calls = [];
    this.props = [];
    this.pendingHandle = null;
    this.failSendObject = failSendObject;
  }
  _log(name, ...args) { this.calls.push([name, ...args]); }
  async getDevicePropValue() { this._log('getDevicePropValue'); return Buffer.alloc(0); }
  async syncDeviceDB() { this._log('syncDeviceDB'); }
  async disableTrustedFiles() { this._log('disableTrustedFiles'); }
  async registerTrackContext(name) { this._log('registerTrackContext', name); }
  async getObjectPropList() { this._log('getObjectPropList'); return Buffer.alloc(0); }
  async getObjectPropDesc() { return Buffer.alloc(0); }
  async getObjectHandles(storageId, format, parent) {
    const want = parent === ROOT ? 0 : parent;
    return [...this.objects].filter(([, o]) => o.parent === want).map(([h]) => h);
  }
  async getObjectInfo(handle) {
    const o = this.objects.get(handle);
    if (!o) throw new Error('InvalidObjectHandle');
    return { objectFormat: o.format, filename: o.filename, compressedSize: o.size, parentObject: o.parent };
  }
  async sendObjectPropList(storageId, parent, format, size, props) {
    const schema = format === ObjectFormat.Association ? 0x05 : format === ObjectFormat.PodcastSeries ? 0x0f : 0x10;
    const handle = (schema << 24) | this.next++;
    const filename = props.find(p => p.code === ObjectProperty.ObjectFileName)?.value;
    this.objects.set(handle, { parent, format, filename, size: 0, expected: size, props });
    this.pendingHandle = handle;
    this._log('sendObjectPropList', format, size);
    return handle;
  }
  async sendObject(data) {
    this._log('sendObject', data.length);
    if (this.failSendObject && data.length > 0) throw new Error('USB stall');
    this.objects.get(this.pendingHandle).size = data.length;
  }
  async setObjectPropUint32(handle, prop, value) { this.props.push([handle, prop, value]); }
  async setObjectPropArray() {}
  async setObjectPropUint16() {}
  async deleteObject(handle) { this._log('deleteObject', handle); this.objects.delete(handle); }
}

function makeSync(mtp, library) {
  const sync = new PodcastDeviceSync({
    mtp, storageId: 0x00010001, isHD: true,
    emitProgress: () => {},
    convertToMp3: async (p) => p,
  });
  sync.readLibrary = async () => library;
  return sync;
}

const episode = (over = {}) => ({
  localPath: episodeFile,
  title: 'Episode One',
  enclosureUrl: 'https://e.com/one.mp3',
  description: '<p>Hello &amp; welcome</p>',
  publishDate: '2026-10-01T12:00:00Z',
  duration: 60,
  playbackPosition: 12.5,
  subscriptionId: 'sub1',
  subscriptionTitle: 'My Show: Daily',
  feedUrl: 'https://e.com/feed.xml',
  author: 'Host',
  ...over,
});

test('new show: creates Series/.ser, Podcasts/<show>/, and the episode with its real size', async () => {
  const mtp = new FakeMtp();
  const sync = makeSync(mtp, { shows: [], episodes: [] });
  const r = await sync.push([episode()]);

  assert.equal(r.sent, 1);
  assert.equal(r.failed, 0);
  const objs = [...mtp.objects.values()];
  const names = objs.map(o => o.filename).sort();
  assert.deepEqual(names, ['Episode One.mp3', 'My Show  Daily', 'My Show  Daily.ser', 'Podcasts', 'Series']);

  const ep = objs.find(o => o.filename === 'Episode One.mp3');
  assert.equal(ep.size, 1234);
  assert.equal(ep.expected, 1234);
  const series = [...mtp.objects].find(([, o]) => o.format === ObjectFormat.PodcastSeries)[0];
  assert.equal(ep.props.find(p => p.code === ObjectProperty.SeriesHandle).value, series);
  assert.equal(ep.props.find(p => p.code === ObjectProperty.Description).value, 'Hello & welcome');

  // Resume position written after upload
  assert.deepEqual(mtp.props, [[r.newDeviceEpisodes[0].handle, ObjectProperty.TimeBookmark, 12500]]);
  // Session framing
  assert.equal(mtp.calls[0][0], 'getDevicePropValue');
  assert.deepEqual(mtp.calls.slice(-2).map(c => c[0]), ['disableTrustedFiles', 'syncDeviceDB']);
});

test('existing show + episode: skipped, nothing created', async () => {
  const mtp = new FakeMtp({ folders: [{ handle: 0x05000010, parent: 0, name: 'Podcasts' }] });
  const library = {
    shows: [{ atomId: 0x0f000001, name: 'My Show: Daily', feedUrl: 'https://e.com/feed.xmlGARBAGE' }],
    episodes: [{ atomId: 0x10000001, showAtomId: 0x0f000001, title: 'Episode One', url: 'https://e.com/one.mp3', folderRef: 0x05000011 }],
  };
  const r = await makeSync(mtp, library).push([episode()]);
  assert.equal(r.skipped, 1);
  assert.equal(r.sent, 0);
  assert.equal(mtp.calls.filter(c => c[0] === 'sendObjectPropList').length, 0);
});

test('existing show, new episode: reuses the show and its episode folder', async () => {
  const mtp = new FakeMtp();
  const library = {
    shows: [{ atomId: 0x0f000001, name: 'My Show: Daily', feedUrl: 'https://e.com/feed.xml' }],
    episodes: [{ atomId: 0x10000001, showAtomId: 0x0f000001, title: 'Old', url: 'https://e.com/old.mp3', folderRef: 0x05000011 }],
  };
  const r = await makeSync(mtp, library).push([episode()]);
  assert.equal(r.sent, 1);
  const creates = mtp.calls.filter(c => c[0] === 'sendObjectPropList');
  assert.equal(creates.length, 1);
  const ep = [...mtp.objects.values()].find(o => o.filename === 'Episode One.mp3');
  assert.equal(ep.parent, 0x05000011);
  assert.equal(ep.props.find(p => p.code === ObjectProperty.SeriesHandle).value, 0x0f000001);
});

test('failed upload: episode removed, and a show created in this run is rolled back', async () => {
  const mtp = new FakeMtp({ failSendObject: true });
  const r = await makeSync(mtp, { shows: [], episodes: [] }).push([episode()]);
  assert.equal(r.sent, 0);
  assert.equal(r.failed, 1);
  assert.match(r.errors[0].error, /USB stall/);
  assert.equal(mtp.objects.size, 0, `left behind: ${[...mtp.objects.values()].map(o => o.filename)}`);
});

test('two episodes of one show in one push: show created once', async () => {
  const mtp = new FakeMtp();
  const r = await makeSync(mtp, { shows: [], episodes: [] }).push([
    episode(),
    episode({ title: 'Episode Two', enclosureUrl: 'https://e.com/two.mp3' }),
  ]);
  assert.equal(r.sent, 2);
  const seriesCount = [...mtp.objects.values()].filter(o => o.format === ObjectFormat.PodcastSeries).length;
  assert.equal(seriesCount, 1);
});
