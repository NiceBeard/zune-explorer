const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeArtistName, artistNamesMatch, primaryArtist, isPlaceholderArtist } = require('../src/shared/artist-name');

test('normalize: case, diacritics, ampersand, leading the', () => {
  assert.equal(normalizeArtistName('Beyoncé'), 'beyonce');
  assert.equal(normalizeArtistName('Tom Petty & The Heartbreakers'), 'tom petty and the heartbreakers');
  assert.equal(normalizeArtistName('The Beatles'), 'beatles');
  assert.equal(normalizeArtistName('  AC/DC  '), 'acdc');
});

test('match: equivalent spellings match', () => {
  assert.equal(artistNamesMatch('Tom Petty and the Heartbreakers', 'Tom Petty & The Heartbreakers'), true);
  assert.equal(artistNamesMatch('Sigur Rós', 'Sigur Ros'), true);
});

test('match: different artists never match', () => {
  assert.equal(artistNamesMatch('Tom Petty', 'Tom Petty & The Heartbreakers'), false);
  assert.equal(artistNamesMatch('Prince', 'Princess'), false);
  assert.equal(artistNamesMatch('', ''), false);
});

test('primaryArtist: strips featured credits', () => {
  assert.equal(primaryArtist('Calvin Harris feat. Rihanna'), 'Calvin Harris');
  assert.equal(primaryArtist('Santana Featuring Rob Thomas'), 'Santana');
  assert.equal(primaryArtist('Simon & Garfunkel'), 'Simon & Garfunkel');
});

test('primaryArtist: "with" inside a band name is not a featuring credit', () => {
  assert.equal(primaryArtist('Sleeping With Sirens'), 'Sleeping With Sirens');
  assert.equal(primaryArtist('Dance With the Dead'), 'Dance With the Dead');
});

test('isPlaceholderArtist: compilation and unknown placeholders', () => {
  assert.equal(isPlaceholderArtist('Various Artists'), true);
  assert.equal(isPlaceholderArtist('Unknown Artist'), true);
  assert.equal(isPlaceholderArtist('unknown'), true);
  assert.equal(isPlaceholderArtist(''), true);
  assert.equal(isPlaceholderArtist('Coheed and Cambria'), false);
});
