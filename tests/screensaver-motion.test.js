const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ANGLES, stackLanes, planRows, rowRectAt, rectsOverlap, overlapsVisible, isClear, chooseNextAngle, pickReversals,
} = require('../src/shared/screensaver-motion');

const vp = { w: 1600, h: 1000 };
const row = (o = {}) => ({ width: 400, height: 100, laneOffset: 0, reverse: false, speedFactor: 1, delay: 0, ...o });
const plan1 = (o, angle = 0, setDuration = 40) => planRows({ rows: [row(o)], angle, viewport: vp, setDuration })[0];

test('ANGLES: the four Zune directions', () => {
  assert.deepEqual(ANGLES, [0, 90, -45, 45]);
});

test('planRows: horizontal row enters right edge, exits left edge', () => {
  const r = plan1();
  assert.equal(r.from, 800);
  assert.equal(r.to, -1200);
  assert.equal(r.duration, 40);
  assert.equal(r.speed, 50);
});

test('planRows: reverse swaps entry and exit', () => {
  const r = plan1({ reverse: true });
  assert.equal(r.from, -1200);
  assert.equal(r.to, 800);
});

test('planRows: speedFactor stretches the duration', () => {
  assert.equal(plan1({ speedFactor: 0.75 }).duration, 30);
});

test('rowRectAt: off-screen right at t=0, centred mid-way, off-screen left at end', () => {
  const r = plan1();
  assert.ok(rowRectAt(r, 0, vp).cx - 200 >= 1600);
  assert.equal(Math.round(rowRectAt(r, 20, vp).cx), 800);
  assert.ok(rowRectAt(r, 40, vp).cx + 200 <= 0);
  assert.deepEqual(rowRectAt(r, 99, vp), rowRectAt(r, 40, vp));
});

test('rowRectAt: delay holds the row at its entry point', () => {
  const r = plan1({ delay: 2 });
  assert.deepEqual(rowRectAt(r, 1, vp), rowRectAt(r, 0, vp));
  assert.equal(Math.round(rowRectAt(r, 22, vp).cx), 800);
});

test('rowRectAt: vertical (90) moves along screen y', () => {
  const r = plan1({}, 90);
  const a = rowRectAt(r, 5, vp);
  const b = rowRectAt(r, 10, vp);
  assert.equal(Math.round(a.cx), 800);
  assert.equal(Math.round(b.cx), 800);
  assert.ok(b.cy < a.cy);
});

test('rowRectAt: lane offset is perpendicular to travel', () => {
  const r = plan1({ laneOffset: 300 });
  assert.equal(Math.round(rowRectAt(r, 20, vp).cy), 800);
});

test('rectsOverlap: crossing diagonals overlap; parallel separated lanes do not', () => {
  const d1 = { cx: 800, cy: 500, hw: 600, hh: 40, angle: 45 };
  const d2 = { cx: 800, cy: 500, hw: 600, hh: 40, angle: -45 };
  assert.equal(rectsOverlap(d1, d2), true);
  const laneA = { cx: 800, cy: 400, hw: 900, hh: 40, angle: 0 };
  const laneB = { cx: 800, cy: 500, hw: 900, hh: 40, angle: 0 };
  assert.equal(rectsOverlap(laneA, laneB), false);
  const rotatedNear = { cx: 800, cy: 470, hw: 900, hh: 40, angle: 3 };
  assert.equal(rectsOverlap(laneB, rotatedNear), true);
});

test('overlapsVisible: overlap only off-screen is ignored', () => {
  const a = { cx: -400, cy: 500, hw: 200, hh: 50, angle: 0 };
  const b = { cx: -350, cy: 500, hw: 200, hh: 50, angle: 90 };
  assert.equal(rectsOverlap(a, b), true);
  assert.equal(overlapsVisible(a, b, vp), false);
  const c = { cx: 800, cy: 500, hw: 200, hh: 50, angle: 0 };
  const d = { cx: 800, cy: 500, hw: 200, hh: 50, angle: 90 };
  assert.equal(overlapsVisible(c, d, vp), true);
});

