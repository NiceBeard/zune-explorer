const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ArtistImages } = require('../src/main/artist-images');

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

let tmpDir;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'artist-images-test-'));
});

function httpError(status) {
  const err = new Error(`HTTP ${status}`);
  err.statusCode = status;
  return err;
}

const PETTY = 'Tom Petty & The Heartbreakers';
const PETTY_KEY = 'tom petty and the heartbreakers';

function fanartPetty() {
  return {
    artistbackground: [
      { url: 'https://f/b1.jpg', likes: '2' },
      { url: 'https://f/b2.jpg', likes: '9' },
    ],
    artistthumb: [{ url: 'https://f/t.jpg', likes: '1' }],
  };
}

function deezerPetty() {
  return { data: [{ name: 'Tom Petty and the Heartbreakers', picture_xl: 'https://d/x.jpg' }] };
}

// Fake network: each source is a function (url|name) -> value, or throws.
function makeStore(opts = {}) {
  const calls = { search: [], json: [], binary: [] };
  const clock = { t: T0 };
  const sources = {
    search: opts.search || (() => [{ mbid: 'm1', name: PETTY, score: 100 }]),
    fanart: opts.fanart || fanartPetty,
    deezer: opts.deezer || deezerPetty,
  };
  const store = new ArtistImages(tmpDir, {
    searchArtists: async (name) => { calls.search.push(name); return sources.search(name); },
    fetchJson: async (url) => {
      calls.json.push(url);
      return url.includes('fanart.tv') ? sources.fanart(url) : sources.deezer(url);
    },
    fetchBinary: async (url) => {
      calls.binary.push(url);
      if (opts.binary) return opts.binary(url);
      return { data: Buffer.from('img:' + url), contentType: 'image/jpeg' };
    },
    getApiKey: () => (opts.key === undefined ? 'test-key' : opts.key),
    now: () => clock.t,
  });
  const networkCalls = () => calls.search.length + calls.json.length + calls.binary.length;
  return { store, calls, clock, sources, networkCalls };
}

async function readIndex() {
  try {
    return JSON.parse(await fs.readFile(path.join(tmpDir, 'artist-images', 'index.json'), 'utf-8'));
  } catch {
    return {};
  }
}

