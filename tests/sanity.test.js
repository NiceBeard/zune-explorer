const { test } = require('node:test');
const assert = require('node:assert/strict');

test('sanity: node:test runs', () => {
  assert.equal(1 + 1, 2);
});
