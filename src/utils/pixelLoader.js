/**
 * Pixel Loader - Determinate Progress Bar
 * 
 * A pixel-style loading bar with 2×2 pixel blocks.
 * UI-only: provides functions to init, update progress, and destroy.
 * Does NOT contain loading logic - call setPixelLoaderProgress() from your code.
 * 
 * Usage:
 *   import { initPixelLoader, setPixelLoaderProgress, destroyPixelLoader } from './utils/pixelLoader.js';
 *   
 *   // Initialize when loader is visible
 *   initPixelLoader('#pixel-loader');
 *   
 *   // Update progress from your loading logic (0 to 1)
 *   setPixelLoaderProgress(0.5);
 *   
 *   // Optional: add completion class for blink effect
 *   setPixelLoaderProgress(1);
 *   
 *   // Cleanup when done
 *   destroyPixelLoader();
 */

// Module state
let pixelLoaderRoot = null;
let pixelLoaderPixelsContainer = null;
let columnCount = 0;
let resizeHandler = null;
let debounceTimer = null;
let currentStepIndex = 0;
let animationInterval = null;
let animationComplete = false;
let loadingComplete = false;
let onCompleteCallback = null;

// Constants
const PIXEL_SIZE = 2;   // 2px × 2px
const PIXEL_GAP = 2;    // 2px gap between pixels/columns
const PIXELS_PER_COLUMN = 3; // 3 stacked pixels per column (like filter nav)
const DEBOUNCE_MS = 100;

// Group-based progression constants
const PIXEL_GROUP_SIZE = 20; // Number of columns per group
const MS_PER_STEP = 100;     // Milliseconds between each group step (slower for consistent pace)

/**
 * Calculate how many columns fit in the available width
 * @param {number} availableWidth - Width in pixels
 * @returns {number} Number of columns that fit
 */
function calculateColumnCount(availableWidth) {
  if (availableWidth <= 0) return 0;
  // Each column takes PIXEL_SIZE + PIXEL_GAP, except the last one (no trailing gap)
  // Formula: n * PIXEL_SIZE + (n - 1) * PIXEL_GAP <= availableWidth
  // Simplified: n * (PIXEL_SIZE + PIXEL_GAP) - PIXEL_GAP <= availableWidth
  // n <= (availableWidth + PIXEL_GAP) / (PIXEL_SIZE + PIXEL_GAP)
  const count = Math.floor((availableWidth + PIXEL_GAP) / (PIXEL_SIZE + PIXEL_GAP));
  return Math.max(count, 1);
}

/**
 * Create pixel column elements in the container
 * Each column contains 3 stacked 2×2 pixels (same as filter nav)
 * @param {number} count - Number of columns to create
 */
function createColumns(count) {
  if (!pixelLoaderPixelsContainer) return;
  
  // Clear existing content
  pixelLoaderPixelsContainer.innerHTML = '';
  
  // Create columns with 3 pixels each
  for (let i = 0; i < count; i++) {
    const column = document.createElement('div');
    column.className = 'pixel-loader-column pixel-loader-column--empty';
    column.dataset.index = i;
    
    // Add 3 pixel squares to the column
    for (let j = 0; j < PIXELS_PER_COLUMN; j++) {
      const pixel = document.createElement('div');
      pixel.className = 'pixel-loader-pixel';
      column.appendChild(pixel);
    }
    
    pixelLoaderPixelsContainer.appendChild(column);
  }
  
  columnCount = count;
}

/**
 * Recalculate and rebuild columns based on current container width
 */
function rebuildPixels() {
  if (!pixelLoaderPixelsContainer) return;
  
  // Get available width (container width minus any padding)
  let availableWidth = pixelLoaderPixelsContainer.offsetWidth || pixelLoaderPixelsContainer.clientWidth;
  
  // Fallback: if width is 0 (not laid out yet), calculate from parent track
  if (availableWidth <= 0 && pixelLoaderRoot) {
    const track = pixelLoaderRoot.querySelector('.pixel-loader-track');
    if (track) {
      const trackPadding = 16; // 8px padding on each side
      const trackBorder = 4;  // 2px border on each side
      const trackWidth = track.offsetWidth || pixelLoaderRoot.offsetWidth || 1274;
      availableWidth = trackWidth - trackPadding - trackBorder;
    }
  }
  
  // Final fallback: use nav width minus padding/border
  if (availableWidth <= 0) {
    availableWidth = 1274 - 20; // nav-width minus padding/border
  }
  
  const newCount = calculateColumnCount(availableWidth);
  
  if (newCount !== columnCount && newCount > 0) {
    createColumns(newCount);
  }
}

/**
 * Debounced resize handler
 */
function handleResize() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    rebuildPixels();
  }, DEBOUNCE_MS);
}

/**
 * Initialize the pixel loader
 * Creates the correct number of pixels based on available width.
 * Can be called multiple times - will rebuild pixels with current width.
 * 
 * @param {string} rootSelector - CSS selector for the .pixel-loader container (default: '#pixel-loader')
 */
