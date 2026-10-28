const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PodcastManager = require('../src/main/podcast-manager');

function setup({ withDownloadDir = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-import-test-'));
  const downloads = path.join(dir, 'downloads');
  const pm = new PodcastManager(dir, { getDownloadDirectory: () => (withDownloadDir ? downloads : null) });
  const tmpFile = (name = 'pulled.mp3') => {
    const p = path.join(dir, `tmp-${Math.random()}-${name}`);
    fs.writeFileSync(p, 'audio');
    return p;
  };
  return { pm, dir, downloads, tmpFile };
}

const deviceEpisode = (over = {}) => ({
  seriesName: 'APM: The Story',
  seriesFeedUrl: 'http://www.thestory.org/archive/podcast.xml',
  author: 'American Public Media',
  title: 'Saving the Rhinos',
  url: 'http://thestory.org/archive/the_story_051311_full_show.mp3',
  description: 'Rhinos.',
  releaseDate: '2011-05-14T00:00:00.000Z',
  duration: 3013000,
  bookmarkMs: 61000,
  size: 5,
  ...over,
});

test('importFromDevice: new show -> subscription created from device data, episode downloaded', () => {
  const { pm, downloads, tmpFile } = setup();
  const r = pm.importFromDevice(deviceEpisode(), tmpFile());

  assert.equal(r.createdSubscription, true);
  const sub = pm.getSubscriptions().find(s => s.id === r.subscriptionId);
  assert.equal(sub.title, 'APM: The Story');
  assert.equal(sub.feedUrl, 'http://www.thestory.org/archive/podcast.xml');
  assert.equal(sub.importedFromDevice, true);

  assert.equal(r.localPath, path.join(downloads, 'APM The Story', 'Saving the Rhinos.mp3'));
  assert.equal(fs.readFileSync(r.localPath, 'utf8'), 'audio');

  const [ep] = pm.getEpisodes(r.subscriptionId);
  assert.equal(ep.downloaded, true);
  assert.equal(ep.localPath, r.localPath);
  assert.equal(ep.playbackPosition, 61);
  assert.equal(ep.duration, 3013);
  assert.equal(ep.enclosureUrl, 'http://thestory.org/archive/the_story_051311_full_show.mp3');
  assert.equal(ep.importedFromDevice, true);
});

test('importFromDevice: existing subscription + feed episode -> marks that episode downloaded', () => {
  const { pm, tmpFile } = setup();
  pm._subscriptions = [{ id: 's1', title: 'The Story (APM)', feedUrl: 'https://www.thestory.org/archive/podcast.xml', newEpisodeCount: 0 }];
  pm._saveEpisodes('s1', [{
    id: 'guid-123', title: 'Saving the Rhinos', enclosureUrl: 'https://thestory.org/archive/the_story_051311_full_show.mp3',
    downloaded: false, localPath: null, playbackPosition: 90, played: false,
  }]);

  const r = pm.importFromDevice(deviceEpisode(), tmpFile());
  assert.equal(r.createdSubscription, false);
  assert.equal(r.subscriptionId, 's1');
  assert.equal(r.episodeId, 'guid-123');
  const [ep] = pm.getEpisodes('s1');
  assert.equal(ep.downloaded, true);
  assert.equal(ep.playbackPosition, 90, 'keeps the further position');
  assert.equal(pm.getSubscriptions().length, 1);
});

test('importFromDevice: same show twice -> one subscription; same episode twice -> one episode', () => {
  const { pm, tmpFile } = setup();
  const a = pm.importFromDevice(deviceEpisode(), tmpFile());
  const b = pm.importFromDevice(deviceEpisode({ title: 'Knowing Her Rights', url: 'http://thestory.org/k.mp3' }), tmpFile());
  const c = pm.importFromDevice(deviceEpisode(), tmpFile());
  assert.equal(b.subscriptionId, a.subscriptionId);
  assert.equal(c.episodeId, a.episodeId);
  assert.equal(pm.getSubscriptions().length, 1);
  assert.equal(pm.getEpisodes(a.subscriptionId).length, 2);
});

test('importFromDevice: show without a feed URL matches by name', () => {
  const { pm, tmpFile } = setup();
  const a = pm.importFromDevice(deviceEpisode({ seriesFeedUrl: '' }), tmpFile());
  const b = pm.importFromDevice(deviceEpisode({ seriesFeedUrl: '', title: 'Other', url: '' }), tmpFile());
  assert.equal(a.subscriptionId, b.subscriptionId);
  assert.equal(pm.getSubscriptions()[0].feedUrl, null);
});

test('importFromDevice: filename collision gets the date suffix', () => {
  const { pm, downloads, tmpFile } = setup();
  fs.mkdirSync(path.join(downloads, 'APM The Story'), { recursive: true });
  fs.writeFileSync(path.join(downloads, 'APM The Story', 'Saving the Rhinos.mp3'), 'other');
  const r = pm.importFromDevice(deviceEpisode(), tmpFile());
  assert.equal(path.basename(r.localPath), 'Saving the Rhinos (2011-05-14).mp3');
});

test('importFromDevice: no download directory -> NO_DOWNLOAD_DIR', () => {
  const { pm, tmpFile } = setup({ withDownloadDir: false });
  assert.throws(() => pm.importFromDevice(deviceEpisode(), tmpFile()), (err) => err.code === 'NO_DOWNLOAD_DIR');
  assert.equal(pm.getSubscriptions().length, 0);
});

test('refresh: an imported episode adopts the feed GUID instead of being listed twice', async () => {
  const { pm, tmpFile } = setup();
  const r = pm.importFromDevice(deviceEpisode(), tmpFile());
  pm._fetchUrl = async () => `<?xml version="1.0"?><rss><channel><title>APM: The Story</title>
    <item><title>Saving the Rhinos</title><guid>story-guid-1</guid>
      <enclosure url="http://thestory.org/archive/the_story_051311_full_show.mp3" type="audio/mpeg" length="5"/></item>
    <item><title>Newer</title><guid>story-guid-2</guid><enclosure url="http://thestory.org/n.mp3" type="audio/mpeg"/></item>
  </channel></rss>`;
  pm._fetchArtwork = async () => null;

  const res = await pm.refresh(r.subscriptionId);
  assert.equal(res.newEpisodeCount, 1);
  const eps = pm.getEpisodes(r.subscriptionId);
  assert.equal(eps.length, 2);
  const rhinos = eps.find(e => e.title === 'Saving the Rhinos');
  assert.equal(rhinos.id, 'story-guid-1');
  assert.equal(rhinos.downloaded, true);
  assert.equal(rhinos.playbackPosition, 61);
});

test('refresh: subscriptions without a feed URL are left alone', async () => {
  const { pm, tmpFile } = setup();
  const r = pm.importFromDevice(deviceEpisode({ seriesFeedUrl: '' }), tmpFile());
  pm._fetchUrl = async () => { throw new Error('should not fetch'); };
  const res = await pm.refresh(r.subscriptionId);
  assert.equal(res.newEpisodeCount, 0);
  assert.equal(pm.getSubscriptions()[0].error, null);
});

test('refresh: an imported episode whose file moved hosts is matched by title (once)', async () => {
  const { pm, tmpFile } = setup();
  const r = pm.importFromDevice(deviceEpisode({ url: 'http://feeds.old-host.com/~r/x/rhinos.mp3' }), tmpFile());
  pm._fetchUrl = async () => `<?xml version="1.0"?><rss><channel><title>APM: The Story</title>
    <item><title>Saving the Rhinos</title><guid>g-1</guid><enclosure url="https://cdn.new-host.com/rhinos.mp3" type="audio/mpeg"/></item>
    <item><title>Saving the Rhinos</title><guid>g-1-repost</guid><enclosure url="https://cdn.new-host.com/rhinos-again.mp3" type="audio/mpeg"/></item>
  </channel></rss>`;
  pm._fetchArtwork = async () => null;

  await pm.refresh(r.subscriptionId);
  const eps = pm.getEpisodes(r.subscriptionId);
  assert.equal(eps.length, 2, 'the feed repost stays, but the import is not a third copy');
  const adopted = eps.find(e => e.id === 'g-1');
  assert.equal(adopted.downloaded, true);
  assert.equal(adopted.enclosureUrl, 'https://cdn.new-host.com/rhinos.mp3');
  assert.equal(eps.find(e => e.id === 'g-1-repost').downloaded, false);
});