test('find: fanart background preferred, saved, then served from cache', async () => {
  const { store, calls, networkCalls } = makeStore();
  const r = await store.find(PETTY);
  assert.equal(r.source, 'fanart');
  assert.equal(r.candidateCount, 4);
  assert.deepEqual(calls.binary, ['https://f/b2.jpg']);
  assert.match(r.url, /^file:\/\/.+\?v=\d+$/);
  assert.ok(calls.json[0].includes('/v3/music/m1?api_key=test-key'));
  const saved = r.url.replace(/^file:\/\//, '').replace(/\?v=\d+$/, '');
  assert.equal(await fs.readFile(decodeURIComponent(saved), 'utf-8'), 'img:https://f/b2.jpg');

  const before = networkCalls();
  const again = await store.find('tom petty and the heartbreakers');
  assert.equal(again.url, r.url);
  assert.equal(networkCalls(), before);
});

test('find: no api key -> Deezer only, no MusicBrainz call', async () => {
  const { store, calls } = makeStore({ key: null });
  const r = await store.find(PETTY);
  assert.equal(r.source, 'deezer');
  assert.equal(calls.search.length, 0);
  assert.ok(calls.json.every((u) => !u.includes('fanart.tv')));
  assert.deepEqual(calls.binary, ['https://d/x.jpg']);
});

test('find: wrong-name results are rejected -> miss', async () => {
  const { store, calls } = makeStore({
    search: () => [{ mbid: 'm2', name: 'Tom Petty', score: 100 }],
    deezer: () => ({ data: [{ name: 'Tom Petty', picture_xl: 'https://d/tp.jpg' }] }),
  });
  const r = await store.find(PETTY);
  assert.equal(r, null);
  assert.equal(calls.binary.length, 0);
  assert.equal((await readIndex())[PETTY_KEY].miss, true);
});

test('find: MusicBrainz score below 90 is ignored', async () => {
  const { store, calls } = makeStore({ search: () => [{ mbid: 'm1', name: PETTY, score: 80 }] });
  const r = await store.find(PETTY);
  assert.equal(r.source, 'deezer');
  assert.ok(calls.json.every((u) => !u.includes('fanart.tv')));
});

test('find: fanart 404 falls through to Deezer', async () => {
  const { store } = makeStore({ fanart: () => { throw httpError(404); } });
  const r = await store.find(PETTY);
  assert.equal(r.source, 'deezer');
});

test('find: network error is not cached as a miss', async () => {
  const err = new Error('socket hang up');
  err.code = 'ECONNRESET';
  const { store } = makeStore({ deezer: () => { throw err; } });
  const r = await store.find(PETTY);
  assert.equal(r, null);
  assert.equal((await readIndex())[PETTY_KEY], undefined);
});

test('find: download error is not cached as a miss', async () => {
  const { store } = makeStore({ binary: () => { throw new Error('Request timeout'); } });
  assert.equal(await store.find(PETTY), null);
  assert.equal((await readIndex())[PETTY_KEY], undefined);
});

test('find: miss is not re-queried within 14 days, is after', async () => {
  const { store, clock, networkCalls } = makeStore({
    search: () => [],
    deezer: () => ({ data: [] }),
  });
  assert.equal(await store.find(PETTY), null);
  const afterFirst = networkCalls();
  clock.t = T0 + 13 * DAY;
  assert.equal(await store.find(PETTY), null);
  assert.equal(networkCalls(), afterFirst);
  clock.t = T0 + 15 * DAY;
  await store.find(PETTY);
  assert.ok(networkCalls() > afterFirst);
});

test('find: concurrent calls share one fetch', async () => {
  const { store, calls } = makeStore();
  const [a, b] = await Promise.all([store.find(PETTY), store.find('tom petty and the heartbreakers')]);
  assert.equal(a.url, b.url);
  assert.equal(calls.binary.length, 1);
  assert.equal(calls.search.length, 1);
});

test('next: cycles candidates and wraps', async () => {
  const { store, calls } = makeStore({
    fanart: () => ({ artistbackground: [{ url: 'https://f/b1.jpg', likes: '5' }] }),
  });
  const first = await store.find(PETTY);
  assert.equal(first.candidateCount, 2);
  const second = await store.next(PETTY);
  assert.equal(second.source, 'deezer');
  assert.notEqual(second.url, first.url);
  const third = await store.next(PETTY);
  assert.equal(third.source, 'fanart');
  // only the photo in use is kept on disk, so wrapping back downloads it again
  assert.deepEqual(calls.binary, ['https://f/b1.jpg', 'https://d/x.jpg', 'https://f/b1.jpg']);
});

test('remove/restore: removed returns null without network; restore brings it back', async () => {
  const { store, networkCalls } = makeStore();
  const r = await store.find(PETTY);
  await store.remove(PETTY);
  const before = networkCalls();
  assert.equal(await store.find(PETTY), null);
  assert.equal(await store.get(PETTY), null);
  assert.equal(networkCalls(), before);
  const back = await store.restore(PETTY);
  assert.equal(back.source, r.source);
});

test('get: never touches the network', async () => {
  const { store, networkCalls } = makeStore();
  assert.equal(await store.get('Unknown'), null);
  assert.equal(networkCalls(), 0);
});

test('clear: empties the directory and index', async () => {
  const { store } = makeStore();
  await store.find(PETTY);
  await store.clear();
  assert.deepEqual(await readIndex(), {});
  assert.equal(await store.get(PETTY), null);
  const files = await fs.readdir(path.join(tmpDir, 'artist-images')).catch(() => []);
  assert.deepEqual(files.filter((f) => f !== 'index.json'), []);
});

test('primary artist used for lookup', async () => {
  const { store, calls } = makeStore({
    search: () => [{ mbid: 'm3', name: 'Calvin Harris', score: 100 }],
    fanart: () => ({ artistthumb: [{ url: 'https://f/ch.jpg', likes: '1' }] }),
    deezer: () => ({ data: [] }),
  });
  const r = await store.find('Calvin Harris feat. Rihanna');
  assert.equal(calls.search[0], 'Calvin Harris');
  assert.equal(r.source, 'fanart');
  assert.ok(calls.json.some((u) => u.includes('q=Calvin%20Harris')));
});

test('image file names never contain the artist name', async () => {
  const { store } = makeStore({ key: null, deezer: () => ({ data: [{ name: '../../etc', picture_xl: 'https://d/e.jpg' }] }) });
  await store.find('../../etc');
  const files = await fs.readdir(path.join(tmpDir, 'artist-images'));
  for (const f of files) assert.match(f, /^(index\.json|[0-9a-f]{40}-\d+\.(jpg|png|webp))$/);
});

test('find: fanart 401 still falls back to Deezer, without recording a miss when Deezer has nothing', async () => {
  const { store } = makeStore({ fanart: () => { throw httpError(401); } });
  const r = await store.find(PETTY);
  assert.equal(r.source, 'deezer');
  const { store: store2 } = makeStore({ fanart: () => { throw httpError(401); }, deezer: () => ({ data: [] }) });
  await fs.rm(path.join(tmpDir, 'artist-images'), { recursive: true, force: true });
  assert.equal(await store2.find(PETTY), null);
  assert.equal((await readIndex())[PETTY_KEY], undefined);
});

test('find: MusicBrainz error still tries Deezer', async () => {
  const { store } = makeStore({ search: () => { throw httpError(503); } });
  const r = await store.find(PETTY);
  assert.equal(r.source, 'deezer');
});

test('find: Deezer error reply is not cached as a miss', async () => {
  const { store } = makeStore({ key: null, deezer: () => ({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } }) });
  assert.equal(await store.find(PETTY), null);
  assert.equal((await readIndex())[PETTY_KEY], undefined);
});