export function initPixelLoader(rootSelector = '#pixel-loader') {
  // Find root element
  const newRoot = document.querySelector(rootSelector);
  if (!newRoot) {
    console.warn(`Pixel Loader: Root element not found: ${rootSelector}`);
    return;
  }
  
  // Find pixels container
  const newPixelsContainer = newRoot.querySelector('.pixel-loader-pixels');
  if (!newPixelsContainer) {
    console.warn('Pixel Loader: .pixel-loader-pixels container not found');
    return;
  }
  
  // Update references
  pixelLoaderRoot = newRoot;
  pixelLoaderPixelsContainer = newPixelsContainer;
  
  // Remove completion class if present
  pixelLoaderRoot.classList.remove('pixel-loader--complete');
  
  // Stop any running animation
  stopAnimation();
  
  // Reset progress state
  currentStepIndex = 0;
  animationComplete = false;
  loadingComplete = false;
  onCompleteCallback = null;
  
  // Force rebuild columns (reset count to force recreation)
  columnCount = 0;
  rebuildPixels();
  
  // Start animation immediately
  startAnimation();
  
  // Setup resize listener (only once)
  if (!resizeHandler) {
    resizeHandler = handleResize;
    window.addEventListener('resize', resizeHandler);
  }
}

/**
 * Render the current visual state (called by animation loop)
 */
function renderCurrentStep() {
  if (!pixelLoaderPixelsContainer || columnCount === 0) return;
  
  const filledColumns = currentStepIndex * PIXEL_GROUP_SIZE;
  
  // Update column states
  const columns = pixelLoaderPixelsContainer.querySelectorAll('.pixel-loader-column');
  columns.forEach((column, index) => {
    if (index < filledColumns) {
      column.classList.add('pixel-loader-column--filled');
      column.classList.remove('pixel-loader-column--empty');
    } else {
      column.classList.remove('pixel-loader-column--filled');
      column.classList.add('pixel-loader-column--empty');
    }
  });
}

/**
 * Check if both animation and loading are complete, then fire callback
 */
function checkComplete() {
  if (animationComplete && loadingComplete) {
    // Fill all remaining columns
    const columns = pixelLoaderPixelsContainer.querySelectorAll('.pixel-loader-column');
    columns.forEach((column) => {
      column.classList.add('pixel-loader-column--filled');
      column.classList.remove('pixel-loader-column--empty');
    });
    
    // Add completion class for blink effect
    if (pixelLoaderRoot) {
      pixelLoaderRoot.classList.add('pixel-loader--complete');
    }
    
    // Fire completion callback
    if (onCompleteCallback) {
      onCompleteCallback();
    }
  }
}

/**
 * Animation step - advance one group at fixed pace
 */
function animationStep() {
  const totalGroups = Math.floor(columnCount / PIXEL_GROUP_SIZE);
  
  if (currentStepIndex < totalGroups) {
    currentStepIndex++;
    renderCurrentStep();
  } else {
    // Animation reached the end
    stopAnimation();
    animationComplete = true;
    checkComplete();
  }
}

/**
 * Start the animation loop if not already running
 */
function startAnimation() {
  if (animationInterval) return;
  animationInterval = setInterval(animationStep, MS_PER_STEP);
}

/**
 * Stop the animation loop
 */
function stopAnimation() {
  if (animationInterval) {
    clearInterval(animationInterval);
    animationInterval = null;
  }
}

/**
 * Mark loading as complete.
 * The loader will hide only when BOTH animation AND loading are done.
 * 
 * Call this when your actual loading finishes.
 */
export function setPixelLoaderProgress(progress01) {
  // We ignore the actual progress value - animation runs at its own fixed pace
  // Just check if loading is complete
  if (progress01 >= 1) {
    loadingComplete = true;
    checkComplete();
  }
}

/**
 * Start the loader animation (call this when loader becomes visible)
 */
export function startPixelLoaderAnimation() {
  if (!pixelLoaderPixelsContainer || columnCount === 0) return;
  startAnimation();
}

/**
 * Set a callback to be called when BOTH animation and loading are complete
 * 
 * @param {Function} callback - Function to call when everything is done
 */
export function onPixelLoaderComplete(callback) {
  onCompleteCallback = callback;
  // If both conditions are already met, fire immediately (fixes race condition)
  if (animationComplete && loadingComplete) {
    checkComplete();
  }
}

/**
 * Get the current column count (useful for debugging or external logic)
 * @returns {number} Current number of columns
 */
export function getPixelCount() {
  return columnCount;
}

/**
 * Destroy the pixel loader
 * Removes resize listeners and cleans up state.
 * Does NOT remove DOM elements (your existing hide logic handles that).
 */
export function destroyPixelLoader() {
  // Remove resize listener
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  
  // Clear debounce timer
  clearTimeout(debounceTimer);
  debounceTimer = null;
  
  // Stop animation
  stopAnimation();
  
  // Reset state
  pixelLoaderRoot = null;
  pixelLoaderPixelsContainer = null;
  columnCount = 0;
  currentStepIndex = 0;
  animationComplete = false;
  loadingComplete = false;
  onCompleteCallback = null;
}
