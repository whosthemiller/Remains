/**
 * Normalize wheel delta so mouse wheel scroll feels snappier while keeping
 * trackpad smooth. Mouse wheels send discrete ticks (often deltaMode 1 "lines"
 * or pixel deltas ~100); trackpads send many small deltas.
 *
 * On macOS, physical mouse wheels often report the opposite deltaY sign from
 * the trackpad for the same gesture — normalize so scroll-down is always positive.
 */
export function isMouseLikeWheel(e) {
  if (e.deltaMode === 1) return true;
  if (e.deltaMode === 0 && Math.abs(e.deltaY) >= 80 && Math.abs(e.deltaY) <= 250) {
    return true;
  }
  return false;
}

function isMacOS() {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform || '';
  const ua = navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/i.test(platform) || ua.includes('Mac');
}

export function normalizedWheelDelta(e) {
  let dy = e.deltaY;
  if (e.deltaMode === 1) {
    // Line mode (typical for mouse wheel): convert to pixels and boost
    dy = dy * 120 * 1.8;
  } else if (e.deltaMode === 0 && Math.abs(dy) >= 80 && Math.abs(dy) <= 250) {
    // Pixel mode but looks like a single mouse wheel tick
    dy = dy * 2.2;
  }
  if (isMacOS() && isMouseLikeWheel(e)) {
    dy = -dy;
  }
  return dy;
}