test('find: Deezer placeholder picture (empty hash) is skipped', async () => {
  const { store, calls } = makeStore({
    key: null,
    deezer: () => ({ data: [{ name: PETTY, picture_xl: 'https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg' }] }),
  });
  assert.equal(await store.find(PETTY), null);
  assert.equal(calls.binary.length, 0);
});

test('find: placeholder artist names never hit the network', async () => {
  const { store, networkCalls } = makeStore();
  assert.equal(await store.find('Various Artists'), null);
  assert.equal(await store.find('Unknown Artist'), null);
  assert.equal(networkCalls(), 0);
});

test('find: different artists at once all end up in the index', async () => {
  const names = ['Alpha Band', 'Beta Band', 'Gamma Band', 'Delta Band', 'Epsilon Band', 'Zeta Band'];
  const { store } = makeStore({
    key: null,
    deezer: (url) => {
      const q = decodeURIComponent(url.split('q=')[1]);
      return { data: [{ name: q, picture_xl: `https://d/${encodeURIComponent(q)}.jpg` }] };
    },
  });
  const results = await Promise.all(names.map((n) => store.find(n)));
  assert.ok(results.every((r) => r && r.source === 'deezer'));
  const index = await readIndex();
  for (const n of names) assert.ok(index[n.toLowerCase()], `missing ${n}`);
});

test('find: a failed download moves on to the next candidate', async () => {
  const { store, calls } = makeStore({
    binary: (url) => {
      if (url === 'https://f/b2.jpg') throw httpError(404);
      return { data: Buffer.from('img:' + url), contentType: 'image/jpeg' };
    },
  });
  const r = await store.find(PETTY);
  assert.equal(r.source, 'fanart');
  assert.deepEqual(calls.binary, ['https://f/b2.jpg', 'https://f/b1.jpg']);
  assert.equal((await readIndex())[PETTY_KEY].index, 1);
});

test('find: every candidate failing to download records nothing', async () => {
  const { store } = makeStore({ binary: () => { throw new Error('Request timeout'); } });
  assert.equal(await store.find(PETTY), null);
  assert.equal((await readIndex())[PETTY_KEY], undefined);
});

// Hold the first fetchBinary until released, to interleave operations with a find in flight.
function gatedBinary() {
  let release;
  const gate = new Promise((r) => { release = r; });
  let first = true;
  return {
    release: () => release(),
    binary: async (url) => {
      if (first) { first = false; await gate; }
      return { data: Buffer.from('img:' + url), contentType: 'image/jpeg' };
    },
  };
}

test('remove during an in-flight find stays removed', async () => {
  const g = gatedBinary();
  const { store } = makeStore({ binary: g.binary });
  const finding = store.find(PETTY);
  await new Promise((r) => setTimeout(r, 10));
  const removing = store.remove(PETTY);
  g.release();
  await Promise.all([finding, removing]);
  assert.equal(await store.get(PETTY), null);
  assert.equal(await store.state(PETTY), 'removed');
});

test('next during an in-flight find advances after it', async () => {
  const g = gatedBinary();
  const { store } = makeStore({ binary: g.binary });
  const finding = store.find(PETTY);
  await new Promise((r) => setTimeout(r, 10));
  const nexting = store.next(PETTY);
  g.release();
  const [a, b] = await Promise.all([finding, nexting]);
  assert.notEqual(a.url, b.url);
  assert.equal((await readIndex())[PETTY_KEY].index, 1);
});

test('clear during an in-flight find leaves the cache empty', async () => {
  const g = gatedBinary();
  const { store } = makeStore({ binary: g.binary });
  const finding = store.find(PETTY);
  await new Promise((r) => setTimeout(r, 10));
  await store.clear();
  g.release();
  await finding;
  assert.equal(await store.get(PETTY), null);
  assert.deepEqual(await readIndex(), {});
});

test('state: none, cached, removed', async () => {
  const { store } = makeStore();
  assert.equal(await store.state(PETTY), 'none');
  await store.find(PETTY);
  assert.equal(await store.state(PETTY), 'cached');
  await store.remove(PETTY);
  assert.equal(await store.state(PETTY), 'removed');
  assert.equal(await store.state('Various Artists'), 'none');
});

test('M.I.A. and Mia in one library keep separate photos', async () => {
  const { store } = makeStore({
    key: null,
    deezer: (url) => {
      const q = decodeURIComponent(url.split('q=')[1]);
      return { data: [{ name: q, picture_xl: `https://d/${encodeURIComponent(q)}.jpg` }] };
    },
  });
  const a = await store.find('M.I.A.');
  const b = await store.find('Mia');
  assert.notEqual(a.url, b.url);
});
