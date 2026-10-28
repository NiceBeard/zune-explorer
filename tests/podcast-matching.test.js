const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  urlsMatch,
  findDeviceShow,
  findDeviceEpisode,
  zuneSafeName,
  formatDateAuthored,
  resolvePositionSync,
  matchPodcastEpisodes,
} = require('../src/shared/podcast-matching');

test('urlsMatch: exact, case-insensitive, and stale-suffix tolerant', () => {
  assert.equal(urlsMatch('http://a.com/x.mp3', 'http://a.com/x.mp3'), true);
  assert.equal(urlsMatch('HTTP://A.com/x.mp3', 'http://a.com/x.mp3'), true);
  // Written without a NUL terminator by other tools: device appends stale bytes
  assert.equal(urlsMatch('https://e.com/feed.xmle Explorer Probe', 'https://e.com/feed.xml'), true);
  assert.equal(urlsMatch('http://a.com/x.mp3', 'http://a.com/y.mp3'), false);
  assert.equal(urlsMatch('', 'http://a.com'), false);
  assert.equal(urlsMatch('http://a.com', ''), false);
});

test('urlsMatch: ignores http vs https', () => {
  assert.equal(urlsMatch('http://feeds.wnyc.org/radiolab', 'https://feeds.wnyc.org/radiolab'), true);
});

const shows = [
  { atomId: 1, name: 'Radiolab', feedUrl: 'http://feeds.wnyc.org/radiolab' },
  { atomId: 2, name: 'Old Copy', feedUrl: 'https://e.com/feed.xmlgarbage' },
  { atomId: 3, name: 'Old Copy', feedUrl: 'https://e.com/feed.xml' },
  { atomId: 4, name: 'No Feed Show', feedUrl: '' },
];
const episodes = [
  { atomId: 10, showAtomId: 3, title: 'A', url: 'https://e.com/a.mp3' },
  { atomId: 11, showAtomId: 3, title: 'B', url: 'https://e.com/b.mp3' },
  { atomId: 12, showAtomId: 2, title: 'A', url: 'https://e.com/a.mp3' },
];

test('findDeviceShow: by feed URL, preferring the show with the most episodes', () => {
  const r = findDeviceShow(shows, episodes, { feedUrl: 'https://e.com/feed.xml', title: 'Whatever' });
  assert.equal(r.show.atomId, 3);
  assert.equal(r.matchedBy, 'feedUrl');
  assert.equal(r.duplicates.length, 1);
});

test('findDeviceShow: an exact feed URL beats a longer URL that shares the prefix', () => {
  const s = [
    { atomId: 20, name: 'Show 2', feedUrl: 'https://x.com/show2' },
    { atomId: 21, name: 'Show', feedUrl: 'https://x.com/show' },
  ];
  const eps = [{ atomId: 30, showAtomId: 20 }, { atomId: 31, showAtomId: 20 }];
  assert.equal(findDeviceShow(s, eps, { feedUrl: 'https://x.com/show', title: 'Show' }).show.atomId, 21);
});

test('findDeviceShow: falls back to the show name when no feed URL matches', () => {
  const r = findDeviceShow(shows, episodes, { feedUrl: 'https://new-host.com/radiolab.rss', title: 'radiolab' });
  assert.equal(r.show.atomId, 1);
  assert.equal(r.matchedBy, 'name');
});

test('findDeviceShow: null when nothing matches', () => {
  assert.equal(findDeviceShow(shows, episodes, { feedUrl: 'https://x.com', title: 'Nope' }).show, null);
});

test('findDeviceEpisode: by enclosure URL, then by title', () => {
  const eps = episodes.filter(e => e.showAtomId === 3);
  assert.equal(findDeviceEpisode(eps, { url: 'https://e.com/b.mp3', title: 'renamed' }).atomId, 11);
  assert.equal(findDeviceEpisode(eps, { url: 'https://cdn.e.com/a.mp3?x=1', title: ' a ' }).atomId, 10);
  assert.equal(findDeviceEpisode(eps, { url: 'https://e.com/c.mp3', title: 'C' }), null);
});

