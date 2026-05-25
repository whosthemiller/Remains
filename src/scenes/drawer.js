/**
 * Drawer Scene - All drawer logic in one file
 * Handles data fetching, layout generation, camera, rendering, and interactions
 * 
 * ✅ CHECKPOINT: Basic Drawer (git tag: basic-drawer)
 * - Poisson-disk layout with good spacing (DENSITY_FACTOR=2.0, MIN_DIST_MULTIPLIER=1.3)
 * - Smooth continuous zoom (0.15x to 1.5x)
 * - No flicker on zoom-out (viewport hysteresis with keepViewport)
 * - All images preload during loader
 * - Aspect ratio preserved, no stretching
 * Date: 2026-01-22
 */

import { navigate, getCurrentRoute } from '../routing.js';
import { updateNavTitle, isLongUsername } from '../pages/user-albums.js';
import { setPixelLoaderProgress, onPixelLoaderComplete } from '../utils/pixelLoader.js';
import { normalizedWheelDelta } from '../utils/wheelDelta.js';

// Helper functions
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function easeInOutQuad(t) {
  // easeInOutQuad: t<0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// Constants
const TILE_WIDTH = 220;
const TILE_HEIGHT = 165;
const MIN_GAP = 1; // Minimal gap for maximum density
const POISSON_K = 30; // Number of attempts per point in Bridson algorithm
const DENSITY_FACTOR = 2.0; // Factor to increase spacing (more breathing room)
const MIN_DIST_MULTIPLIER = 1.3; // Multiplier for minimum distance between tiles
const EDGE_PAN_RADIUS_FACTOR = 0.48; // Fraction of viewport size (almost half-screen)
const SAFE_ZONE_RADIUS_FACTOR = 0.18; // Fraction of viewport size (center safe zone)
const PAN_SPEED_BASE = 8; // World units per frame (reduced for slower, more controlled edge-pan)
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 1.8;
// Focus collapse parameters
const COLLAPSE_ZOOM_START = MIN_ZOOM + 0.001; // No collapse below this zoom (starts immediately, linear response)
const COLLAPSE_ZOOM_FULL = 0.80; // Full collapse at or above this zoom
const COLLAPSE_K_MIN_TIGHT = 0.12; // Minimum collapse factor for small sets (tight cluster)
const COLLAPSE_K_MIN_LOOSE = 0.35; // Minimum collapse factor for large sets (spread more)
const COLLAPSE_DENSITY_THRESHOLD_LOW = 120; // Below this count: tight collapse allowed
const COLLAPSE_DENSITY_THRESHOLD_HIGH = 600; // Above this count: spread more to prevent overlaps
// Focus layout separation: ensure no overlap — minimum gap between tile edges
const FOCUS_SEP_FEW = 1.08; // Separation multiplier when very few visible — enough gap so tiles never overlap
const FOCUS_SEP_MANY = 1.28; // Separation multiplier when many visible (≥220)
const FOCUS_SEP_COUNT_LOW = 20; // Below this: use FOCUS_SEP_FEW
const FOCUS_SEP_COUNT_HIGH = 220; // At or above this: use FOCUS_SEP_MANY (location filters like China/Taiwan/California stay tight)
const OFFSET_MAX_STEP_BASE = 0.08; // Base max step per frame (as fraction of tile width)
const ZOOM_EPSILON = 0.03; // Activation band for immediate response (big enough to feel immediate)
const ZOOM_STABLE_THRESHOLD = 0.0008; // Zoom change threshold for stability check
const ZOOM_STABLE_FRAMES_REQUIRED = 6; // Frames of stability before solving
const ZOOM_SENSITIVITY = 0.02; // Very low sensitivity - requires multiple scrolls to zoom
const ZOOM_EASE_FACTOR = 0.03; // Much softer, slower smoothing
const ZOOM_EASE_FACTOR_INITIAL = 0.12; // Snappier when zoom is low (avoids "stuck" feel right after splash scroll)
const ZOOM_INITIAL_RANGE = 0.25; // Use snappier ease when camera.zoom below this
const ZOOM_DEAD_ZONE = 0.002; // Snap when very close to target
const MIN_ZOOM_TILES = 6;
const CAMERA_BOUNDS_PADDING = 60; // World units (modest padding)
const FILTERED_MIN_ZOOM_FALLBACK = 0.55; // When filter on but bounds not ready yet - avoid showing full world
const FILTERED_BOUNDS_SHRINK = 0.20; // Slight tighten (many photos), leave margin so tiles don't clip
const FILTERED_BOUNDS_SHRINK_SMALL = 0.26; // Tighter for few photos but keep margin so tiles don't clip (26% each side)
const FILTERED_SMALL_CLUSTER_COUNT = 35; // Below this many visible tiles, use SHRINK_SMALL
const FILTERED_BOUNDS_PADDING = 115; // ~half tile: viewport must not clip tiles at screen edges when zoomed in
const MAX_CONCURRENT_LOADS = 8;
const PRELOAD_MAX_CONCURRENT = 20; // Higher concurrency during initial preload (increased for faster loading)
const MAX_CACHE_SIZE = 2000; // Increased to prevent flicker
const LOAD_BUFFER_BASE = 220; // Base load buffer (scales with zoom)
const KEEP_BUFFER_BASE = 520; // Base keep buffer (scales with zoom, larger than load)
const PRELOAD_TARGET = 300; // Target number of images to preload (increased for faster initial display)
const MIN_READY = 120; // Minimum images loaded before hiding loader
const PRELOAD_TIMEOUT_MS = 2000; // Max time to show loader (increased to allow more images to load)
const VISIBILITY_UPDATE_THROTTLE = 3; // Only update visibility every N frames

/**
 * Camera - handles pan/zoom and coordinate transformations
 */
class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.zoom = 1.0;
    this.viewportWidth = 1;
    this.viewportHeight = 1;
  }

  setViewport(width, height) {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  screenToWorld(screenX, screenY) {
    const worldX = (screenX - this.viewportWidth / 2) / this.zoom + this.x;
    const worldY = (screenY - this.viewportHeight / 2) / this.zoom + this.y;
    return { x: worldX, y: worldY };
  }

  pan(deltaX, deltaY) {
    this.x += deltaX;
    this.y += deltaY;
  }

  zoomAt(screenX, screenY, zoomDelta) {
    const oldZoom = this.zoom;
    const newZoom = Math.max(0.1, Math.min(10, this.zoom * zoomDelta));
    
    if (oldZoom === newZoom) return;
    
    const worldPoint = this.screenToWorld(screenX, screenY);
    this.zoom = newZoom;
    const newWorldPoint = this.screenToWorld(screenX, screenY);
    
    this.x += worldPoint.x - newWorldPoint.x;
    this.y += worldPoint.y - newWorldPoint.y;
  }

  getVisibleBounds() {
    const halfWidth = (this.viewportWidth / 2) / this.zoom;
    const halfHeight = (this.viewportHeight / 2) / this.zoom;
    
    return {
      left: this.x - halfWidth,
      right: this.x + halfWidth,
      top: this.y - halfHeight,
      bottom: this.y + halfHeight,
    };
  }

  applyTransform(ctx) {
    ctx.save();
    ctx.translate(this.viewportWidth / 2, this.viewportHeight / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, -this.y);
  }

  restoreTransform(ctx) {
    ctx.restore();
  }
}

/**
 * Check if two rectangles overlap (with gap)
 */
function rectanglesOverlap(rect1, rect2, gap) {
  return (
    rect1.x - gap < rect2.x + rect2.w + gap &&
    rect1.x + rect1.w + gap > rect2.x - gap &&
    rect1.y - gap < rect2.y + rect2.h + gap &&
    rect1.y + rect1.h + gap > rect2.y - gap
  );
}

/**
 * Check if a rectangle overlaps with any existing rectangles
 */
function overlapsAny(rect, existingRects, gap) {
  for (const existing of existingRects) {
    if (rectanglesOverlap(rect, existing, gap)) {
      return true;
    }
  }
  return false;
}

/**
 * Bridson's Poisson-disk sampling algorithm
 * Generates evenly distributed points with minimum distance constraint
 */
function poissonDiskSampling(width, height, minDist, k = POISSON_K) {
  const points = [];
  const activeList = [];
  
  // Grid acceleration structure
  const cellSize = minDist / Math.sqrt(2);
  const cols = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const grid = Array(rows * cols).fill(null);
  
  // Helper: get grid index
  const getGridIndex = (x, y) => {
    const col = Math.floor(x / cellSize);
    const row = Math.floor(y / cellSize);
    return row * cols + col;
  };
  
  // Helper: check if point is valid (far enough from all existing points)
  const isValidPoint = (px, py) => {
    if (px < 0 || px >= width || py < 0 || py >= height) {
      return false;
    }
    
    const col = Math.floor(px / cellSize);
    const row = Math.floor(py / cellSize);
    
    // Check neighboring cells
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
        
        const idx = r * cols + c;
        const neighbor = grid[idx];
        if (neighbor) {
          const dx = px - neighbor.x;
          const dy = py - neighbor.y;
          if (dx * dx + dy * dy < minDist * minDist) {
            return false;
          }
        }
      }
    }
    return true;
  };
  
  // Add first point randomly
  const firstX = Math.random() * width;
  const firstY = Math.random() * height;
  points.push({ x: firstX, y: firstY });
  activeList.push(0);
  grid[getGridIndex(firstX, firstY)] = { x: firstX, y: firstY };
  
  // Generate more points
  while (activeList.length > 0) {
    const activeIdx = Math.floor(Math.random() * activeList.length);
    const pointIdx = activeList[activeIdx];
    const point = points[pointIdx];
    let found = false;
    
    // Try k random points around current point
    for (let i = 0; i < k; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = minDist + Math.random() * minDist; // Between minDist and 2*minDist
      const newX = point.x + Math.cos(angle) * radius;
      const newY = point.y + Math.sin(angle) * radius;
      
      if (isValidPoint(newX, newY)) {
        points.push({ x: newX, y: newY });
        const newIdx = points.length - 1;
        activeList.push(newIdx);
        grid[getGridIndex(newX, newY)] = { x: newX, y: newY };
        found = true;
        break;
      }
    }
    
    // If no valid point found, remove from active list
    if (!found) {
      activeList.splice(activeIdx, 1);
    }
  }
  
  return points;
}

/**
 * Generate layout using Poisson-disk sampling (blue-noise)
 */
function generateLayout(photos) {
  const N = photos.length;
  if (N === 0) return [];
  
  // Calculate minimum distance between tile centers (with multiplier for more spacing)
  const maxTileDim = Math.max(TILE_WIDTH, TILE_HEIGHT);
  const minDist = (maxTileDim + MIN_GAP) * MIN_DIST_MULTIPLIER;
  
  // Calculate placement rectangle size (with density factor for more breathing room)
  const areaPerPoint = (minDist * minDist);
  const totalArea = N * areaPerPoint * DENSITY_FACTOR;
  const aspectRatio = 1.2; // Mild aspect ratio
  let rectHeight = Math.sqrt(totalArea / aspectRatio);
  let rectWidth = rectHeight * aspectRatio;
  
  // Generate Poisson-disk points
  let points = [];
  let attempts = 0;
  const maxAttempts = 5;
  
  while (points.length < N && attempts < maxAttempts) {
    points = poissonDiskSampling(rectWidth, rectHeight, minDist, POISSON_K);
    
    if (points.length < N) {
      // Increase rectangle size and try again
      rectWidth *= 1.12;
      rectHeight *= 1.12;
      attempts++;
    }
  }
  
  // If still not enough points, take what we have (shouldn't happen often)
  if (points.length < N) {
    console.warn(`Poisson sampling generated ${points.length} points, need ${N}`);
  }
  
  // Shuffle points and take first N
  for (let i = points.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [points[i], points[j]] = [points[j], points[i]];
  }
  points = points.slice(0, N);
  
  // Convert points to tiles (center tiles on points)
  const tiles = [];
  for (let i = 0; i < N; i++) {
    const point = points[i];
    const photo = photos[i];
    
    tiles.push({
      id: photo.id,
      x: point.x - TILE_WIDTH / 2,
      y: point.y - TILE_HEIGHT / 2,
      w: TILE_WIDTH,
      h: TILE_HEIGHT,
      src: photo.src,
    });
  }
  
  return tiles;
}

// US States list (same as in main.js - duplicated for drawer.js)
const US_STATES_DRAWER = {
  'alabama': 'Alabama', 'al': 'Alabama', 'alaska': 'Alaska', 'ak': 'Alaska',
  'arizona': 'Arizona', 'az': 'Arizona', 'arkansas': 'Arkansas', 'ar': 'Arkansas',
  'california': 'California', 'ca': 'California', 'colorado': 'Colorado', 'co': 'Colorado',
  'connecticut': 'Connecticut', 'ct': 'Connecticut', 'delaware': 'Delaware', 'de': 'Delaware',
  'florida': 'Florida', 'fl': 'Florida', 'georgia': 'Georgia', 'ga': 'Georgia',
  'hawaii': 'Hawaii', 'hi': 'Hawaii', 'idaho': 'Idaho', 'id': 'Idaho',
  'illinois': 'Illinois', 'il': 'Illinois', 'indiana': 'Indiana', 'in': 'Indiana',
  'iowa': 'Iowa', 'ia': 'Iowa', 'kansas': 'Kansas', 'ks': 'Kansas',
  'kentucky': 'Kentucky', 'ky': 'Kentucky', 'louisiana': 'Louisiana', 'la': 'Louisiana',
  'maine': 'Maine', 'me': 'Maine', 'maryland': 'Maryland', 'md': 'Maryland',
  'massachusetts': 'Massachusetts', 'ma': 'Massachusetts', 'michigan': 'Michigan', 'mi': 'Michigan',
  'minnesota': 'Minnesota', 'mn': 'Minnesota', 'mississippi': 'Mississippi', 'ms': 'Mississippi',
  'missouri': 'Missouri', 'mo': 'Missouri', 'montana': 'Montana', 'mt': 'Montana',
  'nebraska': 'Nebraska', 'ne': 'Nebraska', 'nevada': 'Nevada', 'nv': 'Nevada',
  'new hampshire': 'New Hampshire', 'nh': 'New Hampshire', 'new jersey': 'New Jersey', 'nj': 'New Jersey',
  'new mexico': 'New Mexico', 'nm': 'New Mexico', 'new york': 'New York', 'ny': 'New York',
  'north carolina': 'North Carolina', 'nc': 'North Carolina', 'north dakota': 'North Dakota', 'nd': 'North Dakota',
  'ohio': 'Ohio', 'oh': 'Ohio', 'oklahoma': 'Oklahoma', 'ok': 'Oklahoma',
  'oregon': 'Oregon', 'or': 'Oregon', 'pennsylvania': 'Pennsylvania', 'pa': 'Pennsylvania',
  'rhode island': 'Rhode Island', 'ri': 'Rhode Island', 'south carolina': 'South Carolina', 'sc': 'South Carolina',
  'south dakota': 'South Dakota', 'sd': 'South Dakota', 'tennessee': 'Tennessee', 'tn': 'Tennessee',
  'texas': 'Texas', 'tx': 'Texas', 'utah': 'Utah', 'ut': 'Utah',
  'vermont': 'Vermont', 'vt': 'Vermont', 'virginia': 'Virginia', 'va': 'Virginia',
  'washington': 'Washington', 'wa': 'Washington', 'west virginia': 'West Virginia', 'wv': 'West Virginia',
  'wisconsin': 'Wisconsin', 'wi': 'Wisconsin', 'wyoming': 'Wyoming', 'wy': 'Wyoming',
  'district of columbia': 'District of Columbia', 'dc': 'District of Columbia'
};

const COUNTRIES_DRAWER = {
  'afghanistan': 'Afghanistan', 'af': 'Afghanistan', 'albania': 'Albania', 'al': 'Albania',
  'algeria': 'Algeria', 'dz': 'Algeria', 'argentina': 'Argentina', 'ar': 'Argentina',
  'australia': 'Australia', 'au': 'Australia', 'austria': 'Austria', 'at': 'Austria',
  'bangladesh': 'Bangladesh', 'bd': 'Bangladesh', 'belgium': 'Belgium', 'be': 'Belgium',
  'brazil': 'Brazil', 'br': 'Brazil', 'bulgaria': 'Bulgaria', 'bg': 'Bulgaria',
  'canada': 'Canada', 'ca': 'Canada', 'chile': 'Chile', 'cl': 'Chile',
  'china': 'China', 'cn': 'China', 'colombia': 'Colombia', 'co': 'Colombia',
  'croatia': 'Croatia', 'hr': 'Croatia', 'czech republic': 'Czech Republic', 'cz': 'Czech Republic',
  'denmark': 'Denmark', 'dk': 'Denmark', 'egypt': 'Egypt', 'eg': 'Egypt',
  'finland': 'Finland', 'fi': 'Finland', 'france': 'France', 'fr': 'France',
  'germany': 'Germany', 'de': 'Germany', 'greece': 'Greece', 'gr': 'Greece',
  'hungary': 'Hungary', 'hu': 'Hungary', 'iceland': 'Iceland', 'is': 'Iceland',
  'india': 'India', 'in': 'India', 'indonesia': 'Indonesia', 'id': 'Indonesia',
  'iran': 'Iran', 'ir': 'Iran', 'iraq': 'Iraq', 'iq': 'Iraq',
  'ireland': 'Ireland', 'ie': 'Ireland', 'israel': 'Israel', 'il': 'Israel',
  'italy': 'Italy', 'it': 'Italy', 'japan': 'Japan', 'jp': 'Japan',
  'kenya': 'Kenya', 'ke': 'Kenya', 'mexico': 'Mexico', 'mx': 'Mexico',
  'morocco': 'Morocco', 'ma': 'Morocco', 'netherlands': 'Netherlands', 'nl': 'Netherlands',
  'new zealand': 'New Zealand', 'nz': 'New Zealand', 'nigeria': 'Nigeria', 'ng': 'Nigeria',
  'norway': 'Norway', 'no': 'Norway', 'pakistan': 'Pakistan', 'pk': 'Pakistan',
  'peru': 'Peru', 'pe': 'Peru', 'philippines': 'Philippines', 'ph': 'Philippines',
  'poland': 'Poland', 'pl': 'Poland', 'portugal': 'Portugal', 'pt': 'Portugal',
  'romania': 'Romania', 'ro': 'Romania', 'russia': 'Russia', 'ru': 'Russia',
  'saudi arabia': 'Saudi Arabia', 'sa': 'Saudi Arabia', 'singapore': 'Singapore', 'sg': 'Singapore',
  'south africa': 'South Africa', 'za': 'South Africa', 'south korea': 'South Korea', 'kr': 'South Korea',
  'spain': 'Spain', 'es': 'Spain', 'sweden': 'Sweden', 'se': 'Sweden',
  'switzerland': 'Switzerland', 'ch': 'Switzerland', 'thailand': 'Thailand', 'th': 'Thailand',
  'turkey': 'Turkey', 'tr': 'Turkey', 'ukraine': 'Ukraine', 'ua': 'Ukraine',
  'united kingdom': 'United Kingdom', 'uk': 'United Kingdom', 'gb': 'United Kingdom',
  'vietnam': 'Vietnam', 'vn': 'Vietnam'
};

// Location map cache (loaded asynchronously)
// Location map is no longer used - filtering now uses location.audit.json directly
let locationMapDrawer = null;

// Map tag to geo label (same logic as in main.js)
function mapTagToGeoLabelDrawer(tag) {
  if (!tag) return null;
  
  const normalized = tag.toLowerCase().trim();
  
  // Skip generic USA tags
  if (normalized === 'usa' || normalized === 'united states' || normalized === 'us') {
    return null;
  }
  
  // Check US states first
  if (US_STATES_DRAWER[normalized]) {
    return US_STATES_DRAWER[normalized];
  }
  
  // Check countries
  if (COUNTRIES_DRAWER[normalized]) {
    return COUNTRIES_DRAWER[normalized];
  }
  
  // Check location map
  if (locationMapDrawer && locationMapDrawer[normalized]) {
    return locationMapDrawer[normalized];
  }
  
  return null;
}

/**
 * Check if a photo should be visible based on active filters (Location AND Year)
 * Uses locationToPhotoIds Map and yearToPhotoIds Map for O(1) lookups
 */
/**
 * Check if a photo matches any value in a set (OR logic within category)
 */
function matchesAnySetValue(valuesSet, photoId, valueToPhotoIdsMap, unknownPhotoIds) {
  if (!valuesSet || valuesSet.size === 0) return true; // Empty set = no restriction
  if (!valueToPhotoIdsMap) {
    return true; // Data not loaded = show all
  }
  
  // Check each value in the set (OR logic)
  let foundMatch = false;
  for (const value of valuesSet) {
    if (value === 'Unknown') {
      if (unknownPhotoIds && unknownPhotoIds.has(photoId)) {
        foundMatch = true;
        break; // Matches Unknown
      }
    } else {
      const photoIds = valueToPhotoIdsMap.get(value);
      if (photoIds && photoIds.has(photoId)) {
        foundMatch = true;
        break; // Matches this value
      }
    }
  }
  return foundMatch;
}

function isPhotoVisible(photo, activeLocations, activeYears, activeKeywords, locationToPhotoIds, allLocatedPhotoIds, unknownPhotoIds, yearToPhotoIds, unknownYearIds, keywordToPhotoIds, allKeywordPhotoIds, unknownKeywordIds) {
  if (!photo || !photo.id) return false;
  
  // Check Location filter (OR within set, empty set = pass)
  const passesLocation = matchesAnySetValue(
    activeLocations,
    photo.id,
    locationToPhotoIds,
    unknownPhotoIds
  );
  
  // Check Year filter (OR within set, empty set = pass)
  const passesYear = matchesAnySetValue(
    activeYears,
    photo.id,
    yearToPhotoIds,
    unknownYearIds
  );
  
  // Check Keyword filter (OR within set, empty set = pass)
  const passesKeyword = matchesAnySetValue(
    activeKeywords,
    photo.id,
    keywordToPhotoIds,
    unknownKeywordIds
  );
  
  // Photo is visible only if it passes ALL non-empty sets (AND across categories)
  const result = passesLocation && passesYear && passesKeyword;
  return result;
}

import { buildImageUrl, encodePathSegments } from '../utils/paths.js';

/**
 * Drawer Scene Class
 */
