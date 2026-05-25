const IDLE_MS = 3 * 60 * 1000;

const ACTIVITY_EVENTS = [
  'mousedown',
  'keydown',
  'touchstart',
  'touchmove',
  'wheel',
  'scroll',
  'click',
  'pointerdown',
];

/**
 * Reload the page after `timeoutMs` with no user interaction.
 */
export function setupIdleRefresh(timeoutMs = IDLE_MS) {
  let timeoutId;

  const scheduleReload = () => {
    clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      window.location.reload();
    }, timeoutMs);
  };

  for (const event of ACTIVITY_EVENTS) {
    window.addEventListener(event, scheduleReload, { passive: true, capture: true });
  }

  scheduleReload();
}