test('zuneSafeName: replaces illegal filename characters the way Zune Desktop does', () => {
  assert.equal(zuneSafeName('APM: The Story'), 'APM  The Story');
  assert.equal(zuneSafeName('What? / Why*'), 'What    Why');
  assert.equal(zuneSafeName('Trailing dots...'), 'Trailing dots');
  assert.equal(zuneSafeName(''), 'Untitled');
});

test('formatDateAuthored: YYYYMMDDTHHMMSS.0 in local time', () => {
  assert.equal(formatDateAuthored(new Date(2010, 3, 10, 5, 6, 7)), '20100410T050607.0');
  assert.equal(formatDateAuthored('not a date'), '');
  assert.equal(formatDateAuthored(null), '');
});

test('resolvePositionSync: furthest position wins', () => {
  assert.deepEqual(resolvePositionSync({ localMs: 1000, deviceMs: 1000, durationMs: 60000 }),
    { direction: 'none', positionMs: 1000, played: false });
  assert.deepEqual(resolvePositionSync({ localMs: 1000, deviceMs: 30000, durationMs: 60000 }),
    { direction: 'to-local', positionMs: 30000, played: false });
  assert.deepEqual(resolvePositionSync({ localMs: 45000, deviceMs: 30000, durationMs: 60000 }),
    { direction: 'to-device', positionMs: 45000, played: false });
});

test('resolvePositionSync: 95% or more counts as played', () => {
  const r = resolvePositionSync({ localMs: 0, deviceMs: 57000, durationMs: 60000 });
  assert.equal(r.direction, 'to-local');
  assert.equal(r.played, true);
  assert.equal(resolvePositionSync({ localMs: 0, deviceMs: 5000, durationMs: 0 }).played, false);
});

test('resolvePositionSync: tiny differences are ignored', () => {
  // Device bookmarks are ms; local positions are float seconds — don't ping-pong on rounding
  assert.equal(resolvePositionSync({ localMs: 30400, deviceMs: 30000, durationMs: 60000 }).direction, 'none');
});

test('matchPodcastEpisodes: pairs local downloads with device episodes', () => {
  const local = [
    { episodeId: 'g1', title: 'A', enclosureUrl: 'https://e.com/a.mp3', subscriptionTitle: 'Old Copy' },
    { episodeId: 'g2', title: 'Renamed on feed', enclosureUrl: 'https://e.com/b.mp3', subscriptionTitle: 'Old Copy' },
    { episodeId: 'g3', title: 'B', enclosureUrl: 'https://e.com/z.mp3', subscriptionTitle: 'Other' },
    { episodeId: 'g4', title: 'New', enclosureUrl: 'https://e.com/new.mp3', subscriptionTitle: 'Old Copy' },
  ];
  const device = [
    { handle: 10, title: 'A', url: 'https://e.com/a.mp3', seriesName: 'Old Copy' },
    { handle: 11, title: 'B', url: 'https://e.com/b.mp3', seriesName: 'Old Copy' },
    { handle: 13, title: 'Only on device', url: 'https://e.com/d.mp3', seriesName: 'Old Copy' },
  ];
  const { matched, localOnly, deviceOnly } = matchPodcastEpisodes(local, device);
  assert.deepEqual(matched.map(m => [m.local.episodeId, m.device.handle]), [['g1', 10], ['g2', 11]]);
  // g3 shares a title with handle 11 but a different show, and 11 is already taken
  assert.deepEqual(localOnly.map(e => e.episodeId), ['g3', 'g4']);
  assert.deepEqual(deviceOnly.map(e => e.handle), [13]);
});

test('matchPodcastEpisodes: title fallback also accepts the same show by feed URL', () => {
  // After a feed refresh the show is renamed and the file moved hosts
  const local = [{ episodeId: 'g', title: 'Desperately Seeking Symmetry', enclosureUrl: 'https://cdn.new/x.mp3',
    subscriptionTitle: 'Radiolab', feedUrl: 'http://feeds.wnyc.org/radiolab' }];
  const device = [{ handle: 1, title: 'Desperately Seeking Symmetry', url: 'http://feeds.wnyc.org/~r/old.mp3',
    seriesName: "WNYC's Radiolab", seriesFeedUrl: 'http://feeds.wnyc.org/radiolab' }];
  assert.equal(matchPodcastEpisodes(local, device).matched.length, 1);
});
