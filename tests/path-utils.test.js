const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isUnderPrefix,
  isUnderAnyPrefix,
  computeAddedPaths,
  computeRemovedPaths,
  toFileUrl,
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

test('toFileUrl: POSIX path', () => {
  assert.equal(toFileUrl('/Users/me/Music/song.mp3'), 'file:///Users/me/Music/song.mp3');
});

test('toFileUrl: Windows drive path', () => {
  assert.equal(toFileUrl('C:\\Users\\Me\\Music\\song.mp3'), 'file:///C:/Users/Me/Music/song.mp3');
});

test('toFileUrl: Windows path with mixed separators', () => {
  assert.equal(toFileUrl('C:\\Users\\Me\\AppData/podcasts/art.jpg'), 'file:///C:/Users/Me/AppData/podcasts/art.jpg');
});

test('toFileUrl: UNC share', () => {
  assert.equal(toFileUrl('\\\\nas\\music\\a b.mp3'), 'file://nas/music/a%20b.mp3');
});

test('toFileUrl: encodes spaces, # and ? in each segment', () => {
  assert.equal(toFileUrl('/m/#1 Hits/what?.mp3'), 'file:///m/%231%20Hits/what%3F.mp3');
});

test('toFileUrl: result parses as a URL that keeps the whole path', () => {
  const u = new URL(toFileUrl('D:\\Music\\#1 Hits\\a.mp3'));
  assert.equal(u.hash, '');
  assert.equal(decodeURIComponent(u.pathname), '/D:/Music/#1 Hits/a.mp3');
});
