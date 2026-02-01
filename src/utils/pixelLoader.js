/**
 * Pixel Loader - Progress-Based Loading Bar
 * 
 * A pixel-style loading bar with 2×2 pixel blocks.
 * Progress is tied to ACTUAL loading progress, not a fixed animation.
 * 
 * Usage:
 *   import { initPixelLoader, setPixelLoaderProgress, onPixelLoaderComplete, destroyPixelLoader } from './utils/pixelLoader.js';
 *   
 *   // Initialize when loader is visible
 *   initPixelLoader('#pixel-loader');
 *   
 *   // Update progress from your loading logic (0 to 1)
 *   setPixelLoaderProgress(0.5);
 *   
 *   // Set callback for when loading completes
 *   onPixelLoaderComplete(() => { hideLoader(); });
 *   
 *   // Mark complete when done
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
let currentProgress = 0; // 0 to 1
let onCompleteCallback = null;
let isComplete = false;

// Constants
const PIXEL_SIZE = 2;   // 2px × 2px
const PIXEL_GAP = 2;    // 2px gap between pixels/columns
const PIXELS_PER_COLUMN = 3; // 3 stacked pixels per column (like filter nav)
const DEBOUNCE_MS = 100;

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
  
  // Render current progress after rebuilding columns
  renderProgress();
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
  
  // Final fallback: use loader width minus padding/border (max is 700px)
  if (availableWidth <= 0) {
    availableWidth = 700 - 20; // loader-width minus padding/border
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
 * Render the progress bar based on current progress (0-1)
 */
function renderProgress() {
  if (!pixelLoaderPixelsContainer || columnCount === 0) return;
  
  // Calculate how many columns should be filled
  const filledColumns = Math.floor(currentProgress * columnCount);
  
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
  
  // Reset progress state
  currentProgress = 0;
  isComplete = false;
  onCompleteCallback = null;
  
  // Force rebuild columns (reset count to force recreation)
  columnCount = 0;
  rebuildPixels();
  
  // Setup resize listener (only once)
  if (!resizeHandler) {
    resizeHandler = handleResize;
    window.addEventListener('resize', resizeHandler);
  }
}

/**
 * Update the loader progress
 * Progress value is from 0 to 1.
 * When progress reaches 1, the completion callback is fired.
 * 
 * @param {number} progress01 - Progress value from 0 to 1
 */
export function setPixelLoaderProgress(progress01) {
  // Clamp to 0-1
  const newProgress = Math.max(0, Math.min(1, progress01));
  
  // Only update if progress increased (prevent going backwards)
  if (newProgress > currentProgress) {
    currentProgress = newProgress;
    renderProgress();
  }
  
  // Check for completion
  if (newProgress >= 1 && !isComplete) {
    isComplete = true;
    
    // Fill all columns
    const columns = pixelLoaderPixelsContainer?.querySelectorAll('.pixel-loader-column');
    if (columns) {
      columns.forEach((column) => {
        column.classList.add('pixel-loader-column--filled');
        column.classList.remove('pixel-loader-column--empty');
      });
    }
    
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
 * Set a callback to be called when loading completes (progress reaches 1)
 * 
 * @param {Function} callback - Function to call when complete
 */
export function onPixelLoaderComplete(callback) {
  onCompleteCallback = callback;
  // If already complete, fire immediately
  if (isComplete && callback) {
    callback();
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
  
  // Reset state
  pixelLoaderRoot = null;
  pixelLoaderPixelsContainer = null;
  columnCount = 0;
  currentProgress = 0;
  isComplete = false;
  onCompleteCallback = null;
}
