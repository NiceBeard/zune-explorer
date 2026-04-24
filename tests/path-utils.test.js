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