export class DrawerScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = new Camera();
    // Force at least one render after view switches.
    // Prevents early-exit from skipping the first visible paint when nothing "changed".
    this.forceRenderOnce = false;
    
    this.tiles = [];
    this.photos = []; // Store photo data for filtering
    this.photosMap = new Map(); // Map<id, photo> for O(1) lookup
    this.width = 0;
    this.height = 0;
    this.mouseX = 0;
    this.mouseY = 0;
    this.isPanning = false;
    this.mouseOverCanvas = false;
    this.animationFrameId = null;
    
    // Smooth zoom state
    this.targetZoom = 1.0;
    this.zoomAnchorScreenX = 0;
    this.zoomAnchorScreenY = 0;
    
    // Zooming state for continuous updates
    this.isZooming = false;
    this.zoomingUntil = 0;
    this.zoomIdleMs = 120; // Keep animating for 120ms after last wheel delta
    
    // Layout bounds cache
    this.layoutBounds = null;
    this.filteredLayoutBounds = null; // When filters active: bounds of visible (filtered) tiles for pan clamping
    
    // Image loading state
    this.imageCache = new Map(); // Map<id, { img: Image, lastUsed: number }>
    this.loadingSet = new Set(); // Set<id> - currently loading
    
    // Photo sources mapping: photoId -> { thumb: string, hq: string, w?: number, h?: number }
    this.photoSourcesById = new Map();
    
    // IntersectionObserver for Album view HQ loading
    this.albumImageObserver = null;
    this.albumPrefetchTimers = new Map(); // Map<img, timerId> - for prefetch scheduling
    
    // Focus mode precomputed layout (computed once when filters change)
    this.focusPos = new Map(); // Map<id, {x, y}> - precomputed non-overlapping focus layout (DEPRECATED: use focusAnchor + offsets)
    this.focusOffsets = new Map(); // Map<id, {ox, oy}> - focus positions relative to anchor (world space, camera-independent)
    this.focusAnchorX = null; // World X coordinate of anchor point when focus layout was computed
    this.focusAnchorY = null; // World Y coordinate of anchor point when focus layout was computed
    this.focusLayoutCameraCenter = null; // {x, y} - camera center when focus layout was computed (for reference only)
    this.lastVisibleSetHash = null; // Hash of visible set to detect changes
    this.lastZoomLevel = 1.0; // Track zoom changes
    this.lastFilterState = null; // Track filter changes (string: "location:year" or null)
    this.lastFilterActive = false; // Track if filters were active last frame
    this.lastActiveLocations = null; // Cached Set for comparison
    this.lastActiveYears = null; // Cached Set for comparison
    this.lastActiveKeywords = null; // Cached Set for comparison
    this.lastFilterSizes = null; // Cached sizes for fast comparison
    this.lastVisibleCount = 0; // Cached visible count
    this.visibleSetHash = null; // Cached hash of visible set
    this.panningUntil = 0; // Timestamp when panning should be considered stopped
    this.panningIdleMs = 120; // Panning considered active for 120ms after movement stops
    this.panningCollapseTargetX = null; // Frozen collapse target while user is panning (prevents jump)
    this.panningCollapseTargetY = null;
    
    // Mouse position tracking for collapse target
    this.lastMouseWorldX = undefined;
    this.lastMouseWorldY = undefined;
    this.lastZoomedInWithCenterText = false; // Track zoom state for layout recomputation
    this.zoomStateChangeFrames = 0; // Count frames since zoom state changed (for hysteresis)
    this.ZOOM_STATE_STABLE_FRAMES = 5; // Require 5 stable frames before recomputing layout (increased for smoother transitions)
    this.ZOOM_THRESHOLD_ENTER = 0.52; // Enter center text mode at this zoom (higher threshold)
    this.ZOOM_THRESHOLD_EXIT = 0.48; // Exit center text mode at this zoom (lower threshold) - hysteresis to prevent flickering
    this.frozenCollapseTargetX = null; // Frozen collapse target during zoom (set when zoom starts)
    this.frozenCollapseTargetY = null; // Frozen collapse target during zoom (set when zoom starts)
    this.wasZooming = false; // Track previous zoom state to detect when zoom starts
    this.collapseZoomState = 'out'; // 'out' or 'in' - two-step zoom in collapse mode
    this.COLLAPSE_ZOOM_OUT = MIN_ZOOM; // Zoom out level in collapse mode
    this.COLLAPSE_ZOOM_IN = MAX_ZOOM; // Zoom in level in collapse mode — same max as normal drawer (1.8)
    this.zoomVelocity = 0; // Velocity for smooth zoom transitions in collapse mode
    
    // Center photo highlighting
    this.centerTileId = null; // ID of the photo currently at viewport center
    this.centerTileHysteresis = 10; // Pixels: only switch center tile if new candidate is this much closer
    this.centerDateEl = null; // DOM element for center photo date label
    
    // Dynamic zoom baseline for focus collapse
    this.focusBaseZoom = null; // Zoom level when filter was activated (captured on filter ON)
    this.zoomStart = null; // Computed from focusBaseZoom
    this.zoomFull = null; // Computed from focusBaseZoom
    
    // Velocity-based focus progress (Torque-style movement)
    this.prevZoomLevel = this.camera.zoom; // Previous zoom level for delta calculation
    this.focusProgress = 0; // Current progress (0 = no focus, 1 = full focus) - replaces focusAlpha
    this.focusVel = 0; // Velocity of focus progress
    // Velocity parameters (much reduced to prevent jumps in positions)
    this.focusImpulse = 0.4; // How much zoomDelta pushes velocity (reduced from 1.8)
    this.focusFriction = 0.88; // Friction damping (0..1, lower = more damping) (increased from 0.82)
    this.focusSpring = 0.08; // Spring toward target (for stability) (reduced from 0.25)
    this.focusMaxVel = 0.06; // Maximum velocity clamp (reduced from 0.4 to prevent large jumps)
    this.focusRange = 0.75; // Range from baseZoom to full collapse (for normalization)
    // Smoothing for focusProgress to prevent jumps in final positions
    this.smoothedFocusProgress = 0; // Smoothed version of focusProgress
    this.focusProgressSmoothing = 0.35; // Smoothing factor (increased for stronger smoothing)
    
    // Legacy: keep focusAlpha for compatibility during transition (will be removed)
    this.focusAlpha = 0;
    this.focusAlphaTarget = 0;
    
    // Zoom stability tracking for solver
    this.zoomStableFrames = 0; // Consecutive frames with stable zoom
    this.lastZoomLevelForStability = null; // Last zoom level for stability check
    this.filterJustToggledOn = false; // Flag when filter is toggled on
    
    // Debug logging state
    this.lastDebugLog = Date.now(); // Last debug log timestamp
    this.lastTValue = 0; // Last t value for change detection
    this.loadQueue = []; // Array of { id, distance } - prioritized queue
    this.frameCount = 0;
    this.lastCameraState = { x: 0, y: 0, zoom: 0 };
    
    // Filter change tracking for faster image loading
    this.filterChangeTime = 0; // Timestamp when filters last changed
    this.FILTER_CHANGE_BOOST_MS = 8000; // Use higher concurrency for 8 seconds after filter change
    this.filterChangeBoostActive = false; // Track if boost is currently active
    
    
    // Preload state
    this.loaderElement = document.getElementById('loader');
    this.isPreloading = false;
    this.preloadStartTime = 0;
    this.preloadTargets = []; // Array of ids to preload
    
    // Filtering state - Multi-select filters (Sets for AND/OR logic)
    this.activeLocations = new Set(); // Multiple locations can be active
    this.activeYears = new Set(); // Multiple years can be active
    this.activeKeywords = new Set(); // Multiple keywords can be active
    
    // Filter data structures
    this.locationToPhotoIds = null; // Map<label, Set<photoId>> - set by setupLocationFilter
    this.allLocatedPhotoIds = null; // Set<photoId> - set by setupLocationFilter
    this.unknownPhotoIds = null; // Set<photoId> - set by setupLocationFilter
    this.yearToPhotoIds = null; // Map<year, Set<photoId>> - built during initialize
    this.unknownYearIds = null; // Set<photoId> - built during initialize
    this.keywordToPhotoIds = null; // Map<keyword, Set<photoId>> - loaded from keywords.filters.json
    this.allKeywordPhotoIds = null; // Set<photoId> - all photos in any keyword
    this.unknownKeywordIds = null; // Set<photoId> - photos not in any keyword
    
    // Album View state
    this.viewMode = 'drawer'; // 'drawer' | 'album'
    this.selectedPhotoId = null; // ID of photo selected for album view
    this.albumEnterT = 0; // Transition progress 0 -> 1 (350-500ms)
    this.albumEnterStartTime = 0; // Timestamp when album transition started
    this.albumEnterDuration = 400; // Transition duration in ms
    
    // Album transition animation state
    this.transition = {
      active: false,
      startTime: 0,
      duration: 450,
      startRect: null, // { x, y, w, h } in screen space
      endRect: null, // { x, y, w, h } in screen space
      selectedId: null
    };
    
    // Previous state before entering album mode (for restoration)
    this.prevState = null;
    this.activeTileId = null; // ID of tile that was clicked to enter album
    this.enterTileRect = null; // Screen rect of tile when entering album
    this.fromUserAlbums = false; // Track if we entered from user albums page
    this.fromIndex = false; // Track if we entered from index page (exit returns to index)
    this.userAlbumsUsername = null; // Store username for navigation back
    this.navigateToUserAfterExit = null; // Store username to navigate to after exit transition completes
    
    // Close button element
    this.closeButtonEl = null;
    
    // Overlay image for enter/exit animations
    this.overlayImg = null;
    this.exitTransitionActive = false;
    this.exitTransitionStartTime = 0;
    this.exitTransitionDuration = 550; // ms
    this.exitHideOverlayNextFrame = false; // hide overlay on first drawer frame after exit (no hole)
    // Fade-in when entering drawer from users page (start on first render frame)
    this.enterFromUsersFadePending = false;
    this.enterFromUsersFadeStartTime = 0;
    this.enterFromUsersFadeDuration = 300; // ms
    this.transitionJustCompleted = false; // flag to skip album early return on transition completion frame
    
    // Album meta UI overlay
    this.albumMetaEl = null;
    this.albumMetaDetailsEl = null; // Album metadata details (bottom-left)
    this.albumData = null; // Cached album.json data
    
    // Filtered album state
    this.isFilteredAlbum = false; // True if current album is a filtered album
    this.filteredPhotos = []; // Array of filtered photos when filters are active
    
    // Album stacking state
    this.albumImageWrapper = null; // Wrapper for main image + stack layer
    this.albumMainImage = null; // Main image element (DOM)
    this.albumStackLayer = null; // Container for stacked images
    this.stackIndex = 0; // Current number of stacked images (0 = only main visible)
    this.albumPhotos = []; // Array of photo objects from album.json (ordered)
    this.albumPhotoIdToMapKey = null; // Map<flickrIdString, photosMap key> built when loading album — O(1) lookup instead of O(photosMap.size) per wheel
    this.albumMapKeyToIndex = null;   // Map<photosMap key, albumIndex> — O(1) in updateStackWhenMainChanges instead of 275×277×photosMap
    this.mainPhotoIndex = -1; // Index of main photo in albumPhotos array
    this.initialMainPhotoIndex = -1; // Index of the photo that was clicked (the zero point when entering album)
    this.stackOffsets = new Map(); // Map<photoId, {dx, dy, rot}> - deterministic offsets
    this.albumScrollDelta = 0; // Direct scroll value (no lerp, no velocity, no inertia) - maps 1:1 to wheel delta
    this.ALBUM_SCROLL_STEP = 80; // Scroll delta per image (pixels) — lower = more responsive to wheel
    this.currentImageDisplayWidth = 0; // Current displayed image width (for offset calculations)
    this.currentImageDisplayHeight = 0; // Current displayed image height (for offset calculations)
    this.albumStackImages = new Map(); // Map<photoId, HTMLElement> - all pre-rendered stack images
    this.albumStackByIndex = new Map(); // Map<stackIndex, HTMLElement> - for fast opacity updates (only iterate active window)
    this.albumScrollHintEl = null;
    this.albumScrollHintFaded = false;
    
    // Nav bar mechanical closing animation (all nav bars together)
    this.topNavEl = null;
    this.centerNavEl = null;
    this.filtersWrapEl = null;
    this.totalNavHeight = 0; // Combined height of all nav bars
    this.navCloseAnimations = []; // Array of animations for all nav bars
    this.navOpenAnimations = []; // Array of animations for all nav bars
    
    // Focus collapse state
    this.isReleasingFilters = false; // True during release animation
    this.releaseStartTime = 0; // Timestamp when release started
    this.releaseDuration = 300; // Release animation duration (ms)
    this.clearLocationAfterRelease = false; // Flag to clear location after release
    this.clearYearAfterRelease = false; // Flag to clear year after release
    this.clearKeywordAfterRelease = false; // Flag to clear keyword after release
    this.shouldSyncFocusAlpha = false; // Flag to sync focus alpha after filter switch
    this.releaseStartCollapseK = 1.0; // Collapse factor at start of release
    
    // Debug counters for rendering
    this.debugCounters = {
      totalTiles: 0,
      drawnTiles: 0,
      skippedByFilter: 0,
      missingPhotoLookups: 0,
    };
    this.lastDebugLog = Date.now();
    this.lastOverlapDebug = null;
    
    this.setupResize();
    this.setupEventHandlers();
    
    // Initialize UI alpha CSS variable
    document.documentElement.style.setProperty('--uiAlpha', '1');
  }

  /**
   * Setup resize handler with correct DPR handling
   */
  setupResize() {
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
      
      // Reset transform and apply DPR (prevents accumulation)
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      
      this.width = rect.width;
      this.height = rect.height;
      
      // Initialize mouse to center on first resize to avoid immediate edge-pan
      if (this.mouseX === 0 && this.mouseY === 0) {
        this.mouseX = this.width / 2;
        this.mouseY = this.height / 2;
      }
      
      this.camera.setViewport(this.width, this.height);
      
      // Invalidate layout bounds cache so dynamic minimum zoom recalculates on resize
      this.layoutBounds = null;
      
      // Re-measure nav height on resize
      this.measureNavHeight();
    };
    
    window.addEventListener('resize', resize);
    resize(); // Initial resize
    
    // Setup resize listener for album meta UI wrapping (debounced)
    this.resizeDebounceTimer = null;
    const handleAlbumMetaResize = () => {
      if (this.resizeDebounceTimer) {
        clearTimeout(this.resizeDebounceTimer);
      }
      this.resizeDebounceTimer = setTimeout(() => {
        // Re-apply wrapping if album view is active
        if (this.viewMode === 'album' && this.selectedPhotoId && this.albumMetaEl) {
          const albumNameEl = this.albumMetaEl.querySelector('.album-name');
          if (albumNameEl) {
            const photo = this.photosMap.get(this.selectedPhotoId);
            if (photo) {
              const albumName = photo.meta?.album?.title || photo.albumKey || 'Untitled Album';
              // Reset to original text first, then re-apply wrapping
              albumNameEl.textContent = albumName;
              this.applyNoOrphanWrap(albumNameEl, albumName, 700);
            }
          }
          // Re-size and re-center album wrapper on resize so it stays centered
          this.updateMainImage(this.selectedPhotoId);
        }
        
        // Update album metadata details position on resize
        if (this.viewMode === 'album' && this.albumMetaDetailsEl && this.albumMetaDetailsEl.style.display !== 'none') {
          this.updateAlbumMetaDetailsPosition();
        }
      }, 150); // 150ms debounce
    };
    window.addEventListener('resize', handleAlbumMetaResize);
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    // Mouse enter canvas
    this.canvas.addEventListener('mouseenter', () => {
      this.mouseOverCanvas = true;
    });
    
    // Mouse move for edge-pan
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      // Only update if mouse is actually within canvas bounds
      if (x >= 0 && x <= this.width && y >= 0 && y <= this.height) {
        this.mouseX = x;
        this.mouseY = y;
        this.mouseOverCanvas = true;
      } else {
        // Mouse is outside canvas bounds
        this.mouseOverCanvas = false;
        this.isPanning = false;
      }
    });
    
    // Mouse leave to stop panning
    this.canvas.addEventListener('mouseleave', () => {
      this.mouseOverCanvas = false;
      this.isPanning = false;
    });
    
    // Also track mouse move on document to catch when mouse moves to UI elements
    document.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      // Check if mouse is outside canvas bounds
      if (x < 0 || x > this.width || y < 0 || y > this.height) {
        this.mouseOverCanvas = false;
        this.isPanning = false;
      }
    });
    
    // Wheel for zoom (continuous, no steps)
    // Wheel handler for drawer mode (zoom)
    // Wheel handler for drawer mode (zoom) and album mode (stacking)
    // Add global listener for album mode since canvas might not capture all events
    window.addEventListener('wheel', (e) => {
      // Only handle in album mode
      if (this.viewMode === 'album' && !this.transition.active && !this.exitTransitionActive) {
        this.handleAlbumWheel(e);
        return;
      }
    }, { passive: false });
    
    this.canvas.addEventListener('wheel', (e) => {
      // In album mode, handle wheel separately
      if (this.viewMode === 'album' && !this.transition.active && !this.exitTransitionActive) {
        this.handleAlbumWheel(e);
        return;
      }
      // Disable zoom in album mode, during transition, or during exit transition
      if (this.viewMode === 'album' || this.transition.active || this.exitTransitionActive) return;
      if (window.splashVisible) return;

      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      // Store zoom anchor (cursor position)
      this.zoomAnchorScreenX = x;
      this.zoomAnchorScreenY = y;
      
      // Check if collapse mode is active (filters active)
      const isCollapseMode = this.filtersActive();
      
      if (isCollapseMode) {
        // Two-step zoom in collapse mode: toggle between zoom out and zoom in
        const zoomOut = this.COLLAPSE_ZOOM_OUT;
        const zoomIn = this.COLLAPSE_ZOOM_IN;
        
        // Determine current state (which one we're closer to)
        const currentZoom = this.camera.zoom;
        const distToOut = Math.abs(currentZoom - zoomOut);
        const distToIn = Math.abs(currentZoom - zoomIn);
        const currentState = distToOut < distToIn ? 'out' : 'in';
        
        // Toggle to the other state based on scroll direction (scroll down = zoom in, matches splash)
        const dy = normalizedWheelDelta(e);
        if (dy > 0) {
          this.collapseZoomState = 'in';
          this.targetZoom = zoomIn;
        } else if (dy < 0) {
          this.collapseZoomState = 'out';
          this.targetZoom = zoomOut;
        }
      } else {
        const dy = normalizedWheelDelta(e);
        const delta = dy > 0 ? 1 + ZOOM_SENSITIVITY : 1 - ZOOM_SENSITIVITY;
        this.targetZoom *= delta;
        
        // Clamp to min/max (dynamic minimum based on content bounds)
        this.clampTargetZoom();
      }
      
      // Set zooming state for continuous updates
      this.isZooming = true;
      this.zoomingUntil = performance.now() + this.zoomIdleMs;
      
      // Ensure render loop is running
      if (!this.animationFrameId) {
        this.startRenderLoop();
      }
    });
    
    // Click handler for photo tiles
    this.canvas.addEventListener('click', (e) => {
      // Block clicks when splash overlay is visible (landing page)
      if (window.splashVisible) {
        return;
      }
      
      // Handle clicks in album mode - exit album view
      if (this.viewMode === 'album' && !this.transition.active && !this.exitTransitionActive) {
        e.stopPropagation();
        this.exitAlbumMode();
        return;
      }
      
      // Only handle clicks in drawer mode (not during transition, exit transition, or in album mode)
      if (this.viewMode !== 'drawer' || this.transition.active || this.exitTransitionActive) {
        return;
      }
      
      // Stop event propagation to prevent document click handler from firing
      e.stopPropagation();
      
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      // Convert screen coordinates to world coordinates
      const worldPoint = this.camera.screenToWorld(x, y);
      
      // Find clicked tile
      const clickedTile = this.findTileAtPoint(worldPoint.x, worldPoint.y);
      
      if (clickedTile) {
        this.enterAlbumMode(clickedTile.id);
      }
    });
    
    // Click handler for album mode - clicking anywhere exits album view
    document.addEventListener('click', (e) => {
      // Only handle clicks in album mode (not during transition or exit transition)
      if (this.viewMode !== 'album' || this.transition.active || this.exitTransitionActive) {
        return;
      }
      
      // Don't exit if clicking on album UI elements (meta UI)
      if (this.albumMetaEl && (this.albumMetaEl.contains(e.target) || this.albumMetaEl === e.target)) {
        return; // Click on album meta UI - don't exit
      }
      if (this.albumMetaDetailsEl && (this.albumMetaDetailsEl.contains(e.target) || this.albumMetaDetailsEl === e.target)) {
        return; // Click on album meta details - don't exit
      }
      
      // Canvas clicks are handled by canvas listener, but if we get here, it's a fallback
      // Exit album mode when clicking anywhere else
      this.exitAlbumMode();
    });
  }
  
  /**
   * Find tile at world point (for click detection)
   */
  findTileAtPoint(worldX, worldY) {
    // Get visible tiles with final positions (accounting for focus collapse)
    // IMPORTANT: This must match the rendering logic exactly
    const hasActiveFilter = this.filtersActive();
    const isCollapseActive = hasActiveFilter && this.focusProgress > 0.001;
    const hasFocusData = this.focusPos && this.focusPos.size > 0;
    let checkedCount = 0;
    
    for (const tile of this.tiles) {
      // Check visibility filter (same logic as rendering)
      let isVisible = true;
      if (hasActiveFilter) {
        const photo = this.photosMap.get(tile.id);
        if (photo) {
          isVisible = isPhotoVisible(
            photo,
            this.activeLocations,
            this.activeYears,
            this.activeKeywords,
            this.locationToPhotoIds,
            this.allLocatedPhotoIds,
            this.unknownPhotoIds,
            this.yearToPhotoIds,
            this.unknownYearIds,
            this.keywordToPhotoIds,
            this.allKeywordPhotoIds,
            this.unknownKeywordIds
          );
        }
      }
      
      if (!isVisible) continue;
      
      // Compute final position (TOP-LEFT corner, matching rendering logic)
      // This must match the logic in render() exactly
      const p0 = { x: tile.x, y: tile.y }; // Original position (top-left)
      let drawX = p0.x;
      let drawY = p0.y;
      
      // Blend with focus position if filter is active, has focus data, and focusProgress > 0
      if (isCollapseActive && hasFocusData && this.focusProgress > 0.001 && 
          this.focusAnchorX !== null && this.focusAnchorY !== null) {
        const offset = this.focusOffsets.get(tile.id);
        if (offset) {
          // Compute focus position in world space using stable anchor
          const focusX = this.focusAnchorX + offset.ox;
          const focusY = this.focusAnchorY + offset.oy;
          // Blend using focusProgress (velocity-based, same as rendering)
          drawX = lerp(p0.x, focusX, this.focusProgress);
          drawY = lerp(p0.y, focusY, this.focusProgress);
        }
      }
      
      // Check if point is within tile bounds
      // Use actual rendered image size (accounting for aspect ratio)
      const cacheEntry = this.imageCache.get(tile.id);
      const aspect = cacheEntry ? cacheEntry.aspect : (tile.w / tile.h);
      
      // Calculate actual draw size (same logic as rendering)
      let drawW, drawH;
      if (tile.w / tile.h > aspect) {
        drawH = tile.h;
        drawW = drawH * aspect;
      } else {
        drawW = tile.w;
        drawH = drawW / aspect;
      }
      
      // Image is centered within tile, so compute actual image bounds
      // dx = drawX + (tile.w - drawW) / 2  (from rendering code)
      // dy = drawY + (tile.h - drawH) / 2
      const imageLeft = drawX + (tile.w - drawW) / 2;
      const imageRight = imageLeft + drawW;
      const imageTop = drawY + (tile.h - drawH) / 2;
      const imageBottom = imageTop + drawH;
      
      const isInside = worldX >= imageLeft && worldX <= imageRight &&
                       worldY >= imageTop && worldY <= imageBottom;
      
      if (isInside) {
        return tile;
      }
    }
    return null;
  }
  
  /**
   * Get tile's current screen-space rect (as rendered in drawer)
   */
  getTileScreenRect(tile, finalPositions) {
    // Get final world position (accounting for focus collapse)
    let worldX = tile.x;
    let worldY = tile.y;
    
    if (finalPositions && finalPositions.has(tile.id)) {
      const finalPos = finalPositions.get(tile.id);
      worldX = finalPos.x;
      worldY = finalPos.y;
    }
    
    // Convert world position to screen space
    const screenX = (worldX - this.camera.x) * this.camera.zoom + this.width / 2;
    const screenY = (worldY - this.camera.y) * this.camera.zoom + this.height / 2;
    
    // Get actual drawn size (preserving aspect ratio)
    const cacheEntry = this.imageCache.get(tile.id);
    const aspect = cacheEntry && cacheEntry.aspect ? cacheEntry.aspect : (tile.w / tile.h);
    
    let dw, dh;
    if (tile.w / tile.h > aspect) {
      dh = tile.h * this.camera.zoom;
      dw = dh * aspect;
    } else {
      dw = tile.w * this.camera.zoom;
      dh = dw / aspect;
    }
    
    // Center image inside tile
    const dx = screenX - dw / 2;
    const dy = screenY - dh / 2;
    
    return { x: dx, y: dy, w: dw, h: dh };
  }
  
  /**
   * Compute album target rect (centered, large)
   */
  computeAlbumEndRect(tile) {
    const cacheEntry = this.imageCache.get(tile.id);
    const aspect = cacheEntry && cacheEntry.aspect ? cacheEntry.aspect : (tile.w / tile.h);
    
    // Keep consistent breathing room around the album image,
    // and reserve space for the "Scroll to see more" hint below.
    const margin = 28; // px (top/bottom/left/right)
    const scrollHintReserve = 90; // px reserved under the image
    
    // Target: 60% of viewport width, max 90% of viewport height, accounting for margins
    const targetW = this.width * 0.60 - (margin * 2);
    const targetH = this.height * 0.90 - (margin * 2) - scrollHintReserve;
    
    let endW, endH;
    if (targetW / aspect <= targetH) {
      endW = targetW;
      endH = targetW / aspect;
    } else {
      endH = targetH;
      endW = targetH * aspect;
    }
    
    const x = (this.width - endW) / 2;
    const y = (this.height - endH) / 2;
    
    return { x, y, w: endW, h: endH };
  }
  
  /**
   * Create close button element for album view
   */
  createCloseButton() {
    if (this.closeButtonEl) return; // Already created
    
    // Create close button element
    this.closeButtonEl = document.createElement('button');
    this.closeButtonEl.className = 'album-close-button';
    this.closeButtonEl.setAttribute('aria-label', 'Close album');
    this.closeButtonEl.innerHTML = '<span class="close-x">×</span>';
    
    // Add click handler to exit album mode
    this.closeButtonEl.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent event from bubbling to album wrapper
      this.exitAlbumMode();
    });
    
    // Add to body (fixed positioning relative to viewport, not wrapper)
    document.body.appendChild(this.closeButtonEl);
  }
  
  /**
   * Enter album mode for a selected photo with animated transition
   */
  enterAlbumMode(photoId) {
    const tile = this.tiles.find(t => t.id === photoId);
    if (!tile) {
      return;
    }
    
    // Check if filters are active - if so, create filtered album
    const hasActiveFilter = this.filtersActive();
    this.isFilteredAlbum = hasActiveFilter;
    
    if (hasActiveFilter) {
      // Get filtered photos
      this.filteredPhotos = this.getFilteredPhotos();
      
      // Find the clicked photo in filtered photos
      const clickedPhoto = this.photosMap.get(photoId);
      if (!clickedPhoto) {
        return;
      }
      
      // Find index of clicked photo in filtered photos
      const clickedIndex = this.filteredPhotos.findIndex(p => p.id === photoId);
      if (clickedIndex === -1) {
        // Photo not in filtered set - shouldn't happen, but handle gracefully
        return;
      }
      
      // Reorder filtered photos so clicked photo is first
      this.filteredPhotos = [
        ...this.filteredPhotos.slice(clickedIndex),
        ...this.filteredPhotos.slice(0, clickedIndex)
      ];
    } else {
      this.filteredPhotos = [];
    }
    
    // Store previous state before entering album mode (including filter state)
    this.prevState = {
      viewMode: 'drawer',
      cameraX: this.camera.x,
      cameraY: this.camera.y,
      zoom: this.camera.zoom,
      targetZoom: this.targetZoom,
      // Save filter state (create new Sets to avoid reference issues)
      activeLocations: new Set(this.activeLocations),
      activeYears: new Set(this.activeYears),
      activeKeywords: new Set(this.activeKeywords),
      // Save focus collapse state if active
      focusBaseZoom: this.focusBaseZoom,
      focusProgress: this.focusProgress,
      focusVel: this.focusVel,
      prevZoomLevel: this.prevZoomLevel
    };
    
    // Get current final positions (for focus collapse)
    const finalPositions = new Map();
    
    for (const t of this.tiles) {
      const p0 = { x: t.x, y: t.y };
      let x = p0.x;
      let y = p0.y;
      
      if (hasActiveFilter && this.focusOffsets.size > 0 && 
          this.focusAnchorX !== null && this.focusAnchorY !== null) {
        const offset = this.focusOffsets.get(t.id);
        if (offset && this.focusProgress > 0.001) {
          const focusX = this.focusAnchorX + offset.ox;
          const focusY = this.focusAnchorY + offset.oy;
          x = lerp(p0.x, focusX, this.focusProgress);
          y = lerp(p0.y, focusY, this.focusProgress);
        }
      }
      
      finalPositions.set(t.id, { x, y });
    }
    
    // Capture start rect (current screen-space position) - save for exit animation
    const startRect = this.getTileScreenRect(tile, finalPositions);
    this.enterTileRect = startRect; // Save for exit animation
    this.activeTileId = photoId; // Save tile ID for exit
    
    // Compute end rect (album target)
    const endRect = this.computeAlbumEndRect(tile);
    
    // Start transition
    this.transition.active = true;
    this.transition.startTime = performance.now();
    this.transition.startRect = startRect;
    this.transition.endRect = endRect;
    this.transition.selectedId = photoId;
    this.selectedPhotoId = photoId;
    
    // Add mode-album class immediately to hide "Remains" logo before album name appears
    document.body.classList.add('mode-album');
    
    // Start nav closing animation immediately (mechanical shutter)
    this.animateNavClose();
    
    // Update and show album meta UI
    this.updateAlbumMetaUI(photoId);
    // Show with animation after a short delay to sync with transition
    setTimeout(() => {
      this.showAlbumMetaUI();
    }, 100);
    
    // Load and display album metadata details
    const photo = this.photosMap.get(photoId);
    if (photo) {
      if (this.isFilteredAlbum) {
        // For filtered albums, render filtered album details immediately
        this.albumData = null; // No original album data
        this.renderAlbumMetaDetails(null);
        this.showAlbumMetaDetails();
      } else {
        // For regular albums, load original album data
        this.loadAlbumData(photo).then(albumData => {
          if (albumData) {
            this.albumData = albumData;
            this.renderAlbumMetaDetails(albumData);
            // Position and show together to prevent glitch
            this.showAlbumMetaDetails();
          }
        });
      }
      
      // Load album photos for stacking
      this.loadAlbumPhotos(photoId).then(() => {
        // Update scroll hint visibility after photos are loaded
        this.updateScrollHintVisibility();
        // Update main image once photos are loaded
        if (this.viewMode === 'album' || this.transition.active) {
          this.updateMainImage(photoId);
        }
        // Re-render album meta details now that albumPhotos is populated (for date display)
        this.renderAlbumMetaDetails(this.albumData);
      });
    }
    
    // Create close button if not already created
    if (!this.closeButtonEl) {
      this.createCloseButton();
    }
    
    // Keep viewMode as 'drawer' during transition
    // viewMode will switch to 'album' when transition completes
    
    // Ensure render loop is running for transition animation
    if (!this.animationFrameId) {
      this.startRenderLoop();
    }
    
  }
  
  /**
   * Enter album mode directly without transition (for navigation from user albums page)
   */
  enterAlbumModeDirectly(photoId, username = null) {
    // FIX: Reset filtered album state when entering from navigation pages
    // This ensures we load the actual album photos, not stale filtered photos from a previous session
    this.isFilteredAlbum = false;
    this.filteredPhotos = [];
    
    const tile = this.tiles.find(t => t.id === photoId);
    if (!tile) {
      return;
    }
    
    // Store that we came from user albums page
    this.fromUserAlbums = username !== null;
    this.userAlbumsUsername = username;
    
    // Store previous state before entering album mode (for exit)
    this.prevState = {
      viewMode: 'drawer',
      cameraX: this.camera.x,
      cameraY: this.camera.y,
      zoom: this.camera.zoom,
      targetZoom: this.targetZoom,
      activeLocations: new Set(this.activeLocations),
      activeYears: new Set(this.activeYears),
      activeKeywords: new Set(this.activeKeywords),
      focusBaseZoom: this.focusBaseZoom,
      focusProgress: this.focusProgress,
      focusVel: this.focusVel,
      prevZoomLevel: this.prevZoomLevel
    };
    
    // Set selected photo
    this.selectedPhotoId = photoId;
    this.activeTileId = photoId;
    
    // Close nav bars instantly (without animation)
    if (!this.topNavEl) {
      this.topNavEl = document.getElementById('top-nav');
    }
    if (!this.centerNavEl) {
      this.centerNavEl = document.getElementById('center-nav');
    }
    if (!this.filtersWrapEl) {
      this.filtersWrapEl = document.getElementById('filters-wrap');
    }
    
    // Cancel any existing animations
    this.navCloseAnimations.forEach(anim => anim.cancel());
    this.navCloseAnimations = [];
    
    // Measure height if not set
    if (this.totalNavHeight === 0) {
      this.measureNavHeight();
    }
    
    const navH = this.totalNavHeight;
    const finalTranslateY = -(navH + 12);
    
    // Set nav bars to closed state instantly
    const navElements = [this.topNavEl, this.centerNavEl, this.filtersWrapEl].filter(el => el !== null);
    navElements.forEach((navEl) => {
      navEl.style.transform = `translateY(${finalTranslateY}px) scaleY(0.02)`;
      navEl.style.filter = 'blur(0px)';
      navEl.style.pointerEvents = 'none';
    });
    
    // Set viewMode to album immediately (skip transition)
    this.transition.active = false;
    this.viewMode = 'album';
    
    // Add mode-album class first (required for CSS to show album meta UI)
    document.body.classList.add('mode-album');
    
    // Update album meta UI (text appears immediately, no fade)
    // Ensure element is created first
    if (!this.albumMetaEl) {
      this.createAlbumMetaUI();
    }
    this.updateAlbumMetaUI(photoId);
    // Make sure it's visible (text appears immediately, no fade)
    if (this.albumMetaEl) {
      this.albumMetaEl.style.display = 'block';
      this.albumMetaEl.style.opacity = '1';
      this.albumMetaEl.style.visibility = 'visible';
      // Don't add fade-in animation class - show immediately
      this.albumMetaEl.classList.remove('album-meta-enter', 'album-meta-exit');
    }
    
    // Load and display album metadata details (also show immediately)
    const photo = this.photosMap.get(photoId);
    if (photo) {
      this.loadAlbumData(photo).then(albumData => {
        if (albumData) {
          this.albumData = albumData;
          this.renderAlbumMetaDetails(albumData);
          // Show immediately without fade (text was already visible on hover)
          if (this.albumMetaDetailsEl) {
            this.albumMetaDetailsEl.style.display = 'block';
            this.albumMetaDetailsEl.style.transition = 'none';
            this.albumMetaDetailsEl.style.opacity = '1';
          }
        }
      });
      
      // Load album photos for stacking
      this.loadAlbumPhotos(photoId).then(() => {
        // Update scroll hint visibility after photos are loaded
        this.updateScrollHintVisibility();
        // Setup IntersectionObserver for HQ loading
        this.setupAlbumImageObserver();
        if (this.albumMainImage) {
          this.albumImageObserver.observe(this.albumMainImage);
          this.upgradeToHQ(this.albumMainImage);
        }
        
        // Observe all stack images
        if (this.albumStackLayer) {
          const stackImages = this.albumStackLayer.querySelectorAll('.album-stack-image');
          for (const img of stackImages) {
            this.albumImageObserver.observe(img);
          }
        }
        
        // Update main image once photos are loaded
        this.updateMainImage(photoId);
        // Re-render album meta details now that albumPhotos is populated (for date display)
        this.renderAlbumMetaDetails(this.albumData);
      });
    }
    
    // Set up album mode UI (other elements fade in)
    document.documentElement.style.setProperty('--uiAlpha', '0');
    const navHeight = 15 + 40 + 35;
    document.documentElement.style.setProperty('--navTranslateY', `-${navHeight}px`);
    
    // Show album image wrapper (with fade)
    this.showAlbumImageWrapper();
    
    // Update album metadata details position
    if (this.albumMetaDetailsEl && this.albumData) {
      requestAnimationFrame(() => {
        this.updateAlbumMetaDetailsPosition();
      });
    }
    
    // Ensure render loop is running
    if (!this.animationFrameId) {
      this.startRenderLoop();
    }
  }
  
  /**
   * Enter album mode with soft transition (for navigation from user albums page or index)
   * @param {string} photoId - tile/photo id
   * @param {string|null} username - user key (for nav title and "go to user" click)
   * @param {{ fromIndex?: boolean }} options - fromIndex: true when opened from index page (exit returns to index)
   */
  enterAlbumModeWithTransition(photoId, username = null, options = {}) {
    // Reset filtered album state when entering from navigation pages (user-albums, index)
    // This ensures we load the actual album photos, not stale filtered photos from a previous session
    this.isFilteredAlbum = false;
    this.filteredPhotos = [];
    
    const tile = this.tiles.find(t => t.id === photoId);
    if (!tile) {
      return;
    }
    
    // Ensure canvas is hidden (no drawer placeholders visible)
    const canvas = document.getElementById('canvas');
    if (canvas) {
      canvas.style.display = 'none';
    }
    
    const fromIndex = options && options.fromIndex === true;
    this.fromIndex = fromIndex;
    if (fromIndex) {
      this.fromUserAlbums = false;
      this.userAlbumsUsername = username || (this.photosMap.get(photoId) && this.photosMap.get(photoId).userKey) || null;
    } else {
      this.fromUserAlbums = username !== null;
      this.userAlbumsUsername = username;
    }
    
    // Store previous state before entering album mode (for exit)
    this.prevState = {
      viewMode: 'drawer',
      cameraX: this.camera.x,
      cameraY: this.camera.y,
      zoom: this.camera.zoom,
      targetZoom: this.targetZoom,
      activeLocations: new Set(this.activeLocations),
      activeYears: new Set(this.activeYears),
      activeKeywords: new Set(this.activeKeywords),
      focusBaseZoom: this.focusBaseZoom,
      focusProgress: this.focusProgress,
      focusVel: this.focusVel,
      prevZoomLevel: this.prevZoomLevel
    };
    
    // Set selected photo
    this.selectedPhotoId = photoId;
    this.activeTileId = photoId;
    
    // Close nav bars with animation
    this.animateNavClose();
    
    // Set viewMode to album
    this.transition.active = false;
    this.viewMode = 'album';
    
    // Add mode-album class
    document.body.classList.add('mode-album');
    
    // FIX: Ensure page-container is hidden when entering album mode
    // This prevents the user-albums page from showing behind the album
    const pageContainer = document.getElementById('page-container');
    if (pageContainer) {
      pageContainer.style.display = 'none';
      pageContainer.style.visibility = 'hidden';
      pageContainer.style.opacity = '0';
    }
    
    // Ensure nav title is hidden (mode-album class should hide it, but be explicit)
    const remainsLogo = document.getElementById('remainsLogo');
    if (remainsLogo) {
      const h1 = remainsLogo.querySelector('h1');
      if (h1) {
        h1.style.opacity = '0';
        h1.style.visibility = 'hidden';
      }
    }
    
    // Set up album mode UI
    document.documentElement.style.setProperty('--uiAlpha', '0');
    const navHeight = 15 + 40 + 35;
    document.documentElement.style.setProperty('--navTranslateY', `-${navHeight}px`);
    
    // Update album meta UI (header - fade in softly)
    if (!this.albumMetaEl) {
      this.createAlbumMetaUI();
    }
    this.updateAlbumMetaUI(photoId);
    if (this.albumMetaEl) {
      this.albumMetaEl.style.display = 'block';
      this.albumMetaEl.style.opacity = '0';
      this.albumMetaEl.style.visibility = 'visible';
      this.albumMetaEl.style.transition = 'opacity 0.7s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
      // Fade in after a brief delay
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (this.albumMetaEl) {
            this.albumMetaEl.style.opacity = '1';
          }
        });
      });
    }
    
    // Load and display album metadata details (fade in softly)
    const photo = this.photosMap.get(photoId);
    if (photo) {
      this.loadAlbumData(photo).then(albumData => {
        if (albumData) {
          this.albumData = albumData;
          this.renderAlbumMetaDetails(albumData);
          // Fade in metadata details
          if (this.albumMetaDetailsEl) {
            this.albumMetaDetailsEl.style.display = 'block';
            this.albumMetaDetailsEl.style.opacity = '0';
            this.albumMetaDetailsEl.style.transition = 'opacity 0.7s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
            this.albumMetaDetailsEl.style.visibility = 'visible';
            // Fade in after a brief delay
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (this.albumMetaDetailsEl) {
                  this.albumMetaDetailsEl.style.opacity = '1';
                }
              });
            });
          }
        }
      });
      
      // Load album photos for stacking
      this.loadAlbumPhotos(photoId).then(() => {
        // Update scroll hint visibility after photos are loaded
        this.updateScrollHintVisibility();
        // Setup IntersectionObserver for HQ loading
        this.setupAlbumImageObserver();
        if (this.albumMainImage) {
          this.albumImageObserver.observe(this.albumMainImage);
          this.upgradeToHQ(this.albumMainImage);
        }
        
        // Observe all stack images
        if (this.albumStackLayer) {
          const stackImages = this.albumStackLayer.querySelectorAll('.album-stack-image');
          for (const img of stackImages) {
            this.albumImageObserver.observe(img);
          }
        }
        
        // Update main image once photos are loaded
        this.updateMainImage(photoId);
        // Re-render album meta details now that albumPhotos is populated (for date display)
        this.renderAlbumMetaDetails(this.albumData);
      });
    }
    
    // Create close button if not already created
    if (!this.closeButtonEl) {
      this.createCloseButton();
    }
    
    // Show album image wrapper (with fade)
    this.showAlbumImageWrapper(true);
    
    // Update album metadata details position
    if (this.albumMetaDetailsEl && this.albumData) {
      requestAnimationFrame(() => {
        this.updateAlbumMetaDetailsPosition();
      });
    }
    
    // Ensure render loop is running
    if (!this.animationFrameId) {
      this.startRenderLoop();
    }
  }
  
  /**
   * Measure nav height and set CSS variable
   */
  measureNavHeight() {
    if (!this.topNavEl) {
      this.topNavEl = document.getElementById('top-nav');
    }
    if (this.topNavEl) {
      const rect = this.topNavEl.getBoundingClientRect();
      this.navHeight = rect.height;
      document.documentElement.style.setProperty('--navH', `${this.navHeight}px`);
    }
  }
  
  /**
   * Animate all nav bars closing together (mechanical shutter effect)
   */
  animateNavClose() {
    // Get all nav elements
    if (!this.topNavEl) {
      this.topNavEl = document.getElementById('top-nav');
    }
    if (!this.centerNavEl) {
      this.centerNavEl = document.getElementById('center-nav');
    }
    if (!this.filtersWrapEl) {
      this.filtersWrapEl = document.getElementById('filters-wrap');
    }
    
    // Cancel any existing animations
    this.navCloseAnimations.forEach(anim => anim.cancel());
    this.navCloseAnimations = [];
    
    // Measure height if not set
    if (this.totalNavHeight === 0) {
      this.measureNavHeight();
    }
    
    const navH = this.totalNavHeight;
    const finalTranslateY = -(navH + 12);
    
    // Animate all nav bars together
    const navElements = [this.topNavEl, this.centerNavEl, this.filtersWrapEl].filter(el => el !== null);
    
    navElements.forEach((navEl) => {
      // Two-stage mechanical animation using keyframes (no opacity changes)
      const animation = navEl.animate([
        // Stage 1: Initial pull (0-50%)
        {
          transform: `translateY(0) scaleY(1)`,
          filter: 'blur(0px)'
        },
        {
          transform: `translateY(-10px) scaleY(0.92)`,
          filter: 'blur(0.5px)',
          offset: 0.5
        },
        // Stage 2: Snap shut (50-100%)
        {
          transform: `translateY(${finalTranslateY}px) scaleY(0.02)`,
          filter: 'blur(1px)',
          offset: 0.85
        },
        {
          transform: `translateY(${finalTranslateY}px) scaleY(0.02)`,
          filter: 'blur(0px)',
          offset: 1.0
        }
      ], {
        duration: 480, // ms
        easing: 'cubic-bezier(0.2, 0.9, 0.2, 1.05)', // Mechanical with slight overshoot
        fill: 'forwards' // Keep final state
      });
      
      this.navCloseAnimations.push(animation);
      
      // Update CSS after animation completes
      animation.onfinish = () => {
        navEl.style.transform = `translateY(${finalTranslateY}px) scaleY(0.02)`;
        navEl.style.filter = 'blur(0px)';
        navEl.style.pointerEvents = 'none';
      };
    });
  }
  
  /**
   * Animate all nav bars opening together (reverse mechanical shutter effect)
   */
  animateNavOpen() {
    // Get all nav elements
    if (!this.topNavEl) {
      this.topNavEl = document.getElementById('top-nav');
    }
    if (!this.centerNavEl) {
      this.centerNavEl = document.getElementById('center-nav');
    }
    if (!this.filtersWrapEl) {
      this.filtersWrapEl = document.getElementById('filters-wrap');
    }
    
    // Cancel any existing animations
    this.navOpenAnimations.forEach(anim => anim.cancel());
    this.navOpenAnimations = [];
    
    // Measure height if not set
    if (this.totalNavHeight === 0) {
      this.measureNavHeight();
    }
    
    const navH = this.totalNavHeight;
    const startTranslateY = -(navH + 12);
    
    // Animate all nav bars together
    const navElements = [this.topNavEl, this.centerNavEl, this.filtersWrapEl].filter(el => el !== null);
    
    navElements.forEach((navEl) => {
      // Two-stage mechanical animation (reverse of close, no opacity changes)
      const animation = navEl.animate([
        // Stage 1: Release/spring (0-50%)
        {
          transform: `translateY(${startTranslateY}px) scaleY(0.02)`,
          filter: 'blur(0px)'
        },
        {
          transform: `translateY(-10px) scaleY(0.92)`,
          filter: 'blur(0.5px)',
          offset: 0.5
        },
        // Stage 2: Settle into place (50-100%)
        {
          transform: `translateY(0) scaleY(1)`,
          filter: 'blur(0px)',
          offset: 1.0
        }
      ], {
        duration: 480, // ms
        easing: 'cubic-bezier(0.2, 0.9, 0.2, 1.05)', // Mechanical with slight overshoot
        fill: 'forwards' // Keep final state
      });
      
      this.navOpenAnimations.push(animation);
      
      // Update CSS after animation completes
      animation.onfinish = () => {
        navEl.style.transform = 'translateY(0) scaleY(1)';
        navEl.style.filter = 'blur(0px)';
        // Restore pointer events (filters-wrap should remain none, handled separately)
        if (navEl.id !== 'filters-wrap') {
          navEl.style.pointerEvents = 'auto';
        }
      };
    });
  }
  
  /**
   * Apply no-orphan wrapping to text element
   * Detects if the last line would be a single word and prevents it by using non-breaking space
   * Special case: if text has exactly 3 words, keep them all on one line
   * Numbers are treated as words, and numbers should stay with the following word
   */
  applyNoOrphanWrap(element, text, maxWidth = 700) {
    if (!element || !text) return;
    
    // Split text into words
    const words = text.trim().split(/\s+/);
    
    // Check if first word is a number (starts with digit)
    const isFirstWordNumber = words.length > 0 && /^\d/.test(words[0]);
    
    // If first word is a number, glue it to the next word, then apply normal wrapping
    if (isFirstWordNumber && words.length >= 2) {
      // Glue number to next word
      const numberWord = words[0];
      const restWords = words.slice(1);
      const gluedStart = numberWord + '\u00A0' + restWords[0];
      const finalWords = [gluedStart, ...restWords.slice(1)];
      
      // For 4+ original words (3+ after gluing number), always glue last two to prevent orphan
      // This allows break between the glued number+word and the last two words
      if (finalWords.length >= 3) {
        // Glue last two words to prevent orphan
        // Result: "2009\u00A0Quicke family\u00A0album" - breaks between Quicke and family
        const result = finalWords.slice(0, -2).join(' ') + ' ' + finalWords[finalWords.length - 2] + '\u00A0' + finalWords[finalWords.length - 1];
        element.textContent = result;
        return;
      } else if (finalWords.length === 2) {
        // If only 2 words after gluing, keep them together
        const result = finalWords[0] + '\u00A0' + finalWords[1];
        element.textContent = result;
        return;
      }
      
      // Fallback: just set normally
      element.textContent = finalWords.join(' ');
      return;
    }
    
    // Special case: exactly 3 words - keep them all together on one line
    if (words.length === 3) {
      const result = words[0] + '\u00A0' + words[1] + '\u00A0' + words[2];
      element.textContent = result;
      return;
    }
    
    if (words.length <= 2) {
      // One or two words - no orphan possible, set normally
      element.textContent = text;
      return;
    }
    
    // First, set the text normally to measure actual wrapping
    element.textContent = text;
    
    // Use requestAnimationFrame to ensure DOM has rendered
    requestAnimationFrame(() => {
      // Check if text actually wraps by comparing scrollWidth to clientWidth
      const scrollWidth = element.scrollWidth;
      const clientWidth = element.clientWidth || maxWidth;
      
      // If text doesn't wrap, no need to fix
      if (scrollWidth <= clientWidth) {
        return;
      }
      
      // Text wraps - use Range API to detect if last line is orphan
      const textNode = element.firstChild;
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
        return;
      }
      
      // Get line height for measurement
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || parseFloat(getComputedStyle(element).fontSize) * 1.05;
      const elementHeight = element.offsetHeight;
      const lineCount = Math.round(elementHeight / lineHeight);
      
      // If there are multiple lines, check if last line is orphan
      if (lineCount > 1 && words.length >= 3) {
        // Use Range API to find the start of the last line
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false); // Collapse to end
        
        // Move backwards to find the start of the last line
        let lastLineStart = text.length;
        const rect = range.getBoundingClientRect();
        const lastLineTop = rect.top;
        
        // Find where the last line starts by checking character positions
        // We'll use a simpler heuristic: if text wraps and has 3+ words, glue last two
        // This prevents orphans in most cases
        const result = words.slice(0, -2).join(' ') + ' ' + words[words.length - 2] + '\u00A0' + words[words.length - 1];
        element.textContent = result;
      }
    });
  }
  
  /**
   * Create album meta UI overlay element
   */
  createAlbumMetaUI() {
    if (this.albumMetaEl) return; // Already created
    
    this.albumMetaEl = document.createElement('div');
    this.albumMetaEl.className = 'album-meta-ui';
    this.albumMetaEl.style.display = 'none'; // Hidden by default
    
    // Create album name line
    const albumNameEl = document.createElement('div');
    albumNameEl.className = 'album-name';
    this.albumMetaEl.appendChild(albumNameEl);
    
    // Create "by username" line
    // Use non-breaking space between "by" and username to prevent orphan
    const byLineEl = document.createElement('div');
    byLineEl.className = 'album-by';
    const byText = document.createTextNode('by\u00A0'); // Non-breaking space
    byLineEl.appendChild(byText);
    const usernameSpan = document.createElement('span');
    usernameSpan.className = 'album-username';
    byLineEl.appendChild(usernameSpan);
    this.albumMetaEl.appendChild(byLineEl);
    
    document.body.appendChild(this.albumMetaEl);
  }
  
  /**
   * Update album meta UI with photo data
   */
  updateAlbumMetaUI(photoId) {
    if (!this.albumMetaEl) {
      this.createAlbumMetaUI();
    }
    
    const photo = this.photosMap.get(photoId);
    if (!photo) {
      // Hide if no photo data
      this.albumMetaEl.style.display = 'none';
      return;
    }
    
    // Extract album name - use filtered album name if filters are active
    let albumName;
    if (this.isFilteredAlbum) {
      albumName = this.generateFilteredAlbumName();
    } else {
      albumName = photo.albumKey || photo.meta?.album?.title || 'Untitled Album';
    }
    
    // Extract user real name (prefer realname over username) - always from current photo
    const userDisplayName = photo.meta?.user?.realname || photo.meta?.user?.username || photo.userKey || this.userAlbumsUsername || 'Unknown';
    // Get username for navigation (use userKey; when from index, fallback to userAlbumsUsername)
    const usernameForNav = photo.userKey || this.userAlbumsUsername || 'Unknown';
    
    // Update content
    const albumNameEl = this.albumMetaEl.querySelector('.album-name');
    const usernameSpan = this.albumMetaEl.querySelector('.album-username');
    
    if (albumNameEl) {
      // Apply smart wrapping to prevent orphan words
      this.applyNoOrphanWrap(albumNameEl, albumName, 700);
    }
    if (usernameSpan) {
      // Show username and "by" line for both filtered and regular albums (keep Alaine & Joe Chang intact)
      usernameSpan.style.display = '';
      if (userDisplayName === 'Alaine & Joe Chang') {
        usernameSpan.innerHTML = 'Alaine &amp;<br>Joe Chang';
      } else {
        // Use non-breaking space between words so name doesn't wrap mid-name (avoids visual dot/glitch after first name on narrow viewport)
        const nameForDisplay = (typeof userDisplayName === 'string' && userDisplayName.includes(' '))
          ? userDisplayName.replace(/\s+(\S+)\s*$/, '\u00A0$1') // last space -> nbsp
          : userDisplayName;
        usernameSpan.textContent = nameForDisplay;
      }
      const byLineEl = this.albumMetaEl.querySelector('.album-by');
      if (byLineEl) {
        byLineEl.style.display = '';
      }
      if (!this.isFilteredAlbum) {
        // Add click handler to navigate to user page with fade out animation
        usernameSpan.onclick = (e) => {
          e.stopPropagation();
          // Store username for navigation after exit transition completes
          this.navigateToUserAfterExit = usernameForNav;
          // Start exit transition (will navigate after animation completes)
          this.exitAlbumMode();
        };
      } else {
        usernameSpan.onclick = null;
      }
    }
    // When entering from user page with long username (e.g. paterson.andrea), use same reduced title size so header doesn't jump
    this.albumMetaEl.classList.toggle('album-meta-ui--from-long-username',
      !!this.fromUserAlbums && !!this.userAlbumsUsername && isLongUsername(this.userAlbumsUsername));
    
    // Re-apply wrapping on next frame to ensure it's visible
    requestAnimationFrame(() => {
      if (albumNameEl && this.albumMetaEl.style.display !== 'none') {
        this.applyNoOrphanWrap(albumNameEl, albumName, 700);
      }
    });
  }
  
  /**
   * Show album meta UI with animation
   */
  showAlbumMetaUI() {
    if (!this.albumMetaEl) return;
    
    this.albumMetaEl.style.display = 'block';
    // Trigger animation by removing and re-adding class
    this.albumMetaEl.classList.remove('album-meta-enter');
    void this.albumMetaEl.offsetWidth; // Force reflow
    this.albumMetaEl.classList.add('album-meta-enter');
  }
  
  /**
   * Hide album meta UI with animation
   */
  hideAlbumMetaUI() {
    if (!this.albumMetaEl) return;
    
    this.albumMetaEl.classList.remove('album-meta-enter');
    this.albumMetaEl.classList.add('album-meta-exit');
    
    // Hide after animation
    setTimeout(() => {
      if (this.albumMetaEl) {
        this.albumMetaEl.style.display = 'none';
        this.albumMetaEl.classList.remove('album-meta-exit');
      }
    }, 300);
  }
  
  /**
   * Create album metadata details UI element (bottom-left)
   */
  createAlbumMetaDetailsUI() {
    if (this.albumMetaDetailsEl) return; // Already created
    
    this.albumMetaDetailsEl = document.createElement('div');
    this.albumMetaDetailsEl.className = 'album-meta-details';
    this.albumMetaDetailsEl.setAttribute('aria-hidden', 'true');
    this.albumMetaDetailsEl.style.display = 'none';
    const left = (typeof getComputedStyle !== 'undefined'
      ? getComputedStyle(document.documentElement).getPropertyValue('--remains-left').trim()
      : '') || '30px';
    this.albumMetaDetailsEl.style.left = left.endsWith('px') ? left : `${left}px`;
    // Match the exact position from user albums hover info
    this.albumMetaDetailsEl.style.bottom = '25px';
    this.albumMetaDetailsEl.style.top = 'auto';
    this.albumMetaDetailsEl.style.right = 'auto';
    
    document.body.appendChild(this.albumMetaDetailsEl);
  }
  
  /**
   * Format date from ISO string or Unix timestamp to dd.mm.yyyy
   */
  formatDate(dateString, unixTimestamp) {
    let date;
    if (dateString) {
      date = new Date(dateString);
    } else if (unixTimestamp) {
      date = new Date(unixTimestamp * 1000);
    } else {
      return null;
    }
    
    if (isNaN(date.getTime())) {
      return null;
    }
    
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    
    return `${day}.${month}.${year}`;
  }

  /**
   * Calculate how many whole days passed since a given date
   */
  getDaysSince(dateString, unixTimestamp) {
    let date;
    if (dateString) {
      date = new Date(dateString);
    } else if (unixTimestamp) {
      date = new Date(unixTimestamp * 1000);
    } else {
      return null;
    }

    if (isNaN(date.getTime())) {
      return null;
    }

    const diffMs = Date.now() - date.getTime();
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    return Number.isFinite(days) && days >= 0 ? days : null;
  }
  
  /**
   * Convert file size string (e.g., "189 KB") to MB with one decimal place
   */
  convertFileSizeToMB(fileSizeString) {
    if (!fileSizeString) return null;
    
    // Extract number and unit
    const match = fileSizeString.match(/([\d.]+)\s*(KB|MB|GB|bytes?)/i);
    if (!match) return null;
    
    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    
    let mbValue;
    if (unit === 'KB' || unit === 'KILOBYTES') {
      mbValue = value / 1024;
    } else if (unit === 'MB' || unit === 'MEGABYTES') {
      mbValue = value;
    } else if (unit === 'GB' || unit === 'GIGABYTES') {
      mbValue = value * 1024;
    } else {
      // bytes
      mbValue = value / (1024 * 1024);
    }
    
    return mbValue.toFixed(1);
  }
  
  /**
   * Get display label for a filter (remove prefixes, capitalize keywords)
   */
  getFilterDisplayLabel(label, type) {
    if (!label) return '';
    
    if (type === 'location') {
      // Strip "US State: " prefix
      if (label.startsWith('US State: ')) {
        return label.substring('US State: '.length);
      }
      return label;
    } else if (type === 'keyword' || type === 'tags') {
      // Capitalize first letter
      return label.charAt(0).toUpperCase() + label.slice(1);
    } else if (type === 'year' || type === 'date') {
      // Years are already in good format
      return label;
    }
    
    return label;
  }
  
  /**
   * Get all photos that pass the active filters
   */
  getFilteredPhotos() {
    if (!this.filtersActive()) {
      return [];
    }
    
    const filtered = [];
    for (const photo of this.photos) {
      if (isPhotoVisible(
        photo,
        this.activeLocations,
        this.activeYears,
        this.activeKeywords,
        this.locationToPhotoIds,
        this.allLocatedPhotoIds,
        this.unknownPhotoIds,
        this.yearToPhotoIds,
        this.unknownYearIds,
        this.keywordToPhotoIds,
        this.allKeywordPhotoIds,
        this.unknownKeywordIds
      )) {
        filtered.push(photo);
      }
    }
    
    // Shuffle so filtered album order is random (Fisher–Yates)
    for (let i = filtered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
    }
    return filtered;
  }
  
  /**
   * Generate album name from active filters (year, tag, location in that order)
   */
  generateFilteredAlbumName() {
    const parts = [];
    
    // Year filter (first)
    if (this.activeYears.size > 0) {
      const years = Array.from(this.activeYears).sort();
      parts.push(years.join(', '));
    }
    
    // Keyword/Tag filter (second)
    if (this.activeKeywords.size > 0) {
      const keywords = Array.from(this.activeKeywords)
        .map(k => this.getFilterDisplayLabel(k, 'keyword'))
        .sort();
      parts.push(keywords.join(', '));
    }
    
    // Location filter (third)
    if (this.activeLocations.size > 0) {
      const locations = Array.from(this.activeLocations)
        .map(l => this.getFilterDisplayLabel(l, 'location'))
        .sort();
      parts.push(locations.join(', '));
    }
    
    return parts.join(', ') || 'Filtered Album';
  }
  
  /**
   * Load album.json data for a photo
   */
  async loadAlbumData(photo) {
    if (!photo || !photo.albumKey || !photo.userKey) {
      return null;
    }
    
    try {
      const albumPath = `img/${photo.userKey}/${photo.albumKey}/album.json`;
      const response = await fetch(albumPath);
      if (!response.ok) {
        return null;
      }
      const data = await response.json();
      return data.album || null;
    } catch (error) {
      console.warn(`Failed to load album data for ${photo.albumKey}:`, error);
      return null;
    }
  }
  
  /**
   * Render album metadata details
   */
  renderAlbumMetaDetails(albumData) {
    if (!this.albumMetaDetailsEl) {
      return;
    }
    
    // Clear existing content
    this.albumMetaDetailsEl.innerHTML = '';
    
    // Handle filtered album case
    if (this.isFilteredAlbum) {
      // Get current photo
      const currentPhoto = this.photosMap.get(this.selectedPhotoId);
      if (!currentPhoto) {
        return;
      }
      
      // Username (first item) - from current photo
      const userDisplayName = currentPhoto.meta?.user?.realname || currentPhoto.meta?.user?.username || currentPhoto.userKey || 'Unknown';
      const usernameForNav = currentPhoto.userKey || 'Unknown';
      const usernameEl = document.createElement('div');
      usernameEl.className = 'meta-detail-item';
      const usernameSpan = document.createElement('span');
      usernameSpan.className = 'meta-value';
      if (userDisplayName === 'Alaine & Joe Chang') {
        usernameSpan.textContent = 'Alaine & Joe Chang';
      } else {
        usernameSpan.textContent = userDisplayName;
      }
      usernameSpan.style.cursor = 'pointer';
      usernameSpan.style.textDecoration = 'underline';
      usernameSpan.style.pointerEvents = 'auto'; // Enable clicks (parent has pointer-events: none)
      // Add click handler to navigate to user page
      usernameSpan.onclick = (e) => {
        e.stopPropagation();
        // Store username for navigation after exit transition completes
        this.navigateToUserAfterExit = usernameForNav;
        // Start exit transition (will navigate after animation completes)
        this.exitAlbumMode();
      };
      usernameEl.innerHTML = `<span class="meta-label">by</span> `;
      usernameEl.appendChild(usernameSpan);
      this.albumMetaDetailsEl.appendChild(usernameEl);
      
      // Photo count (number of photos in filtered album)
      const photoCountEl = document.createElement('div');
      photoCountEl.className = 'meta-detail-item';
      photoCountEl.innerHTML = `<span class="meta-value">${this.albumPhotos.length} photos</span>`;
      this.albumMetaDetailsEl.appendChild(photoCountEl);
      
      // Date (dd.mm.yyyy) — below photo count (current photo, changes when scrolling)
      const currentFilteredPhoto = this.albumPhotos[this.mainPhotoIndex >= 0 ? this.mainPhotoIndex : 0];
      const orig = currentFilteredPhoto?._originalPhoto || currentFilteredPhoto;
      const filteredDate = orig ? this.formatDate(orig.taken, orig.uploadedUnix) : null;
      if (filteredDate) {
        const dateEl = document.createElement('div');
        dateEl.className = 'meta-detail-item';
        dateEl.innerHTML = `<span class="meta-value">${filteredDate}</span>`;
        this.albumMetaDetailsEl.appendChild(dateEl);
      }
      
      // Current photo size in MB
      if (currentPhoto.fileSize) {
        const sizeMB = this.convertFileSizeToMB(currentPhoto.fileSize);
        if (sizeMB !== null) {
          const sizeEl = document.createElement('div');
          sizeEl.className = 'meta-detail-item';
          sizeEl.innerHTML = `<span class="meta-label">Image size:</span> <span class="meta-value">${sizeMB} MB</span>`;
          this.albumMetaDetailsEl.appendChild(sizeEl);
        }
      }
      
      // Current photo date (taken date in dd.mm.yyyy format)
      const takenDate = this.formatDate(currentPhoto.taken, currentPhoto.uploadedUnix);
      if (takenDate) {
        const dateEl = document.createElement('div');
        dateEl.className = 'meta-detail-item';
        dateEl.innerHTML = `<span class="meta-label">Date taken:</span> <span class="meta-value">${takenDate}</span>`;
        this.albumMetaDetailsEl.appendChild(dateEl);
      }
      
      return;
    }
    
    // Original album logic
    if (!albumData) {
      return;
    }
    
    // Description (only if non-empty)
    if (albumData.description && albumData.description.trim()) {
      const descEl = document.createElement('div');
      descEl.className = 'meta-detail-item';
      descEl.innerHTML = `<span class="meta-value">${albumData.description}</span>`;
      this.albumMetaDetailsEl.appendChild(descEl);
    }
    
    // Photo count
    if (albumData.photoCount !== undefined) {
      const photoCountEl = document.createElement('div');
      photoCountEl.className = 'meta-detail-item';
      photoCountEl.innerHTML = `<span class="meta-value">${albumData.photoCount} photos</span>`;
      this.albumMetaDetailsEl.appendChild(photoCountEl);
    }
    
    // Date (dd.mm.yyyy) — below photo count (current photo, changes when scrolling)
    const currentPhoto = this.albumPhotos[this.mainPhotoIndex >= 0 ? this.mainPhotoIndex : 0];
    const currentPhotoDate = currentPhoto ? this.formatDate(currentPhoto.taken, currentPhoto.uploadedUnix) : null;
    if (currentPhotoDate) {
      const dateEl = document.createElement('div');
      dateEl.className = 'meta-detail-item';
      dateEl.innerHTML = `<span class="meta-value">${currentPhotoDate}</span>`;
      this.albumMetaDetailsEl.appendChild(dateEl);
    }
    
    // Size in MB (1 decimal place)
    if (albumData.sizeMB !== undefined && albumData.sizeMB !== null) {
      const sizeEl = document.createElement('div');
      sizeEl.className = 'meta-detail-item';
      const sizeFormatted = albumData.sizeMB.toFixed(1);
      sizeEl.innerHTML = `<span class="meta-label">Album size:</span> <span class="meta-value">${sizeFormatted} MB</span>`;
      this.albumMetaDetailsEl.appendChild(sizeEl);
    }
    
    // Last updated (days only)
    if (albumData.lastUploadedUnix !== undefined) {
      const now = Math.floor(Date.now() / 1000);
      const days = Math.floor((now - albumData.lastUploadedUnix) / 86400);
      const dateEl = document.createElement('div');
      dateEl.className = 'meta-detail-item';
      dateEl.innerHTML = `<span class="meta-label">Last updated:</span> <span class="meta-value">${days} days</span>`;
      this.albumMetaDetailsEl.appendChild(dateEl);
    }
  }
  
  /**
   * Update position of album metadata details
   * Uses fixed left (--remains-left / 30px) so position is correct immediately,
   * without depending on album-meta-ui being visible (avoids x jump on enter).
   */
  updateAlbumMetaDetailsPosition() {
    if (!this.albumMetaDetailsEl) {
      return;
    }
    
    // Match the exact position from user albums hover info
    const left = (typeof getComputedStyle !== 'undefined'
      ? getComputedStyle(document.documentElement).getPropertyValue('--remains-left').trim()
      : '') || '30px';
    this.albumMetaDetailsEl.style.left = left.endsWith('px') ? left : `${left}px`;
    this.albumMetaDetailsEl.style.bottom = '25px';
    this.albumMetaDetailsEl.style.top = 'auto';
    this.albumMetaDetailsEl.style.right = 'auto';
  }
  
  /**
   * Show album metadata details
   */
  showAlbumMetaDetails() {
    if (!this.albumMetaDetailsEl) {
      this.createAlbumMetaDetailsUI();
    }
    
    // Set correct position before showing (fixed left, no title dependency)
    this.updateAlbumMetaDetailsPosition();
    this.albumMetaDetailsEl.style.display = 'block';
    this.albumMetaDetailsEl.style.opacity = '0';
    this.albumMetaDetailsEl.style.transition = 'none';
    void this.albumMetaDetailsEl.offsetWidth;
    requestAnimationFrame(() => {
      this.albumMetaDetailsEl.style.transition = 'opacity 200ms ease';
      void this.albumMetaDetailsEl.offsetWidth;
      this.albumMetaDetailsEl.style.opacity = '1';
    });
  }
  
  /**
   * Hide album metadata details
   */
  hideAlbumMetaDetails() {
    if (this.albumMetaDetailsEl) {
      this.albumMetaDetailsEl.style.opacity = '0';
      this.albumMetaDetailsEl.style.transition = 'opacity 200ms ease';
      // Hide after fade
      setTimeout(() => {
        if (this.albumMetaDetailsEl) {
          this.albumMetaDetailsEl.style.display = 'none';
          this.albumMetaDetailsEl.style.transition = 'none';
        }
      }, 200);
    }
  }
  
  /**
   * Create overlay image element for enter/exit animations
   */
  createOverlayImage() {
    if (this.overlayImg) return; // Already created
    
    this.overlayImg = document.createElement('img');
    this.overlayImg.className = 'album-overlay-image';
    this.overlayImg.style.position = 'fixed';
    this.overlayImg.style.pointerEvents = 'none';
    this.overlayImg.style.zIndex = '10000';
    this.overlayImg.style.display = 'none';
    this.overlayImg.style.objectFit = 'contain';
    
    document.body.appendChild(this.overlayImg);
  }
  
  /**
   * Create album image wrapper and stack layer
   */
  createAlbumImageWrapper() {
    if (this.albumImageWrapper) return; // Already created
    
    // Create wrapper container
    this.albumImageWrapper = document.createElement('div');
    this.albumImageWrapper.className = 'album-image-wrapper';
    this.albumImageWrapper.style.position = 'fixed';
    this.albumImageWrapper.style.left = '50%';
    this.albumImageWrapper.style.top = '50%';
    this.albumImageWrapper.style.transform = 'translate(-50%, -50%)';
    this.albumImageWrapper.style.width = '60vw';
    this.albumImageWrapper.style.maxHeight = '90vh';
    this.albumImageWrapper.style.margin = '28px'; // Keep more space around image + hint
    this.albumImageWrapper.style.boxSizing = 'border-box';
    this.albumImageWrapper.style.zIndex = '9999'; // Below UI (10000+), above canvas
    this.albumImageWrapper.style.display = 'none';
    this.albumImageWrapper.style.flexDirection = 'column';
    this.albumImageWrapper.style.alignItems = 'center';
    this.albumImageWrapper.style.pointerEvents = 'none';
    
    // Inner container: image + stack layer (stack overlays image only)
    this.albumImageInner = document.createElement('div');
    this.albumImageInner.className = 'album-image-inner';
    this.albumImageInner.style.position = 'relative';
    this.albumImageInner.style.width = '100%';
    this.albumImageInner.style.flexShrink = '0';
    const inner = this.albumImageInner;
    
    // Create main image element
    this.albumMainImage = document.createElement('img');
    this.albumMainImage.className = 'album-main-image';
    this.albumMainImage.style.width = '100%';
    this.albumMainImage.style.height = 'auto';
    this.albumMainImage.style.display = 'block';
    this.albumMainImage.style.objectFit = 'contain';
    this.albumMainImage.style.position = 'relative';
    this.albumMainImage.style.zIndex = '0'; // Bottom of stack – rest of album images appear on top when scrolling
    inner.appendChild(this.albumMainImage);
    
    // HQ crossfade overlay (no refocus when upgrading: new image appears instantly on top)
    this.albumMainImageHq = document.createElement('img');
    this.albumMainImageHq.className = 'album-main-image album-main-image-hq-overlay';
    this.albumMainImageHq.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:2;pointer-events:none;opacity:0;';
    this.albumMainImageHq.dataset.role = 'hq-overlay';
    inner.appendChild(this.albumMainImageHq);
    
    // Create stack layer
    this.albumStackLayer = document.createElement('div');
    this.albumStackLayer.className = 'album-stack-layer';
    this.albumStackLayer.style.position = 'absolute';
    this.albumStackLayer.style.inset = '0';
    this.albumStackLayer.style.pointerEvents = 'none';
    this.albumStackLayer.style.zIndex = '1'; // Above center image (0) so stack images appear on top when scrolling
    inner.appendChild(this.albumStackLayer);
    
    this.albumImageWrapper.appendChild(inner);
    
    // Scroll hint under first image (vertically aligned to image center axis)
    this.albumScrollHintEl = document.createElement('div');
    this.albumScrollHintEl.className = 'album-scroll-hint';
    this.albumScrollHintEl.textContent = 'Scroll to see more';
    this.albumImageWrapper.appendChild(this.albumScrollHintEl);
    
    document.body.appendChild(this.albumImageWrapper);
    
    // Create close button if it doesn't exist (it will be added to body, not wrapper)
    if (!this.closeButtonEl) {
      this.createCloseButton();
    }
  }
  
  /**
   * Generate deterministic random offset for a photo ID
   * Fixed: Ensure symmetric distribution around 0 to prevent top-left bias
   */
  getStackOffset(photoId, imageWidth, imageHeight) {
    const cacheKey = `${photoId}_${imageWidth}_${imageHeight}`;
    if (this.stackOffsets.has(cacheKey)) {
      return this.stackOffsets.get(cacheKey);
    }
    
    // Generate deterministic offset based on photo ID hash
    let hash = 0;
    for (let i = 0; i < photoId.length; i++) {
      const char = photoId.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    // Use fixed small offset (15-20px) for stack effect - images should be slightly offset to the sides
    // This creates a subtle stacking effect where images appear slightly shifted
    const maxOffset = 20; // pixels - small offset to create visible stacking effect
    
    // Use different hash bits for x and y to ensure independence
    const hashX = hash;
    const hashY = (hash >> 8) ^ (hash >> 16); // Mix more bits for better distribution
    
    // Generate symmetric offsets: use hash to get value in [0, 2*maxOffset], then subtract maxOffset
    // This ensures true symmetry around 0 (centered distribution)
    const dxRaw = (Math.abs(hashX) % (maxOffset * 2 + 1)); // 0 to 2*maxOffset
    const dyRaw = (Math.abs(hashY) % (maxOffset * 2 + 1)); // 0 to 2*maxOffset
    
    const dx = dxRaw - maxOffset; // -maxOffset to +maxOffset (symmetric around 0)
    const dy = dyRaw - maxOffset; // -maxOffset to +maxOffset (symmetric around 0)
    
    const rot = 0; // No rotation for now
    
    const offset = { dx, dy, rot };
    this.stackOffsets.set(cacheKey, offset);
    return offset;
  }
  
  /**
   * Get full photoId (photosMap key) for the photo at album index i
   */
  getPhotoIdForAlbumIndex(i) {
    if (i < 0 || i >= this.albumPhotos.length) return null;
    const albumPhoto = this.albumPhotos[i];
    if (this.isFilteredAlbum && albumPhoto._originalPhoto) {
      return albumPhoto._originalPhoto.id;
    }
    const flickrId = String(albumPhoto.id || albumPhoto.photoId || '');
    if (!flickrId) return null;
    for (const [id, p] of this.photosMap.entries()) {
      if (p.photoId && String(p.photoId) === flickrId) return id;
    }
    return null;
  }
  
  /**
   * When main photo changes by scroll: update stack in place (remove new main from stack,
   * add previous main to stack, update indices). Avoids re-creating all elements so the first
   * image etc. don't jump.
   */
  updateStackWhenMainChanges(newMainPhotoId, scrollingBack = false) {
    if (!this.albumStackLayer || !this.albumStackImages.size) return;
    
    const step = this.ALBUM_SCROLL_STEP;
    const dimFallback = this.albumImageInner || this.albumImageWrapper;
    const imageW = this.currentImageDisplayWidth || (dimFallback ? dimFallback.offsetWidth : 0);
    const imageH = this.currentImageDisplayHeight || (dimFallback ? dimFallback.offsetHeight : 0);
    
    // 1. Remove the element that is now main (no longer in stack)
    // Prefer DOM lookup by data-photo-id so we remove the actual visible element (map key can differ from attribute)
    const newIdStr = String(newMainPhotoId);
    let elToRemove = this.albumStackLayer && Array.from(this.albumStackLayer.querySelectorAll('[data-photo-id]')).find(
      el => (el.getAttribute('data-photo-id') || '') === newIdStr
    );
    const foundByDom = !!elToRemove;
    if (!elToRemove) elToRemove = this.albumStackImages.get(newMainPhotoId);
    const foundByMap = !!elToRemove && !foundByDom;
    if (elToRemove && foundByDom) {
      for (const [key, el] of this.albumStackImages.entries()) {
        if (el === elToRemove) {
          this.albumStackImages.delete(key);
          break;
        }
      }
    }
    if (elToRemove && elToRemove.parentNode) {
      elToRemove.parentNode.removeChild(elToRemove);
      if (this.albumStackImages.get(newMainPhotoId) === elToRemove) this.albumStackImages.delete(newMainPhotoId);
    }
    
    // 2. Add the photo that left the main position back to the stack
    // Forward: mainPhotoIndex - 1 goes to "before" with stackIndex -1
    // Backward: mainPhotoIndex + 1 goes to "after" with stackIndex 0
    const oldMainIndex = scrollingBack ? this.mainPhotoIndex + 1 : this.mainPhotoIndex - 1;
    const addStackIndex = scrollingBack ? 0 : -1;
    if (scrollingBack ? oldMainIndex < this.albumPhotos.length : oldMainIndex >= 0) {
      let oldMainPhotoId = null;
      if (this.albumMapKeyToIndex) {
        // Reverse lookup: we need photoId for album index oldMainIndex — use albumPhotos + albumPhotoIdToMapKey
        const ap = this.albumPhotos[oldMainIndex];
        if (ap) {
          if (this.isFilteredAlbum && ap._originalPhoto) oldMainPhotoId = ap._originalPhoto.id;
          else if (this.albumPhotoIdToMapKey) {
            const fid = String(ap.id || ap.photoId || '');
            oldMainPhotoId = this.albumPhotoIdToMapKey.get(fid) || null;
          }
        }
      }
      if (!oldMainPhotoId) oldMainPhotoId = this.getPhotoIdForAlbumIndex(oldMainIndex);
      if (oldMainPhotoId && !this.albumStackImages.has(oldMainPhotoId)) {
        const photo = this.photosMap.get(oldMainPhotoId);
        const albumPhoto = this.albumPhotos[oldMainIndex];
        if (photo && albumPhoto) {
          const sources = this.photoSourcesById.get(oldMainPhotoId);
          const cacheEntry = this.imageCache.get(oldMainPhotoId);
          if (cacheEntry) {
            const stackImg = document.createElement('img');
            stackImg.setAttribute('data-photo-id', oldMainPhotoId);
            stackImg.setAttribute('data-stack-index', addStackIndex);
            stackImg._stackIndex = addStackIndex;
            stackImg.className = 'album-stack-image';
            if (sources) {
              stackImg.dataset.thumbSrc = sources.thumb;
              stackImg.dataset.hqSrc = sources.hq;
              stackImg.dataset.state = 'thumb';
              stackImg.src = sources.thumb;
            } else {
              stackImg.src = cacheEntry.img.src;
            }
            const imgAspect = cacheEntry.aspect || (cacheEntry.img.naturalWidth / cacheEntry.img.naturalHeight);
            const fixedSize = this.calculateImageSize(imgAspect, imageW, imageH);
            stackImg.dataset.originalWidth = String(fixedSize.width);
            stackImg.dataset.originalHeight = String(fixedSize.height);
            stackImg.style.position = 'absolute';
            stackImg.style.left = '50%';
            stackImg.style.top = '50%';
            stackImg.style.width = `${fixedSize.width}px`;
            stackImg.style.height = `${fixedSize.height}px`;
            stackImg.style.marginLeft = `${-fixedSize.width / 2}px`;
            stackImg.style.marginTop = `${-fixedSize.height / 2}px`;
            stackImg.style.objectFit = 'contain';
            stackImg.style.transition = 'none';
            const offset = this.getStackOffset(oldMainPhotoId, fixedSize.width, fixedSize.height);
            stackImg.style.transform = `translate(${offset.dx}px, ${offset.dy}px) scale(1.0)`;
            // Insert after "before main" images, before "after main" (stable DOM order = less reflow/jump)
            const firstAfter = Array.from(this.albumStackLayer.children).find(
              el => parseInt(el.getAttribute('data-stack-index') || '0') >= 0
            );
            if (firstAfter) {
              this.albumStackLayer.insertBefore(stackImg, firstAfter);
            } else {
              this.albumStackLayer.appendChild(stackImg);
            }
            this.albumStackImages.set(oldMainPhotoId, stackImg);
            stackImg.style.opacity = addStackIndex === -1 ? '0.7' : '0'; // -1: visible "before"; 0: first "after" (opacity set by updateAlbumStackOpacities)
          }
        }
      }
    }
    
    // 3. Update data-stack-index on all stack elements (use albumMapKeyToIndex for O(1) per element)
    this.albumStackImages.forEach((stackImg, photoId) => {
      let albumIndex = -1;
      if (this.albumMapKeyToIndex) {
        albumIndex = this.albumMapKeyToIndex.get(photoId) ?? -1;
      } else {
        for (let k = 0; k < this.albumPhotos.length; k++) {
          if (this.getPhotoIdForAlbumIndex(k) === photoId) {
            albumIndex = k;
            break;
          }
        }
      }
      if (albumIndex < 0) return;
      const newStackIndex = albumIndex < this.mainPhotoIndex
        ? -(this.mainPhotoIndex - albumIndex)
        : (albumIndex - this.mainPhotoIndex - 1);
      stackImg.setAttribute('data-stack-index', newStackIndex);
      stackImg._stackIndex = newStackIndex;
    });
    
    // Rebuild index map so updateAlbumStackOpacities only iterates active window
    this.albumStackByIndex.clear();
    this.albumStackImages.forEach((stackImg) => {
      this.albumStackByIndex.set(stackImg._stackIndex, stackImg);
    });
    
    this.updateAlbumStackOpacities();
  }
  
  /**
   * Load album photos array and determine main photo index
   * If filters are active, uses filtered photos instead of loading album.json
   */
  async loadAlbumPhotos(photoId) {
    const photo = this.photosMap.get(photoId);
    if (!photo) {
      return Promise.resolve();
    }
    
    // If filters are active, use filtered photos
    if (this.isFilteredAlbum && this.filteredPhotos.length > 0) {
      // Convert filtered photos to album.json-like structure
      // The albumPhotos array expects objects with id or photoId fields
      this.albumPhotos = this.filteredPhotos.map(p => ({
        id: p.photoId || this.extractPhotoIdFromFilename(p.id),
        photoId: p.photoId || this.extractPhotoIdFromFilename(p.id),
        // Store reference to original photo for metadata access
        _originalPhoto: p
      }));
      
      // O(1) lookup when scrolling: flickrId -> photosMap key (avoid 50k+ iteration per wheel)
      this.albumPhotoIdToMapKey = new Map();
      this.albumPhotos.forEach(ap => {
        const fid = String(ap.id || ap.photoId || '');
        if (ap._originalPhoto && fid) this.albumPhotoIdToMapKey.set(fid, ap._originalPhoto.id);
      });
      this.albumMapKeyToIndex = new Map();
      this.albumPhotos.forEach((ap, i) => {
        if (ap._originalPhoto && ap._originalPhoto.id) this.albumMapKeyToIndex.set(ap._originalPhoto.id, i);
      });
      
      // Main photo is always at index 0 (already reordered in enterAlbumMode)
      this.mainPhotoIndex = 0;
      this.initialMainPhotoIndex = 0;
      
      // Reset scroll and pre-render all stack images
      this.albumScrollDelta = 0;
      this.preRenderAlbumStack();
      
      return Promise.resolve();
    }
    
    // Original logic: load from album.json
    if (!photo.albumKey || !photo.userKey) {
      return Promise.resolve();
    }
    
    try {
      const albumPath = `img/${photo.userKey}/${photo.albumKey}/album.json`;
      const response = await fetch(albumPath);
      if (!response.ok) {
        return Promise.resolve();
      }
      const data = await response.json();
      const album = data.album || data;
      
      // Get photos array from root level (not from album object)
      const allPhotos = data.photos || [];
      
      // Find main photo index in original array
      // photoId is the full path (e.g., "userKey/albumKey/filename"), but album.json photos have numeric id
      // We need to match by the numeric photoId from the photo object
      const targetPhotoId = photo.photoId || this.extractPhotoIdFromFilename(photoId);
      
      const originalMainPhotoIndex = allPhotos.findIndex(p => {
        // Match by photo ID (extract from filename or use id field)
        const photoIdFromPhoto = p.id || p.photoId || this.extractPhotoIdFromFilename(p.filename || p.src || '');
        // Compare numeric IDs (both should be strings for comparison)
        return String(photoIdFromPhoto) === String(targetPhotoId);
      });
      
      // If not found, assume first photo is main
      const mainIndex = originalMainPhotoIndex === -1 ? 0 : originalMainPhotoIndex;
      
      // Reorder albumPhotos: start with selected photo (index 0), then all photos after it, then all photos before it
      // This ensures the selected photo is always at index 0 and we can only scroll forward
      this.albumPhotos = [
        ...allPhotos.slice(mainIndex), // Selected photo + all photos after it
        ...allPhotos.slice(0, mainIndex) // All photos before selected photo
      ];
      
      // O(1) lookup when scrolling: flickrId -> photosMap key (avoid 50k+ iteration per wheel)
      this.albumPhotoIdToMapKey = new Map();
      for (const [id, p] of this.photosMap.entries()) {
        if (p.albumKey === photo.albumKey && p.userKey === photo.userKey && p.photoId != null) {
          this.albumPhotoIdToMapKey.set(String(p.photoId), id);
        }
      }
      // Map photosMap key -> album index for O(1) in updateStackWhenMainChanges
      this.albumMapKeyToIndex = new Map();
      this.albumPhotos.forEach((ap, i) => {
        const fid = String(ap.id || ap.photoId || '');
        const mapKey = this.albumPhotoIdToMapKey.get(fid);
        if (mapKey != null) this.albumMapKeyToIndex.set(mapKey, i);
      });
      
      // Main photo is always at index 0 after reordering
      this.mainPhotoIndex = 0;
      
      // Save the initial main photo index - this is the zero point when entering album
      this.initialMainPhotoIndex = 0;
      
      // Reset scroll and pre-render all stack images
      this.albumScrollDelta = 0;
      this.preRenderAlbumStack();
      
      return Promise.resolve();
    } catch (error) {
      console.warn(`Failed to load album photos for ${photo.albumKey}:`, error);
      return Promise.resolve();
    }
  }
  
  /**
   * Extract photo ID from filename (helper)
   */
  extractPhotoIdFromFilename(filename) {
    const match = filename.match(/(\d{7,})/);
    return match ? match[1] : null;
  }
  
  /**
   * Update main image source and size
   * @param {string} photoId - Photo ID to show as main
   * @param {{ skipWrapperLayout?: boolean }} [options] - If skipWrapperLayout is true, only update image source and meta; do not resize/reposition wrapper (keeps album stack fixed when scrolling)
   */
  updateMainImage(photoId, options = {}) {
    if (!this.albumMainImage || !this.albumImageWrapper) return;
    
    const cacheEntry = this.imageCache.get(photoId);
    if (!cacheEntry || !cacheEntry.img.complete) {
      return;
    }
    
    const img = cacheEntry.img;
    const aspect = cacheEntry.aspect || (img.naturalWidth / img.naturalHeight);
    
    // When only changing which photo is main (e.g. scroll to next/prev), keep wrapper position/size fixed so images don't jump
    if (options.skipWrapperLayout) {
      const sources = this.photoSourcesById.get(photoId);
      if (sources) {
        this.albumMainImage.dataset.photoId = photoId;
        this.albumMainImage.dataset.thumbSrc = sources.thumb;
        this.albumMainImage.dataset.hqSrc = sources.hq;
        this.albumMainImage.dataset.state = 'thumb';
        this.albumMainImage.src = sources.thumb;
      } else {
        this.albumMainImage.src = cacheEntry.img.src;
      }
      this.albumMainImage.style.width = '100%';
      this.albumMainImage.style.height = '100%';
      this.albumMainImage.style.objectFit = 'contain';
      if (this.isFilteredAlbum && this.selectedPhotoId === photoId) {
        this.updateAlbumMetaUI(photoId);
        this.renderAlbumMetaDetails(null);
      }
      return;
    }
    
    // Keep consistent breathing room around the album image,
    // and reserve space for the "Scroll to see more" hint below.
    const margin = 28; // px (top/bottom/left/right)
    const scrollHintReserve = 90; // px reserved under the image
    
    // Step 1: Calculate base "fit to viewport" size (contain logic), accounting for margins
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const baseTargetW = viewportW * 0.60 - (margin * 2);
    const baseTargetH = viewportH * 0.90 - (margin * 2) - scrollHintReserve;
    
    let baseW, baseH;
    if (baseTargetW / aspect <= baseTargetH) {
      baseW = baseTargetW;
      baseH = baseTargetW / aspect;
    } else {
      baseH = baseTargetH;
      baseW = baseTargetH * aspect;
    }
    
    // Step 2: Apply scale boost (make images bigger - 12% larger)
    const scaleBoost = 1.12;
    let boostedW = baseW * scaleBoost;
    let boostedH = baseH * scaleBoost;
    
    // Step 3: Ensure boosted size still fits in viewport with margins (safety check)
    const maxW = viewportW - (margin * 2);
    const maxH = viewportH - (margin * 2) - scrollHintReserve;
    if (boostedW > maxW) {
      boostedW = maxW * 0.95; // 95% of available width with safety margin
      boostedH = boostedW / aspect;
    }
    if (boostedH > maxH) {
      boostedH = maxH * 0.95; // 95% of available height with safety margin
      boostedW = boostedH * aspect;
    }
    
    // Store the actual display size for offset calculations
    this.currentImageDisplayWidth = boostedW;
    this.currentImageDisplayHeight = boostedH;
    
    // Update wrapper size and re-center in viewport (so images stay centered when scrolling to next/prev)
    this.albumImageWrapper.style.width = `${boostedW}px`;
    this.albumImageWrapper.style.height = `${boostedH + scrollHintReserve}px`;
    this.albumImageInner.style.height = `${boostedH}px`;
    const totalH = boostedH + scrollHintReserve;
    this.albumImageWrapper.style.left = `${(window.innerWidth - boostedW) / 2}px`;
    this.albumImageWrapper.style.top = `${(window.innerHeight - totalH) / 2}px`;
    this.albumImageWrapper.style.transform = 'none';
    
    // Update main image with data attributes for HQ upgrade
    const sources = this.photoSourcesById.get(photoId);
    if (sources) {
      this.albumMainImage.dataset.photoId = photoId;
      this.albumMainImage.dataset.thumbSrc = sources.thumb;
      this.albumMainImage.dataset.hqSrc = sources.hq;
      this.albumMainImage.dataset.state = 'thumb';
      // Start with thumb, will upgrade to HQ
      this.albumMainImage.src = sources.thumb;
    } else {
      // Fallback to cache entry
      this.albumMainImage.src = cacheEntry.img.src;
    }
    this.albumMainImage.style.width = '100%';
    this.albumMainImage.style.height = '100%';
    this.albumMainImage.style.objectFit = 'contain';
    
    // Update stack layer size to match
    if (this.albumStackLayer) {
      this.albumStackLayer.style.width = '100%';
      this.albumStackLayer.style.height = '100%';
    }
    
    // Update metadata if in filtered album mode
    if (this.isFilteredAlbum && this.selectedPhotoId === photoId) {
      this.updateAlbumMetaUI(photoId);
      this.renderAlbumMetaDetails(null);
    }
  }
  
  /**
   * Add one photo to the stack (DEPRECATED - now using pre-render + opacity control)
   */
  addStackPhoto() {
    // Ensure wrapper and stack layer exist
    if (!this.albumImageWrapper) {
      this.createAlbumImageWrapper();
    }
    
    if (!this.albumStackLayer) {
      this.createAlbumImageWrapper();
    }
    
    // Re-get stack layer reference if missing (it should be in the wrapper)
    if (!this.albumStackLayer && this.albumImageWrapper) {
      this.albumStackLayer = this.albumImageWrapper.querySelector('.album-stack-layer');
    }
    
    if (!this.albumStackLayer || this.albumPhotos.length === 0) {
      return;
    }
    
    // Calculate next photo index (skip main photo)
    const nextIndex = this.mainPhotoIndex + this.stackIndex + 1;
    
    if (nextIndex >= this.albumPhotos.length) {
      return; // No more photos
    }
    
    const albumPhoto = this.albumPhotos[nextIndex];
    
    // For filtered albums, use _originalPhoto directly
    let photo = null;
    let photoId = null; // This will be the full path ID from photosMap
    
    if (this.isFilteredAlbum && albumPhoto._originalPhoto) {
      photo = albumPhoto._originalPhoto;
      photoId = albumPhoto._originalPhoto.id;
    } else {
      // For regular albums, find photo in photosMap by photoId
      const flickrId = String(albumPhoto.id || albumPhoto.photoId || '');
      
      if (!flickrId) {
        return;
      }
      
      // Search through photosMap to find matching photoId field
      for (const [id, p] of this.photosMap.entries()) {
        if (p.photoId && String(p.photoId) === flickrId) {
          photo = p;
          photoId = id;
          break;
        }
      }
    }
    
    if (!photo || !photoId) {
      return;
    }
    
    // Check if image is already in stack
    const existingImg = this.albumStackLayer.querySelector(`[data-photo-id="${photoId}"]`);
    if (existingImg) {
      return; // Already stacked
    }
    
    // Get image from cache
    let cacheEntry = this.imageCache.get(photoId);
    
    if (!cacheEntry) {
      // Load image asynchronously (use thumb source)
      const sources = this.photoSourcesById.get(photoId);
      const thumbSrc = sources ? sources.thumb : buildImageUrl(photo);
      if (thumbSrc) {
        // Load image asynchronously
        const img = new Image();
        img.decoding = 'async';
        img.loading = 'lazy';
        img.onload = () => {
          // Add to cache
          const aspect = img.naturalWidth / img.naturalHeight;
          this.imageCache.set(photoId, { img, aspect });
          // Try adding again
          this.addStackPhoto();
        };
        img.onerror = () => {
          console.warn('[IMG 404]', img.src, photo || { id: photoId });
        };
        img.src = thumbSrc;
        return; // Will retry after load
      }
      return;
    }
    
    // Create stack image element with data attributes for HQ upgrade
    const stackImg = document.createElement('img');
    stackImg.setAttribute('data-photo-id', photoId);
    stackImg.className = 'album-stack-image';
    
    // Set sources for HQ upgrade
    const sources = this.photoSourcesById.get(photoId);
    if (sources) {
      stackImg.dataset.thumbSrc = sources.thumb;
      stackImg.dataset.hqSrc = sources.hq;
      stackImg.dataset.state = 'thumb';
      // Start with thumb, will upgrade to HQ when visible
      stackImg.src = sources.thumb;
    } else {
      // Fallback to cache entry
      stackImg.src = cacheEntry.img.src;
    }
    // Calculate fixed size for this image based on its aspect ratio
    const imgAspect = cacheEntry.aspect || (cacheEntry.img.naturalWidth / cacheEntry.img.naturalHeight);
    const fallbackEl = this.albumImageInner || this.albumImageWrapper;
    const currentImageW = this.currentImageDisplayWidth || (fallbackEl ? fallbackEl.offsetWidth : 0);
    const currentImageH = this.currentImageDisplayHeight || (fallbackEl ? fallbackEl.offsetHeight : 0);
    const fixedSize = this.calculateImageSize(imgAspect, currentImageW, currentImageH);
    
    // Store fixed size in data attributes
    stackImg.dataset.originalWidth = String(fixedSize.width);
    stackImg.dataset.originalHeight = String(fixedSize.height);
    
    stackImg.style.position = 'absolute';
    stackImg.style.left = '50%';
    stackImg.style.top = '50%';
    stackImg.style.width = `${fixedSize.width}px`;
    stackImg.style.height = `${fixedSize.height}px`;
    stackImg.style.marginLeft = `${-fixedSize.width / 2}px`;
    stackImg.style.marginTop = `${-fixedSize.height / 2}px`;
    stackImg.style.objectFit = 'contain';
    // Get deterministic offset (use fixed size for offset calculation)
    const offset = this.getStackOffset(photoId, fixedSize.width, fixedSize.height);
    
    // Set initial state (slightly offset and scaled down for "float in" effect)
    stackImg.style.opacity = '0';
    stackImg.style.transition = `opacity ${this.ADD_ANIMATION_DURATION}ms cubic-bezier(0.16, 1, 0.3, 1), transform ${this.ADD_ANIMATION_DURATION}ms cubic-bezier(0.16, 1, 0.3, 1)`;
    stackImg.style.transform = `translate(${offset.dx}px, ${offset.dy}px) scale(0.985)`;
    
    this.albumStackLayer.appendChild(stackImg);
    this.stackIndex++;
    
    // Trigger fade-in and float-in animation (immediate, no double RAF delay)
    requestAnimationFrame(() => {
      stackImg.style.opacity = '0.7';
      stackImg.style.transform = `translate(${offset.dx}px, ${offset.dy}px) scale(1.0)`;
    });
  }
  
  /**
   * Remove one photo from the stack (DEPRECATED - now using pre-render + opacity control)
   */
  removeStackPhoto() {
    // No-op: images are pre-rendered and controlled via opacity
  }
  
  /**
   * Handle wheel event in album view
   * Direct mapping: wheel delta → scroll value (no lerp, no velocity, no inertia)
   */
  handleAlbumWheel(e) {
    if (this.viewMode !== 'album' || this.transition.active || this.exitTransitionActive) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    
    const deltaY = normalizedWheelDelta(e);
    const step = this.ALBUM_SCROLL_STEP;
    
    // Calculate scroll range
    // Max forward: (total photos - 1) * step (excluding main photo at index 0)
    const maxDeltaForward = (this.albumPhotos.length - 1) * step;
    // Max backward: can go back to -(mainPhotoIndex * step) to reach index 0
    // If at index 0, maxDeltaBackward is 0 (can't scroll backward)
    const maxDeltaBackward = this.mainPhotoIndex > 0 ? -(this.mainPhotoIndex * step) : 0;
    
    // Block backward scrolling only when at index 0 with scrollDelta = 0
    // Once we've scrolled forward (mainPhotoIndex > 0 or scrollDelta > 0), allow backward scrolling
    const isAtZeroPoint = this.mainPhotoIndex === 0 && this.albumScrollDelta === 0;
    
    if (isAtZeroPoint && deltaY <= 0) {
      return; // Exit early, don't process backward scroll
    }
    
    // Fade "Scroll to see more" hint on first scroll (forward)
    if (isAtZeroPoint && deltaY > 0 && !this.albumScrollHintFaded && this.albumScrollHintEl) {
      this.albumScrollHintFaded = true;
      this.albumScrollHintEl.classList.add('is-faded');
    }
    
    // Calculate potential new scroll delta
    let potentialNewScrollDelta = this.albumScrollDelta + deltaY;
    
    // Clamp to valid range
    potentialNewScrollDelta = Math.max(maxDeltaBackward, Math.min(maxDeltaForward, potentialNewScrollDelta));
    
    // Update scroll delta
    this.albumScrollDelta = potentialNewScrollDelta;
    
    // Calculate which photo should be the main photo based on scroll position
    // When scroll >= step, we've moved to the next photo
    // When scroll < 0, we've moved to the previous photo (only possible if we've scrolled forward first)
    let newMainPhotoIndex = this.mainPhotoIndex;
    if (this.albumScrollDelta >= step) {
      // Scrolled forward - calculate how many photos forward
      const photosForward = Math.floor(this.albumScrollDelta / step);
      newMainPhotoIndex = Math.min(this.albumPhotos.length - 1, this.mainPhotoIndex + photosForward);
      // Adjust scroll delta to be relative to new main photo
      this.albumScrollDelta = this.albumScrollDelta % step;
    } else if (this.albumScrollDelta < 0 && this.mainPhotoIndex > 0) {
      // Scrolled backward - calculate how many photos backward
      // Only allow if we're not at index 0
      const photosBackward = Math.ceil(Math.abs(this.albumScrollDelta) / step);
      newMainPhotoIndex = Math.max(0, this.mainPhotoIndex - photosBackward);
      // Adjust scroll delta to be relative to new main photo
      this.albumScrollDelta = this.albumScrollDelta + (photosBackward * step);
      
      // If we've reached index 0, reset scroll delta to 0
      if (newMainPhotoIndex === 0) {
        this.albumScrollDelta = 0;
      }
    }
    
    // Update main photo if it changed
    if (newMainPhotoIndex !== this.mainPhotoIndex) {
      const scrollingBack = newMainPhotoIndex < this.mainPhotoIndex;
      this.mainPhotoIndex = newMainPhotoIndex;
      
      // If we're now at index 0, ensure scrollDelta is 0
      if (this.mainPhotoIndex === 0) {
        this.albumScrollDelta = 0;
      }
      
      // Find the photo ID for the new main photo
      const newMainPhoto = this.albumPhotos[this.mainPhotoIndex];
      if (newMainPhoto) {
        let newMainPhotoId = null;
        
        // For filtered albums, use _originalPhoto.id directly (it's the key in photosMap)
        if (this.isFilteredAlbum && newMainPhoto._originalPhoto) {
          newMainPhotoId = newMainPhoto._originalPhoto.id;
        } else if (this.albumPhotoIdToMapKey) {
          const flickrId = String(newMainPhoto.id || newMainPhoto.photoId || '');
          newMainPhotoId = this.albumPhotoIdToMapKey.get(flickrId) || null;
        } else {
          const flickrId = String(newMainPhoto.id || newMainPhoto.photoId || '');
          for (const [id, p] of this.photosMap.entries()) {
            if (p.photoId && String(p.photoId) === flickrId) {
              newMainPhotoId = id;
              break;
            }
          }
        }
        
        if (newMainPhotoId) {
          this.selectedPhotoId = newMainPhotoId;
          this.updateMainImage(newMainPhotoId, { skipWrapperLayout: true });
          
          if (this.isFilteredAlbum) {
            this.updateAlbumMetaUI(newMainPhotoId);
            this.renderAlbumMetaDetails(null);
          } else if (this.albumData) {
            this.renderAlbumMetaDetails(this.albumData);
          }
          
          this.updateStackWhenMainChanges(newMainPhotoId, scrollingBack);
        }
      }
    } else {
      // Main photo didn't change, just update opacities
      this.updateAlbumStackOpacities();
    }
  }
  
  /**
   * Pre-render all album stack images (called once when entering album view)
   * IMPORTANT: This renders ALL photos from albumPhotos array, ignoring drawer filters.
   * Album view must show the complete album regardless of active filters.
   */
  preRenderAlbumStack() {
    if (!this.albumStackLayer || this.albumPhotos.length === 0) {
      return;
    }
    
    // Build new stack in a separate container, then swap in one step (no visible empty frame)
    const newLayer = document.createElement('div');
    newLayer.className = 'album-stack-layer';
    newLayer.style.position = 'absolute';
    newLayer.style.inset = '0';
    newLayer.style.pointerEvents = 'none';
    newLayer.style.width = '100%';
    newLayer.style.height = '100%';
    const newMap = new Map();
    const newIndexMap = new Map(); // stackIndex -> element for fast opacity loop
    
    // Get image dimensions for offset calculations
    const dimFallback = this.albumImageInner || this.albumImageWrapper;
    const imageW = this.currentImageDisplayWidth || (dimFallback ? dimFallback.offsetWidth : 0);
    const imageH = this.currentImageDisplayHeight || (dimFallback ? dimFallback.offsetHeight : 0);
    
    // Pre-render all stack images (skip main photo)
    // Since mainPhotoIndex is always 0 after reordering, all other photos are after it
    // All stack indices will be positive (no negative indices)
    for (let i = 0; i < this.albumPhotos.length; i++) {
      // Skip main photo (always at index 0)
      if (i === this.mainPhotoIndex) continue;
      
      const albumPhoto = this.albumPhotos[i];
      
      // For filtered albums, use _originalPhoto directly
      let photo = null;
      let photoId = null;
      
      if (this.isFilteredAlbum && albumPhoto._originalPhoto) {
        photo = albumPhoto._originalPhoto;
        photoId = albumPhoto._originalPhoto.id;
      } else {
        // For regular albums, find photo in photosMap by photoId
        const flickrId = String(albumPhoto.id || albumPhoto.photoId || '');
        
        if (!flickrId) continue;
        
        // Find photo in photosMap
        for (const [id, p] of this.photosMap.entries()) {
          if (p.photoId && String(p.photoId) === flickrId) {
            photo = p;
            photoId = id;
            break;
          }
        }
      }
      
      if (!photo || !photoId) continue;
      
      // Get sources once for this photo
      const sources = this.photoSourcesById.get(photoId);
      
      // Get or load image (use thumb source for drawer)
      let cacheEntry = this.imageCache.get(photoId);
      if (!cacheEntry) {
        // Use thumb source from photo sources mapping, or build from photo
        const thumbSrc = sources ? sources.thumb : buildImageUrl(photo);
        if (thumbSrc) {
          // Create image and load asynchronously
          const img = new Image();
          img.decoding = 'async';
          img.loading = 'lazy';
          img.onerror = () => {
            console.warn('[IMG 404]', img.src, photo || { id: photoId });
          };
          img.src = thumbSrc;
          // If image is already loaded, use it immediately
          if (img.complete && img.naturalWidth > 0) {
            const aspect = img.naturalWidth / img.naturalHeight;
            cacheEntry = { img, aspect };
            this.imageCache.set(photoId, cacheEntry);
          } else {
            // Load asynchronously - create DOM element now, update when loaded
            // Create stack image element immediately (even though image isn't loaded yet)
            const stackImg = document.createElement('img');
            stackImg.setAttribute('data-photo-id', photoId);
            // Stack index: negative for photos before main, positive for photos after main
            // Since albumPhotos is reordered so selected photo is at index 0, mainPhotoIndex starts at 0
            // But mainPhotoIndex can grow as we scroll forward
            const stackIndex = i < this.mainPhotoIndex ? -(this.mainPhotoIndex - i) : (i - this.mainPhotoIndex - 1);
            stackImg.setAttribute('data-stack-index', stackIndex);
            stackImg._stackIndex = stackIndex;
            stackImg.className = 'album-stack-image';
            
            // Set sources for HQ upgrade
            if (sources) {
              stackImg.dataset.thumbSrc = sources.thumb;
              stackImg.dataset.hqSrc = sources.hq;
              stackImg.dataset.state = 'thumb';
              stackImg.src = sources.thumb;
            }
            // Calculate fixed size for this image based on its aspect ratio
            // Use current wrapper size as reference, but image will keep this size even if wrapper changes
            const imgAspect = cacheEntry ? cacheEntry.aspect : (img.naturalWidth / img.naturalHeight);
            const fixedSize = this.calculateImageSize(imgAspect, imageW, imageH);
            
            // Store fixed size in data attributes
            stackImg.dataset.originalWidth = String(fixedSize.width);
            stackImg.dataset.originalHeight = String(fixedSize.height);
            
            stackImg.style.position = 'absolute';
            stackImg.style.left = '50%';
            stackImg.style.top = '50%';
            stackImg.style.width = `${fixedSize.width}px`;
            stackImg.style.height = `${fixedSize.height}px`;
            stackImg.style.marginLeft = `${-fixedSize.width / 2}px`;
            stackImg.style.marginTop = `${-fixedSize.height / 2}px`;
            stackImg.style.objectFit = 'contain';
            stackImg.style.opacity = '0';
            stackImg.style.transition = 'none';
            // Match updateAlbumStackOpacities: z = album index (image 1 → 0, image 2 → 1, …)
            const albumIdx = i;
            stackImg.style.zIndex = String(albumIdx);
            
            // Get deterministic offset (use fixed size for offset calculation)
            const offset = this.getStackOffset(photoId, fixedSize.width, fixedSize.height);
            const transformValue = `translate(${offset.dx}px, ${offset.dy}px) scale(1.0)`;
            stackImg.style.transform = transformValue;
            
            // Add to new layer (will swap entire layer at end)
            newLayer.appendChild(stackImg);
            newMap.set(photoId, stackImg);
            newIndexMap.set(stackIndex, stackImg);
            
            // Update cache and opacity when image loads
            img.onload = () => {
              const aspect = img.naturalWidth / img.naturalHeight;
              this.imageCache.set(photoId, { img, aspect });
              
              // If image size wasn't set yet (because aspect wasn't known), calculate and set it now
              if (!stackImg.dataset.originalWidth) {
                const dimFb = this.albumImageInner || this.albumImageWrapper;
                const currentImageW = this.currentImageDisplayWidth || (dimFb ? dimFb.offsetWidth : 0);
                const currentImageH = this.currentImageDisplayHeight || (dimFb ? dimFb.offsetHeight : 0);
                const fixedSize = this.calculateImageSize(aspect, currentImageW, currentImageH);
                
                stackImg.dataset.originalWidth = String(fixedSize.width);
                stackImg.dataset.originalHeight = String(fixedSize.height);
                stackImg.style.width = `${fixedSize.width}px`;
                stackImg.style.height = `${fixedSize.height}px`;
                stackImg.style.marginLeft = `${-fixedSize.width / 2}px`;
                stackImg.style.marginTop = `${-fixedSize.height / 2}px`;
                
                // Update offset with correct size
                const offset = this.getStackOffset(photoId, fixedSize.width, fixedSize.height);
                stackImg.style.transform = `translate(${offset.dx}px, ${offset.dy}px) scale(1.0)`;
              }
              
              // Update opacity now that image is loaded
              this.updateAlbumStackOpacities();
            };
            continue; // Continue to next photo, this one will appear when loaded
          }
        }
      }
      
      if (!cacheEntry) {
        continue;
      }
      
      // Create stack image element with data attributes for HQ upgrade
      const stackImg = document.createElement('img');
      stackImg.setAttribute('data-photo-id', photoId);
      // Stack index: negative for photos before main, positive for photos after main
      // Since albumPhotos is reordered so selected photo is at index 0, mainPhotoIndex starts at 0
      // But mainPhotoIndex can grow as we scroll forward
      const stackIndex = i < this.mainPhotoIndex ? -(this.mainPhotoIndex - i) : (i - this.mainPhotoIndex - 1);
      
      stackImg.setAttribute('data-stack-index', stackIndex);
      stackImg._stackIndex = stackIndex;
      stackImg.className = 'album-stack-image';
      
      // Set sources for HQ upgrade (reuse sources from above)
      if (sources) {
        stackImg.dataset.thumbSrc = sources.thumb;
        stackImg.dataset.hqSrc = sources.hq;
        stackImg.dataset.state = 'thumb';
        // Start with thumb, will upgrade to HQ when visible
        stackImg.src = sources.thumb;
      } else {
        // Fallback to cache entry
        stackImg.src = cacheEntry.img.src;
      }
      // Calculate fixed size for this image based on its aspect ratio
      // Use current wrapper size as reference, but image will keep this size even if wrapper changes
      const imgAspect = cacheEntry.aspect || (cacheEntry.img.naturalWidth / cacheEntry.img.naturalHeight);
      const fixedSize = this.calculateImageSize(imgAspect, imageW, imageH);
      
      // Store fixed size in data attributes
      stackImg.dataset.originalWidth = String(fixedSize.width);
      stackImg.dataset.originalHeight = String(fixedSize.height);
      
      stackImg.style.position = 'absolute';
      stackImg.style.left = '50%';
      stackImg.style.top = '50%';
      stackImg.style.width = `${fixedSize.width}px`;
      stackImg.style.height = `${fixedSize.height}px`;
      stackImg.style.marginLeft = `${-fixedSize.width / 2}px`;
      stackImg.style.marginTop = `${-fixedSize.height / 2}px`;
      stackImg.style.objectFit = 'contain';
      stackImg.style.opacity = '0'; // Start invisible
      stackImg.style.transition = 'none'; // No transitions - direct opacity control
      // Match updateAlbumStackOpacities: z = album index (image 1 → 0, image 2 → 1, …)
      const albumIdx = i;
      stackImg.style.zIndex = String(albumIdx);
      
      // Get deterministic offset (use fixed size for offset calculation)
      const offset = this.getStackOffset(photoId, fixedSize.width, fixedSize.height);
      const transformValue = `translate(${offset.dx}px, ${offset.dy}px) scale(1.0)`;
      stackImg.style.transform = transformValue;
      
      newLayer.appendChild(stackImg);
      newMap.set(photoId, stackImg);
      newIndexMap.set(stackIndex, stackImg);
    }
    
    // Replace entire stack layer in one step so old content stays visible until new is ready
    const parent = this.albumStackLayer.parentNode;
    if (parent) {
      parent.replaceChild(newLayer, this.albumStackLayer);
      this.albumStackLayer = newLayer;
    } else {
      this.albumStackLayer.innerHTML = '';
      while (newLayer.firstChild) this.albumStackLayer.appendChild(newLayer.firstChild);
    }
    this.albumStackImages = newMap;
    this.albumStackByIndex = newIndexMap;
    
    // Update opacities based on initial scroll (0)
    this.updateAlbumStackOpacities();
  }
  
  /**
   * Calculate image display size based on aspect ratio and current wrapper size
   * Returns fixed pixel dimensions that preserve aspect ratio
   */
  calculateImageSize(aspect, referenceWidth, referenceHeight) {
    // Use the same logic as updateMainImage to calculate size
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    
    // Keep consistent breathing room around the album image,
    // and reserve space for the "Scroll to see more" hint below.
    const margin = 28; // px (top/bottom/left/right)
    const scrollHintReserve = 90; // px reserved under the image
    
    const baseTargetW = viewportW * 0.60 - (margin * 2);
    const baseTargetH = viewportH * 0.90 - (margin * 2) - scrollHintReserve;
    
    let baseW, baseH;
    if (baseTargetW / aspect <= baseTargetH) {
      baseW = baseTargetW;
      baseH = baseTargetW / aspect;
    } else {
      baseH = baseTargetH;
      baseW = baseTargetH * aspect;
    }
    
    // Apply scale boost (same as main image)
    const scaleBoost = 1.12;
    let boostedW = baseW * scaleBoost;
    let boostedH = baseH * scaleBoost;
    
    // Ensure boosted size still fits in viewport with margins
    const maxW = viewportW - (margin * 2);
    const maxH = viewportH - (margin * 2) - scrollHintReserve;
    if (boostedW > maxW) {
      boostedW = maxW * 0.95;
      boostedH = boostedW / aspect;
    }
    if (boostedH > maxH) {
      boostedH = maxH * 0.95;
      boostedW = boostedH * aspect;
    }
    
    return { width: boostedW, height: boostedH };
  }
  
  /**
   * Update opacities of all stack images based on current scroll position
   * Linear, deterministic fade based on scroll thresholds.
   * Only opacity updates are limited to "active" window for performance; z-index is updated for
   * ALL stack images every time so no stale high z can let an old image show through the latest.
   */
  updateAlbumStackOpacities() {
    if (!this.albumStackLayer || !this.albumStackByIndex) return;
    
    const step = this.ALBUM_SCROLL_STEP;
    const scroll = this.albumScrollDelta;
    
    // Active window for opacity (avoids 277 style writes when not needed)
    const scrollStepIndex = Math.floor(scroll / step);
    const activeWindowHalf = 30;
    const minActive = Math.max(-(this.mainPhotoIndex || 0), -activeWindowHalf);
    const maxActive = Math.min(scrollStepIndex + activeWindowHalf, (this.albumPhotos.length || 1) - 1);
    
    // First pass: set opacity only for active window
    for (let stackIndex = minActive; stackIndex <= maxActive; stackIndex++) {
      const stackImg = this.albumStackByIndex.get(stackIndex);
      if (!stackImg) continue;
      
      const fadeStart = stackIndex * step;
      const fadeEnd = stackIndex < 0 ? Math.max(0, (stackIndex + 1) * step) : (stackIndex + 1) * step;
      
      let opacity = 0;
      if (stackIndex < 0) {
        // "Before" (photos we scrolled past): keep visible (0.7) so they stay in the stack on top of center.
        if (scroll <= fadeStart) {
          opacity = 0.7;
        } else if (scroll < fadeEnd) {
          const t = (scroll - fadeStart) / step;
          opacity = (1 - t) * 0.7;
        } else {
          const albumIndex = this.mainPhotoIndex + stackIndex;
          opacity = albumIndex === 0 ? 0 : 0.7;
        }
      } else {
        if (scroll >= fadeEnd) {
          opacity = 0.7;
        } else if (scroll > fadeStart) {
          const t = (scroll - fadeStart) / step;
          opacity = t * 0.7;
        } else {
          opacity = 0;
        }
      }
      
      stackImg.style.opacity = String(opacity);
    }
    
    // Second pass: set z-index for ALL stack images by album order.
    // Rule: image 1 → z 0, image 2 → z 1, image 3 → z 2, … so the latest (current) is on top.
    for (const [stackIndex, stackImg] of this.albumStackByIndex) {
      const albumIndex = stackIndex < 0
        ? this.mainPhotoIndex + stackIndex
        : this.mainPhotoIndex + 1 + stackIndex;
      stackImg.style.zIndex = String(albumIndex);
    }
    // Orphans: elements in the layer that are not in albumStackByIndex (duplicate stackIndex overwrote them).
    // Force them to bottom and hidden so they never show on top.
    if (this.albumStackLayer) {
      const inMap = new Set(this.albumStackByIndex.values());
      Array.from(this.albumStackLayer.children).forEach(c => {
        if (!inMap.has(c)) {
          c.style.zIndex = '1';
          c.style.opacity = '0';
        }
      });
    }
  }
  
  /**
   * Update scroll hint visibility based on album photos count
   */
  updateScrollHintVisibility() {
    if (!this.albumScrollHintEl) return;
    
    // Reset scroll hint (visible, not faded) — only show when album has more than one photo
    this.albumScrollHintFaded = false;
    this.albumScrollHintEl.classList.remove('is-faded');
    this.albumScrollHintEl.style.display = this.albumPhotos.length > 1 ? '' : 'none';
  }
  
  /**
   * Show album image wrapper at exact rect position (matches canvas transition end)
   * This ensures no visible jump between canvas and wrapper
   */
  showAlbumImageWrapperAtRect(rect) {
    if (!this.albumImageWrapper) return;
    
    // Use viewport-centered positioning so album stays centered (no drift on scroll/resize)
    this.albumImageWrapper.style.margin = '0';
    this.albumImageWrapper.style.left = `${(window.innerWidth - rect.w) / 2}px`;
    this.albumImageWrapper.style.top = `${(window.innerHeight - rect.h) / 2}px`;
    this.albumImageWrapper.style.transform = 'none';
    this.albumImageWrapper.style.width = `${rect.w}px`;
    this.albumImageWrapper.style.height = `${rect.h}px`;
    
    // Set inner container to full size (no scroll hint space - that's handled by wrapper)
    if (this.albumImageInner) {
      this.albumImageInner.style.height = `${rect.h}px`;
    }
    
    // Store dimensions for stack offset calculations
    this.currentImageDisplayWidth = rect.w;
    this.currentImageDisplayHeight = rect.h;
    
    // Show wrapper instantly
    this.albumImageWrapper.style.display = 'flex';
    this.albumImageWrapper.style.opacity = '1';
    this.albumImageWrapper.style.transition = 'none';
    
    // Show close button
    if (this.closeButtonEl) {
      this.closeButtonEl.style.display = 'block';
    }
    
    // Hide scroll hint initially (will show after transition settles)
    if (this.albumScrollHintEl) {
      this.albumScrollHintEl.style.display = 'none';
    }
    
    // Update main image if we have a selected photo
    if (this.selectedPhotoId) {
      // Set image source but don't recalculate size (we already set it to match canvas)
      const tile = this.tiles.find(t => t.id === this.selectedPhotoId);
      if (tile) {
        const cacheEntry = this.imageCache.get(this.selectedPhotoId);
        if (cacheEntry) {
          const sources = this.photoSourcesById.get(this.selectedPhotoId);
          if (sources) {
            this.albumMainImage.dataset.photoId = this.selectedPhotoId;
            this.albumMainImage.dataset.thumbSrc = sources.thumb;
            this.albumMainImage.dataset.hqSrc = sources.hq;
            this.albumMainImage.dataset.state = 'thumb';
            this.albumMainImage.src = sources.thumb;
          } else {
            this.albumMainImage.src = cacheEntry.img.src;
          }
          this.albumMainImage.style.width = '100%';
          this.albumMainImage.style.height = '100%';
          this.albumMainImage.style.objectFit = 'contain';
        }
      }
    }
    
    // Show scroll hint after a short delay
    setTimeout(() => {
      if (this.albumScrollHintEl && this.viewMode === 'album') {
        this.albumScrollHintEl.style.display = '';
        this.updateScrollHintVisibility();
      }
    }, 300);
  }
  
  /**
   * Show album image wrapper
   */
  showAlbumImageWrapper(fadeIn = true) {
    if (!this.albumImageWrapper) return;
    this.albumImageWrapper.style.display = 'flex';
    
    // Show close button
    if (this.closeButtonEl) {
      this.closeButtonEl.style.display = 'block';
    }
    
    // Update scroll hint visibility (will use current albumPhotos length)
    this.updateScrollHintVisibility();
    
    // Fade in animation if requested
    if (fadeIn) {
      this.albumImageWrapper.style.opacity = '0';
      this.albumImageWrapper.style.transition = 'opacity 300ms ease';
      void this.albumImageWrapper.offsetWidth; // Force reflow
      requestAnimationFrame(() => {
        if (this.albumImageWrapper) {
          this.albumImageWrapper.style.opacity = '1';
        }
      });
    } else {
      // Show immediately without fade
      this.albumImageWrapper.style.opacity = '1';
      this.albumImageWrapper.style.transition = 'none';
    }
    
    // Update main image if we have a selected photo
    if (this.selectedPhotoId) {
      this.updateMainImage(this.selectedPhotoId);
    }
  }
  
  /**
   * Hide album image wrapper
   */
  hideAlbumImageWrapper() {
    if (!this.albumImageWrapper) return;
    this.albumImageWrapper.style.display = 'none';
    
    // Reset positioning to CSS-centered for next use
    this.albumImageWrapper.style.left = '50%';
    this.albumImageWrapper.style.top = '50%';
    this.albumImageWrapper.style.transform = 'translate(-50%, -50%)';
    this.albumImageWrapper.style.margin = '28px'; // Restore margin
    
    // Hide close button
    if (this.closeButtonEl) {
      this.closeButtonEl.style.display = 'none';
    }
    
    // Clear stack
    if (this.albumStackLayer) {
      this.albumStackLayer.innerHTML = '';
    }
    this.albumStackImages.clear();
    if (this.albumStackByIndex) this.albumStackByIndex.clear();
    this.albumPhotoIdToMapKey = null;
    this.albumMapKeyToIndex = null;
    this.albumScrollDelta = 0;
  }
  
  /**
   * Get tile screen rect for a given camera state (pure function)
   */
  getTileScreenRectForState(tileId, state) {
    const tile = this.tiles.find(t => t.id === tileId);
    if (!tile) return null;
    
    // World position (base) - start with natural position
    let worldX = tile.x;
    let worldY = tile.y;
    
    // Account for focus collapse if it was active when state was saved
    const hasActiveFilter = (state.activeLocations && state.activeLocations.size > 0) || 
                           (state.activeYears && state.activeYears.size > 0) || 
                           (state.activeKeywords && state.activeKeywords.size > 0);
    
    if (hasActiveFilter && this.focusOffsets.size > 0 && 
        this.focusAnchorX !== null && this.focusAnchorY !== null && 
        state.focusProgress && state.focusProgress > 0.001) {
      const offset = this.focusOffsets.get(tileId);
      if (offset) {
        const focusX = this.focusAnchorX + offset.ox;
        const focusY = this.focusAnchorY + offset.oy;
        worldX = lerp(tile.x, focusX, state.focusProgress);
        worldY = lerp(tile.y, focusY, state.focusProgress);
      }
    }
    
    // Convert world position to screen space using the saved state
    // screenX/screenY is the tile's TOP-LEFT corner in screen space
    const screenX = (worldX - state.cameraX) * state.zoom + this.width / 2;
    const screenY = (worldY - state.cameraY) * state.zoom + this.height / 2;
    
    // Get actual drawn size (preserving aspect ratio)
    const cacheEntry = this.imageCache.get(tileId);
    const aspect = cacheEntry && cacheEntry.aspect ? cacheEntry.aspect : (tile.w / tile.h);
    
    let dw, dh;
    if (tile.w / tile.h > aspect) {
      dh = tile.h * state.zoom;
      dw = dh * aspect;
    } else {
      dw = tile.w * state.zoom;
      dh = dw / aspect;
    }
    
    // Center image inside tile (same formula as tile rendering)
    const tileScreenW = tile.w * state.zoom;
    const tileScreenH = tile.h * state.zoom;
    const dx = screenX + (tileScreenW - dw) / 2;
    const dy = screenY + (tileScreenH - dh) / 2;
    
    return { x: dx, y: dy, w: dw, h: dh };
  }
  
  /**
   * Start exit transition animation
   */
  startExitTransition() {
    if (!this.activeTileId || !this.prevState) {
      // Fallback: immediate exit without animation
      this.exitAlbumModeImmediate();
      return;
    }
    
    // Get the image source
    const cacheEntry = this.imageCache.get(this.activeTileId);
    if (!cacheEntry || !cacheEntry.img.complete) {
      // Image not loaded, fallback to immediate exit
      this.exitAlbumModeImmediate();
      return;
    }
    
    // Create overlay if needed
    this.createOverlayImage();
    
    // Use the same image that is currently displayed (possibly HQ) so there is no flash
    const displaySrc = (this.albumMainImage && (this.albumMainImage.currentSrc || this.albumMainImage.src)) || cacheEntry.img.src;
    this.overlayImg.src = displaySrc;
    
    // Start rect: current album image rect (centered, large)
    const tile = this.tiles.find(t => t.id === this.activeTileId);
    if (!tile) {
      this.exitAlbumModeImmediate();
      return;
    }
    const startRect = this.computeAlbumEndRect(tile);
    
    // End rect: compute based on prevState (where camera will be restored to)
    // This ensures the overlay animates to the exact position where the tile will appear
    const endRect = this.getTileScreenRectForState(this.activeTileId, this.prevState);
    
    if (!endRect) {
      // Couldn't compute end rect, fallback to immediate exit
      this.exitAlbumModeImmediate();
      return;
    }
    
    // Start exit transition
    this.exitTransitionActive = true;
    this.exitTransitionStartTime = performance.now();
    
    // Hide album meta UI with fade out animation
    this.hideAlbumMetaUI();
    
    // Hide album metadata details
    this.hideAlbumMetaDetails();
    this.albumData = null;
    
    // Position and show overlay FIRST (before hiding wrapper to avoid flash)
    this.overlayImg.style.left = `${startRect.x}px`;
    this.overlayImg.style.top = `${startRect.y}px`;
    this.overlayImg.style.width = `${startRect.w}px`;
    this.overlayImg.style.height = `${startRect.h}px`;
    this.overlayImg.style.opacity = '1'; // Explicit opacity for CSS transition to work
    this.overlayImg.style.transition = ''; // Clear any previous transition
    this.overlayImg.style.display = 'block';
    
    // NOW hide the album image wrapper (overlay is already visible on top)
    this.hideAlbumImageWrapper();
    
    // Store transition data
    this.exitStartRect = startRect;
    this.exitEndRect = endRect;
    
    // Ensure render loop is running
    if (!this.animationFrameId) {
      this.startRenderLoop();
    }
    
  }
  
  /**
   * Start fade-out transition animation (for navigating to user page)
   * This fades out the album image instead of flying it back to tile position
   */
  startFadeOutTransition() {
    const fadeDuration = 650; // ms - balanced fade for transition to user page
    const fadeEasing = 'cubic-bezier(0.4, 0, 0.2, 1)';
    const fadeTransition = `opacity ${fadeDuration}ms ${fadeEasing}`;
    
    const pageContainer = document.getElementById('page-container');
    const canvas = document.getElementById('canvas');
    
    // Enable smooth transition on nav bars for this fade-out
    document.body.classList.add('album-exit-fade');
    
    // CRITICAL: Clear page container content AND hide it to prevent index flash
    // Even if main.js shows it immediately, there's nothing to see
    if (pageContainer) {
      pageContainer.innerHTML = '';
      pageContainer.classList.remove('fade-in');
      pageContainer.classList.add('fade-out');
      pageContainer.style.transition = 'none';
      pageContainer.style.display = 'none';
      pageContainer.style.opacity = '0';
      pageContainer.style.visibility = 'hidden';
      void pageContainer.offsetHeight; // Force synchronous reflow
    }
    
    // Also ensure canvas is hidden
    if (canvas) {
      canvas.style.display = 'none';
    }
    
    // Hide album meta UI with smooth fade (same duration as album image)
    if (this.albumMetaEl) {
      this.albumMetaEl.style.transition = fadeTransition;
      this.albumMetaEl.style.opacity = '0';
    }
    
    // Hide album metadata details with same smooth fade
    if (this.albumMetaDetailsEl) {
      this.albumMetaDetailsEl.style.transition = fadeTransition;
      this.albumMetaDetailsEl.style.opacity = '0';
    }
    this.albumData = null;
    
    // Fade out the album image wrapper with same duration
    if (this.albumImageWrapper) {
      this.albumImageWrapper.style.transition = fadeTransition;
      this.albumImageWrapper.style.opacity = '0';
    }
    
    // Fade out UI (menu bars) over the same duration for a unified feel
    const navHeight = 15 + 40 + 35;
    document.documentElement.style.setProperty('--uiAlpha', '0');
    document.documentElement.style.setProperty('--navTranslateY', `-${navHeight}px`);
    
    // After fade completes, navigate to user page
    setTimeout(() => {
      const username = this.navigateToUserAfterExit;
      // If state was cleared (e.g. user opened another album from user page), do not navigate
      if (!username) return;

      // Reset state
      this.navigateToUserAfterExit = null;
      this.fromIndex = false;
      this.viewMode = 'drawer';
      this.selectedPhotoId = null;
      this.activeTileId = null;
      this.enterTileRect = null;
      
      // Hide album meta elements completely (after fade)
      if (this.albumMetaEl) {
        this.albumMetaEl.style.display = 'none';
        this.albumMetaEl.style.transition = '';
        this.albumMetaEl.style.opacity = '';
        this.albumMetaEl.classList.remove('album-meta-enter', 'album-meta-exit');
      }
      if (this.albumMetaDetailsEl) {
        this.albumMetaDetailsEl.style.display = 'none';
        this.albumMetaDetailsEl.style.transition = '';
        this.albumMetaDetailsEl.style.opacity = '';
      }
      
      // Disconnect observer and downgrade all album images
      if (this.albumImageObserver) {
        this.albumImageObserver.disconnect();
      }
      this.downgradeAllAlbumImages();
      
      // Hide album image wrapper
      this.hideAlbumImageWrapper();
      if (this.albumImageWrapper) {
        this.albumImageWrapper.style.transition = '';
        this.albumImageWrapper.style.opacity = '';
      }
      
      // Hide canvas to prevent drawer from showing
      const canvas = document.getElementById('canvas');
      if (canvas) {
        canvas.style.display = 'none';
        canvas.classList.remove('fade-out', 'fade-in');
      }
      
      // Remove album mode class
      document.body.classList.remove('mode-album');
      document.documentElement.style.setProperty('--uiAlpha', '1');
      document.documentElement.style.setProperty('--navTranslateY', '0px');
      
      // Remove fade-out transition class
      document.body.classList.remove('album-exit-fade');
      
      // Restore nav bars
      if (!this.topNavEl) this.topNavEl = document.getElementById('top-nav');
      if (!this.centerNavEl) this.centerNavEl = document.getElementById('center-nav');
      if (!this.filtersWrapEl) this.filtersWrapEl = document.getElementById('filters-wrap');
      
      this.navCloseAnimations.forEach(anim => anim.cancel());
      this.navCloseAnimations = [];
      this.navOpenAnimations.forEach(anim => anim.cancel());
      this.navOpenAnimations = [];
      
      const navElements = [this.topNavEl, this.centerNavEl, this.filtersWrapEl].filter(el => el !== null);
      navElements.forEach((navEl) => {
        navEl.style.transform = 'translateY(0) scaleY(1)';
        navEl.style.filter = 'blur(0px)';
        navEl.style.pointerEvents = '';
      });
      
      // Set flag and update nav title
      window.returningFromAlbum = true;
      updateNavTitle({ view: 'user', username });
      
      // Navigate to user page (unless user already went to Collections)
      if (getCurrentRoute() !== 'users') {
        navigate('user-albums', { username });
      }
    }, fadeDuration);
  }
  
  /**
   * Exit album mode immediately (fallback, no animation)
   */
  exitAlbumModeImmediate() {
    // Cancel transition if active
    if (this.transition.active) {
      this.transition.active = false;
    }
    
    if (this.exitTransitionActive) {
      this.exitTransitionActive = false;
    }
    this.exitHideOverlayNextFrame = false;
    
    // Hide overlay
    if (this.overlayImg) {
      this.overlayImg.style.display = 'none';
    }
    
    // Reset filtered album state
    this.isFilteredAlbum = false;
    this.filteredPhotos = [];
    
    // Restore previous state (including filter state)
    if (this.prevState) {
      this.camera.x = this.prevState.cameraX;
      this.camera.y = this.prevState.cameraY;
      this.camera.zoom = this.prevState.zoom;
      this.targetZoom = this.prevState.targetZoom;
      
      // Restore filter state (create new Sets to avoid reference issues)
      this.activeLocations = new Set(this.prevState.activeLocations || []);
      this.activeYears = new Set(this.prevState.activeYears || []);
      this.activeKeywords = new Set(this.prevState.activeKeywords || []);
      
      // Restore focus collapse state if it was active
      if (this.prevState.focusBaseZoom !== undefined) {
        this.focusBaseZoom = this.prevState.focusBaseZoom;
      }
      if (this.prevState.focusProgress !== undefined) {
        this.focusProgress = this.prevState.focusProgress;
      }
      if (this.prevState.focusVel !== undefined) {
        this.focusVel = this.prevState.focusVel;
      }
      if (this.prevState.prevZoomLevel !== undefined) {
        this.prevZoomLevel = this.prevState.prevZoomLevel;
      }
    }
    
    // Return to drawer mode (only if not navigating to user albums)
    // viewMode will be set after navigation check
    this.selectedPhotoId = null;
    this.activeTileId = null;
    this.enterTileRect = null;
    
    // Disconnect observer and downgrade all album images
    if (this.albumImageObserver) {
      this.albumImageObserver.disconnect();
    }
    this.downgradeAllAlbumImages();
    
    // Close button removed
    
    // Hide album meta UI
    this.hideAlbumMetaUI();
    
    // Hide album metadata details
    this.hideAlbumMetaDetails();
    this.albumData = null;
    
    // Hide album image wrapper
    this.hideAlbumImageWrapper();
    
    // Navigate back to user albums page if we came from there
    if (this.fromUserAlbums && this.userAlbumsUsername) {
      // Store username before clearing flags
      const username = this.userAlbumsUsername;
      
      // Set flag FIRST, before any navigation or other operations
      // This prevents showDrawerView from updating nav title to "Remains"
      window.returningFromAlbum = true;
      
      // Update nav title IMMEDIATELY, BEFORE removing mode-album class
      // This ensures the correct text is set before the title becomes visible
      updateNavTitle({ view: 'user', username });
      
      // Force a synchronous reflow to ensure the text is updated
      const remainsLogo = document.getElementById('remainsLogo');
      if (remainsLogo) {
        const h1 = remainsLogo.querySelector('h1');
        if (h1) {
          // Ensure nav title is visible (it might have been hidden during transition)
          h1.style.opacity = '1';
          h1.style.visibility = 'visible';
          h1.style.transition = ''; // Reset transition to use CSS defaults
          void h1.offsetHeight;
        }
      }
      
      // Restore nav bars
      if (!this.topNavEl) {
        this.topNavEl = document.getElementById('top-nav');
      }
      if (!this.centerNavEl) {
        this.centerNavEl = document.getElementById('center-nav');
      }
      if (!this.filtersWrapEl) {
        this.filtersWrapEl = document.getElementById('filters-wrap');
      }
      
      // Cancel any existing animations
      this.navCloseAnimations.forEach(anim => anim.cancel());
      this.navCloseAnimations = [];
      this.navOpenAnimations.forEach(anim => anim.cancel());
      this.navOpenAnimations = [];
      
      // Restore nav bars to open state instantly
      const navElements = [this.topNavEl, this.centerNavEl, this.filtersWrapEl].filter(el => el !== null);
      navElements.forEach((navEl) => {
        navEl.style.transform = 'translateY(0) scaleY(1)';
        navEl.style.filter = 'blur(0px)';
        navEl.style.pointerEvents = '';
      });
      
      // Reset CSS variable
      document.documentElement.style.setProperty('--navTranslateY', '0px');
      
      // Hide canvas immediately to prevent drawer from showing during transition
      const canvas = document.getElementById('canvas');
      if (canvas) {
        canvas.style.display = 'none';
        canvas.classList.remove('fade-out', 'fade-in');
      }
      
      // Clear flags
      this.fromUserAlbums = false;
      this.userAlbumsUsername = null;
      
      // Remove album mode class and restore UI AFTER nav title is updated
      
      // Hide album-meta-ui IMMEDIATELY before removing mode-album class to prevent overlap
      if (this.albumMetaEl) {
        this.albumMetaEl.style.display = 'none';
      }
      
      document.body.classList.remove('mode-album');
      document.documentElement.style.setProperty('--uiAlpha', '1');
      
      // Ensure nav title is still visible after removing mode-album class
      const remainsLogoAfter = document.getElementById('remainsLogo');
      if (remainsLogoAfter) {
        const h1After = remainsLogoAfter.querySelector('h1');
        if (h1After) {
          h1After.style.opacity = '1';
          h1After.style.visibility = 'visible';
        }
      }
      
      // Now navigate (unless user already went to Collections)
      if (getCurrentRoute() !== 'users') {
        navigate('user-albums', { username });
      }
    } else if (this.fromIndex) {
      // Came from index: restore UI and navigate back to index
      window.returningToIndex = true;
      
      // Restore nav bars to open state immediately (before navigating)
      if (!this.topNavEl) this.topNavEl = document.getElementById('top-nav');
      if (!this.centerNavEl) this.centerNavEl = document.getElementById('center-nav');
      if (!this.filtersWrapEl) this.filtersWrapEl = document.getElementById('filters-wrap');
      this.navCloseAnimations.forEach(anim => anim.cancel());
      this.navCloseAnimations = [];
      this.navOpenAnimations.forEach(anim => anim.cancel());
      this.navOpenAnimations = [];
      const navElements = [this.topNavEl, this.centerNavEl, this.filtersWrapEl].filter(el => el !== null);
      navElements.forEach((navEl) => {
        navEl.style.transform = 'translateY(0) scaleY(1)';
        navEl.style.filter = 'blur(0px)';
        navEl.style.pointerEvents = '';
      });
      document.documentElement.style.setProperty('--navTranslateY', '0px');
      
      const canvas = document.getElementById('canvas');
      if (canvas) {
        canvas.style.display = 'none';
        canvas.classList.remove('fade-out', 'fade-in');
      }
      
      this.fromIndex = false;
      this.fromUserAlbums = false;
      this.userAlbumsUsername = null;
      
      if (this.albumMetaEl) this.albumMetaEl.style.display = 'none';
      document.body.classList.remove('mode-album');
      document.documentElement.style.setProperty('--uiAlpha', '1');
      
      const remainsLogoAfter = document.getElementById('remainsLogo');
      if (remainsLogoAfter) {
        const h1After = remainsLogoAfter.querySelector('h1');
        if (h1After) {
          h1After.style.opacity = '1';
          h1After.style.visibility = 'visible';
        }
      }
      
      navigate('index');
    } else {
      // Only set viewMode to drawer if we're not navigating away
      this.viewMode = 'drawer';
    }
  }
  
  /**
   * Exit album mode and return to drawer view with animation
   */
  exitAlbumMode() {
    // If we came from user albums page, skip transition and navigate directly back
    if (this.fromUserAlbums && this.userAlbumsUsername) {
      window.returningFromAlbum = true;
      this.exitAlbumModeImmediate();
      return;
    }
    
    // If user clicked on username (go to user page), use fade-out transition instead of fly-out
    if (this.navigateToUserAfterExit) {
      this.startFadeOutTransition();
      return;
    }
    
    // If we came from index page, skip transition and navigate back to index
    if (this.fromIndex) {
      window.returningToIndex = true;
      this.exitAlbumModeImmediate();
      return;
    }
    
    // Otherwise, use the normal exit transition animation
    this.startExitTransition();
  }

  /**
   * Select all tiles to preload (prioritized by distance from viewport center)
   */
  selectPreloadTargets() {
    const bounds = this.camera.getVisibleBounds();
    const viewportCenter = { x: this.camera.x, y: this.camera.y };
    const candidates = [];
    
    // Add all tiles, prioritized by distance from viewport center
    for (const tile of this.tiles) {
      const distance = this.tileDistanceFromCenter(tile, viewportCenter);
      candidates.push({ id: tile.id, distance });
    }
    
    // Sort by distance (nearest first) for prioritized loading
    candidates.sort((a, b) => a.distance - b.distance);
    
    // Return all tile IDs
    return candidates.map(c => c.id);
  }

  /**
   * Check if preload is complete and hide loader if ready
   * Also updates the progress bar based on visible images loaded
   */
  checkPreloadComplete() {
    if (!this.isPreloading) return;
    
    const loadedCount = this.imageCache.size;
    const elapsed = Date.now() - this.preloadStartTime;
    
    // Count visible images (tiles within viewport)
    let visibleCount = 0;
    let visibleLoaded = 0;
    
    if (this.tiles.length > 0) {
      const bounds = this.camera.getVisibleBounds();
      for (const tile of this.tiles) {
        // Check if tile is within viewport bounds
        const tileRight = tile.x + tile.w;
        const tileBottom = tile.y + tile.h;
        if (tile.x < bounds.right && tileRight > bounds.left &&
            tile.y < bounds.bottom && tileBottom > bounds.top) {
          visibleCount++;
          if (this.imageCache.has(tile.id)) {
            visibleLoaded++;
          }
        }
      }
      
      // Update progress bar based on visible images loaded
      // Progress = visible images loaded / visible images total
      if (visibleCount > 0) {
        const progress = visibleLoaded / visibleCount;
        setPixelLoaderProgress(progress);
      }
    }
    
    // Check if ALL visible images are loaded (100%, not 90%)
    const allVisibleLoaded = visibleCount > 0 && visibleLoaded >= visibleCount;
    
    // Hard timeout after 15 seconds to prevent infinite loading on very slow connections
    const hardTimeoutReached = elapsed >= 15000;
    
    // Only complete when ALL visible images are loaded, or hard timeout
    const shouldComplete = allVisibleLoaded || hardTimeoutReached;
    
    if (shouldComplete) {
      this.isPreloading = false;
      
      // Mark loading as complete
      setPixelLoaderProgress(1);
      
      // Set up callback to hide loader
      const loaderEl = this.loaderElement;
      const canvasEl = this.canvas;
      onPixelLoaderComplete(() => {
        if (loaderEl) {
          loaderEl.classList.add('hidden');
          document.body.classList.remove('loading');
          // Wait for loader fade-out to complete, then show splash and remove loader from DOM
          setTimeout(() => {
            if (loaderEl) {
              loaderEl.remove();
            }
            // Fade in canvas (background images)
            if (canvasEl) {
              canvasEl.classList.add('canvas-loaded');
            }
            // Notify main to show splash overlay and hide UI until first scroll
            // This happens AFTER loader has fully faded out to prevent overlap
            window.dispatchEvent(new CustomEvent('splashShow'));
          }, 300);
        } else {
          // No loader element - show splash immediately
          if (canvasEl) {
            canvasEl.classList.add('canvas-loaded');
          }
          window.dispatchEvent(new CustomEvent('splashShow'));
        }
      });
      
    }
  }

  /**
   * Build photo sources mapping (thumb vs HQ)
   * Converts imgSmallWebp paths to thumb, and img paths to HQ
   */
  buildPhotoSourcesMap(photos) {
    for (const photo of photos) {
      // Use centralized buildImageUrl to get thumb path (unencoded)
      const thumbSrc = buildImageUrl(photo);
      
      // Convert imgSmallWebp path to img path for HQ
      // imgSmallWebp/user/album/file.webp -> img/user/album/file.jpg
      let hqSrc = '';
      if (thumbSrc) {
        // Replace imgSmallWebp with img and .webp with .jpg (thumbSrc is relative path)
        const hqPath = thumbSrc.replace(/^(\/)?imgSmallWebp\//, 'img/').replace(/\.webp$/i, '.jpg');
        hqSrc = hqPath; // Don't encode - use as-is
      }
      
      this.photoSourcesById.set(photo.id, {
        thumb: thumbSrc,
        hq: hqSrc || thumbSrc, // Fallback to thumb if no HQ available
      });
    }
  }
  
  /**
   * Upgrade image to high quality
   */
  async upgradeToHQ(img) {
    if (!img || img.dataset.state === 'hq') return;
    
    // Prevent duplicate calls (race condition guard)
    if (img.dataset.upgrading === 'true') return;
    img.dataset.upgrading = 'true';
    
    // Check if we have a photo sources mapping
    const photoId = img.dataset.photoId;
    if (!photoId || !this.photoSourcesById.has(photoId)) {
      img.dataset.upgrading = 'false';
      return;
    }
    
    const sources = this.photoSourcesById.get(photoId);
    const actualHqSrc = sources.hq;
    
    if (actualHqSrc === sources.thumb || !actualHqSrc) {
      // No separate HQ file, skip upgrade
      return;
    }
    
    try {
      // Main album image: use crossfade overlay so there is no visible swap/refocus
      if (this.albumMainImageHq && img === this.albumMainImage) {
        const overlay = this.albumMainImageHq;
        overlay.src = actualHqSrc;
        overlay.style.opacity = '0';
        await new Promise((resolve, reject) => {
          overlay.onload = () => {
            if (overlay.decode) {
              overlay.decode().then(resolve).catch(() => resolve());
            } else {
              resolve();
            }
          };
          overlay.onerror = reject;
        });
        // Show HQ overlay instantly and swap main image immediately (no visible transition)
        overlay.style.opacity = '1';
        img.src = actualHqSrc;
        img.dataset.state = 'hq';
        img.dataset.upgrading = 'false';
        // Hide overlay after a frame (main image now has HQ)
        requestAnimationFrame(() => {
          overlay.style.opacity = '0';
          overlay.removeAttribute('src');
          overlay.onload = null;
          overlay.onerror = null;
        });
        return;
      }
      
      // Stack images: preload then swap (no overlay for each)
      const preloader = new Image();
      preloader.decoding = 'async';
      
      await new Promise((resolve, reject) => {
        preloader.onload = () => {
          if (preloader.decode) {
            preloader.decode().then(resolve).catch(() => resolve());
          } else {
            resolve();
          }
        };
        preloader.onerror = reject;
        preloader.src = actualHqSrc;
      });
      
      img.classList.add('is-upgrading');
      img.src = actualHqSrc;
      img.dataset.state = 'hq';
      img.dataset.upgrading = 'false';
      setTimeout(() => {
        img.classList.remove('is-upgrading');
      }, 300);
    } catch (error) {
      img.dataset.upgrading = 'false';
      console.warn(`Failed to upgrade image to HQ: ${photoId}`, error);
    }
  }
  
  /**
   * Downgrade image back to thumbnail
   */
  downgradeToThumb(img) {
    if (!img || img.dataset.state !== 'hq') return;
    
    const photoId = img.dataset.photoId;
    if (photoId && this.photoSourcesById.has(photoId)) {
      const sources = this.photoSourcesById.get(photoId);
      img.src = sources.thumb;
      img.dataset.state = 'thumb';
      img.classList.remove('is-upgrading');
      if (this.albumMainImageHq && img === this.albumMainImage) {
        this.albumMainImageHq.removeAttribute('src');
        this.albumMainImageHq.style.opacity = '0';
      }
    }
  }
  
  /**
   * Setup IntersectionObserver for Album view HQ loading
   */
  setupAlbumImageObserver() {
    if (this.albumImageObserver) {
      this.albumImageObserver.disconnect();
    }
    
    this.albumImageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const img = entry.target;
        if (entry.isIntersecting) {
          // Upgrade to HQ
          this.upgradeToHQ(img);
          
          // Schedule prefetch for next/prev images (after idle)
          if (window.requestIdleCallback) {
            window.requestIdleCallback(() => {
              this.prefetchAdjacentAlbumImages(img);
            }, { timeout: 1000 });
          } else {
            setTimeout(() => {
              this.prefetchAdjacentAlbumImages(img);
            }, 250);
          }
        } else {
          // Downgrade if not in buffer
          const photoId = img.dataset.photoId;
          if (photoId && this.selectedPhotoId !== photoId) {
            // Only downgrade if not the main selected photo
            this.downgradeToThumb(img);
          }
        }
      }
    }, {
      root: null,
      rootMargin: '50px', // Small buffer
      threshold: 0.1
    });
  }
  
  /**
   * Prefetch adjacent album images (next/prev)
   */
  prefetchAdjacentAlbumImages(img) {
    if (!this.albumStackLayer || !img.dataset.photoId) return;
    
    const currentPhotoId = img.dataset.photoId;
    const stackImages = Array.from(this.albumStackLayer.querySelectorAll('.album-stack-image'));
    const currentIndex = stackImages.findIndex(el => el.dataset.photoId === currentPhotoId);
    
    if (currentIndex === -1) return;
    
    // Prefetch next 1-2 images
    for (let i = 1; i <= 2 && currentIndex + i < stackImages.length; i++) {
      const nextImg = stackImages[currentIndex + i];
      if (nextImg && nextImg.dataset.state !== 'hq') {
        this.upgradeToHQ(nextImg);
      }
    }
    
    // Prefetch previous 1-2 images
    for (let i = 1; i <= 2 && currentIndex - i >= 0; i++) {
      const prevImg = stackImages[currentIndex - i];
      if (prevImg && prevImg.dataset.state !== 'hq') {
        this.upgradeToHQ(prevImg);
      }
    }
  }
  
  /**
   * Downgrade all album images to thumb
   */
  downgradeAllAlbumImages() {
    if (this.albumMainImage) {
      this.downgradeToThumb(this.albumMainImage);
    }
    
    if (this.albumStackLayer) {
      const stackImages = this.albumStackLayer.querySelectorAll('.album-stack-image');
      for (const img of stackImages) {
        this.downgradeToThumb(img);
      }
    }
    
    // Clear prefetch timers
    for (const timerId of this.albumPrefetchTimers.values()) {
      clearTimeout(timerId);
    }
    this.albumPrefetchTimers.clear();
  }

  async initialize() {
    try {
      // Location filtering now uses location.audit.json directly (loaded in main.js)
      
      // Show loader immediately and hide nav until loading finishes
      if (this.loaderElement) {
        this.loaderElement.classList.remove('hidden');
        document.body.classList.add('loading');
      }
      
      // Fetch photo data
      const response = await fetch('data/photos.index.json');
      if (!response.ok) {
        throw new Error(`Failed to load photo index: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Store photos for filtering
      this.photos = data.photos;
      
      // Create map for O(1) photo lookup
      this.photosMap = new Map();
      for (const photo of data.photos) {
        this.photosMap.set(photo.id, photo);
      }
      
      // Build photo sources mapping (thumb vs HQ)
      this.buildPhotoSourcesMap(data.photos);
      
      // Start early preloading immediately after we have photo data
      // This begins loading images before layout is created, so images appear faster
      this.startEarlyPreload(data.photos);
      
      // Build year index for Date filtering
      this.yearToPhotoIds = new Map(); // Map<year, Set<photoId>>
      this.unknownYearIds = new Set(); // Set<photoId>
      
      for (const photo of data.photos) {
        let year = null;
        
        // Parse year from photo.taken
        if (photo.taken && typeof photo.taken === 'string' && photo.taken.length >= 4) {
          const yearStr = photo.taken.substring(0, 4);
          const yearInt = parseInt(yearStr, 10);
          
          // Valid year range: 1900-2100
          if (!isNaN(yearInt) && yearInt >= 1900 && yearInt <= 2100) {
            year = String(yearInt);
          }
        }
        
        // Add to appropriate set
        if (year) {
          if (!this.yearToPhotoIds.has(year)) {
            this.yearToPhotoIds.set(year, new Set());
          }
          this.yearToPhotoIds.get(year).add(photo.id);
        } else {
          this.unknownYearIds.add(photo.id);
        }
      }
      
      // Load keywords filter data
      const keywordsResponse = await fetch('data/keywords.filters.json');
      if (!keywordsResponse.ok) {
        throw new Error(`Failed to load keywords.filters.json: ${keywordsResponse.statusText}`);
      }
      const keywordsData = await keywordsResponse.json();
      
      // Build keyword index from JSON
      this.keywordToPhotoIds = new Map();
      this.allKeywordPhotoIds = new Set();
      
      if (keywordsData.filters && Array.isArray(keywordsData.filters)) {
        for (const filter of keywordsData.filters) {
          const keyword = filter.key;
          
          // Exclude "photography" keyword from filter UI
          if (keyword === 'photography') {
            continue;
          }
          
          const photoIds = new Set();
          
          if (filter.photoIds && Array.isArray(filter.photoIds)) {
            for (const photoId of filter.photoIds) {
              photoIds.add(photoId);
              this.allKeywordPhotoIds.add(photoId);
            }
          }
          
          this.keywordToPhotoIds.set(keyword, photoIds);
        }
      }
      
      // Build unknown keyword set (photos not in any keyword)
      const allPhotoIds = new Set(data.photos.map(p => p.id));
      this.unknownKeywordIds = new Set();
      for (const photoId of allPhotoIds) {
        if (!this.allKeywordPhotoIds.has(photoId)) {
          this.unknownKeywordIds.add(photoId);
        }
      }
      
      // Generate proper layout
      this.tiles = generateLayout(data.photos);
      
      // Center camera on the layout
      if (this.tiles.length > 0) {
        const avgX = this.tiles.reduce((sum, t) => sum + t.x, 0) / this.tiles.length;
        const avgY = this.tiles.reduce((sum, t) => sum + t.y, 0) / this.tiles.length;
        this.camera.x = avgX;
        this.camera.y = avgY;
      }
      
      // Set initial zoom to show a good portion of tiles
      const bounds = this.getLayoutBounds();
      const layoutWidth = bounds.maxX - bounds.minX;
      const layoutHeight = bounds.maxY - bounds.minY;
      const maxDimension = Math.max(layoutWidth, layoutHeight);
      
      const padding = 1.2;
      const zoomX = (this.width * padding) / maxDimension;
      const zoomY = (this.height * padding) / maxDimension;
      let initialZoom = Math.min(zoomX, zoomY, 1.0);
      
      // Clamp initial zoom to dynamic minimum and maximum
      const dynamicMinZoom = this.computeMinZoom();
      this.camera.zoom = Math.max(dynamicMinZoom, Math.min(MAX_ZOOM, initialZoom));
      
      this.clampZoom();
      
      // Initialize target zoom to current zoom
      this.targetZoom = this.camera.zoom;
      
      // Cache layout bounds
      this.layoutBounds = bounds;
      
      // Clamp camera to bounds after initial positioning
      this.clampCameraToBounds();
      
      // Update camera state tracking
      this.lastCameraState = {
        x: this.camera.x,
        y: this.camera.y,
        zoom: this.camera.zoom,
      };
      
      // Select preload targets (prioritized by distance from viewport center)
      // Note: Early preload already started, but now we prioritize by viewport
      this.preloadTargets = this.selectPreloadTargets();
      
      // Continue preloading
      // Early preload already started, so we just ensure it continues
      if (!this.isPreloading) {
        this.isPreloading = true;
        this.preloadStartTime = Date.now();
      }
      this.startPreload();
      
      // Create center date label element
      this.createCenterDateElement();
      
      // Close button removed - clicking anywhere on page exits album
      
      // Create overlay image element
      this.createOverlayImage();
      
      // Create album metadata details UI
      this.createAlbumMetaDetailsUI();
      
      // Create album image wrapper and stack layer
      this.createAlbumImageWrapper();
      
      // Create close button
      this.createCloseButton();
      
      // Start render loop after layout is ready
      this.startRenderLoop();
      
    } catch (error) {
      console.error('Error initializing drawer view:', error);
      // Hide loader on error and show nav
      if (this.loaderElement) {
        this.loaderElement.classList.add('hidden');
        document.body.classList.remove('loading');
      }
      // Show error message on canvas
      this.ctx.fillStyle = '#f5f5f5';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.fillStyle = '#333';
      this.ctx.font = '16px sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.fillText('Error loading photo data', this.width / 2, this.height / 2);
      this.ctx.fillText(error.message, this.width / 2, this.height / 2 + 30);
    }
  }

  /**
   * Start early preloading - begins immediately after photo data is loaded
   * This loads images before layout is created, so they appear faster
   */
  startEarlyPreload(photos) {
    // Start preloading immediately with first batch of photos
    // Prioritize first N photos (they're likely to be visible)
    const earlyBatchSize = Math.min(PRELOAD_TARGET, photos.length);
    const earlyPhotos = photos.slice(0, earlyBatchSize);
    
    // Mark as preloading
    this.isPreloading = true;
    this.preloadStartTime = Date.now();
    
    // Add early photos to queue with high priority (distance 0)
    // Use Set for faster lookup
    const queueIds = new Set(this.loadQueue.map(item => item.id));
    for (const photo of earlyPhotos) {
      if (!this.imageCache.has(photo.id) && !this.loadingSet.has(photo.id) && !queueIds.has(photo.id)) {
        this.loadQueue.push({ id: photo.id, distance: 0 });
        queueIds.add(photo.id);
      }
    }
    
    
    // Start processing the queue immediately - process multiple batches
    // This ensures we start loading as many images as possible right away
    for (let i = 0; i < 3; i++) {
      this.processLoadQueue();
    }
  }

  /**
   * Start preloading initial batch (after layout is created, with viewport prioritization)
   * Visible images get ABSOLUTE priority (loaded first before any other images)
   */
  startPreload() {
    const bounds = this.camera.getVisibleBounds();
    const viewportCenter = { x: this.camera.x, y: this.camera.y };
    
    // Separate visible images from non-visible images
    const visibleImages = [];
    const otherImages = [];
    
    for (const tile of this.tiles) {
      if (this.imageCache.has(tile.id) || this.loadingSet.has(tile.id)) {
        continue; // Already loaded or loading
      }
      
      // Check if tile is within viewport
      const tileRight = tile.x + tile.w;
      const tileBottom = tile.y + tile.h;
      const isVisible = tile.x < bounds.right && tileRight > bounds.left &&
                        tile.y < bounds.bottom && tileBottom > bounds.top;
      
      const distance = this.tileDistanceFromCenter(tile, viewportCenter);
      
      if (isVisible) {
        visibleImages.push({ id: tile.id, distance });
      } else {
        otherImages.push({ id: tile.id, distance });
      }
    }
    
    // Sort each group by distance
    visibleImages.sort((a, b) => a.distance - b.distance);
    otherImages.sort((a, b) => a.distance - b.distance);
    
    // Clear and rebuild queue with visible images FIRST
    this.loadQueue = [...visibleImages, ...otherImages];
    
    // Start processing the queue
    this.processLoadQueue();
    
    // Check if visible images are already loaded (from early preload)
    this.checkPreloadComplete();
  }

  /**
   * Get layout bounds
   */
  getLayoutBounds() {
    if (this.tiles.length === 0) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    }
    
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    
    for (const tile of this.tiles) {
      minX = Math.min(minX, tile.x);
      maxX = Math.max(maxX, tile.x + tile.w);
      minY = Math.min(minY, tile.y);
      maxY = Math.max(maxY, tile.y + tile.h);
    }
    
    return { minX, maxX, minY, maxY };
  }

  /**
   * Clamp zoom so max zoom still shows ~6 tiles
   */
  clampZoom() {
    const tileWidth = 220;
    const tileHeight = 165;
    const maxTileDimension = Math.max(tileWidth, tileHeight);
    
    const minVisibleWidth = maxTileDimension * MIN_ZOOM_TILES;
    const maxZoom = Math.min(
      this.width / minVisibleWidth,
      this.height / minVisibleWidth,
      10.0
    );
    
    this.camera.zoom = Math.min(this.camera.zoom, maxZoom);
    this.camera.zoom = Math.max(this.camera.zoom, 0.1);
  }

  /**
   * Compute dynamic minimum zoom based on content bounds and viewport size
   * Ensures content always fully covers viewport (no empty space).
   * When filters active, use filtered cluster bounds so zoom-in cannot show empty space.
   */
  computeMinZoom() {
    if (!this.layoutBounds) {
      this.layoutBounds = this.getLayoutBounds();
    }
    
    // When filter on but bounds not yet computed (same frame), force higher min zoom so we don't show full world
    if (this.filtersActive() && !this.filteredLayoutBounds) {
      return Math.max(MIN_ZOOM, FILTERED_MIN_ZOOM_FALLBACK);
    }
    const bounds = (this.filtersActive() && this.filteredLayoutBounds)
      ? this.filteredLayoutBounds
      : this.layoutBounds;
    const contentWidth = bounds.maxX - bounds.minX;
    const contentHeight = bounds.maxY - bounds.minY;
    
    // If no content, use default minimum
    if (contentWidth <= 0 || contentHeight <= 0) {
      return MIN_ZOOM;
    }
    
    // Compute minimum zoom such that viewport in world units fits within content
    // viewWidthWorld = viewportWidth / zoom
    // We need: viewWidthWorld <= contentWidth
    // Therefore: viewportWidth / zoom <= contentWidth
    // Therefore: zoom >= viewportWidth / contentWidth
    const minZoomX = this.width / contentWidth;
    const minZoomY = this.height / contentHeight;
    
    // Use the larger of the two (more restrictive constraint)
    // Add small padding to ensure content fully covers viewport
    const padding = 1.01; // 1% padding to prevent edge cases
    const dynamicMinZoom = Math.max(minZoomX, minZoomY) * padding;
    
    // Still respect absolute minimum (but dynamic should be higher)
    return Math.max(MIN_ZOOM, dynamicMinZoom);
  }
  
  /**
   * Clamp target zoom (dynamic minimum + fixed maximum)
   * Applies max zoom rule to ensure ~6 tiles visible at max zoom
   */
  clampTargetZoom() {
    const dynamicMinZoom = this.computeMinZoom();
    this.targetZoom = Math.max(dynamicMinZoom, Math.min(MAX_ZOOM, this.targetZoom));
  }

  /**
   * Clamp camera position to layout bounds to prevent empty background.
   * When filters active, use filtered tiles bounds so pan cannot reach areas without images.
   */
  clampCameraToBounds() {
    if (!this.layoutBounds) {
      this.layoutBounds = this.getLayoutBounds();
    }
    
    // When filter on but bounds not ready, don't clamp to full layout (would show empty world)
    if (this.filtersActive() && !this.filteredLayoutBounds) {
      return;
    }
    // In collapse mode use bounds of visible (filtered) tiles so view cannot pan into empty space
    const useFilteredBounds = this.filtersActive() && this.filteredLayoutBounds;
    const layout = useFilteredBounds ? this.filteredLayoutBounds : this.layoutBounds;
    const visible = this.camera.getVisibleBounds();
    const visibleWidth = visible.right - visible.left;
    const visibleHeight = visible.bottom - visible.top;
    const layoutWidth = layout.maxX - layout.minX;
    const layoutHeight = layout.maxY - layout.minY;
    
    // Add padding; use minimal padding when filtered so no empty space around cluster
    const padding = useFilteredBounds ? FILTERED_BOUNDS_PADDING : CAMERA_BOUNDS_PADDING;
    const paddedMinX = layout.minX - padding;
    const paddedMaxX = layout.maxX + padding;
    const paddedMinY = layout.minY - padding;
    const paddedMaxY = layout.maxY + padding;
    const paddedWidth = paddedMaxX - paddedMinX;
    const paddedHeight = paddedMaxY - paddedMinY;
    
    // Clamp X
    if (visibleWidth <= paddedWidth) {
      // Viewport is smaller than layout - clamp to bounds
      if (visible.left < paddedMinX) {
        this.camera.x += paddedMinX - visible.left;
      } else if (visible.right > paddedMaxX) {
        this.camera.x += paddedMaxX - visible.right;
      }
    } else {
      // Viewport is larger than layout - center on layout
      this.camera.x = (paddedMinX + paddedMaxX) / 2;
    }
    
    // Clamp Y
    if (visibleHeight <= paddedHeight) {
      // Viewport is smaller than layout - clamp to bounds
      if (visible.top < paddedMinY) {
        this.camera.y += paddedMinY - visible.top;
      } else if (visible.bottom > paddedMaxY) {
        this.camera.y += paddedMaxY - visible.bottom;
      }
    } else {
      // Viewport is larger than layout - center on layout
      this.camera.y = (paddedMinY + paddedMaxY) / 2;
    }
  }

  /**
   * Check if mouse is over a UI element that should block panning
   */
  isMouseOverUIBlockingPan() {
    // Get mouse position in viewport coordinates
    const mouseX = this.mouseX;
    const mouseY = this.mouseY;
    
    // Check if mouse is in the gap between center-nav and filters-nav
    // center-nav is at top: var(--nav-height) (15px), height: 48px
    // filters-nav is at top: calc(var(--nav-height) + var(--center-nav-height) + var(--filters-nav-gap))
    // Gap is var(--filters-nav-gap) = 10px
    const navHeight = 15; // --nav-height
    const centerNavHeight = 48; // --center-nav-height (updated from 40px to 48px)
    const filtersNavGap = 10; // --filters-nav-gap
    const navRightOffset = 35; // --nav-right-offset
    const navWidth = 980; // --nav-width
    
    const centerNavTop = navHeight;
    const centerNavBottom = centerNavTop + centerNavHeight;
    const filtersNavTop = centerNavBottom + filtersNavGap;
    
    // Check if mouse is in the gap between center-nav and filters-nav (right side of screen)
    const viewportWidth = this.width;
    const mouseViewportX = mouseX;
    const mouseViewportY = mouseY;
    
    if (mouseViewportX >= (viewportWidth - navRightOffset - navWidth) && 
        mouseViewportX <= (viewportWidth - navRightOffset) &&
        mouseViewportY >= centerNavBottom && 
        mouseViewportY < filtersNavTop) {
      return true; // Mouse is in the gap between nav bars
    }
    
    return false;
  }
  
  /**
   * Update center-based panning - any movement from center moves the canvas organically
   * When filters active, pan is enabled but camera is clamped to filtered tiles bounds (no empty areas).
   */
  updateEdgePan() {
    // Stop panning if mouse is not over canvas
    if (!this.mouseOverCanvas) {
      this.isPanning = false;
      return;
    }
    
    // Stop panning if mouse is over UI elements that should block panning
    if (this.isMouseOverUIBlockingPan()) {
      this.isPanning = false;
      return;
    }
    
    // Stop panning if mouse is in the gap between center nav and filters nav
    // Gap: Y from 55px (center nav end) to 65px (filters nav start)
    // Nav area: X from (width - 1015px) to (width - 35px)
    const width = this.width;
    const height = this.height;
    const navRightOffset = 35;
    const navWidth = 980;
    const navLeft = width - navRightOffset - navWidth;
    const navRight = width - navRightOffset;
    const centerNavEnd = 15 + 48; // top nav height (15px) + center nav height (48px)
    const gapStart = centerNavEnd; // 63px
    const gapEnd = centerNavEnd + 10; // 63px + 10px gap = 73px
    
    if (this.mouseY >= gapStart && this.mouseY <= gapEnd &&
        this.mouseX >= navLeft && this.mouseX <= navRight) {
      this.isPanning = false;
      return;
    }
    
    // Center of viewport
    const centerX = width / 2;
    const centerY = height / 2;
    
    // Distance from center (in pixels)
    const dx = this.mouseX - centerX;
    const dy = this.mouseY - centerY;
    
    // Calculate distance from center
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // Maximum distance (diagonal from center to corner)
    const maxDistance = Math.sqrt(width * width + height * height) / 2;
    
    // Normalize distance (0 to 1, where 1 is at the corner)
    const normalizedDistance = Math.min(1, distance / maxDistance);
    
    // Use smooth easing curve for organic feel (easeOutCubic: 1 - (1-t)^3)
    // This gives gentle response near center, smoothly ramping up further out
    const intensity = 1 - Math.pow(1 - normalizedDistance, 3);
    
    // Calculate pan speeds (scaled by zoom with additional reduction at high zoom)
    // Base scaling: 1/zoom, but apply additional reduction factor at high zoom levels
    const baseZoomFactor = 1 / this.camera.zoom;
    // Additional reduction factor: at max zoom (1.8), reduce by ~40%
    const zoomT = (this.camera.zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM); // 0 to 1
    const highZoomReduction = 1 - (zoomT * 0.4); // 1.0 at min zoom, 0.6 at max zoom
    const zoomFactor = baseZoomFactor * highZoomReduction;
    
    // Pan speed is directly proportional to distance from center for natural feel
    // Use a reference distance (about 25% of screen) for comfortable base speed
    const referenceDistance = Math.min(width, height) * 0.25;
    const distanceRatio = distance / referenceDistance;
    
    // Calculate base speed with smooth intensity curve
    // Scale by intensity for smooth response, and by distance ratio for responsiveness
    const speedMultiplier = PAN_SPEED_BASE * intensity * zoomFactor * Math.min(1.5, distanceRatio);
    
    // Pan speed is proportional to distance from center
    // Normalize direction vector and scale by speed
    if (distance > 0) {
      const directionX = dx / distance;
      const directionY = dy / distance;
      
      const panX = directionX * speedMultiplier;
      const panY = directionY * speedMultiplier;
      
      const wasPanning = this.isPanning;
      this.isPanning = Math.abs(panX) > 0.01 || Math.abs(panY) > 0.01;
      
      if (this.isPanning) {
        this.camera.pan(panX, panY);
        this.clampCameraToBounds();
        // Extend panning timeout
        this.panningUntil = performance.now() + this.panningIdleMs;
      } else if (wasPanning) {
        // Just stopped panning - set timeout
        this.panningUntil = performance.now() + this.panningIdleMs;
      }
    } else {
      // Mouse is exactly at center
      this.isPanning = false;
    }
    
    // Check if panning timeout has expired
    const now = performance.now();
    if (!this.isPanning && now > this.panningUntil) {
      this.panningUntil = 0;
    }
  }

  /**
   * Update zoom with easing toward targetZoom (stepped but smooth)
   */
  updateZoom() {
    const diff = this.targetZoom - this.camera.zoom;
    
    // Check if collapse mode is active (filters active)
    const isCollapseMode = this.filtersActive();
    
    // Dead zone: snap when very close to target (much larger dead zone in collapse mode to prevent bounce)
    const deadZone = isCollapseMode ? 0.05 : ZOOM_DEAD_ZONE; // Even larger dead zone to prevent any bounce
    if (Math.abs(diff) < deadZone) {
      if (Math.abs(this.camera.zoom - this.targetZoom) > 0.0001) {
        // Get world point before zoom change
        const worldPoint = this.camera.screenToWorld(this.zoomAnchorScreenX, this.zoomAnchorScreenY);
        this.camera.zoom = this.targetZoom;
        const newWorldPoint = this.camera.screenToWorld(this.zoomAnchorScreenX, this.zoomAnchorScreenY);
        this.camera.x += worldPoint.x - newWorldPoint.x;
        this.camera.y += worldPoint.y - newWorldPoint.y;
      }
      // Reset velocity when at target
      if (isCollapseMode) {
        this.zoomVelocity = 0;
      }
      return;
    }
    
    // Get world point before zoom change
    const worldPoint = this.camera.screenToWorld(this.zoomAnchorScreenX, this.zoomAnchorScreenY);
    
    // In collapse mode, use simple ease-out without spring to prevent bounce
    // Otherwise, use normal easing
    if (isCollapseMode) {
      // Platter (collapse) zoom: faster than regular zoom for snappier feel
      // Simple ease-out: slow down as we approach target
      const maxDistance = Math.abs(this.COLLAPSE_ZOOM_IN - this.COLLAPSE_ZOOM_OUT);
      const distanceRatio = Math.min(1, Math.abs(diff) / maxDistance);
      
      // Ease-out curve: faster at start, slower near target
      const easedRatio = 1 - Math.pow(1 - distanceRatio, 4);
      
      // Platter zoom faster than regular (ZOOM_EASE_FACTOR=0.03): use higher base/min
      let baseSpeed = 0.14; // Faster than regular zoom
      let minSpeed = 0.025; // Snappy near target
      
      // When zooming out, mild slowdown so out is still fast but smooth
      if (diff < 0) {
        const zoomOutDistance = this.COLLAPSE_ZOOM_IN - this.COLLAPSE_ZOOM_OUT;
        const currentDistance = this.COLLAPSE_ZOOM_IN - this.camera.zoom;
        const rawZoomOutRatio = Math.min(1, Math.max(0, currentDistance / zoomOutDistance));
        
        if (this._lastZoomOutRatio === undefined) {
          this._lastZoomOutRatio = rawZoomOutRatio;
        }
        const smoothingFactor = 0.4;
        const zoomOutRatio = this._lastZoomOutRatio + (rawZoomOutRatio - this._lastZoomOutRatio) * smoothingFactor;
        this._lastZoomOutRatio = zoomOutRatio;
        
        // Light slowdown on zoom out (platter stays faster than regular)
        const zoomOutSlowdown = 1 - (zoomOutRatio * 0.25); // Up to 25% slower on way out
        baseSpeed *= zoomOutSlowdown;
        minSpeed *= zoomOutSlowdown;
      }
      
      const easeFactor = baseSpeed * easedRatio + minSpeed * (1 - easedRatio);
      
      // Calculate step size
      const step = diff * easeFactor;
      
      // Update zoom directly (no velocity, no spring)
      // Always clamp to never exceed target
      if (diff > 0) {
        // Moving toward higher zoom
        this.camera.zoom = Math.min(this.camera.zoom + step, this.targetZoom);
      } else {
        // Moving toward lower zoom
        this.camera.zoom = Math.max(this.camera.zoom + step, this.targetZoom);
      }
    } else {
      // Normal easing for non-collapse mode; snappier when zoom is low so initial zoom segment doesn't feel stuck
      const easeFactor = this.camera.zoom < ZOOM_INITIAL_RANGE ? ZOOM_EASE_FACTOR_INITIAL : ZOOM_EASE_FACTOR;
      this.camera.zoom += diff * easeFactor;
      
      // Clamp to dynamic minimum (prevents empty space)
      const dynamicMinZoom = this.computeMinZoom();
      if (this.camera.zoom < dynamicMinZoom) {
        this.camera.zoom = dynamicMinZoom;
        this.targetZoom = dynamicMinZoom;
      }
    }
    
    // Adjust camera position to keep zoom anchor fixed
    const newWorldPoint = this.camera.screenToWorld(this.zoomAnchorScreenX, this.zoomAnchorScreenY);
    this.camera.x += worldPoint.x - newWorldPoint.x;
    this.camera.y += worldPoint.y - newWorldPoint.y;
  }

  /**
   * Start fade-in of drawer tiles when entering from users page (timer starts on first render frame)
   */
  startEnterFromUsersFadeIn() {
    this.enterFromUsersFadePending = true;
  }

  /**
   * Start render loop
   */
  startRenderLoop() {
    // Don't start render loop if tiles are not ready yet
    if (this.tiles.length === 0) {
      return;
    }
    
    // If render loop is already running, don't start it again
    if (this.animationFrameId !== null) {
      return;
    }
    const frame = () => {
      this.render();
      this.animationFrameId = requestAnimationFrame(frame);
    };
    
    frame();
  }

  /**
   * Stop render loop
   */
  stopRenderLoop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Wait for at least a minimum number of images to be loaded
   * Returns a Promise that resolves when enough images are loaded
   */
  waitForImages(minCount = 5, maxWaitMs = 2000) {
    return new Promise((resolve) => {
      // If we already have enough images, resolve immediately
      if (this.imageCache.size >= minCount) {
        resolve();
        return;
      }

      const startTime = Date.now();
      const checkInterval = 50; // Check every 50ms
      
      const checkImages = () => {
        const elapsed = Date.now() - startTime;
        
        // If we have enough images, resolve
        if (this.imageCache.size >= minCount) {
          resolve();
          return;
        }
        
        // If we've waited too long, resolve anyway (don't wait forever)
        if (elapsed >= maxWaitMs) {
          resolve();
          return;
        }
        
        // Check again after a short delay
        setTimeout(checkImages, checkInterval);
      };
      
      checkImages();
    });
  }

  /**
   * Check if camera has changed significantly
   */
  cameraChanged() {
    const current = {
      x: this.camera.x,
      y: this.camera.y,
      zoom: this.camera.zoom,
    };
    const last = this.lastCameraState;
    const threshold = 10; // World units or zoom difference
    
    if (
      Math.abs(current.x - last.x) > threshold ||
      Math.abs(current.y - last.y) > threshold ||
      Math.abs(current.zoom - last.zoom) > 0.01
    ) {
      this.lastCameraState = { ...current };
      return true;
    }
    return false;
  }

  /**
   * Compare two Sets for equality (optimized)
   */
  setsEqual(setA, setB) {
    if (!setA || !setB) return setA === setB;
    if (setA.size !== setB.size) return false;
    for (const item of setA) {
      if (!setB.has(item)) return false;
    }
    return true;
  }

  /**
   * Compute hash of visible set (optimized for small sets)
   */
  computeVisibleSetHash(visibleTiles) {
    if (visibleTiles.length === 0) return '';
    if (visibleTiles.length <= 100) {
      // For small sets, use sorted IDs
      return visibleTiles.map(t => t.id).sort().join(',');
    }
    // For large sets, use size + first/last IDs (much faster)
    return `${visibleTiles.length}:${visibleTiles[0].id}:${visibleTiles[visibleTiles.length - 1].id}`;
  }

  /**
   * Check if a tile rect intersects with expanded viewport bounds
   */
  tileIntersectsViewport(tile, bounds, buffer) {
    return !(
      tile.x + tile.w < bounds.left - buffer ||
      tile.x > bounds.right + buffer ||
      tile.y + tile.h < bounds.top - buffer ||
      tile.y > bounds.bottom + buffer
    );
  }

  /**
   * Compute distance from tile center to viewport center
   */
  tileDistanceFromCenter(tile, viewportCenter) {
    const tileCenterX = tile.x + tile.w / 2;
    const tileCenterY = tile.y + tile.h / 2;
    const dx = tileCenterX - viewportCenter.x;
    const dy = tileCenterY - viewportCenter.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Add all visible tiles to load queue (used after filter change)
   * OPTIMIZATION: When filters are cleared, only add viewport tiles (not all tiles)
   */
  addAllVisibleTilesToQueue() {
    if (this.tiles.length === 0) return;
    
    const bounds = this.camera.getVisibleBounds();
    const viewportCenter = { x: this.camera.x, y: this.camera.y };
    const hasActiveFilter = this.filtersActive();
    
    const candidates = [];
    const queueIds = new Set(this.loadQueue.map(item => item.id));
    
    // Calculate load viewport (expanded viewport for loading)
    const zoomInv = 1 / this.camera.zoom;
    const loadBuffer = LOAD_BUFFER_BASE * zoomInv;
    const loadViewport = {
      left: bounds.left - loadBuffer,
      right: bounds.right + loadBuffer,
      top: bounds.top - loadBuffer,
      bottom: bounds.bottom + loadBuffer,
    };
    
    // OPTIMIZATION: When filters are cleared (no active filters), only iterate through viewport tiles
    // This avoids iterating through all 1850+ tiles when filters are cleared
    const tilesToCheck = hasActiveFilter 
      ? this.tiles  // With filters: check all tiles (filtered set is usually small)
      : this.tiles.filter(tile => this.tileIntersectsViewport(tile, loadViewport, 0)); // No filters: only check viewport tiles
    
    for (const tile of tilesToCheck) {
      // Skip if already loaded or loading or already in queue
      if (this.imageCache.has(tile.id) || this.loadingSet.has(tile.id) || queueIds.has(tile.id)) {
        continue;
      }
      
      // Check if tile is visible (passes filters)
      let isVisible = true;
      if (hasActiveFilter) {
        const photo = this.photosMap.get(tile.id);
        if (photo) {
          isVisible = isPhotoVisible(
            photo,
            this.activeLocations,
            this.activeYears,
            this.activeKeywords,
            this.locationToPhotoIds,
            this.allLocatedPhotoIds,
            this.unknownPhotoIds,
            this.yearToPhotoIds,
            this.unknownYearIds,
            this.keywordToPhotoIds,
            this.allKeywordPhotoIds,
            this.unknownKeywordIds
          );
        }
      }
      
      if (isVisible) {
        // Calculate distance from viewport center for prioritization
        const tileCenterX = tile.x + tile.w / 2;
        const tileCenterY = tile.y + tile.h / 2;
        const dx = tileCenterX - viewportCenter.x;
        const dy = tileCenterY - viewportCenter.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        candidates.push({ id: tile.id, distance });
        queueIds.add(tile.id);
      }
    }
    
    // Sort by distance (nearest first) and add to queue
    if (candidates.length > 0) {
      candidates.sort((a, b) => a.distance - b.distance);
      this.loadQueue.push(...candidates);
      this.loadQueue.sort((a, b) => a.distance - b.distance);
    }
  }

  /**
   * Update visibility and add items to load queue using loadViewport
   */
  updateVisibility() {
    if (this.tiles.length === 0) return;
    
    const bounds = this.camera.getVisibleBounds();
    const viewportCenter = { x: this.camera.x, y: this.camera.y };
    
    // Zoom-adaptive buffers
    const k = 1 / this.camera.zoom;
    const loadBuffer = LOAD_BUFFER_BASE * k;
    
    // loadViewport: expanded viewport for loading
    const loadViewport = {
      left: bounds.left - loadBuffer,
      right: bounds.right + loadBuffer,
      top: bounds.top - loadBuffer,
      bottom: bounds.bottom + loadBuffer,
    };
    
    const candidates = [];
    
    for (const tile of this.tiles) {
      // Skip if already loaded or loading
      if (this.imageCache.has(tile.id) || this.loadingSet.has(tile.id)) {
        continue;
      }
      
      // Check if tile intersects loadViewport
      if (this.tileIntersectsViewport(tile, loadViewport, 0)) {
        const distance = this.tileDistanceFromCenter(tile, viewportCenter);
        candidates.push({ id: tile.id, distance });
      }
    }
    
    // Sort by distance (nearest first) and add to queue
    if (candidates.length > 0) {
      candidates.sort((a, b) => a.distance - b.distance);
      
      // Use Set for O(1) lookup instead of O(n) find
      const queueIds = new Set(this.loadQueue.map(item => item.id));
      
      for (const candidate of candidates) {
        if (!queueIds.has(candidate.id)) {
          this.loadQueue.push(candidate);
          queueIds.add(candidate.id);
        }
      }
      
      // Only sort if we added new items
      if (candidates.length > 0) {
        this.loadQueue.sort((a, b) => a.distance - b.distance);
      }
    }
  }

  /**
   * Process load queue (up to MAX_CONCURRENT_LOADS or PRELOAD_MAX_CONCURRENT during preload)
   */
  processLoadQueue() {
    // Remove items that are already loaded or loading
    this.loadQueue = this.loadQueue.filter(
      item => !this.imageCache.has(item.id) && !this.loadingSet.has(item.id)
    );
    
    // Use higher concurrency during preload, after filter change, OR if we still have many items in queue
    const now = performance.now();
    const recentlyChangedFilters = (now - this.filterChangeTime) < this.FILTER_CHANGE_BOOST_MS;
    const hasLargePreloadQueue = this.loadQueue.length > 100; // Still many items to load
    
    // Use even higher concurrency after filter change (30 instead of 20)
    const FILTER_CHANGE_CONCURRENT = 30;
    let maxConcurrent;
    if (this.isPreloading || hasLargePreloadQueue) {
      maxConcurrent = PRELOAD_MAX_CONCURRENT;
    } else if (recentlyChangedFilters) {
      maxConcurrent = FILTER_CHANGE_CONCURRENT;
      this.filterChangeBoostActive = true;
    } else {
      maxConcurrent = MAX_CONCURRENT_LOADS;
      this.filterChangeBoostActive = false;
    }
    
    // Start loading up to max concurrent
    while (this.loadingSet.size < maxConcurrent && this.loadQueue.length > 0) {
      const item = this.loadQueue.shift();
      this.loadImage(item.id);
    }
  }

  /**
   * Load a single image
   */
  loadImage(id) {
    if (this.loadingSet.has(id) || this.imageCache.has(id)) {
      return;
    }
    
    // Get photo to get src (tiles might not exist yet during early preload)
    const photo = this.photosMap.get(id);
    if (!photo) {
      console.warn(`[loadImage] Photo not found for id: ${id}`);
      return;
    }
    
    // Use thumb source for drawer view (from photoSourcesById, or build from photo)
    const sources = this.photoSourcesById.get(id);
    const thumbSrc = sources ? sources.thumb : buildImageUrl(photo);
    
    // Check if thumbSrc is empty
    if (!thumbSrc) {
      console.warn(`[loadImage] Empty thumbSrc for id: ${id}`, { photo, sources });
      // Remove from loading set and continue queue
      this.processLoadQueue();
      return;
    }
    
    this.loadingSet.add(id);
    
    const img = new Image();
    img.decoding = 'async';
    // Don't use lazy loading for programmatically created images - they won't load
    // img.loading = 'lazy'; // REMOVED: prevents preloading of canvas images
    
    // photo is already declared above for error logging
    
    img.onload = () => {
      // Store image with aspect ratio
      const aspect = img.naturalWidth / img.naturalHeight;
      this.imageCache.set(id, { img, aspect, lastUsed: Date.now() });
      this.loadingSet.delete(id);
      
      // Update progress bar on every image load for real-time feedback
      if (this.isPreloading) {
        this.checkPreloadComplete();
      }
      
      // Continue processing queue immediately
      this.processLoadQueue();
    };
    img.onerror = () => {
      // Log 404 errors with photo data for debugging
      if (!this.image404Log || this.image404Log.size < 10) {
        if (!this.image404Log) this.image404Log = new Set();
        const logKey = `${img.src}|${id}`;
        if (!this.image404Log.has(logKey)) {
          this.image404Log.add(logKey);
          console.warn('[IMG 404]', img.src, photo || { id });
        }
      }
      
      // Skip on error, just remove from loading set
      this.loadingSet.delete(id);
      
      // Check if preload is complete (even if some failed)
      if (this.isPreloading) {
        this.checkPreloadComplete();
      }
      
      this.processLoadQueue(); // Continue processing queue
    };
    img.src = thumbSrc;
  }

  /**
   * Evict least-recently-used images if cache is too large
   * Never evict tiles in keepViewport to prevent flickering
   */
  evictCache() {
    if (this.imageCache.size <= MAX_CACHE_SIZE) return;
    
    const bounds = this.camera.getVisibleBounds();
    
    // Zoom-adaptive keep buffer
    const k = 1 / this.camera.zoom;
    const keepBuffer = KEEP_BUFFER_BASE * k;
    
    // keepViewport: expanded viewport for keeping images
    const keepViewport = {
      left: bounds.left - keepBuffer,
      right: bounds.right + keepBuffer,
      top: bounds.top - keepBuffer,
      bottom: bounds.bottom + keepBuffer,
    };
    
    const toEvict = [];
    
    // Collect all cache entries
    for (const [id, entry] of this.imageCache.entries()) {
      const tile = this.tiles.find(t => t.id === id);
      // Check if tile is in keepViewport (never evict these)
      const inKeepViewport = tile && this.tileIntersectsViewport(tile, keepViewport, 0);
      
      if (inKeepViewport) {
        continue; // Skip tiles in keepViewport
      }
      
      toEvict.push({
        id,
        lastUsed: entry.lastUsed,
      });
    }
    
    // Sort by lastUsed (oldest first)
    toEvict.sort((a, b) => a.lastUsed - b.lastUsed);
    
    // Remove oldest items outside keepViewport
    const toRemove = this.imageCache.size - MAX_CACHE_SIZE;
    for (let i = 0; i < toRemove && i < toEvict.length; i++) {
      this.imageCache.delete(toEvict[i].id);
    }
  }

  /**
   * Compute collapse factor k based on zoom level and visible count (density-aware)
   * Returns k in [kMin..1] where 1 = no collapse, kMin = full collapse
   * @param {number} visibleCount - Number of currently visible (filtered) photos
   */
  computeCollapseFactor(visibleCount = 0) {
    // If no filter active, no collapse
    if (!this.filtersActive()) {
      return 1.0;
    }
    
    // If releasing, animate k back to 1
    if (this.isReleasingFilters) {
      const now = performance.now();
      const elapsed = now - this.releaseStartTime;
      const releaseT = Math.min(elapsed / this.releaseDuration, 1.0);
      
      // Mechanical steps (4 steps for 300ms = 75ms per step)
      const steps = 4;
      const stepT = Math.floor(releaseT * steps) / steps;
      
      // Lerp from start collapse to 1.0
      const k = this.releaseStartCollapseK + (1.0 - this.releaseStartCollapseK) * stepT;
      
      // If release complete, clear filters
      if (releaseT >= 1.0) {
        const wasClearingLocation = this.clearLocationAfterRelease;
        const wasClearingYear = this.clearYearAfterRelease;
        const wasClearingKeyword = this.clearKeywordAfterRelease;
        
        if (this.clearLocationAfterRelease) {
          // Clear location Set (already cleared in main.js, but ensure it's empty)
          this.activeLocations.clear();
          this.clearLocationAfterRelease = false;
        }
        if (this.clearYearAfterRelease) {
          // Clear year Set (already cleared in main.js, but ensure it's empty)
          this.activeYears.clear();
          this.clearYearAfterRelease = false;
        }
        if (this.clearKeywordAfterRelease) {
          // Clear keyword Set (already cleared in main.js, but ensure it's empty)
          this.activeKeywords.clear();
          this.clearKeywordAfterRelease = false;
        }
        this.isReleasingFilters = false;
        this.releaseStartCollapseK = 1.0;
        
        // Hard reset focus state when filters are cleared
        this.resetFocusState();
        
        // Reset UI state after clearing filters
        if (wasClearingLocation) {
          // Call UI reset function if registered
          if (this.resetLocationUI && typeof this.resetLocationUI === 'function') {
            setTimeout(() => {
              this.resetLocationUI();
            }, 0);
          }
        }
        if (wasClearingYear) {
          // Call UI reset function if registered
          if (this.resetDateUI && typeof this.resetDateUI === 'function') {
            setTimeout(() => {
              this.resetDateUI();
            }, 0);
          }
        }
        if (wasClearingKeyword) {
          // Call UI reset function if registered
          if (this.resetKeywordsUI && typeof this.resetKeywordsUI === 'function') {
            setTimeout(() => {
              this.resetKeywordsUI();
            }, 0);
          }
        }
        
        // If all filters are cleared, ensure complete reset
        if (this.activeLocations.size === 0 && this.activeYears.size === 0 && this.activeKeywords.size === 0) {
          this.resetFocusState();
        }
        
        return 1.0;
      }
      
      return k;
    }
    
    // Normal collapse based on zoom
    const zoomLevel = this.camera.zoom;
    
    // Track actual minimum zoom at runtime
    this.actualMinZoom = Math.min(this.actualMinZoom, zoomLevel);
    
    // Calibrate zoomStart and zoomFull based on actual minZoom
    if (this.zoomStart === null || this.zoomFull === null) {
      this.zoomStart = this.actualMinZoom; // Use minZoom directly (no offset)
      this.zoomFull = this.actualMinZoom + 0.85; // Max zoom band
      
      // Log calibration once
      if (!this.hasLoggedZoomCalibration) {
        this.hasLoggedZoomCalibration = true;
      }
    }
    
    // Compute density factor d in [0..1] based on visible count
    // For small sets (<=120): d=0 (tight collapse allowed)
    // For large sets (>=600): d=1 (spread more to prevent overlaps)
    const d = Math.max(0, Math.min(1, 
      (visibleCount - COLLAPSE_DENSITY_THRESHOLD_LOW) / 
      (COLLAPSE_DENSITY_THRESHOLD_HIGH - COLLAPSE_DENSITY_THRESHOLD_LOW)
    ));
    
    // Compute dynamic kMin based on density
    const kMinComputed = COLLAPSE_K_MIN_TIGHT + (COLLAPSE_K_MIN_LOOSE - COLLAPSE_K_MIN_TIGHT) * d;
    
    // Smooth kMin to avoid sudden parameter jumps
    this.kMinCurrent = this.kMinCurrent + (kMinComputed - this.kMinCurrent) * 0.10;
    
    // Compute t in [0..1] based on zoom with epsilon for immediate response
    // Use epsilon to shift the activation point earlier (removes deadzone)
    const zoomStartWithEpsilon = this.zoomStart - ZOOM_EPSILON;
    const zoomFullWithEpsilon = this.zoomFull - ZOOM_EPSILON;
    let t = (zoomLevel - zoomStartWithEpsilon) / (zoomFullWithEpsilon - zoomStartWithEpsilon);
    t = Math.max(0, Math.min(1, t)); // Clamp to [0..1]
    
    // Amplify early zoom for always-visible movement
    const t2 = Math.max(0, Math.min(1, t * 1.25)); // Amplifies early zoom
    
    // Compute target k (linear, no smoothstep)
    const kTarget = 1.0 + (this.kMinCurrent - 1.0) * t2;
    
    // Smooth k but keep it responsive
    this.kCurrent = this.kCurrent + (kTarget - this.kCurrent) * 0.28;
    
    // Return kCurrent (debug logging happens in render loop)
    return this.kCurrent;
  }
  
  /**
   * Compute collapsed position for a tile
   * Returns {x, y} in world space
   * @param {number} collapseTargetX - X coordinate of collapse target in world space
   * @param {number} collapseTargetY - Y coordinate of collapse target in world space
   */
  computeCollapsedPosition(tile, k, collapseTargetX, collapseTargetY) {
    // Base position
    const x0 = tile.x;
    const y0 = tile.y;
    
    // Use provided collapse target (mouse position in world space)
    const cx = collapseTargetX;
    const cy = collapseTargetY;
    
    // Offset from collapse target
    const dx = x0 - cx;
    const dy = y0 - cy;
    
    // Collapsed position
    const xCollapsed = cx + dx * k;
    const yCollapsed = cy + dy * k;
    
    return { x: xCollapsed, y: yCollapsed };
  }
  
  /**
   * Precompute non-overlapping focus layout for visible tiles
   * Called once when filters change or visible set changes
   * @param {Array} visibleTiles - Array of visible tile objects
   * @param {number} visibleCount - Number of visible tiles (for density-aware kMin)
   * @param {number} collapseTargetX - X coordinate of collapse target in world space (mouse position)
   * @param {number} collapseTargetY - Y coordinate of collapse target in world space (mouse position)
   */
  computeFocusLayout(visibleTiles, visibleCount, collapseTargetX, collapseTargetY) {
    if (visibleTiles.length === 0) {
      this.focusPos.clear();
      this.focusOffsets.clear();
      this.focusLayoutCameraCenter = null;
      return;
    }
    
    // Compute density-aware kMin for initial collapse (same as in render loop)
    const d = clamp((visibleCount - 120) / (600 - 120), 0, 1);
    const kMin = lerp(0.10, 0.45, d); // 0.10 = very compressed, 0.45 = less compressed
    
    // Use REAL drawn thumbnail size in WORLD units
    const tileWWorld = visibleTiles[0].w;
    const tileHWorld = visibleTiles[0].h;
    
    // Separation distances for anti-overlap: tighter for few images so zoom doesn't look too sparse
    const sepT = Math.max(0, Math.min(1, (visibleCount - FOCUS_SEP_COUNT_LOW) / (FOCUS_SEP_COUNT_HIGH - FOCUS_SEP_COUNT_LOW)));
    const sepMult = lerp(FOCUS_SEP_FEW, FOCUS_SEP_MANY, sepT);
    // Require at least tile size + gap so rectangles never overlap
    const minGap = MIN_GAP;
    const sepX = Math.max(tileWWorld * sepMult, tileWWorld + minGap);
    const sepY = Math.max(tileHWorld * sepMult, tileHWorld + minGap);
    const minDistX = sepX;
    const minDistY = sepY;
    const cellSize = Math.max(minDistX, minDistY);
    
    // More iterations so relaxation always removes overlaps
    const iterations = (visibleCount < 250) ? 22 : 32;
    
    // Build tile lookup map
    const tileMap = new Map();
    for (const tile of visibleTiles) {
      tileMap.set(tile.id, tile);
    }
    
    // Sort by id for deterministic order
    const sortedTiles = [...visibleTiles].sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    
    // Step 1: Start from natural positions, apply initial collapse to get seed positions
    const positions = new Map();
    for (const tile of sortedTiles) {
      const dx = tile.x - collapseTargetX;
      const dy = tile.y - collapseTargetY;
      // Apply initial collapse scale
      positions.set(tile.id, {
        x: collapseTargetX + dx * kMin,
        y: collapseTargetY + dy * kMin
      });
    }
    
    // Step 2: Run packing relaxation solver to remove overlaps
    const getCellKey = (x, y) => {
      const cellX = Math.floor(x / cellSize);
      const cellY = Math.floor(y / cellSize);
      return `${cellX},${cellY}`;
    };
    
    for (let iter = 0; iter < iterations; iter++) {
      // Rebuild spatial hash
      const grid = new Map();
      for (const tile of sortedTiles) {
        const pos = positions.get(tile.id);
        if (!pos) continue;
        const key = getCellKey(pos.x, pos.y);
        if (!grid.has(key)) {
          grid.set(key, []);
        }
        grid.get(key).push(tile.id);
      }
      
      let hadOverlap = false;
      
      for (const tile of sortedTiles) {
        const posA = positions.get(tile.id);
        if (!posA) continue;
        
        const cellX = Math.floor(posA.x / cellSize);
        const cellY = Math.floor(posA.y / cellSize);
        
        // Check own cell + 8 adjacent cells
        for (let cellDx = -1; cellDx <= 1; cellDx++) {
          for (let cellDy = -1; cellDy <= 1; cellDy++) {
            const neighborKey = `${cellX + cellDx},${cellY + cellDy}`;
            const neighborIds = grid.get(neighborKey);
            if (!neighborIds) continue;
            
            for (const neighborId of neighborIds) {
              if (neighborId === tile.id) continue;
              
              const neighborTile = tileMap.get(neighborId);
              if (!neighborTile) continue;
              
              const posB = positions.get(neighborId);
              if (!posB) continue;
              
              // Check axis-aligned bounding box overlap
              const dx = posB.x - posA.x;
              const dy = posB.y - posA.y;
              const absDx = Math.abs(dx);
              const absDy = Math.abs(dy);
              
              if (absDx < minDistX && absDy < minDistY) {
                hadOverlap = true;
                
                // Handle exact overlap
                if (absDx < 0.001 && absDy < 0.001) {
                  const hashA = tile.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
                  const hashB = neighborId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
                  const angleA = (hashA % 360) * Math.PI / 180;
                  const angleB = (hashB % 360) * Math.PI / 180;
                  const nudge = Math.min(minDistX, minDistY) * 0.3;
                  posA.x += Math.cos(angleA) * nudge;
                  posA.y += Math.sin(angleA) * nudge;
                  posB.x += Math.cos(angleB) * nudge;
                  posB.y += Math.sin(angleB) * nudge;
                } else {
                  // Push along dominant axis
                  const ratioX = absDx / minDistX;
                  const ratioY = absDy / minDistY;
                  
                  if (ratioX > ratioY) {
                    const pushX = (minDistX - absDx) * 0.5;
                    const signX = dx >= 0 ? 1 : -1;
                    posA.x -= signX * pushX;
                    posB.x += signX * pushX;
                  } else {
                    const pushY = (minDistY - absDy) * 0.5;
                    const signY = dy >= 0 ? 1 : -1;
                    posA.y -= signY * pushY;
                    posB.y += signY * pushY;
                  }
                }
              }
            }
          }
        }
      }
      
      if (!hadOverlap) {
        break; // No overlaps found, early exit
      }
    }
    
    // Step 3: Store focus positions and offsets relative to camera center
    // IMPORTANT: Only store positions for tiles in the CURRENT visible set
    // Clear any old entries first (should already be cleared, but double-check)
    const storedIds = new Set();
    for (const tile of sortedTiles) {
      const pos = positions.get(tile.id);
      if (!pos) continue;
      
      // Store absolute position
      this.focusPos.set(tile.id, { x: pos.x, y: pos.y });
      storedIds.add(tile.id);
      
      // Store offset relative to collapse target (for panning)
      this.focusOffsets.set(tile.id, {
        ox: pos.x - collapseTargetX,
        oy: pos.y - collapseTargetY
      });
    }
    
    // Remove any focusPos entries for tiles NOT in current visible set (safety check)
    for (const [id, pos] of this.focusPos.entries()) {
      if (!storedIds.has(id)) {
        this.focusPos.delete(id);
        this.focusOffsets.delete(id);
      }
    }
    
    // Store stable anchor point in world space (camera-independent)
    // This anchor is used to compute focus positions, allowing panning to work correctly
    // The anchor is the collapse target (mouse position) when layout was computed
    this.focusAnchorX = collapseTargetX;
    this.focusAnchorY = collapseTargetY;
    
    // Also store camera center for reference (but don't use it to update positions)
    this.focusLayoutCameraCenter = { x: this.camera.x, y: this.camera.y };
    
  }
  
  /**
   * Format date string from "YYYY-MM-DD HH:mm:ss" to "dd.mm.yyyy"
   */
  formatDateDDMMYYYY(dateString) {
    if (!dateString || typeof dateString !== 'string') return null;
    
    // Parse "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DD"
    const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!dateMatch) return null;
    
    const year = dateMatch[1];
    const month = dateMatch[2];
    const day = dateMatch[3];
    
    return `${day}.${month}.${year}`;
  }
  
  /**
   * Update which tile is at the viewport center (closest to screen center)
   * Uses hysteresis to prevent flickering when two tiles are close
   * Returns center tile info including screen rect and date string
   */
  updateCenterTile(visibleTiles, finalPositions) {
    if (visibleTiles.length === 0) {
      this.centerTileId = null;
      return { centerId: null, rect: null, dateString: null };
    }
    
    // Viewport center in screen space
    const viewportCenterX = this.width / 2;
    const viewportCenterY = this.height / 2;
    
    // Find the tile whose center is closest to viewport center (in screen space)
    let closestTileId = null;
    let closestDistSq = Infinity;
    let currentCenterDistSq = Infinity;
    let closestTile = null;
    let closestFinalPos = null;
    
    for (const tile of visibleTiles) {
      const finalPos = finalPositions.get(tile.id);
      if (!finalPos) continue;
      
      // Convert world position to screen space
      // Same transform as in applyTransform: translate to center, scale, translate back
      const worldCenterX = finalPos.x + tile.w / 2;
      const worldCenterY = finalPos.y + tile.h / 2;
      
      // Apply camera transform to get screen coordinates
      const screenX = (worldCenterX - this.camera.x) * this.camera.zoom + viewportCenterX;
      const screenY = (worldCenterY - this.camera.y) * this.camera.zoom + viewportCenterY;
      
      // Distance squared (avoid sqrt for performance)
      const dx = screenX - viewportCenterX;
      const dy = screenY - viewportCenterY;
      const distSq = dx * dx + dy * dy;
      
      // Track distance of current center tile (if it exists)
      if (tile.id === this.centerTileId) {
        currentCenterDistSq = distSq;
      }
      
      // Track closest tile
      if (distSq < closestDistSq) {
        closestDistSq = distSq;
        closestTileId = tile.id;
        closestTile = tile;
        closestFinalPos = finalPos;
      }
    }
    
    // Apply hysteresis: only switch if new candidate is significantly closer
    if (this.centerTileId === null) {
      // No current center, accept closest
      this.centerTileId = closestTileId;
    } else {
      // Check if current center is still valid (within viewport)
      const currentTile = visibleTiles.find(t => t.id === this.centerTileId);
      if (!currentTile) {
        // Current center is no longer visible, switch immediately
        this.centerTileId = closestTileId;
        // closestTile and closestFinalPos already set in loop above
      } else {
        // Only switch if new candidate is closer by hysteresis threshold (in screen pixels)
        const distDiff = Math.sqrt(currentCenterDistSq) - Math.sqrt(closestDistSq);
        if (distDiff > this.centerTileHysteresis) {
          this.centerTileId = closestTileId;
          // closestTile and closestFinalPos already set in loop above
        } else {
          // Keep current center tile
          closestTile = currentTile;
          closestFinalPos = finalPositions.get(this.centerTileId);
        }
      }
    }
    
    // Compute screen rect for center tile using REAL rendered image bounds
    let rect = null;
    let dateString = null;
    
    if (this.centerTileId && closestTile && closestFinalPos) {
      // Get aspect ratio from cache (if image is loaded)
      const cacheEntry = this.imageCache.get(this.centerTileId);
      const aspect = cacheEntry ? cacheEntry.aspect : (closestTile.w / closestTile.h); // Fallback to tile aspect
      
      // Compute REAL draw size in world units (same calculation as rendering)
      // Images are drawn with "contain" mode - fit inside tile while preserving aspect
      let drawW_world, drawH_world;
      if (closestTile.w / closestTile.h > aspect) {
        // Tile is wider than image aspect - fit to height
        drawH_world = closestTile.h;
        drawW_world = drawH_world * aspect;
      } else {
        // Tile is taller than image aspect - fit to width
        drawW_world = closestTile.w;
        drawH_world = drawW_world / aspect;
      }
      
      // Compute REAL image bounds in world space
      // Image is centered in tile: drawX/drawY is tile top-left, image is centered inside
      const imageCenterX_world = closestFinalPos.x + closestTile.w / 2;
      const imageCenterY_world = closestFinalPos.y + closestTile.h / 2;
      
      const imageLeft_world = imageCenterX_world - drawW_world / 2;
      const imageRight_world = imageCenterX_world + drawW_world / 2;
      const imageTop_world = imageCenterY_world - drawH_world / 2;
      const imageBottom_world = imageCenterY_world + drawH_world / 2;
      
      // Convert to screen space using camera transform (same as rendering)
      const imageLeft_screen = (imageLeft_world - this.camera.x) * this.camera.zoom + viewportCenterX;
      const imageBottom_screen = (imageBottom_world - this.camera.y) * this.camera.zoom + viewportCenterY;
      const imageRight_screen = (imageRight_world - this.camera.x) * this.camera.zoom + viewportCenterX;
      const imageTop_screen = (imageTop_world - this.camera.y) * this.camera.zoom + viewportCenterY;
      
      rect = {
        left: imageLeft_screen,
        top: imageTop_screen,
        right: imageRight_screen,
        bottom: imageBottom_screen,
        width: imageRight_screen - imageLeft_screen,
        height: imageBottom_screen - imageTop_screen
      };
      
      // Get date from photo metadata
      const photo = this.photosMap.get(this.centerTileId);
      if (photo && photo.taken) {
        dateString = this.formatDateDDMMYYYY(photo.taken);
      }
    }
    
    return { centerId: this.centerTileId, rect, dateString };
  }
  
  /**
   * Create the center date label DOM element
   */
  createCenterDateElement() {
    if (this.centerDateEl) return; // Already created
    
    this.centerDateEl = document.createElement('div');
    this.centerDateEl.className = 'center-date';
    this.centerDateEl.style.display = 'none';
    
    // Append to body (positioned relative to viewport, not canvas container)
    // This ensures it appears above the canvas
    document.body.appendChild(this.centerDateEl);
  }
  
  /**
   * Update the center date label position and content
   */
  updateCenterDateLabel(centerInfo) {
    if (!this.centerDateEl) {
      this.createCenterDateElement();
    }
    
    // During album mode or its exit transition, keep the center date label hidden
    // so it never appears before the drawer image is fully back in place.
    if (this.viewMode !== 'drawer' || this.exitTransitionActive) {
      this.centerDateEl.style.display = 'none';
      return;
    }
    
    if (!centerInfo) {
      this.centerDateEl.style.display = 'none';
      return;
    }
    
    const { centerId, rect, dateString } = centerInfo;
    
    // Check zoom level - only show date when center image has full opacity (zoomed in)
    // Use the same calculation as the center tile opacity
    const zoomT = clamp((this.camera.zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM), 0, 1);
    const ZOOM_THRESHOLD_FOR_CENTER = 0.5; // Same threshold as center image opacity
    // Use >= instead of > to match exactly when opacity becomes 1.0
    const isZoomedIn = zoomT >= ZOOM_THRESHOLD_FOR_CENTER;
    
    // Also check if center tile actually exists and is the current center
    const isCurrentCenter = centerId === this.centerTileId;
    
    // Hide if no center tile, no date, not zoomed in enough, or not the current center
    if (!centerId || !rect || !dateString || !isZoomedIn || !isCurrentCenter) {
      this.centerDateEl.style.display = 'none';
      return;
    }
    
    // Show and position the label (only when zoomed in)
    const GAP = 8; // Gap between image bottom and label
    this.centerDateEl.textContent = dateString;
    // Clear any inline styles that might hide it (from album mode exit)
    this.centerDateEl.style.display = 'block';
    this.centerDateEl.style.opacity = '';
    this.centerDateEl.style.visibility = '';
    this.centerDateEl.style.left = `${rect.left}px`;
    this.centerDateEl.style.top = `${rect.bottom + GAP}px`;
  }
  
  /**
   * Hard reset of focus state when filter is turned OFF
   * Fully clears all focus-related state
   */
  resetFocusState() {
    // Clear all focus data
    this.focusPos.clear();
    this.focusOffsets.clear();
    this.focusAnchorX = null;
    this.focusAnchorY = null;
    this.focusLayoutCameraCenter = null;
    this.lastVisibleSetHash = null;
    
    // Reset zoom baseline
    this.focusBaseZoom = null;
    this.zoomStart = null;
    this.zoomFull = null;
    
    // Reset focus progress and velocity
    this.focusProgress = 0;
    this.focusVel = 0;
    this.prevZoomLevel = this.camera.zoom;
    // Legacy compatibility
    this.focusAlpha = 0;
    this.focusAlphaTarget = 0;
    this.shouldSyncFocusAlpha = false;
    
    // Reset collapse zoom state
    this.collapseZoomState = 'out';
  }
  
  /**
   * Check if any filter is currently active
   */
  filtersActive() {
    return this.activeLocations.size > 0 || this.activeYears.size > 0 || this.activeKeywords.size > 0;
  }
  
  /**
   * Capture zoom baseline when filter is activated (first time only)
   * Called from main.js when filter is turned ON for the first time
   * Sets baseline appropriately based on current zoom to avoid jump
   * Note: Progress syncing happens in render loop after layout is computed
   */
  captureFocusBaseZoom() {
    const currentZoom = this.camera.zoom;
    
    // In collapse mode, set zoom to zoom out state (two-step zoom)
    this.collapseZoomState = 'out';
    this.targetZoom = this.COLLAPSE_ZOOM_OUT;
    
    // If already zoomed in, set baseline so targetProgress matches current zoom
    // This prevents jump when switching filters while already zoomed
    const estimatedProgress = clamp((currentZoom - MIN_ZOOM) / this.focusRange, 0, 1);
    
    if (estimatedProgress > 0.1) {
      // Already zoomed in: set baseline so current zoom maps to current progress
      this.focusBaseZoom = currentZoom - (estimatedProgress * this.focusRange);
      // Compute zoom range immediately (for legacy compatibility, but not used for motion)
      this.zoomStart = this.focusBaseZoom;
      this.zoomFull = this.focusBaseZoom + this.focusRange;
      // Set flag to sync progress after layout is computed in render loop
      this.shouldSyncFocusAlpha = true;
    } else {
      // Not zoomed in: keep focusBaseZoom null so focusProgress stays at 0
      // This prevents images from jumping when filter is first applied at low zoom
      this.focusBaseZoom = null;
      this.zoomStart = null;
      this.zoomFull = null;
      this.shouldSyncFocusAlpha = false;
      // Ensure progress is 0 when starting at low zoom
      this.focusProgress = 0;
      this.focusVel = 0;
    }
  }
  
  /**
   * Sync focus alpha to current zoom when switching filters while already zoomed
   * Called after recomputing focus layout for new filter
   */
  syncFocusAlphaFromCurrentZoom() {
    if (!this.filtersActive() || this.focusBaseZoom === null) {
      return;
    }
    
    // Compute focus alpha from current zoom immediately
    this.updateFocusFromZoom();
    // Sync alpha to target immediately (no smoothing delay)
    this.focusAlpha = this.focusAlphaTarget;
  }
  
  /**
   * Update focus progress using velocity-based controller (Torque-style)
   * Called in render loop - ALWAYS active, regardless of filters
   * Derives velocity from zoomDelta, integrates with friction
   * @param {number} [visibleCount] - When few filtered images, use faster collapse to reduce empty white space
   */
  updateFocusProgress(visibleCount) {
    const zoomLevel = this.camera.zoom;
    const zoomDelta = zoomLevel - this.prevZoomLevel;
    this.prevZoomLevel = zoomLevel;
    
    // Auto-set focusBaseZoom when user starts zooming (first non-zero zoomDelta)
    // Also reset if zoomLevel goes back near minimum
    // IMPORTANT: Check for any zoom change, even tiny ones, to capture baseline
    if (Math.abs(zoomDelta) > 0.00001) {
      // User is zooming - capture baseline if not set
      if (this.focusBaseZoom === null && this.filtersActive()) {
        // Set baseline to current zoom level when user starts zooming
        // This allows focus progress to start from 0 and increase as user zooms in
        this.focusBaseZoom = zoomLevel;
        // Compute zoom range immediately
        this.zoomStart = this.focusBaseZoom;
        this.zoomFull = this.focusBaseZoom + this.focusRange;
      }
    }
    
    // Reset focusBaseZoom if zoomLevel goes back near minimum
    if (zoomLevel <= 0.16) {
      this.focusBaseZoom = null;
      // Also reset progress when at minimum zoom
      if (this.focusProgress < 0.001) {
        this.focusProgress = 0;
        this.focusVel = 0;
      }
    }
    
    // IMPORTANT: If focusBaseZoom is null AND filters are active, keep progress at 0
    // This prevents images from jumping when filter is first applied at low zoom
    // But once user starts zooming, focusBaseZoom will be set and progress will update
    if (this.focusBaseZoom === null && this.filtersActive()) {
      // Keep progress at 0 until user starts zooming (which will set focusBaseZoom)
      this.focusProgress = 0;
      this.focusVel = 0;
      return;
    }
    
    // If filters are not active, don't update focus progress (it will decay to 0)
    if (!this.filtersActive()) {
      // No filters: progress decays to 0
      this.focusVel += (0 - this.focusProgress) * this.focusSpring;
      this.focusVel = clamp(this.focusVel, -this.focusMaxVel, this.focusMaxVel);
      this.focusProgress += this.focusVel;
      this.focusProgress = clamp(this.focusProgress, 0, 1);
      this.focusVel *= this.focusFriction;
      return;
    }
    
    // Compute target progress (focusBaseZoom is guaranteed to be non-null here)
    const targetProgress = clamp((zoomLevel - this.focusBaseZoom) / this.focusRange, 0, 1);
    
    // Normalize zoomDelta by focusRange so velocity impulse is strong from first tiny scroll
    const normalizedDelta = zoomDelta / this.focusRange;
    
    // Velocity model: vel += (target - progress) * spring + (zoomDelta / focusRange) * impulse
    this.focusVel += (targetProgress - this.focusProgress) * this.focusSpring;
    this.focusVel += normalizedDelta * this.focusImpulse;
    
    // Clamp velocity more aggressively to prevent large jumps
    this.focusVel = clamp(this.focusVel, -this.focusMaxVel, this.focusMaxVel);
    
    // When few filtered images: allow faster velocity change so collapse finishes quickly
    const fewVisible = visibleCount != null && visibleCount <= 55;
    const maxVelChange = fewVisible ? 0.012 : 0.005;
    if (this._lastFocusVel !== undefined) {
      const velChange = this.focusVel - this._lastFocusVel;
      const clampedVelChange = clamp(velChange, -maxVelChange, maxVelChange);
      this.focusVel = this._lastFocusVel + clampedVelChange;
      this.focusVel = clamp(this.focusVel, -this.focusMaxVel, this.focusMaxVel);
    }
    this._lastFocusVel = this.focusVel;
    
    // Clamp progress change per frame to prevent large jumps
    const lastProgress = this.focusProgress;
    
    // Integrate: progress += vel
    this.focusProgress += this.focusVel;
    this.focusProgress = clamp(this.focusProgress, 0, 1);
    
    // Clamp progress change per frame (additional safety)
    // When few filtered images: faster collapse so less long empty white space during zoom-in
    const isZoomingOut = zoomDelta < 0;
    const maxProgressChange = isZoomingOut ? 0.015 : (fewVisible ? 0.032 : 0.008);
    if (this._lastFocusProgress !== undefined) {
      const progressChange = this.focusProgress - this._lastFocusProgress;
      const clampedProgressChange = clamp(progressChange, -maxProgressChange, maxProgressChange);
      this.focusProgress = this._lastFocusProgress + clampedProgressChange;
      this.focusProgress = clamp(this.focusProgress, 0, 1);
    }
    this._lastFocusProgress = this.focusProgress;
    
    // Friction: vel *= friction
    this.focusVel *= this.focusFriction;
    
    // Smooth focusProgress to prevent jumps in final positions
    // When few visible: faster smoothing so cluster forms quickly and white space is brief
    const progressDiff = this.focusProgress - this.smoothedFocusProgress;
    const maxChangePerFrame = isZoomingOut ? 0.015 : (fewVisible ? 0.032 : 0.008);
    const clampedDiff = clamp(progressDiff, -maxChangePerFrame, maxChangePerFrame);
    const smoothingFactor = isZoomingOut ? 0.6 : (fewVisible ? 0.7 : 0.5);
    this.smoothedFocusProgress += clampedDiff * smoothingFactor;
    this.smoothedFocusProgress = clamp(this.smoothedFocusProgress, 0, 1);
    
    // Legacy compatibility
    this.focusAlpha = this.focusProgress;
    this.focusAlphaTarget = targetProgress;
    
  }
  
  /**
   * Anti-overlap pass for collapsed visible tiles (DEPRECATED - kept for reference)
   * Uses spatial hashing for O(n) performance
   * Returns Map<id, {x, y}> with non-overlapping positions
   * @param {Array} visibleTiles - Array of visible tile objects
   * @param {Map} collapsedPositions - Map<id, {x, y}> of collapsed positions
   * @param {number} collapseK - Current collapse factor (k < 0.9 means collapse is active)
   */
  resolveOverlaps(visibleTiles, collapsedPositions, collapseK) {
    if (visibleTiles.length === 0) return collapsedPositions;
    
    // Only run overlap resolution when collapse is meaningfully active (k <= 0.98)
    // Skip solver near boundary to reduce micro-jitter
    if (collapseK > 0.98) {
      return collapsedPositions;
    }
    
    // Use REAL drawn thumbnail size in WORLD units (tiles are already in world coords)
    const tileWWorld = visibleTiles[0].w; // Already in world coordinates
    const tileHWorld = visibleTiles[0].h; // Already in world coordinates
    
    // Scale separation with collapse progress (t2) - more space at max zoom
    // For few images use smaller sep range so zoom doesn't look too sparse; for many keep current range
    const sepRangeT = Math.max(0, Math.min(1, visibleCount / FOCUS_SEP_COUNT_HIGH));
    const sepMin = lerp(1.02, 1.12, sepRangeT);
    const sepMax = lerp(1.10, 1.30, sepRangeT);
    const kNormalized = Math.max(0, Math.min(1, (1.0 - collapseK) / (1.0 - COLLAPSE_K_MIN_TIGHT)));
    const t2 = Math.max(0, Math.min(1, kNormalized * 1.25)); // Amplified like in computeCollapseFactor
    const sepScale = sepMin + (sepMax - sepMin) * t2;
    const minDistX = tileWWorld * sepScale;
    const minDistY = tileHWorld * sepScale;
    
    // Cell size for spatial hash (should be >= max dimension)
    const cellSize = Math.max(minDistX, minDistY);
    
    // Increase iterations based on visible count (more iterations for large sets)
    const visibleCount = visibleTiles.length;
    const maxIterations = (visibleCount < 250) ? 8 : 14;
    
    // Create working positions (copy of collapsed positions)
    const positions = new Map();
    for (const [id, pos] of collapsedPositions.entries()) {
      positions.set(id, { x: pos.x, y: pos.y });
    }
    
    // Build tile lookup map for O(1) access
    const tileMap = new Map();
    for (const tile of visibleTiles) {
      tileMap.set(tile.id, tile);
    }
    
    // Sort visible tiles by id for deterministic iteration order
    const sortedTiles = [...visibleTiles].sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    
    const getCellKey = (x, y) => {
      const cellX = Math.floor(x / cellSize);
      const cellY = Math.floor(y / cellSize);
      return `${cellX},${cellY}`;
    };
    
    // Push-apart iterations
    let overlapFixIterations = 0;
    let totalNeighborChecks = 0;
    
    for (let iter = 0; iter < maxIterations; iter++) {
      // Rebuild spatial hash grid (positions may have changed)
      const grid = new Map();
      for (const tile of sortedTiles) {
        const pos = positions.get(tile.id);
        if (!pos) continue;
        const key = getCellKey(pos.x, pos.y);
        if (!grid.has(key)) {
          grid.set(key, []);
        }
        grid.get(key).push(tile.id);
      }
      
      let hadOverlap = false;
      
      // Iterate in deterministic order (sorted by id)
      for (const tile of sortedTiles) {
        const posA = positions.get(tile.id);
        if (!posA) continue;
        
        const cellX = Math.floor(posA.x / cellSize);
        const cellY = Math.floor(posA.y / cellSize);
        
        // Check own cell + 8 adjacent cells
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const neighborKey = `${cellX + dx},${cellY + dy}`;
            const neighborIds = grid.get(neighborKey);
            if (!neighborIds) continue;
            
            for (const neighborId of neighborIds) {
              if (neighborId === tile.id) continue;
              
              const neighborTile = tileMap.get(neighborId);
              if (!neighborTile) continue;
              
              const posB = positions.get(neighborId);
              if (!posB) continue;
              
              totalNeighborChecks++;
              
              // Check axis-aligned bounding box overlap
              const dx = posB.x - posA.x;
              const dy = posB.y - posA.y;
              const absDx = Math.abs(dx);
              const absDy = Math.abs(dy);
              
              // Check if they overlap (axis-aligned bounding box)
              if (absDx < minDistX && absDy < minDistY) {
                hadOverlap = true;
                
                // Handle exact overlap (dx == 0 && dy == 0)
                if (absDx < 0.001 && absDy < 0.001) {
                  // Deterministic tie-break using id hash (no jitter)
                  const hashA = tile.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
                  const hashB = neighborId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
                  
                  // Derive stable pseudo-direction from hash
                  const angleA = (hashA % 360) * Math.PI / 180;
                  const angleB = (hashB % 360) * Math.PI / 180;
                  
                  // Nudge amount based on minimum distance
                  const nudge = Math.min(minDistX, minDistY) * 0.3;
                  
                  posA.x += Math.cos(angleA) * nudge;
                  posA.y += Math.sin(angleA) * nudge;
                  posB.x += Math.cos(angleB) * nudge;
                  posB.y += Math.sin(angleB) * nudge;
                } else {
                  // Push along dominant axis to fully resolve overlap
                  const ratioX = absDx / minDistX;
                  const ratioY = absDy / minDistY;
                  
                  if (ratioX > ratioY) {
                    // Push along X axis (dominant)
                    const pushX = (minDistX - absDx) * 0.5;
                    const signX = dx >= 0 ? 1 : -1;
                    posA.x -= signX * pushX;
                    posB.x += signX * pushX;
                  } else {
                    // Push along Y axis (dominant)
                    const pushY = (minDistY - absDy) * 0.5;
                    const signY = dy >= 0 ? 1 : -1;
                    posA.y -= signY * pushY;
                    posB.y += signY * pushY;
                  }
                }
              }
            }
          }
        }
      }
      
      if (hadOverlap) {
        overlapFixIterations++;
      } else {
        break; // No overlaps found, early exit
      }
    }
    
    // Gently pull positions back toward collapsed target to keep cluster centered (light damping)
    for (const tile of sortedTiles) {
      const pos = positions.get(tile.id);
      const target = collapsedPositions.get(tile.id);
      if (!pos || !target) continue;
      
      // Lerp 8% back toward target (reduced from 15% for stability)
      pos.x = pos.x + (target.x - pos.x) * 0.08;
      pos.y = pos.y + (target.y - pos.y) * 0.08;
    }
    
    // Return raw solved positions (no smoothing - offsets will be used for stability)
    // Smoothing is handled via offsets in the render loop
    const solvedPositions = new Map();
    for (const tile of sortedTiles) {
      const pos = positions.get(tile.id);
      if (pos) {
        solvedPositions.set(tile.id, { x: pos.x, y: pos.y });
      }
    }
    
    // Store debug info
    this.lastOverlapDebug = {
      visibleCount: visibleTiles.length,
      overlapFixIterations,
      avgNeighborChecks: totalNeighborChecks / visibleTiles.length || 0
    };
    
    return solvedPositions;
  }

  /**
   * Render the scene
   */
  render() {
    const now = performance.now();
    
    // Update exit transition progress
    if (this.exitTransitionActive) {
      const elapsed = now - this.exitTransitionStartTime;
      const t = clamp(elapsed / this.exitTransitionDuration, 0, 1);
      const ease = easeInOutQuad(t);
      
      if (this.exitStartRect && this.exitEndRect && this.overlayImg) {
        // Interpolate overlay position
        const currentRect = {
          x: lerp(this.exitStartRect.x, this.exitEndRect.x, ease),
          y: lerp(this.exitStartRect.y, this.exitEndRect.y, ease),
          w: lerp(this.exitStartRect.w, this.exitEndRect.w, ease),
          h: lerp(this.exitStartRect.h, this.exitEndRect.h, ease)
        };
        
        // Update overlay position
        this.overlayImg.style.left = `${currentRect.x}px`;
        this.overlayImg.style.top = `${currentRect.y}px`;
        this.overlayImg.style.width = `${currentRect.w}px`;
        this.overlayImg.style.height = `${currentRect.h}px`;
      }
      
      // Stage 1: Fade in UI and animate menu bars down (starts at 30% of transition)
      const uiPhase = clamp((t - 0.3) / 0.7, 0, 1);
      const uiEase = easeInOutQuad(uiPhase);
      const fadeIn = uiEase; // 0 -> 1
      document.documentElement.style.setProperty('--uiAlpha', fadeIn.toString());
      
      // Animate menu bars down (translateY from negative to 0)
      // Calculate total height of all nav bars (top-nav + center-nav + filters-wrap)
      const navHeight = 15 + 40 + 35; // top-nav + center-nav + filters-nav (approximate)
      const translateY = lerp(-navHeight, 0, uiEase); // Start above, move down
      document.documentElement.style.setProperty('--navTranslateY', `${translateY}px`);
      
      // Check if exit transition is complete
      if (t >= 1) {
        this.exitTransitionActive = false;
        // Don't hide overlay here: hide on first drawer frame so the tile is drawn first (no hole) here: hide on first drawer frame so the tile is drawn first (no hole)
        this.exitHideOverlayNextFrame = true;
        
        // Return to drawer mode first (before restoring camera to prevent edge-pan interference)
        // viewMode will be set conditionally after navigation check
        this.selectedPhotoId = null;
        this.activeTileId = null;
        this.enterTileRect = null;
        
        // Disconnect observer and downgrade all album images
        if (this.albumImageObserver) {
          this.albumImageObserver.disconnect();
        }
        this.downgradeAllAlbumImages();
        
        // Do NOT clear center date label here: camera is restored in rAF below, so the next
        // render will call updateCenterDateLabel with correct camera and show the date in place.
        // Clearing here would make the date visible one frame early (wrong position) then jump.
        
        // Stop any panning activity and reset mouse tracking
        this.isPanning = false;
        this.mouseOverCanvas = false;
        this.panningUntil = 0; // Reset panning timer
        
        // Restore previous state IMMEDIATELY so tiles render at correct positions
        // (Must happen before this frame's tile rendering, not in requestAnimationFrame)
        const shouldSetViewModeToDrawer = !this.fromUserAlbums && !this.navigateToUserAfterExit;
        
        if (this.prevState) {
          this.camera.x = this.prevState.cameraX;
          this.camera.y = this.prevState.cameraY;
          this.camera.zoom = this.prevState.zoom;
          this.targetZoom = this.prevState.targetZoom;
          
          // Restore filter state (create new Sets to avoid reference issues)
          this.activeLocations = new Set(this.prevState.activeLocations || []);
          this.activeYears = new Set(this.prevState.activeYears || []);
          this.activeKeywords = new Set(this.prevState.activeKeywords || []);
          
          // Restore focus collapse state if it was active
          if (this.prevState.focusBaseZoom !== undefined) {
            this.focusBaseZoom = this.prevState.focusBaseZoom;
          }
          if (this.prevState.focusProgress !== undefined) {
            this.focusProgress = this.prevState.focusProgress;
          }
          if (this.prevState.focusVel !== undefined) {
            this.focusVel = this.prevState.focusVel;
          }
          if (this.prevState.prevZoomLevel !== undefined) {
            this.prevZoomLevel = this.prevState.prevZoomLevel;
          }
        }
        
        // Set viewMode to drawer immediately (camera is now restored)
        if (shouldSetViewModeToDrawer) {
          this.viewMode = 'drawer';
          // Force one full render so the returned-to tile is drawn even when camera
          // matches lastCameraState (e.g. after 2nd+ exit to same view), preventing
          // early-exit from leaving canvas stale until mouse move.
          this.forceRenderOnce = true;
        }
        
        // Navigate back to user albums page only if user explicitly clicked username (navigateToUserAfterExit).
        // If we came from user page but exit was via close/click-outside, return to drawer instead.
        if (this.fromUserAlbums && this.userAlbumsUsername && this.navigateToUserAfterExit) {
          // Store username before clearing flags
          const username = this.navigateToUserAfterExit;
          
          // Set flag FIRST, before any navigation or other operations
          // This prevents showDrawerView from updating nav title to "Remains"
          window.returningFromAlbum = true;
          
          // Update nav title IMMEDIATELY, BEFORE removing mode-album class
          // This ensures the correct text is set before the title becomes visible
          updateNavTitle({ view: 'user', username });
          
          // Force a synchronous reflow to ensure the text is updated
          const remainsLogo = document.getElementById('remainsLogo');
          if (remainsLogo) {
            const h1 = remainsLogo.querySelector('h1');
            if (h1) {
              void h1.offsetHeight;
            }
          }
          
          // Restore nav bars to open state immediately (before navigating)
          if (!this.topNavEl) {
            this.topNavEl = document.getElementById('top-nav');
          }
          if (!this.centerNavEl) {
            this.centerNavEl = document.getElementById('center-nav');
          }
          if (!this.filtersWrapEl) {
            this.filtersWrapEl = document.getElementById('filters-wrap');
          }
          
          // Cancel any existing animations
          this.navCloseAnimations.forEach(anim => anim.cancel());
          this.navCloseAnimations = [];
          this.navOpenAnimations.forEach(anim => anim.cancel());
          this.navOpenAnimations = [];
          
          // Restore nav bars to open state instantly
          const navElements = [this.topNavEl, this.centerNavEl, this.filtersWrapEl].filter(el => el !== null);
          navElements.forEach((navEl) => {
            navEl.style.transform = 'translateY(0) scaleY(1)';
            navEl.style.filter = 'blur(0px)';
            navEl.style.pointerEvents = '';
          });
          
          // Reset CSS variable
          document.documentElement.style.setProperty('--navTranslateY', '0px');
          
          // Hide canvas immediately to prevent drawer from showing during transition
          const canvas = document.getElementById('canvas');
          if (canvas) {
            canvas.style.display = 'none';
            canvas.classList.remove('fade-out', 'fade-in');
          }
          
          // Clear flags
          this.fromUserAlbums = false;
          this.userAlbumsUsername = null;
          this.navigateToUserAfterExit = null;
          
          // Remove album mode class and restore UI AFTER nav title is updated
          document.body.classList.remove('mode-album');
          document.documentElement.style.setProperty('--uiAlpha', '1');
          document.documentElement.style.setProperty('--navTranslateY', '0px'); // Ensure menu bars are fully down
          
          // Now navigate (unless user already went to Collections)
          if (getCurrentRoute() !== 'users') {
            navigate('user-albums', { username });
          }
        } else if (this.fromUserAlbums && this.userAlbumsUsername) {
          // Exited via close/click-outside (not username click) - return to drawer, do not navigate to user
          this.fromUserAlbums = false;
          this.userAlbumsUsername = null;
          document.body.classList.remove('mode-album');
          document.documentElement.style.setProperty('--uiAlpha', '1');
          document.documentElement.style.setProperty('--navTranslateY', '0px');
          const remainsLogo = document.getElementById('remainsLogo');
          if (remainsLogo && remainsLogo.querySelector('h1')) {
            remainsLogo.querySelector('h1').style.opacity = '1';
            remainsLogo.querySelector('h1').style.visibility = 'visible';
            remainsLogo.querySelector('h1').style.transition = '';
          }
          if (!this.topNavEl) this.topNavEl = document.getElementById('top-nav');
          if (!this.centerNavEl) this.centerNavEl = document.getElementById('center-nav');
          if (!this.filtersWrapEl) this.filtersWrapEl = document.getElementById('filters-wrap');
          this.navCloseAnimations.forEach(anim => anim.cancel());
          this.navCloseAnimations = [];
          this.navOpenAnimations.forEach(anim => anim.cancel());
          this.navOpenAnimations = [];
          [this.topNavEl, this.centerNavEl, this.filtersWrapEl].filter(Boolean).forEach((navEl) => {
            navEl.style.transform = 'translateY(0) scaleY(1)';
            navEl.style.filter = 'blur(0px)';
            navEl.style.pointerEvents = '';
          });
          const canvas = document.getElementById('canvas');
          if (canvas) {
            canvas.style.display = 'block';
            canvas.classList.remove('fade-out', 'fade-in');
          }
          this.viewMode = 'drawer';
          updateNavTitle({ view: 'drawer' });
          document.body.classList.add('filters-hover-disabled');
          this.animateNavOpen && this.animateNavOpen();
        } else if (this.navigateToUserAfterExit) {
          // Navigate to user page after exit transition (clicked on username)
          const username = this.navigateToUserAfterExit;
          
          // Set flag FIRST, before any navigation or other operations
          // This prevents showDrawerView from updating nav title to "Remains"
          window.returningFromAlbum = true;
          
          // Update nav title IMMEDIATELY, BEFORE removing mode-album class
          // This ensures the correct text is set before the title becomes visible
          updateNavTitle({ view: 'user', username });
          
          // Force a synchronous reflow to ensure the text is updated
          const remainsLogo = document.getElementById('remainsLogo');
          if (remainsLogo) {
            const h1 = remainsLogo.querySelector('h1');
            if (h1) {
              void h1.offsetHeight;
            }
          }
          
          // Restore nav bars to open state immediately (before navigating)
          if (!this.topNavEl) {
            this.topNavEl = document.getElementById('top-nav');
          }
          if (!this.centerNavEl) {
            this.centerNavEl = document.getElementById('center-nav');
          }
          if (!this.filtersWrapEl) {
            this.filtersWrapEl = document.getElementById('filters-wrap');
          }
          
          // Cancel any existing animations
          this.navCloseAnimations.forEach(anim => anim.cancel());
          this.navCloseAnimations = [];
          this.navOpenAnimations.forEach(anim => anim.cancel());
          this.navOpenAnimations = [];
          
          // Restore nav bars to open state instantly
          const navElements = [this.topNavEl, this.centerNavEl, this.filtersWrapEl].filter(el => el !== null);
          navElements.forEach((navEl) => {
            navEl.style.transform = 'translateY(0) scaleY(1)';
            navEl.style.filter = 'blur(0px)';
            navEl.style.pointerEvents = '';
          });
          
          // Reset CSS variable
          document.documentElement.style.setProperty('--navTranslateY', '0px');
          
          // Hide canvas immediately to prevent drawer from showing during transition
          const canvas = document.getElementById('canvas');
          if (canvas) {
            canvas.style.display = 'none';
            canvas.classList.remove('fade-out', 'fade-in');
          }
          
          // Clear flag and reset "from index" so later opening drawer doesn't redirect to index
          this.navigateToUserAfterExit = null;
          this.fromIndex = false;
          this.viewMode = 'drawer';
          
          // Remove album mode class and restore UI AFTER nav title is updated
          document.body.classList.remove('mode-album');
          document.documentElement.style.setProperty('--uiAlpha', '1');
          document.documentElement.style.setProperty('--navTranslateY', '0px'); // Ensure menu bars are fully down
          
          // Now navigate (unless user already went to Collections)
          if (getCurrentRoute() !== 'users') {
            navigate('user-albums', { username });
          }
        } else {
          // viewMode will be set to 'drawer' inside requestAnimationFrame above,
          // AFTER camera is restored, to prevent date label appearing at wrong position
          
          // Remove album mode class and restore UI when returning to drawer
          document.body.classList.remove('mode-album');
          document.documentElement.style.setProperty('--uiAlpha', '1');
          document.documentElement.style.setProperty('--navTranslateY', '0px');
          
          // Ensure nav title is visible
          const remainsLogo = document.getElementById('remainsLogo');
          if (remainsLogo) {
            const h1 = remainsLogo.querySelector('h1');
            if (h1) {
              h1.style.opacity = '1';
              h1.style.visibility = 'visible';
              h1.style.transition = '';
            }
          }
          
          // Restore nav bars to open state
          if (!this.topNavEl) {
            this.topNavEl = document.getElementById('top-nav');
          }
          if (!this.centerNavEl) {
            this.centerNavEl = document.getElementById('center-nav');
          }
          if (!this.filtersWrapEl) {
            this.filtersWrapEl = document.getElementById('filters-wrap');
          }
          
          // Cancel any existing animations
          this.navCloseAnimations.forEach(anim => anim.cancel());
          this.navCloseAnimations = [];
          this.navOpenAnimations.forEach(anim => anim.cancel());
          this.navOpenAnimations = [];
          
          // Restore nav bars to open state instantly
          const navElements = [this.topNavEl, this.centerNavEl, this.filtersWrapEl].filter(el => el !== null);
          navElements.forEach((navEl) => {
            navEl.style.transform = 'translateY(0) scaleY(1)';
            navEl.style.filter = 'blur(0px)';
            navEl.style.pointerEvents = '';
          });
        }
        
        // Temporarily disable filters panel hover to prevent accidental opening
        // User must move mouse away and hover again to activate
        document.body.classList.add('filters-hover-disabled');
        
        // Re-enable filters hover when mouse moves away from filters nav
        // This ensures user must move mouse away first, then hover again to activate
        const checkMouseAndEnable = () => {
          const filtersNav = document.getElementById('filters-nav');
          if (filtersNav) {
            const rect = filtersNav.getBoundingClientRect();
            // Get current mouse position from document (more reliable)
            let mouseX, mouseY;
            const handleMouseMove = (e) => {
              mouseX = e.clientX;
              mouseY = e.clientY;
              
              // Check if mouse is over filters nav
              const isOverFilters = (
                mouseX >= rect.left && mouseX <= rect.right &&
                mouseY >= rect.top && mouseY <= rect.bottom
              );
              
              if (!isOverFilters) {
                // Mouse moved away - re-enable hover
                document.body.classList.remove('filters-hover-disabled');
                document.removeEventListener('mousemove', handleMouseMove);
              }
            };
            
            // Listen for mouse move to detect when it leaves filters nav
            document.addEventListener('mousemove', handleMouseMove);
            
            // Also check immediately if mouse is already away
            setTimeout(() => {
              if (this.mouseX !== undefined && this.mouseY !== undefined) {
                const canvasRect = this.canvas.getBoundingClientRect();
                const canvasMouseX = this.mouseX + canvasRect.left;
                const canvasMouseY = this.mouseY + canvasRect.top;
                
                const isOverFilters = (
                  canvasMouseX >= rect.left && canvasMouseX <= rect.right &&
                  canvasMouseY >= rect.top && canvasMouseY <= rect.bottom
                );
                
                if (!isOverFilters) {
                  document.body.classList.remove('filters-hover-disabled');
                  document.removeEventListener('mousemove', handleMouseMove);
                }
              }
            }, 50);
          } else {
            document.body.classList.remove('filters-hover-disabled');
          }
        };
        
        checkMouseAndEnable();
        
        // Start nav opening animation (mechanical shutter reverse)
        // This happens after the image has landed back into its tile
        this.animateNavOpen();
        
      }
    }
    
    // Update enter transition progress
    if (this.transition.active) {
      const elapsed = now - this.transition.startTime;
      const t = clamp(elapsed / this.transition.duration, 0, 1);
      const ease = easeInOutQuad(t);
      
      // Stage 1: First fade out UI and animate menu bars up (0-70% of transition)
      const uiPhase = clamp(t / 0.7, 0, 1);
      const uiEase = easeInOutQuad(uiPhase);
      const fadeOut = 1 - uiEase;
      document.documentElement.style.setProperty('--uiAlpha', fadeOut.toString());
      
      // Animate menu bars up (translateY from 0 to negative)
      // Calculate total height of all nav bars (top-nav + center-nav + filters-wrap)
      const navHeight = 15 + 40 + 35; // top-nav + center-nav + filters-nav (approximate)
      const translateY = lerp(0, -navHeight, uiEase); // Start at 0, move up
      document.documentElement.style.setProperty('--navTranslateY', `${translateY}px`);
      
      // Check if transition is complete
      if (t >= 1) {
        this.transition.active = false;
        this.transitionJustCompleted = true; // Flag to skip album early return this frame
        this.viewMode = 'album';
        
        // Setup IntersectionObserver for HQ loading and upgrade main image
        this.setupAlbumImageObserver();
        if (this.albumMainImage) {
          this.albumImageObserver.observe(this.albumMainImage);
          // Upgrade main image to HQ immediately
          this.upgradeToHQ(this.albumMainImage);
        }
        
        // Observe all stack images
        if (this.albumStackLayer) {
          const stackImages = this.albumStackLayer.querySelectorAll('.album-stack-image');
          for (const img of stackImages) {
            this.albumImageObserver.observe(img);
          }
        }
        document.body.classList.add('mode-album');
        // Ensure UI is fully hidden
        document.documentElement.style.setProperty('--uiAlpha', '0');
        // Ensure menu bars are fully up
        const navHeight = 15 + 40 + 35;
        document.documentElement.style.setProperty('--navTranslateY', `-${navHeight}px`);
        // Ensure album meta UI is visible (it should already be shown, but make sure)
        if (this.albumMetaEl && this.selectedPhotoId) {
          this.updateAlbumMetaUI(this.selectedPhotoId);
          this.showAlbumMetaUI();
        }
        
        // Show album image wrapper INSTANTLY (no fade) - canvas was already showing the image
        // CRITICAL: Position/size wrapper to EXACTLY match canvas transition end rect
        const canvasEndRect = this.computeAlbumEndRect(this.tiles.find(t => t.id === this.selectedPhotoId));
        this.showAlbumImageWrapperAtRect(canvasEndRect);
        // NOTE: Do NOT call updateMainImage here - it would override the exact positioning
        // The image source was already set in showAlbumImageWrapperAtRect
        
        // Update album metadata details position after transition completes
        if (this.albumMetaDetailsEl && this.albumData) {
          requestAnimationFrame(() => {
            this.updateAlbumMetaDetailsPosition();
          });
        }
      }
    } else if (this.viewMode === 'album' && !this.exitTransitionActive) {
      // In album mode (not exiting) - close button removed
    } else if (this.exitTransitionActive) {
      // During exit transition
    } else if (this.viewMode === 'drawer' && !this.exitTransitionActive) {
      // In drawer mode - close button removed
    }
    
    // Branch: Album mode or Drawer mode
    // During exit transition, we need to render drawer tiles (with fade-in) instead of album mode
    // Also: when exit just completed (exitHideOverlayNextFrame), we must render tiles even if viewMode is still 'album'
    // Also: on the frame when enter transition just completed (transitionJustCompleted), draw only background to avoid flash of gallery tiles
    if ((this.viewMode === 'album' && !this.transition.active && !this.exitTransitionActive && !this.exitHideOverlayNextFrame && !this.transitionJustCompleted) || this.transitionJustCompleted) {
      // Normal album mode (not exiting) - DOM wrapper handles rendering, canvas just shows background
      // Same for transitionJustCompleted frame: only background, no tile loop
      this.ctx.fillStyle = '#f5f5f5';
      this.ctx.fillRect(0, 0, this.width, this.height);
      if (this.transitionJustCompleted) {
        this.transitionJustCompleted = false;
      }
      return;
    }
    
    // Reset transitionJustCompleted flag after it's been used (if not already consumed above)
    
    // First drawer frame after exit: fade out overlay (tile is drawn underneath)
    // This also handles the case where viewMode is still 'album' but exit just completed
    if (this.exitHideOverlayNextFrame) {
      this.exitHideOverlayNextFrame = false;
      if (this.overlayImg) {
        // IMPORTANT: Set transition FIRST, then force reflow, then change opacity
        this.overlayImg.style.transition = 'opacity 200ms ease-out';
        void this.overlayImg.offsetWidth; // Force reflow to apply transition
        this.overlayImg.style.opacity = '0';
        // Actually hide after fade completes
        setTimeout(() => {
          if (this.overlayImg) {
            this.overlayImg.style.display = 'none';
            this.overlayImg.style.transition = '';
            this.overlayImg.style.opacity = '1'; // Reset for next use
          }
        }, 220);
      }
    }
    
    // During exit transition, we render drawer tiles (with fade-in) - overlay handles the selected image
    // The drawer rendering code below will handle fade-in for other tiles
    
    // Don't render if tiles are not ready yet (layout still being created)
    if (this.tiles.length === 0) {
      // Just show background while loading
      this.ctx.fillStyle = '#f5f5f5';
      this.ctx.fillRect(0, 0, this.width, this.height);
      this.frameCount++;
      return;
    }
    
    // Drawer mode rendering (existing code)
    // Update zooming state
    if (this.isZooming && now > this.zoomingUntil) {
      this.isZooming = false;
    }
    
    // Update zoom with easing
    const zoomChanged = Math.abs(this.targetZoom - this.camera.zoom) > ZOOM_DEAD_ZONE;
    if (zoomChanged) {
      this.updateZoom();
    }
    
    // Clamp zoom to dynamic minimum (prevents empty space).
    // When filter just applied (focusBaseZoom null), do NOT force zoom-in to frame cluster — stay at zoom-out until user zooms.
    // When user chose zoom-out in collapse mode (collapseZoomState 'out'), allow zoom to reach COLLAPSE_ZOOM_OUT so they can exit zoom-in.
    const dynamicMinZoom = this.computeMinZoom();
    const allowZoomOutWhenFiltered = this.filtersActive() && (this.focusBaseZoom === null || this.collapseZoomState === 'out');
    if (this.camera.zoom < dynamicMinZoom && !allowZoomOutWhenFiltered) {
      this.camera.zoom = dynamicMinZoom;
      this.targetZoom = dynamicMinZoom;
    }
    
    // Clamp camera to bounds after zoom update
    this.clampCameraToBounds();
    
    // Update edge-pan (applies panning and clamps)
    // IMPORTANT: Panning must work in all modes, including focus collapse
    // Disable during transition, exit transition, or in album mode
    if (!this.transition.active && !this.exitTransitionActive && this.viewMode !== 'album') {
      this.updateEdgePan();
    }
    
    
    // Check if panning is still active (consider timeout)
    const isCurrentlyPanning = this.isPanning || (this.panningUntil > 0 && now < this.panningUntil);
    
    // Check if camera changed (for early exit optimization)
    const cameraChanged = this.cameraChanged();
    
    // Update visibility periodically or when camera changes
    // Skip throttle if filter change boost is active (load faster after filter change)
    const recentlyChangedFilters = (now - this.filterChangeTime) < this.FILTER_CHANGE_BOOST_MS;
    const shouldUpdateVisibility = recentlyChangedFilters || 
                                   this.frameCount % VISIBILITY_UPDATE_THROTTLE === 0 || 
                                   cameraChanged;
    if (shouldUpdateVisibility) {
      this.updateVisibility();
    }
    
    // Process load queue
    this.processLoadQueue();
    
    // Check preload completion (check every few frames to avoid overhead)
    if (this.isPreloading && this.frameCount % 5 === 0) {
      this.checkPreloadComplete();
    }
    
    // Evict cache if needed
    this.evictCache();
    
    // Check for filter changes BEFORE early exit (critical for detecting filter clears)
    // This must happen before early exit to prevent skipping render when filters are cleared
    const wasFilterActiveLastFrame = this.lastFilterActive;
    const isFilterActiveNow = this.filtersActive();
    const filterJustCleared = wasFilterActiveLastFrame && !isFilterActiveNow;
    const filterJustActivated = !wasFilterActiveLastFrame && isFilterActiveNow;
    const filterStateChanged = filterJustCleared || filterJustActivated;
    
    // Early exit optimization: skip rendering if nothing changed and no animations active
    // Only skip if: camera didn't change, not panning, not zooming, no transitions, no focus animation
    // IMPORTANT: Don't skip if images are still loading (imageCacheSize might be increasing)
    // IMPORTANT: Don't skip if filters are active OR if focus animation is running (need to render filtered results or animation)
    // IMPORTANT: Don't skip if filter state just changed (filters cleared or activated) - need to render the change
    const hasActiveAnimations = this.transition.active || 
                                this.exitTransitionActive || 
                                isCurrentlyPanning || 
                                zoomChanged ||
                                this.filtersActive() ||
                                (this.focusProgress > 0.001 || this.focusVel !== 0) ||
                                filterStateChanged; // Force render when filter state changes
    
    // Track if images are still loading
    const imagesStillLoading = this.isPreloading || this.loadingSet.size > 0 || this.loadQueue.length > 0;
    
    // Only skip if we're in drawer mode and nothing is animating and no images are loading
    // Increment frame count before early exit check
    this.frameCount++;
    
    if (!this.forceRenderOnce &&
        !hasActiveAnimations && 
        !cameraChanged && 
        !imagesStillLoading &&
        this.viewMode === 'drawer' && 
        this.frameCount > 1) {
      // Skip rendering this frame - nothing changed and no images loading
      return;
    }

    // If we forced a render, consume the flag now that we're actually going to draw.
    if (this.forceRenderOnce) {
      this.forceRenderOnce = false;
    }
    
    // Clear canvas with background color
    this.ctx.fillStyle = '#f5f5f5';
    this.ctx.fillRect(0, 0, this.width, this.height);
    
    // Apply camera transform
    this.camera.applyTransform(this.ctx);
    
    // Get visible bounds for culling
    const bounds = this.camera.getVisibleBounds();
    
    // Zoom-adaptive keep buffer for drawing images
    const zoomInv = 1 / this.camera.zoom;
    const keepBuffer = KEEP_BUFFER_BASE * zoomInv;
    const keepViewport = {
      left: bounds.left - keepBuffer,
      right: bounds.right + keepBuffer,
      top: bounds.top - keepBuffer,
      bottom: bounds.bottom + keepBuffer,
    };
    
    // Reset debug counters
    this.debugCounters.totalTiles = 0;
    this.debugCounters.drawnTiles = 0;
    this.debugCounters.skippedByFilter = 0;
    this.debugCounters.missingPhotoLookups = 0;
    
    // Compute collapse factor (only if filters active)
    const hasActiveFilter = this.filtersActive();
    
    // Collect visible tiles and compute collapsed positions (also get count for density-aware collapse)
    const visibleTiles = [];
    const visibleTileIds = new Set();
    const collapsedPositions = new Map();
    
    // Recompute visible set from scratch every frame (no caching)
    // OPTIMIZATION: When no filters are active, skip iteration and use all tiles directly
    let checkedCount = 0;
    let visibleCount = 0;
    let filteredOutCount = 0;
    
    if (!hasActiveFilter) {
      // No filters active - all tiles are visible, skip iteration for performance
      visibleTiles.push(...this.tiles);
      for (const tile of this.tiles) {
        visibleTileIds.add(tile.id);
      }
      visibleCount = this.tiles.length;
    } else {
      // Filters active - need to check each tile
      for (const tile of this.tiles) {
        // Check visibility filter (AND across categories, OR within categories)
        let isVisible = true;
        checkedCount++;
        const photo = this.photosMap.get(tile.id);
        if (!photo) {
          // Continue drawing even if photo lookup fails (fallback behavior)
        } else {
          // Recompute visibility from current Set state (no stale data)
          isVisible = isPhotoVisible(
            photo,
            this.activeLocations, // Current Set state
            this.activeYears,     // Current Set state
            this.activeKeywords,  // Current Set state
            this.locationToPhotoIds,
            this.allLocatedPhotoIds,
            this.unknownPhotoIds,
            this.yearToPhotoIds,
            this.unknownYearIds,
            this.keywordToPhotoIds,
            this.allKeywordPhotoIds,
            this.unknownKeywordIds
          );
          if (!isVisible) {
            filteredOutCount++;
            continue; // Skip if filtered out
          }
        }
        
        if (isVisible) {
          visibleTiles.push(tile);
          visibleTileIds.add(tile.id);
          visibleCount++;
        }
      }
    }
    
    // Get visible count
    const finalVisibleCount = visibleTiles.length;
    // isCollapseActive: filters are active (focusProgress always updates regardless)
    const isCollapseActive = hasActiveFilter;
    
    
    // Track filter state changes - use Set size comparison first for fast path
    let filterChanged = false;
    if (hasActiveFilter !== this.lastFilterActive) {
      filterChanged = true;
      this.lastFilterActive = hasActiveFilter;
      // Mark filter change time for faster image loading
      this.filterChangeTime = performance.now();
      // Add all visible tiles to queue immediately after filter change
      this.addAllVisibleTilesToQueue();
    } else if (hasActiveFilter) {
      // Only do expensive comparison if filters are active
      const locsChanged = this.activeLocations.size !== this.lastFilterSizes?.locations ||
        !this.setsEqual(this.activeLocations, this.lastActiveLocations);
      const yearsChanged = this.activeYears.size !== this.lastFilterSizes?.years ||
        !this.setsEqual(this.activeYears, this.lastActiveYears);
      const keywordsChanged = this.activeKeywords.size !== this.lastFilterSizes?.keywords ||
        !this.setsEqual(this.activeKeywords, this.lastActiveKeywords);
      
      filterChanged = locsChanged || yearsChanged || keywordsChanged;
      
      if (filterChanged) {
        // Mark filter change time for faster image loading
        this.filterChangeTime = performance.now();
        // Add all visible tiles to queue immediately after filter change
        this.addAllVisibleTilesToQueue();
        // Cache current state for next comparison
        this.lastActiveLocations = new Set(this.activeLocations);
        this.lastActiveYears = new Set(this.activeYears);
        this.lastActiveKeywords = new Set(this.activeKeywords);
        this.lastFilterSizes = {
          locations: this.activeLocations.size,
          years: this.activeYears.size,
          keywords: this.activeKeywords.size
        };
      }
    } else {
      // Filters were cleared - also mark as change
      if (this.lastFilterActive) {
        filterChanged = true;
        this.filterChangeTime = performance.now();
        // Add all visible tiles to queue immediately after filter clear
        this.addAllVisibleTilesToQueue();
      }
      this.lastFilterActive = false;
      this.lastActiveLocations = null;
      this.lastActiveYears = null;
      this.lastActiveKeywords = null;
      this.lastFilterSizes = null;
    }
    
    // Compute hash of visible set to detect changes - use size first for fast path
    const visibleSetChanged = visibleCount !== this.lastVisibleCount || 
      (visibleCount > 0 && visibleCount <= 1000 && this.visibleSetHash !== this.computeVisibleSetHash(visibleTiles));
    if (visibleSetChanged) {
      this.lastVisibleCount = visibleCount;
      if (visibleCount > 0 && visibleCount <= 1000) {
        this.visibleSetHash = this.computeVisibleSetHash(visibleTiles);
      }
    }
    
    // Check if zoom just started - freeze collapse target at center of view (camera center)
    // So after panning, zoom-in brings images to what the user is looking at, not to initial mouse position
    const zoomJustStarted = this.isZooming && !this.wasZooming;
    if (zoomJustStarted) {
      this.frozenCollapseTargetX = this.camera.x;
      this.frozenCollapseTargetY = this.camera.y;
    }
    
    // Update wasZooming for next frame
    this.wasZooming = this.isZooming;
    
    // Convert mouse position to world space for collapse target
    // Check if we're at zoom level where center image with text is shown
    // Use hysteresis: different thresholds for entering and exiting to prevent flickering
    const zoomT = clamp((this.camera.zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM), 0, 1);
    let isZoomedInWithCenterText;
    if (this.lastZoomedInWithCenterText) {
      // Currently in center text mode - use lower threshold to exit (hysteresis)
      isZoomedInWithCenterText = zoomT >= this.ZOOM_THRESHOLD_EXIT;
    } else {
      // Currently not in center text mode - use higher threshold to enter (hysteresis)
      isZoomedInWithCenterText = zoomT >= this.ZOOM_THRESHOLD_ENTER;
    }
    
    // While user is panning (organic center-based pan), freeze collapse target so cluster doesn't jump
    const panningActive = this.isPanning || (this.panningUntil > 0 && now < this.panningUntil);
    if (!panningActive) {
      this.panningCollapseTargetX = null;
      this.panningCollapseTargetY = null;
    }
    
    // Determine collapse target:
    // 1. If panning - use frozen target (camera center when pan started) so cluster doesn't jump
    // 2. If zooming - use frozen target (set when zoom started)
    // 3. If zoomed in with center text - use camera center
    // 4. Otherwise - follow mouse position
    let collapseTargetX, collapseTargetY;
    if (panningActive) {
      // During pan - use frozen target at camera center when pan started (don't chase mouse)
      if (this.panningCollapseTargetX === null || this.panningCollapseTargetY === null) {
        this.panningCollapseTargetX = this.camera.x;
        this.panningCollapseTargetY = this.camera.y;
      }
      collapseTargetX = this.panningCollapseTargetX;
      collapseTargetY = this.panningCollapseTargetY;
    } else if (this.isZooming && this.frozenCollapseTargetX !== null && this.frozenCollapseTargetY !== null) {
      // During zoom - use frozen target (don't update during zoom or pan)
      collapseTargetX = this.frozenCollapseTargetX;
      collapseTargetY = this.frozenCollapseTargetY;
    } else if (isZoomedInWithCenterText) {
      // At zoom level with center text - use camera center, don't follow mouse
      collapseTargetX = this.camera.x;
      collapseTargetY = this.camera.y;
      // Clear frozen target when entering center text mode
      this.frozenCollapseTargetX = null;
      this.frozenCollapseTargetY = null;
    } else if (this.mouseOverCanvas && this.mouseX > 0 && this.mouseY > 0) {
      // Not zooming and not at center text zoom - follow mouse position
      const mouseWorldPos = this.camera.screenToWorld(this.mouseX, this.mouseY);
      collapseTargetX = mouseWorldPos.x;
      collapseTargetY = mouseWorldPos.y;
      // Clear frozen target when not zooming
      this.frozenCollapseTargetX = null;
      this.frozenCollapseTargetY = null;
    } else {
      // Fallback to camera center when mouse is not over canvas
      collapseTargetX = this.camera.x;
      collapseTargetY = this.camera.y;
      // Clear frozen target
      this.frozenCollapseTargetX = null;
      this.frozenCollapseTargetY = null;
    }
    
    // Check if collapse target changed significantly (for layout recomputation)
    // Use larger threshold to prevent frequent layout updates that cause jumps
    const COLLAPSE_TARGET_CHANGE_THRESHOLD = 200; // World units - only recompute if target moved significantly
    const collapseTargetChanged = this.lastMouseWorldX === undefined || 
      this.lastMouseWorldY === undefined ||
      Math.abs(this.lastMouseWorldX - collapseTargetX) > COLLAPSE_TARGET_CHANGE_THRESHOLD ||
      Math.abs(this.lastMouseWorldY - collapseTargetY) > COLLAPSE_TARGET_CHANGE_THRESHOLD;
    
    // Only track mouse movement if not at zoom level with center text
    const mouseMoved = !isZoomedInWithCenterText && collapseTargetChanged;
    
    if (collapseTargetChanged) {
      this.lastMouseWorldX = collapseTargetX;
      this.lastMouseWorldY = collapseTargetY;
    } else if (isZoomedInWithCenterText) {
      // At zoom with center text - always use camera center, update tracking
      this.lastMouseWorldX = collapseTargetX;
      this.lastMouseWorldY = collapseTargetY;
    }
    
    // Check if zoom state changed (entered or exited center text zoom level)
    const zoomStateChanged = this.lastZoomedInWithCenterText !== isZoomedInWithCenterText;
    if (zoomStateChanged) {
      // Reset counter when state changes
      this.zoomStateChangeFrames = 0;
    } else {
      // Increment counter if state is stable
      this.zoomStateChangeFrames++;
    }
    
    // Update tracked state
    this.lastZoomedInWithCenterText = isZoomedInWithCenterText;
    
    // Only recompute layout if zoom state has been stable for a few frames (hysteresis to prevent flickering)
    // Also check that zoom is not currently changing rapidly (additional stability check)
    const zoomDelta = Math.abs(this.camera.zoom - this.lastZoomLevel);
    const zoomIsStable = zoomDelta < 0.01; // Zoom change is small (not rapidly changing)
    const zoomStateStable = !zoomStateChanged && this.zoomStateChangeFrames >= this.ZOOM_STATE_STABLE_FRAMES && zoomIsStable;
    const shouldRecomputeForZoomState = zoomStateStable && this.zoomStateChangeFrames === this.ZOOM_STATE_STABLE_FRAMES; // Only recompute once when stable
    
    // Compute focus layout if needed (filter changed, visible set changed, collapse target changed significantly, zoom state stable, or first time)
    // Allow one recompute when zoom just started so cluster uses frozen target (camera center) - fixes images not coming to frame center after pan
    // Don't recompute during zoom (except zoomJustStarted) or on mouse movement when at zoom level with center text
    // Don't recompute while user is panning (organic pan) - prevents cluster jump; target is frozen
    const needsFocusLayout = isCollapseActive && (!this.isZooming || zoomJustStarted) && (
      filterChanged ||
      visibleSetChanged ||
      shouldRecomputeForZoomState || // Recompute when zoom state has been stable (hysteresis)
      (collapseTargetChanged && this.focusPos.size > 0 && !isZoomedInWithCenterText && !panningActive) || // Recompute when collapse target moved (not while panning)
      this.focusPos.size === 0 ||
      this.focusLayoutCameraCenter === null ||
      zoomJustStarted // Recompute once at zoom start so focusAnchor = camera center (frozen target)
    );
    
    if (needsFocusLayout) {
      this.computeFocusLayout(visibleTiles, visibleCount, collapseTargetX, collapseTargetY);
      this.lastVisibleSetHash = this.visibleSetHash;
      
      // After recomputing layout, sync focus progress to current zoom level
      // This ensures images start in correct focused state when switching filters while zoomed
      // IMPORTANT: Only sync if focusBaseZoom is set (captured when filter was activated)
      // If not set, keep focusProgress at 0 to prevent images from jumping
      if (this.shouldSyncFocusAlpha && this.focusBaseZoom !== null) {
        // Compute target progress from current zoom (NO deadzone - no +0.0005 offset)
        const targetProgress = clamp((this.camera.zoom - this.focusBaseZoom) / this.focusRange, 0, 1);
        // Set progress immediately but keep velocity at 0 to avoid jump
        this.focusProgress = targetProgress;
        this.focusVel = 0;
        this.shouldSyncFocusAlpha = false;
      } else if (this.focusBaseZoom === null && isCollapseActive) {
        // Filter just activated but focusBaseZoom not set yet - keep progress at 0
        // This prevents images from jumping when filter is first applied
        this.focusProgress = 0;
        this.focusVel = 0;
      }
    }
    
    // Update focus progress using velocity-based controller (Torque-style)
    // Pass visible count so few filtered images collapse faster (less empty white space)
    this.updateFocusProgress(finalVisibleCount);
    
    // Precompute focus layout if needed (but don't apply until focusProgress > 0)
    // Build focus layout when filter is active, even if focusProgress is 0
    // IMPORTANT: Clear focusPos when filter changes to prevent stale entries
    if (filterChanged) {
      // Always clear focus data when filter changes (whether going active or inactive)
      this.focusPos.clear();
      this.focusOffsets.clear();
      this.lastVisibleSetHash = null; // Force recompute
      
      if (!isCollapseActive) {
        // Filter was cleared - reset focus state immediately
        this.resetFocusState();
      }
    }
    
    if (isCollapseActive && (filterChanged || visibleSetChanged || this.focusPos.size === 0)) {
      // Compute new focus layout for current visible set
      this.computeFocusLayout(visibleTiles, visibleCount, collapseTargetX, collapseTargetY);
      this.lastVisibleSetHash = this.visibleSetHash;
    }
    
    // Compute final positions using focusProgress blend (velocity-based, Torque-style)
    // p0 = original position (always exists)
    // p1 = focus position (if available)
    // final = lerp(p0, p1, focusProgress)
    // IMPORTANT: Only compute positions for tiles that are CURRENTLY visible
    let finalPositions = new Map();
    const hasFocusData = this.focusPos && this.focusPos.size > 0;
    
    for (const tile of visibleTiles) {
      // Double-check: tile must be in visibleTileIds (safety check)
      if (!visibleTileIds.has(tile.id)) {
        continue; // Skip if not in visible set
      }
      
      const p0 = { x: tile.x, y: tile.y }; // Original position (always exists)
      let x = p0.x;
      let y = p0.y;
      
      // Blend with focus position if filter is active, has focus data, and focusProgress > 0
      // IMPORTANT: Compute focus position in WORLD SPACE using stable anchor (camera-independent)
      // This allows panning to work correctly - the camera transform will handle the pan
      if (isCollapseActive && hasFocusData && this.focusProgress > 0.001 && 
          this.focusAnchorX !== null && this.focusAnchorY !== null) {
        const offset = this.focusOffsets.get(tile.id);
        if (offset) {
          // Compute focus position in world space using stable anchor (NOT current camera center)
          // This ensures panning works: when camera moves, focus positions stay in world space
          const focusX = this.focusAnchorX + offset.ox;
          const focusY = this.focusAnchorY + offset.oy;
          
          // Use smoothed focusProgress instead of raw focusProgress to prevent jumps
          const smoothProgress = this.smoothedFocusProgress;
          
          // Blend using smoothed focusProgress (smooth transitions)
          x = lerp(p0.x, focusX, smoothProgress);
          y = lerp(p0.y, focusY, smoothProgress);
        }
      }
      
      finalPositions.set(tile.id, { x, y });
    }
    
    // When filters active, store bounds of filtered tiles for pan clamping (camera cannot leave cluster).
    // Use focus positions (anchor + offsets) when available so bounds always match the collapsed cluster;
    // using finalPositions (blend) when focusProgress is low would yield full layout bounds and wrong centering.
    // EXCEPTION: When in zoom-out state (collapseZoomState === 'out'), use ORIGINAL tile positions
    // so the user can pan across all filtered tiles that are spread out.
    if (isCollapseActive && visibleTiles.length > 0) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      // When zoomed out, use original positions for bounds so user can pan to see all filtered tiles
      const isZoomOutState = this.collapseZoomState === 'out';
      const useFocusBounds = !isZoomOutState && this.focusAnchorX !== null && this.focusAnchorY !== null && this.focusOffsets && this.focusOffsets.size > 0;
      for (const tile of visibleTiles) {
        let pos;
        if (isZoomOutState) {
          // Use original tile positions when zoomed out
          pos = { x: tile.x, y: tile.y };
        } else if (useFocusBounds) {
          const offset = this.focusOffsets.get(tile.id);
          if (offset) {
            pos = {
              x: this.focusAnchorX + offset.ox,
              y: this.focusAnchorY + offset.oy
            };
          } else {
            pos = finalPositions.get(tile.id);
          }
        } else {
          pos = finalPositions.get(tile.id);
        }
        if (!pos) continue;
        minX = Math.min(minX, pos.x);
        maxX = Math.max(maxX, pos.x + tile.w);
        minY = Math.min(minY, pos.y);
        maxY = Math.max(maxY, pos.y + tile.h);
      }
      if (Number.isFinite(minX)) {
        // No shrink: use full cluster AABB so viewport never clips tiles at edges
        this.filteredLayoutBounds = { minX, maxX, minY, maxY };
      } else {
        this.filteredLayoutBounds = null;
      }
    } else {
      this.filteredLayoutBounds = null;
    }
    
    // When filter + collapse: ensure at least one tile is always visible so it's clear something is happening
    if (isCollapseActive && visibleTiles.length > 0) {
      const visible = this.camera.getVisibleBounds();
      let anyInView = false;
      for (const tile of visibleTiles) {
        const pos = finalPositions.get(tile.id);
        if (!pos) continue;
        const tileRight = pos.x + tile.w;
        const tileBottom = pos.y + tile.h;
        if (pos.x < visible.right && tileRight > visible.left && pos.y < visible.bottom && tileBottom > visible.top) {
          anyInView = true;
          break;
        }
      }
      // When filter changed: always recenter to new cluster so images are not cut off after zoom+filter change.
      // Use bounds center (not focusAnchor) on filter change: focusAnchor is tied to collapse target (= camera center when zoomed), so it would not move the camera.
      // When no tile is in view, recenter to the bounds of *current* final positions (not focus layout) so we center where tiles actually are this frame (they may still be lerping).
      const shouldRecenter = !anyInView || (filterChanged && isCollapseActive);
      if (shouldRecenter) {
        let centerX, centerY;
        if (filterChanged && isCollapseActive && this.filteredLayoutBounds) {
          centerX = (this.filteredLayoutBounds.minX + this.filteredLayoutBounds.maxX) / 2;
          centerY = (this.filteredLayoutBounds.minY + this.filteredLayoutBounds.maxY) / 2;
        } else if (!anyInView && visibleTiles.length > 0) {
          // Use AABB of current final positions so first image enters viewport immediately (works during zoom/collapse lerp)
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const tile of visibleTiles) {
            const pos = finalPositions.get(tile.id);
            if (!pos) continue;
            minX = Math.min(minX, pos.x);
            maxX = Math.max(maxX, pos.x + tile.w);
            minY = Math.min(minY, pos.y);
            maxY = Math.max(maxY, pos.y + tile.h);
          }
          if (Number.isFinite(minX)) {
            centerX = (minX + maxX) / 2;
            centerY = (minY + maxY) / 2;
          } else {
            centerX = this.focusAnchorX !== null ? this.focusAnchorX : this.camera.x;
            centerY = this.focusAnchorY !== null ? this.focusAnchorY : this.camera.y;
          }
        } else {
          centerX = this.focusAnchorX !== null ? this.focusAnchorX : (this.filteredLayoutBounds ? (this.filteredLayoutBounds.minX + this.filteredLayoutBounds.maxX) / 2 : this.camera.x);
          centerY = this.focusAnchorY !== null ? this.focusAnchorY : (this.filteredLayoutBounds ? (this.filteredLayoutBounds.minY + this.filteredLayoutBounds.maxY) / 2 : this.camera.y);
        }
        this.camera.x = centerX;
        this.camera.y = centerY;
        // Clamp camera to bounds in same frame so viewport does not show empty space or clip tiles at edges.
        if (isCollapseActive) {
          this.clampCameraToBounds();
        }
      }
    }
    
    // Clear focus layout when not in collapse
    if (!isCollapseActive) {
      this.resetFocusState();
    }
    
    // Update center tile (photo closest to viewport center)
    const centerInfo = this.updateCenterTile(visibleTiles, finalPositions);
    // Only show date label in drawer mode when canvas is visible (not in album mode, during transition, or when canvas is hidden)
    const isCanvasVisible = this.canvas && 
      this.canvas.style.display !== 'none' && 
      !this.canvas.classList.contains('fade-out') &&
      window.getComputedStyle(this.canvas).display !== 'none';
    
    if (this.viewMode === 'drawer' && !this.transition.active && isCanvasVisible) {
      this.updateCenterDateLabel(centerInfo);
    } else {
      // Hide date label in album mode or when canvas is hidden
      if (this.centerDateEl) {
        this.centerDateEl.style.display = 'none';
        this.centerDateEl.style.opacity = '0';
        this.centerDateEl.style.visibility = 'hidden';
      }
    }
    
    // Debug: sample first visible tile for logging
    let exampleTile = null;
    let sampleFound = false;
    
    // Enter-from-users fade: start on first drawer frame, one multiplier per frame for all tiles
    let enterFromUsersFadeMultiplier = 1;
    if (this.viewMode === 'drawer' && !this.transition.active && isCanvasVisible) {
      if (this.enterFromUsersFadePending) {
        this.enterFromUsersFadeStartTime = now;
        this.enterFromUsersFadePending = false;
      }
      if (this.enterFromUsersFadeStartTime > 0) {
        const elapsed = now - this.enterFromUsersFadeStartTime;
        const t = clamp(elapsed / this.enterFromUsersFadeDuration, 0, 1);
        enterFromUsersFadeMultiplier = easeInOutQuad(t);
        if (t >= 1) this.enterFromUsersFadeStartTime = 0;
      }
    }
    
    // Draw tiles (images or placeholders)
    // IMPORTANT: Only draw tiles that are in the current visible set
    for (const tile of this.tiles) {
      this.debugCounters.totalTiles++;
      
      // Check if tile is visible (use precomputed set - this is the source of truth)
      const isVisible = visibleTileIds.has(tile.id);
      if (!isVisible) {
        // Tile is not in visible set - skip it completely
        if (this.filtersActive()) {
          // Double-check visibility for filtered tiles (for debug counters)
          const photo = this.photosMap.get(tile.id);
          if (!photo) {
            this.debugCounters.missingPhotoLookups++;
          } else {
            this.debugCounters.skippedByFilter++;
          }
        }
        continue; // Skip drawing if not visible
      }
      
      // Get final draw position (from anti-overlap or base)
      let drawX = tile.x;
      let drawY = tile.y;
      
      if (isVisible) {
        const finalPos = finalPositions.get(tile.id);
        if (finalPos) {
          drawX = finalPos.x;
          drawY = finalPos.y;
        }
        
        // Capture first visible tile for debug (world and screen positions)
        if (!sampleFound) {
          const naturalX = tile.x;
          const naturalY = tile.y;
          const offset = this.focusOffsets.get(tile.id);
          const focusX = (this.focusAnchorX !== null && offset) ? this.focusAnchorX + offset.ox : null;
          const focusY = (this.focusAnchorY !== null && offset) ? this.focusAnchorY + offset.oy : null;
          
          // Convert world position to screen coordinates using camera transform
          const screenX = (drawX - this.camera.x) * this.camera.zoom + this.width / 2;
          const screenY = (drawY - this.camera.y) * this.camera.zoom + this.height / 2;
          
          exampleTile = {
            id: tile.id,
            naturalX: naturalX,
            naturalY: naturalY,
            focusX: focusX,
            focusY: focusY,
            drawX: drawX,
            drawY: drawY,
            screenX: screenX,
            screenY: screenY
          };
          sampleFound = true;
        }
      }
      
      // Simple culling: check if tile is in view (use collapsed position when applicable)
      if (
        drawX + tile.w < bounds.left ||
        drawX > bounds.right ||
        drawY + tile.h < bounds.top ||
        drawY > bounds.bottom
      ) {
        continue;
      }
      
      // During enter transition: draw only uniform background + selected tile in screen space (no gallery tiles)
      if (this.transition.active) {
        continue;
      }
      
      // Check if image is loaded and in keepViewport
      const cacheEntry = this.imageCache.get(tile.id);
      const hasImage = cacheEntry && cacheEntry.img.complete && cacheEntry.img.naturalWidth > 0;
      // Use final position for viewport intersection check
      const tileForViewport = isVisible && finalPositions.has(tile.id)
        ? { x: drawX, y: drawY, w: tile.w, h: tile.h }
        : tile;
      const inKeepViewport = hasImage && this.tileIntersectsViewport(tileForViewport, keepViewport, 0);
      
      // Update lastUsed for visible cached images
      if (cacheEntry) {
        cacheEntry.lastUsed = Date.now();
      }
      
      // Draw image if loaded and in keepViewport (prevents flicker)
      if (hasImage && inKeepViewport) {
        // Apply opacity based on zoom and center tile status
        const isCenterTile = (tile.id === this.centerTileId);
        
        // Compute opacity based on zoom and center tile status
        // Non-center images: always 0.5 opacity (same in zoomed out and zoomed in)
        // Center image: full opacity (1.0) ONLY when zoomed in (at or above threshold)
        const zoomT = clamp((this.camera.zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM), 0, 1);
        const ZOOM_THRESHOLD_FOR_CENTER = 0.5; // Only show center at full opacity when zoomT >= 0.5
        let opacityAmount = (isCenterTile && zoomT >= ZOOM_THRESHOLD_FOR_CENTER) ? 1.0 : 0.5;
        
        // Skip drawing selected tile during enter transition (will be drawn separately in screen space)
        if (this.transition.active && tile.id === this.transition.selectedId) {
          continue; // Skip this tile - it will be drawn in screen space after all other tiles
        }
        
        // Skip drawing selected tile during exit transition (overlay handles it)
        if (this.exitTransitionActive && tile.id === this.activeTileId) {
          continue; // Skip this tile - overlay handles the animation
        }
        
        // Apply fade-out during enter transition
        if (this.transition.active) {
          const elapsed = now - this.transition.startTime;
          const t = clamp(elapsed / this.transition.duration, 0, 1);
          const ease = easeInOutQuad(t);
          // First frame: other tiles start invisible to prevent flash (then same fade-out curve)
          const fadeOut = (elapsed < 16) ? 0 : (1 - ease);
          // Other tiles fade out
          opacityAmount *= fadeOut;
        }
        
        // Apply fade-in during exit transition
        if (this.exitTransitionActive) {
          const elapsed = now - this.exitTransitionStartTime;
          const t = clamp(elapsed / this.exitTransitionDuration, 0, 1);
          const ease = easeInOutQuad(t);
          const fadeIn = ease; // 0 -> 1
          // Other tiles fade in
          opacityAmount *= fadeIn;
        }
        
        // Apply fade-in when entering drawer from users page
        opacityAmount *= enterFromUsersFadeMultiplier;
        
        // Save context state
        this.ctx.save();
        
        // Apply opacity
        this.ctx.globalAlpha = opacityAmount;
        
        // Draw image, preserving aspect ratio (contain mode)
        const aspect = cacheEntry.aspect;
        let dw, dh, dx, dy;
        
        // Calculate draw dimensions that fit inside tile while preserving aspect
        if (tile.w / tile.h > aspect) {
          // Tile is wider than image aspect - fit to height
          dh = tile.h;
          dw = dh * aspect;
        } else {
          // Tile is taller than image aspect - fit to width
          dw = tile.w;
          dh = dw / aspect;
        }
        
        // Center image inside tile (use collapsed position)
        dx = drawX + (tile.w - dw) / 2;
        dy = drawY + (tile.h - dh) / 2;
        
      // Draw image
      this.ctx.drawImage(cacheEntry.img, dx, dy, dw, dh);
        
        // Restore context state
        this.ctx.restore();
      } else {
        // Draw placeholder only if image is not loaded or not in keepViewport (use collapsed position)
        // Apply same opacity as images
        const isCenterTile = (tile.id === this.centerTileId);
        const zoomT = clamp((this.camera.zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM), 0, 1);
        const ZOOM_THRESHOLD_FOR_CENTER = 0.5; // Only show center at full opacity when zoomT >= 0.5
        const opacityAmount = (isCenterTile && zoomT >= ZOOM_THRESHOLD_FOR_CENTER) ? 1.0 : 0.5;
        
        // Save context state
        this.ctx.save();
        
        // Skip drawing selected tile during enter transition (will be drawn separately in screen space)
        if (this.transition.active && tile.id === this.transition.selectedId) {
          continue; // Skip this tile - it will be drawn in screen space after all other tiles
        }
        
        // Skip drawing selected tile during exit transition (overlay handles it)
        if (this.exitTransitionActive && tile.id === this.activeTileId) {
          continue; // Skip this tile - overlay handles the animation
        }
        
        // Apply fade-out during enter transition
        let placeholderOpacity = opacityAmount;
        if (this.transition.active) {
          const elapsed = now - this.transition.startTime;
          const t = clamp(elapsed / this.transition.duration, 0, 1);
          const ease = easeInOutQuad(t);
          // First frame: other tiles start invisible to prevent flash (same as image branch)
          const fadeOut = (elapsed < 16) ? 0 : (1 - ease);
          // Other tiles fade out
          placeholderOpacity *= fadeOut;
        }
        // Apply fade-in when entering drawer from users page
        if (this.enterFromUsersFadeStartTime > 0) {
          const elapsed = now - this.enterFromUsersFadeStartTime;
          const t = clamp(elapsed / this.enterFromUsersFadeDuration, 0, 1);
          const ease = easeInOutQuad(t);
          placeholderOpacity *= ease;
        }
        
        this.ctx.globalAlpha = placeholderOpacity;
        
        this.ctx.fillStyle = '#e0e0e0';
        this.ctx.strokeStyle = '#d0d0d0';
        this.ctx.lineWidth = 1;
        this.ctx.fillRect(drawX, drawY, tile.w, tile.h);
        this.ctx.strokeRect(drawX, drawY, tile.w, tile.h);
        
        // Restore context state
        this.ctx.restore();
      }
      
      this.debugCounters.drawnTiles++;
    }
    
    // Restore transform
    this.camera.restoreTransform(this.ctx);
    
    // Draw selected tile in screen space during transition
    if (this.transition.active && this.transition.selectedId) {
      const elapsed = now - this.transition.startTime;
      const t = clamp(elapsed / this.transition.duration, 0, 1);
      const ease = easeInOutQuad(t);
      
      // Interpolate rect
      const startRect = this.transition.startRect;
      const endRect = this.transition.endRect;
      const currentRect = {
        x: lerp(startRect.x, endRect.x, ease),
        y: lerp(startRect.y, endRect.y, ease),
        w: lerp(startRect.w, endRect.w, ease),
        h: lerp(startRect.h, endRect.h, ease)
      };
      
      // Get image
      const cacheEntry = this.imageCache.get(this.transition.selectedId);
      if (cacheEntry && cacheEntry.img.complete && cacheEntry.img.naturalWidth > 0) {
        // Draw in screen space (no camera transform)
        this.ctx.save();
        this.ctx.globalAlpha = 1.0; // Selected tile stays fully visible
        this.ctx.drawImage(
          cacheEntry.img,
          currentRect.x,
          currentRect.y,
          currentRect.w,
          currentRect.h
        );
        this.ctx.restore();
      } else {
        // Draw placeholder
        this.ctx.save();
        this.ctx.globalAlpha = 1.0;
        this.ctx.fillStyle = '#e0e0e0';
        this.ctx.strokeStyle = '#d0d0d0';
        this.ctx.lineWidth = 1;
        this.ctx.fillRect(currentRect.x, currentRect.y, currentRect.w, currentRect.h);
        this.ctx.strokeRect(currentRect.x, currentRect.y, currentRect.w, currentRect.h);
        this.ctx.restore();
      }
    }
  }
  
  /**
   * Render album mode - single photo centered and large
   */
  renderAlbumMode() {
    // Clear canvas with background color
    this.ctx.fillStyle = '#f5f5f5';
    this.ctx.fillRect(0, 0, this.width, this.height);
    
    if (!this.selectedPhotoId) {
      return; // No photo selected
    }
    
    // Get the selected tile
    const tile = this.tiles.find(t => t.id === this.selectedPhotoId);
    if (!tile) {
      return; // Tile not found
    }
    
    // Get image from cache
    const cacheEntry = this.imageCache.get(this.selectedPhotoId);
    if (!cacheEntry || !cacheEntry.img.complete || cacheEntry.img.naturalWidth === 0) {
      // Image not loaded yet - draw placeholder
      this.ctx.fillStyle = '#e0e0e0';
      this.ctx.strokeStyle = '#d0d0d0';
      this.ctx.lineWidth = 1;
      
      // Calculate size for placeholder (same as image)
      const targetW = this.width * 0.40;
      const targetH = this.height * 0.80;
      // Try to get aspect from cache if available, otherwise use tile dimensions
      const cacheEntry = this.imageCache.get(this.selectedPhotoId);
      const aspect = cacheEntry && cacheEntry.aspect ? cacheEntry.aspect : (tile.w / tile.h);
      
      let drawW, drawH;
      if (targetW / aspect <= targetH) {
        drawW = targetW;
        drawH = targetW / aspect;
      } else {
        drawH = targetH;
        drawW = targetH * aspect;
      }
      
      const x = (this.width - drawW) / 2;
      const y = (this.height - drawH) / 2;
      
      this.ctx.fillRect(x, y, drawW, drawH);
      this.ctx.strokeRect(x, y, drawW, drawH);
      return;
    }
    
    const img = cacheEntry.img;
    
    // Calculate display size
    // Target: 40% of viewport width, max 80% of viewport height
    const targetW = this.width * 0.40;
    const targetH = this.height * 0.80;
    
    // Get aspect ratio from cache (preferred) or image
    const aspect = cacheEntry.aspect || (img.naturalWidth / img.naturalHeight);
    
    let drawW, drawH;
    if (targetW / aspect <= targetH) {
      // Width is the constraint
      drawW = targetW;
      drawH = targetW / aspect;
    } else {
      // Height is the constraint
      drawH = targetH;
      drawW = targetH * aspect;
    }
    
    // Center position
    const x = (this.width - drawW) / 2;
    const y = (this.height - drawH) / 2;
    
    // Draw image (no camera transform - direct screen space)
    this.ctx.drawImage(img, x, y, drawW, drawH);
  }
}
