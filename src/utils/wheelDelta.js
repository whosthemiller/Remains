/**
 * Normalize wheel delta so mouse wheel scroll feels snappier while keeping
 * trackpad smooth. Mouse wheels send discrete ticks (often deltaMode 1 "lines"
 * or pixel deltas ~100); trackpads send many small deltas.
 */
export function normalizedWheelDelta(e) {
  let dy = e.deltaY;
  if (e.deltaMode === 1) {
    // Line mode (typical for mouse wheel): convert to pixels and boost
    dy = dy * 120 * 1.8;
  } else if (e.deltaMode === 0 && Math.abs(dy) >= 80 && Math.abs(dy) <= 250) {
    // Pixel mode but looks like a single mouse wheel tick
    dy = dy * 2.2;
  }
  return dy;
}
