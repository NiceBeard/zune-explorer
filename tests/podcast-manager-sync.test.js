const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PodcastManager = require('../src/main/podcast-manager');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-mgr-test-'));
  const audio = path.join(dir, 'a.mp3');
  fs.writeFileSync(audio, 'x');
  const pm = new PodcastManager(dir);
  pm._subscriptions = [{
    id: 'sub1', title: 'Show', author: 'Host', feedUrl: 'https://e.com/feed.xml',
    artworkPath: 'artwork/sub1.jpg', newEpisodeCount: 2,
  }];
  pm._saveEpisodes('sub1', [
    { id: 'e1', title: 'One', enclosureUrl: 'https://e.com/1.mp3', downloaded: true, localPath: audio,
      duration: 60, playbackPosition: 5, played: false, publishDate: '2026-10-01T00:00:00Z', description: 'd' },
    { id: 'e2', title: 'Two', enclosureUrl: 'https://e.com/2.mp3', downloaded: false, localPath: null },
    { id: 'e3', title: 'Gone', enclosureUrl: 'https://e.com/3.mp3', downloaded: true, localPath: path.join(dir, 'missing.mp3') },
  ]);
  return { pm, dir, audio };
}

test('getAllDownloaded: downloaded episodes whose files exist, with show info for the device', () => {
  const { pm, dir, audio } = setup();
  const all = pm.getAllDownloaded();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0], {
    subscriptionId: 'sub1', subscriptionTitle: 'Show', feedUrl: 'https://e.com/feed.xml', author: 'Host',
    artworkPath: path.join(dir, 'podcasts', 'artwork/sub1.jpg'),
    episodeId: 'e1', title: 'One', description: 'd', enclosureUrl: 'https://e.com/1.mp3', localPath: audio,
    duration: 60, playbackPosition: 5, played: false, publishDate: '2026-10-01T00:00:00Z',
  });
});

test('updatePositionFromSync: moves position, marks played once', () => {
  const { pm } = setup();
  assert.equal(pm.updatePositionFromSync('sub1', 'e1', 30, false), true);
  assert.equal(pm.getEpisodes('sub1')[0].playbackPosition, 30);

  pm.updatePositionFromSync('sub1', 'e1', 58, true);
  pm.updatePositionFromSync('sub1', 'e1', 58, true);
  const ep = pm.getEpisodes('sub1')[0];
  assert.equal(ep.played, true);
  assert.equal(pm.getSubscriptions()[0].newEpisodeCount, 1, 'only decremented once');

  assert.equal(pm.updatePositionFromSync('sub1', 'nope', 1, false), false);
});
