/**
 * Wheel event normalization for mouse vs trackpad.
 * - Trackpad: many small deltas, often deltaMode 0 (pixels). Keep direction and scale as-is.
 * - Mouse: discrete notches, often deltaMode 1 (lines) or large single deltas. Normalize to
 *   "natural" scroll direction (scroll down = zoom out / content down) and scale so it feels responsive.
 */

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** Typical pixels per "line" for mouse wheel (browsers use ~32–40) */
const PIXELS_PER_LINE = 38;
/** Single-step delta above this is treated as mouse (discrete notch) */
const MOUSE_STEP_THRESHOLD = 45;

/**
 * @param {WheelEvent} e
 * @returns {{ deltaY: number, isMouse: boolean }}
 */
export function normalizeWheel(e) {
  let deltaY = e.deltaY;
  const mode = e.deltaMode;

  if (mode === DOM_DELTA_LINE) {
    deltaY *= PIXELS_PER_LINE;
  } else if (mode === DOM_DELTA_PAGE) {
    deltaY *= window.innerHeight * 0.8;
  }

  const isMouse =
    mode === DOM_DELTA_LINE ||
    mode === DOM_DELTA_PAGE ||
    Math.abs(e.deltaY) >= MOUSE_STEP_THRESHOLD;

  return { deltaY, isMouse };
}

/**
 * For zoom: trackpad = current inverted (scroll down = zoom in). Mouse = natural (scroll down = zoom out).
 * @param {WheelEvent} e
 * @returns {number} deltaY to apply to zoom logic (positive = zoom in, negative = zoom out)
 */
export function wheelDeltaForZoom(e) {
  const { deltaY, isMouse } = normalizeWheel(e);
  if (isMouse) return -deltaY; // natural: scroll down -> zoom out
  return deltaY;
}

/**
 * For album scroll: same direction on both (scroll down = next photo). Mouse gets normalized line/page deltas + 1.5x so it feels responsive.
 * @param {WheelEvent} e
 * @param {number} [trackpadScale=1] - optional multiplier for trackpad deltas (e.g. 1.35)
 * @returns {number} deltaY to add to albumScrollDelta (positive = next photo)
 */
export function wheelDeltaForAlbum(e, trackpadScale = 1) {
  const { deltaY, isMouse } = normalizeWheel(e);
  if (isMouse) {
    return deltaY * 1.5; // same direction as trackpad, 1.5x so mouse wheel feels responsive
  }
  return deltaY * trackpadScale;
}
