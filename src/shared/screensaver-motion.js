// Motion model for the screensaver. Each row is a rectangle sliding along its
// rotated lane; a set enters once and leaves once. These helpers predict where
// rows will be so the next set can start from edges the old set has vacated,
// without the two sets ever crossing on screen.

const ANGLES = [0, 90, -45, 45];

const lerp = (a, b, t) => a + (b - a) * t;
const toRad = (deg) => (deg * Math.PI) / 180;

// Lane centre offsets (px from the stage centre, perpendicular to travel), in input order.
// Gaps are uneven and may be slightly negative; gaps touching a `solid` lane (the cover)
// are kept positive so it never slides over text.
function stackLanes(heights, viewportH, rand, { solid = [] } = {}) {
  const centres = [];
  let y = 0;
  heights.forEach((h, i) => {
    centres.push(y + h / 2);
    y += h;
    if (i < heights.length - 1) {
      let gap = viewportH * lerp(-0.03, 0.06, rand());
      if (solid.includes(i) || solid.includes(i + 1)) gap = Math.max(gap, viewportH * 0.02);
      y += gap;
    }
  });
  const shift = -y / 2 + viewportH * lerp(-0.08, 0.08, rand());
  return centres.map((c) => c + shift);
}

function halfSpanFor(angle, viewport) {
  const r = toRad(angle);
  return (viewport.w * Math.abs(Math.cos(r)) + viewport.h * Math.abs(Math.sin(r))) / 2;
}

// `from`/`to` are the row's left edge along its lane, relative to the stage centre.
function planRows({ rows, angle, viewport, setDuration }) {
  const halfSpan = halfSpanFor(angle, viewport);
  return rows.map((row) => {
    const enter = halfSpan;
    const exit = -halfSpan - row.width;
    const from = row.reverse ? exit : enter;
    const to = row.reverse ? enter : exit;
    const duration = setDuration * row.speedFactor;
    return { ...row, angle, from, to, speed: Math.abs(to - from) / duration, duration };
  });
}

// t: seconds since the row's animation started (its delay included).
function rowRectAt(row, t, viewport) {
  const progress = Math.min(1, Math.max(0, (t - row.delay) / row.duration));
  const x = row.from + (row.to - row.from) * progress + row.width / 2;
  const y = row.laneOffset;
  const r = toRad(row.angle);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    cx: viewport.w / 2 + x * cos - y * sin,
    cy: viewport.h / 2 + x * sin + y * cos,
    hw: row.width / 2,
    hh: row.height / 2,
    angle: row.angle,
  };
}

function corners(rect) {
  const r = toRad(rect.angle);
  const ux = Math.cos(r), uy = Math.sin(r);
  const vx = -uy, vy = ux;
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [
    rect.cx + a * rect.hw * ux + b * rect.hh * vx,
    rect.cy + a * rect.hw * uy + b * rect.hh * vy,
  ]);
}

function axes(rect) {
  const r = toRad(rect.angle);
  return [[Math.cos(r), Math.sin(r)], [-Math.sin(r), Math.cos(r)]];
}

// Separating-axis test for two oriented rectangles.
function rectsOverlap(a, b) {
  const ca = corners(a);
  const cb = corners(b);
  for (const [ax, ay] of [...axes(a), ...axes(b)]) {
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const [x, y] of ca) { const p = x * ax + y * ay; minA = Math.min(minA, p); maxA = Math.max(maxA, p); }
    for (const [x, y] of cb) { const p = x * ax + y * ay; minB = Math.min(minB, p); maxB = Math.max(maxB, p); }
    if (maxA <= minB || maxB <= minA) return false;
  }
  return true;
}

function viewportRect(viewport) {
  return { cx: viewport.w / 2, cy: viewport.h / 2, hw: viewport.w / 2, hh: viewport.h / 2, angle: 0 };
}

// A collision only matters if it can be seen: both rows must be on screen.
function overlapsVisible(a, b, viewport) {
  const screen = viewportRect(viewport);
  return rectsOverlap(a, screen) && rectsOverlap(b, screen) && rectsOverlap(a, b);
}

// outgoing: [{ row, elapsed }] with elapsed taken from each row's own animation clock.
// incoming: planned rows that would start now. Simulates until the outgoing rows are gone.
function isClear({ outgoing, incoming, viewport, step = 0.25 }) {
  const horizon = Math.max(0, ...outgoing.map(({ row, elapsed }) => row.delay + row.duration - elapsed));
  for (let tau = 0; tau <= horizon + 1e-9; tau += step) {
    const inRects = incoming.map((row) => rowRectAt(row, tau, viewport));
    for (const { row, elapsed } of outgoing) {
      if (elapsed + tau > row.delay + row.duration) continue;
      const out = rowRectAt(row, elapsed + tau, viewport);
      for (const inc of inRects) {
        if (overlapsVisible(out, inc, viewport)) return false;
      }
    }
  }
  return true;
}

function shuffled(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// First direction (never the previous one) whose incoming set stays clear of the outgoing rows,
// or null when none is clear yet.
function chooseNextAngle({ previous, buildIncoming, outgoing, viewport, rand }) {
  const candidates = shuffled(ANGLES.filter((a) => a !== previous), rand);
  if (outgoing.length === 0) return candidates[0];
  for (const angle of candidates) {
    if (isClear({ outgoing, incoming: buildIncoming(angle), viewport })) return angle;
  }
  return null;
}

// Occasionally (40% of sets) one eligible row runs the opposite way.
function pickReversals(count, eligible, rand) {
  const out = new Array(count).fill(false);
  if (eligible.length > 0 && rand() < 0.4) {
    out[eligible[Math.floor(rand() * eligible.length)]] = true;
  }
  return out;
}

const screensaverMotion = {
  ANGLES, stackLanes, planRows, rowRectAt, rectsOverlap, overlapsVisible, isClear, chooseNextAngle, pickReversals,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = screensaverMotion;
}
if (typeof window !== 'undefined') {
  window.screensaverMotion = screensaverMotion;
}
