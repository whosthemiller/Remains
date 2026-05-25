/**
 * Normalize wheel delta so mouse wheel scroll feels snappier while keeping
 * trackpad smooth.
 *
 * Browsers do not expose wired vs trackpad — we only flip sign for unambiguous
 * mouse-wheel ticks on macOS, and never during trackpad scroll streams.
 */

const WHEEL_HISTORY_MAX = 8;
const recentSamples = [];

/** Do not treat wheels as mouse until this timestamp (ms). */
let suppressMouseFlipUntil = 0;

function isMacOS() {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform || '';
  const ua = navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/i.test(platform) || ua.includes('Mac');
}

function recordWheelSample(e) {
  const t = performance.now();
  recentSamples.push({
    t,
    abs: Math.abs(e.deltaY),
    mode: e.deltaMode,
  });
  if (recentSamples.length > WHEEL_HISTORY_MAX) {
    recentSamples.shift();
  }
}

function markTrackpadScroll() {
  suppressMouseFlipUntil = performance.now() + 2500;
}

/** Rapid stream of small pixel deltas — trackpad fling/momentum. */
function isTrackpadBurst() {
  if (recentSamples.length < 3) return false;
  const tail = recentSamples.slice(-3);
  const span = tail[2].t - tail[0].t;
  if (span > 100) return false;
  return tail.every((s) => s.mode === 0 && s.abs > 0 && s.abs < 80);
}

/** Two quick pixel deltas — start of trackpad gesture. */
function isTrackpadPair() {
  if (recentSamples.length < 2) return false;
  const a = recentSamples[recentSamples.length - 2];
  const b = recentSamples[recentSamples.length - 1];
  return (
    b.t - a.t < 55 &&
    a.mode === 0 &&
    b.mode === 0 &&
    a.abs > 0 &&
    a.abs < 80 &&
    b.abs > 0 &&
    b.abs < 80
  );
}

function isTrackpadScrolling() {
  if (performance.now() < suppressMouseFlipUntil) return true;
  if (isTrackpadBurst() || isTrackpadPair()) {
    markTrackpadScroll();
    return true;
  }
  return false;
}

/**
 * macOS mouse-wheel sign correction — never true during trackpad scroll.
 */
export function isMouseLikeWheel(e) {
  if (!isMacOS()) return false;

  recordWheelSample(e);

  if (isTrackpadScrolling()) {
    return false;
  }

  const abs = Math.abs(e.deltaY);

  // Line mode: wired/USB mice on macOS (trackpad uses pixel mode)
  if (e.deltaMode === 1) {
    return true;
  }

  // Large discrete pixel notch (~one wheel click)
  if (e.deltaMode === 0 && abs >= 80 && abs <= 250) {
    return true;
  }

  return false;
}

export function normalizedWheelDelta(e) {
  let dy = e.deltaY;
  if (e.deltaMode === 1) {
    dy = dy * 120 * 1.8;
  } else if (e.deltaMode === 0 && Math.abs(dy) >= 80 && Math.abs(dy) <= 250) {
    dy = dy * 2.2;
  }
  if (isMouseLikeWheel(e)) {
    dy = -dy;
  }
  return dy;
}
