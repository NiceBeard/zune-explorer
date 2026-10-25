const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getFanartApiKey } = require('../src/main/app-config');

test('env var wins', () => {
  assert.equal(getFanartApiKey({ env: { FANART_API_KEY: 'abc' }, readBuildConfig: () => ({ fanartApiKey: 'zzz' }) }), 'abc');
});

test('falls back to build config', () => {
  assert.equal(getFanartApiKey({ env: {}, readBuildConfig: () => ({ fanartApiKey: 'zzz' }) }), 'zzz');
});

test('no key anywhere -> null', () => {
  assert.equal(getFanartApiKey({ env: {}, readBuildConfig: () => ({}) }), null);
  assert.equal(getFanartApiKey({ env: { FANART_API_KEY: '' }, readBuildConfig: () => ({ fanartApiKey: '' }) }), null);
});