test('isClear: new horizontal set right behind a leaving horizontal set is clear', () => {
  const outgoing = [{ row: plan1(), elapsed: 30 }];
  assert.equal(isClear({ outgoing, incoming: [plan1()], viewport: vp }), true);
});

test('isClear: vertical set entering while a horizontal giant row spans the screen is not clear', () => {
  const outgoing = [{ row: plan1({ width: 6000, height: 500 }), elapsed: 20 }];
  const incoming = [plan1({ width: 1000 }, 90)];
  assert.equal(isClear({ outgoing, incoming, viewport: vp }), false);
});

test("isClear: uses each outgoing row's own elapsed time", () => {
  const giantVertical = plan1({ width: 6000, height: 300 }, 90);
  const incoming = [plan1({ laneOffset: 400 })];
  assert.equal(isClear({ outgoing: [{ row: giantVertical, elapsed: 39.5 }], incoming, viewport: vp }), true);
  assert.equal(isClear({ outgoing: [{ row: giantVertical, elapsed: 20 }], incoming, viewport: vp }), false);
});

test('isClear: nothing outgoing is clear', () => {
  assert.equal(isClear({ outgoing: [], incoming: [plan1()], viewport: vp }), true);
});

const buildIncoming = (angle) => [plan1({ width: 300 }, angle)];

test('chooseNextAngle: never returns previous angle', () => {
  for (let i = 0; i < 50; i++) {
    assert.notEqual(chooseNextAngle({ previous: 0, buildIncoming, outgoing: [], viewport: vp, rand: Math.random }), 0);
  }
});

test('chooseNextAngle: null when every candidate collides', () => {
  const wall = plan1({ width: 6000, height: 3000 });
  const outgoing = [{ row: wall, elapsed: 20 }];
  assert.equal(chooseNextAngle({ previous: 0, buildIncoming, outgoing, viewport: vp, rand: Math.random }), null);
});

test('chooseNextAngle: picks a clear direction when one exists', () => {
  // Outgoing horizontal row leaving through the top band; only some directions avoid it.
  const outgoing = [{ row: plan1({ laneOffset: -400, width: 3000 }), elapsed: 10 }];
  const picked = chooseNextAngle({ previous: 0, buildIncoming: (a) => [plan1({ width: 300, laneOffset: a === 90 ? 600 : 300 }, a)], outgoing, viewport: vp, rand: Math.random });
  assert.ok(ANGLES.includes(picked) && picked !== 0);
  assert.equal(isClear({ outgoing, incoming: [plan1({ width: 300, laneOffset: picked === 90 ? 600 : 300 }, picked)], viewport: vp }), true);
});

const heights = [550, 60, 130, 380, 100, 600];

test('stackLanes: preserves order and stays near centre', () => {
  for (let i = 0; i < 200; i++) {
    const lanes = stackLanes(heights, 1000, Math.random);
    for (let k = 1; k < lanes.length; k++) assert.ok(lanes[k] > lanes[k - 1]);
    const top = lanes[0] - heights[0] / 2;
    const bottom = lanes[lanes.length - 1] + heights[heights.length - 1] / 2;
    assert.ok(Math.abs((top + bottom) / 2) <= 80 + 1e-9);
  }
});

test('stackLanes: solid lane never overlaps neighbours', () => {
  for (let i = 0; i < 200; i++) {
    const lanes = stackLanes(heights, 1000, Math.random, { solid: [3] });
    const band = (k) => [lanes[k] - heights[k] / 2, lanes[k] + heights[k] / 2];
    assert.ok(band(2)[1] <= band(3)[0]);
    assert.ok(band(3)[1] <= band(4)[0]);
  }
});

test('pickReversals: at most one, only from eligible', () => {
  let anyReversed = false;
  for (let i = 0; i < 200; i++) {
    const r = pickReversals(6, [1, 2, 4], Math.random);
    assert.equal(r.length, 6);
    const idx = r.map((v, k) => (v ? k : -1)).filter((k) => k >= 0);
    assert.ok(idx.length <= 1);
    for (const k of idx) assert.ok([1, 2, 4].includes(k));
    if (idx.length) anyReversed = true;
  }
  assert.ok(anyReversed);
});
