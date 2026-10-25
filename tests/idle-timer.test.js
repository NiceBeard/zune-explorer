const { test } = require('node:test');
const assert = require('node:assert/strict');
const IdleTimer = require('../src/shared/idle-timer');

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
    },
  };
}

function make(timeoutMs = 1000) {
  const clock = fakeClock();
  let fired = 0;
  const timer = new IdleTimer({ timeoutMs, onIdle: () => fired++, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  return { clock, timer, fired: () => fired };
}

test('fires after the timeout', () => {
  const { clock, timer, fired } = make();
  timer.poke();
  clock.advance(999);
  assert.equal(fired(), 0);
  clock.advance(1);
  assert.equal(fired(), 1);
});

test('pokes postpone it', () => {
  const { clock, timer, fired } = make();
  timer.poke();
  clock.advance(800);
  timer.poke();
  clock.advance(800);
  assert.equal(fired(), 0);
  clock.advance(200);
  assert.equal(fired(), 1);
});

test('fires only once per idle period', () => {
  const { clock, timer, fired } = make();
  timer.poke();
  clock.advance(5000);
  assert.equal(fired(), 1);
  timer.poke();
  clock.advance(1000);
  assert.equal(fired(), 2);
});

test('setTimeoutMs applies on the next arm', () => {
  const { clock, timer, fired } = make();
  timer.poke();
  timer.setTimeoutMs(5000);
  clock.advance(1000);
  assert.equal(fired(), 0);
  clock.advance(4000);
  assert.equal(fired(), 1);
});

test('stop prevents firing until the next poke', () => {
  const { clock, timer, fired } = make();
  timer.poke();
  timer.stop();
  clock.advance(5000);
  assert.equal(fired(), 0);
  timer.poke();
  clock.advance(1000);
  assert.equal(fired(), 1);
});
