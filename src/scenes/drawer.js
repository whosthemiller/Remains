/**
 * Drawer Scene - All drawer logic in one file
 * Handles data fetching, layout generation, camera, rendering, and interactions
 * 
 * ✅ CHECKPOINT: Good working state
 * - Poisson-disk layout with good spacing (DENSITY_FACTOR=2.0, MIN_DIST_MULTIPLIER=1.3)
 * - Smooth continuous zoom (0.15x to 1.5x)
 * - No flicker on zoom-out (viewport hysteresis with keepViewport)
 * - All images preload during loader
 * - Aspect ratio preserved, no stretching
 * Date: 2026-01-22
 */

// Constants
const TILE_WIDTH = 220;
const TILE_HEIGHT = 165;
const MIN_GAP = 1; // Minimal gap for maximum density
const POISSON_K = 30; // Number of attempts per point in Bridson algorithm
const DENSITY_FACTOR = 2.0; // Factor to increase spacing (more breathing room)
const MIN_DIST_MULTIPLIER = 1.3; // Multiplier for minimum distance between tiles
const EDGE_PAN_RADIUS_FACTOR = 0.48; // Fraction of viewport size (almost half-screen)
const SAFE_ZONE_RADIUS_FACTOR = 0.18; // Fraction of viewport size (center safe zone)
const PAN_SPEED_BASE = 12; // World units per frame (reduced for slower, more controlled edge-pan)
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 1.5;
const ZOOM_SENSITIVITY = 0.1;
const ZOOM_EASE_FACTOR = 0.03; // Much softer, slower smoothing
const ZOOM_DEAD_ZONE = 0.002; // Snap when very close to target
const MIN_ZOOM_TILES = 6;
const CAMERA_BOUNDS_PADDING = 60; // World units (modest padding)
const MAX_CONCURRENT_LOADS = 8;
const PRELOAD_MAX_CONCURRENT = 12; // Higher concurrency during initial preload
const MAX_CACHE_SIZE = 2000; // Increased to prevent flicker
const LOAD_BUFFER_BASE = 220; // Base load buffer (scales with zoom)
const KEEP_BUFFER_BASE = 520; // Base keep buffer (scales with zoom, larger than load)
const PRELOAD_TARGET = 160; // Target number of images to preload
const MIN_READY = 120; // Minimum images loaded before hiding loader
const PRELOAD_TIMEOUT_MS = 1500; // Max time to show loader
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

/**
 * Drawer Scene Class
 */
export class DrawerScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = new Camera();
    
    this.tiles = [];
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
    
    // Layout bounds cache
    this.layoutBounds = null;
    
    // Image loading state
    this.imageCache = new Map(); // Map<id, { img: Image, lastUsed: number }>
    this.loadingSet = new Set(); // Set<id> - currently loading
    this.loadQueue = []; // Array of { id, distance } - prioritized queue
    this.frameCount = 0;
    this.lastCameraState = { x: 0, y: 0, zoom: 0 };
    
    // Preload state
    this.loaderElement = document.getElementById('loader');
    this.isPreloading = false;
    this.preloadStartTime = 0;
    this.preloadTargets = []; // Array of ids to preload
    
    this.setupResize();
    this.setupEventHandlers();
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
    };
    
    window.addEventListener('resize', resize);
    resize(); // Initial resize
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
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      // Store zoom anchor (cursor position)
      this.zoomAnchorScreenX = x;
      this.zoomAnchorScreenY = y;
      
      // Continuous zoom: multiply by delta
      const delta = e.deltaY > 0 ? 1 - ZOOM_SENSITIVITY : 1 + ZOOM_SENSITIVITY;
      this.targetZoom *= delta;
      
      // Clamp to min/max
      this.clampTargetZoom();
    });
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
   */
  checkPreloadComplete() {
    if (!this.isPreloading) return;
    
    const loadedCount = this.imageCache.size;
    const totalTiles = this.tiles.length;
    const elapsed = Date.now() - this.preloadStartTime;
    
    // Hide loader if all images are loaded or timeout reached
    if (loadedCount >= totalTiles || elapsed >= PRELOAD_TIMEOUT_MS) {
      this.isPreloading = false;
      if (this.loaderElement) {
        this.loaderElement.classList.add('hidden');
        // Remove from DOM after transition
        setTimeout(() => {
          if (this.loaderElement) {
            this.loaderElement.remove();
          }
        }, 300);
      }
      console.log(`Preload complete: ${loadedCount}/${totalTiles} images loaded in ${elapsed}ms`);
    }
  }

  /**
   * Initialize with photo data
   */
  async initialize() {
    try {
      // Show loader immediately
      if (this.loaderElement) {
        this.loaderElement.classList.remove('hidden');
      }
      
      // Fetch photo data
      console.log('Loading photo index...');
      const response = await fetch('data/photos.index.json');
      if (!response.ok) {
        throw new Error(`Failed to load photo index: ${response.statusText}`);
      }
      
      const data = await response.json();
      console.log(`Loaded ${data.count} photos`);
      
      // Generate layout
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
      
      // Clamp initial zoom to min/max range
      this.camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, initialZoom));
      
      this.clampZoom();
      
      // Initialize target zoom to current zoom
      this.targetZoom = this.camera.zoom;
      
      // Cache layout bounds
      this.layoutBounds = bounds;
      
      // Clamp camera to bounds after initial positioning
      this.clampCameraToBounds();
      
      // Initialize camera state tracking
      this.lastCameraState = {
        x: this.camera.x,
        y: this.camera.y,
        zoom: this.camera.zoom,
      };
      
      // Select preload targets
      this.preloadTargets = this.selectPreloadTargets();
      console.log(`Selected ${this.preloadTargets.length} images for preload`);
      
      // Start preloading
      this.isPreloading = true;
      this.preloadStartTime = Date.now();
      this.startPreload();
      
      // Start render loop
      this.startRenderLoop();
      
      console.log('Drawer view initialized');
    } catch (error) {
      console.error('Error initializing drawer view:', error);
      // Hide loader on error
      if (this.loaderElement) {
        this.loaderElement.classList.add('hidden');
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
   * Start preloading initial batch
   */
  startPreload() {
    for (const id of this.preloadTargets) {
      if (!this.imageCache.has(id) && !this.loadingSet.has(id)) {
        this.loadImage(id);
      }
    }
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
   * Clamp target zoom (same logic as clampZoom but for targetZoom)
   * Applies max zoom rule to ensure ~6 tiles visible at max zoom
   */
  clampTargetZoom() {
    // Clamp to min/max zoom range (continuous, no steps)
    this.targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.targetZoom));
  }

  /**
   * Clamp camera position to layout bounds to prevent empty background
   */
  clampCameraToBounds() {
    if (!this.layoutBounds) {
      this.layoutBounds = this.getLayoutBounds();
    }
    
    const layout = this.layoutBounds;
    const visible = this.camera.getVisibleBounds();
    const visibleWidth = visible.right - visible.left;
    const visibleHeight = visible.bottom - visible.top;
    const layoutWidth = layout.maxX - layout.minX;
    const layoutHeight = layout.maxY - layout.minY;
    
    // Add padding
    const paddedMinX = layout.minX - CAMERA_BOUNDS_PADDING;
    const paddedMaxX = layout.maxX + CAMERA_BOUNDS_PADDING;
    const paddedMinY = layout.minY - CAMERA_BOUNDS_PADDING;
    const paddedMaxY = layout.maxY + CAMERA_BOUNDS_PADDING;
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
   * Update edge-pan with distance-from-center calculation and stronger contrast
   */
  updateEdgePan() {
    // Stop panning if mouse is not over canvas
    if (!this.mouseOverCanvas) {
      this.isPanning = false;
      return;
    }
    
    const width = this.width;
    const height = this.height;
    const minDimension = Math.min(width, height);
    const edgePanRadius = EDGE_PAN_RADIUS_FACTOR * minDimension;
    const safeZoneRadius = SAFE_ZONE_RADIUS_FACTOR * minDimension;
    
    // Center of viewport
    const centerX = width / 2;
    const centerY = height / 2;
    
    // Distance from center
    const dx = this.mouseX - centerX;
    const dy = this.mouseY - centerY;
    
    // Compute distance beyond safe zone for X axis
    const ax = Math.max(0, Math.abs(dx) - safeZoneRadius);
    const tX = Math.min(1, ax / (edgePanRadius - safeZoneRadius));
    // Strong contrast curve (very low in middle, ramps hard near edges)
    const intensityX = Math.pow(tX, 3.2);
    
    // Compute distance beyond safe zone for Y axis
    const ay = Math.max(0, Math.abs(dy) - safeZoneRadius);
    const tY = Math.min(1, ay / (edgePanRadius - safeZoneRadius));
    // Strong contrast curve
    const intensityY = Math.pow(tY, 3.2);
    
    // Calculate pan speeds (scaled by zoom)
    const speedX = PAN_SPEED_BASE * intensityX * (1 / this.camera.zoom);
    const speedY = PAN_SPEED_BASE * intensityY * (1 / this.camera.zoom);
    
    // Apply direction
    const panX = dx !== 0 ? Math.sign(dx) * speedX : 0;
    const panY = dy !== 0 ? Math.sign(dy) * speedY : 0;
    
    this.isPanning = panX !== 0 || panY !== 0;
    
    if (this.isPanning) {
      this.camera.pan(panX, panY);
      this.clampCameraToBounds();
    }
  }

  /**
   * Update zoom with easing toward targetZoom (stepped but smooth)
   */
  updateZoom() {
    const diff = this.targetZoom - this.camera.zoom;
    
    // Dead zone: snap when very close to target
    if (Math.abs(diff) < ZOOM_DEAD_ZONE) {
      if (Math.abs(this.camera.zoom - this.targetZoom) > 0.0001) {
        // Get world point before zoom change
        const worldPoint = this.camera.screenToWorld(this.zoomAnchorScreenX, this.zoomAnchorScreenY);
        this.camera.zoom = this.targetZoom;
        const newWorldPoint = this.camera.screenToWorld(this.zoomAnchorScreenX, this.zoomAnchorScreenY);
        this.camera.x += worldPoint.x - newWorldPoint.x;
        this.camera.y += worldPoint.y - newWorldPoint.y;
      }
      return;
    }
    
    // Get world point before zoom change
    const worldPoint = this.camera.screenToWorld(this.zoomAnchorScreenX, this.zoomAnchorScreenY);
    
    // Ease toward target with slower smoothing for "soft stops"
    this.camera.zoom += diff * ZOOM_EASE_FACTOR;
    
    // Adjust camera position to keep zoom anchor fixed
    const newWorldPoint = this.camera.screenToWorld(this.zoomAnchorScreenX, this.zoomAnchorScreenY);
    this.camera.x += worldPoint.x - newWorldPoint.x;
    this.camera.y += worldPoint.y - newWorldPoint.y;
  }

  /**
   * Start render loop
   */
  startRenderLoop() {
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
    candidates.sort((a, b) => a.distance - b.distance);
    
    for (const candidate of candidates) {
      if (!this.loadQueue.find(item => item.id === candidate.id)) {
        this.loadQueue.push(candidate);
      }
    }
    
    // Sort queue by distance
    this.loadQueue.sort((a, b) => a.distance - b.distance);
  }

  /**
   * Process load queue (up to MAX_CONCURRENT_LOADS or PRELOAD_MAX_CONCURRENT during preload)
   */
  processLoadQueue() {
    // Remove items that are already loaded or loading
    this.loadQueue = this.loadQueue.filter(
      item => !this.imageCache.has(item.id) && !this.loadingSet.has(item.id)
    );
    
    // Use higher concurrency during preload
    const maxConcurrent = this.isPreloading ? PRELOAD_MAX_CONCURRENT : MAX_CONCURRENT_LOADS;
    
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
    
    // Find tile to get src
    const tile = this.tiles.find(t => t.id === id);
    if (!tile) return;
    
    this.loadingSet.add(id);
    
    const img = new Image();
    img.onload = () => {
      // Store image with aspect ratio
      const aspect = img.naturalWidth / img.naturalHeight;
      this.imageCache.set(id, { img, aspect, lastUsed: Date.now() });
      this.loadingSet.delete(id);
      
      // Check if preload is complete
      if (this.isPreloading) {
        this.checkPreloadComplete();
      }
      
      this.processLoadQueue(); // Continue processing queue
    };
    img.onerror = () => {
      // Skip on error, just remove from loading set
      this.loadingSet.delete(id);
      
      // Check if preload is complete (even if some failed)
      if (this.isPreloading) {
        this.checkPreloadComplete();
      }
      
      this.processLoadQueue(); // Continue processing queue
    };
    img.src = tile.src;
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
   * Render the scene
   */
  render() {
    this.frameCount++;
    
    // Update zoom with easing
    this.updateZoom();
    
    // Clamp camera to bounds after zoom update
    this.clampCameraToBounds();
    
    // Update edge-pan (applies panning and clamps)
    this.updateEdgePan();
    
    // Update visibility periodically or when camera changes
    if (this.frameCount % VISIBILITY_UPDATE_THROTTLE === 0 || this.cameraChanged()) {
      this.updateVisibility();
    }
    
    // Process load queue
    this.processLoadQueue();
    
    // Check preload completion
    if (this.isPreloading) {
      this.checkPreloadComplete();
    }
    
    // Evict cache if needed
    this.evictCache();
    
    // Clear canvas with background color
    this.ctx.fillStyle = '#f5f5f5';
    this.ctx.fillRect(0, 0, this.width, this.height);
    
    // Apply camera transform
    this.camera.applyTransform(this.ctx);
    
    // Get visible bounds for culling
    const bounds = this.camera.getVisibleBounds();
    
    // Zoom-adaptive keep buffer for drawing images
    const k = 1 / this.camera.zoom;
    const keepBuffer = KEEP_BUFFER_BASE * k;
    const keepViewport = {
      left: bounds.left - keepBuffer,
      right: bounds.right + keepBuffer,
      top: bounds.top - keepBuffer,
      bottom: bounds.bottom + keepBuffer,
    };
    
    // Draw tiles (images or placeholders)
    for (const tile of this.tiles) {
      // Simple culling: check if tile is in view
      if (
        tile.x + tile.w < bounds.left ||
        tile.x > bounds.right ||
        tile.y + tile.h < bounds.top ||
        tile.y > bounds.bottom
      ) {
        continue;
      }
      
      // Check if image is loaded and in keepViewport
      const cacheEntry = this.imageCache.get(tile.id);
      const hasImage = cacheEntry && cacheEntry.img.complete && cacheEntry.img.naturalWidth > 0;
      const inKeepViewport = hasImage && this.tileIntersectsViewport(tile, keepViewport, 0);
      
      // Update lastUsed for visible cached images
      if (cacheEntry) {
        cacheEntry.lastUsed = Date.now();
      }
      
      // Draw image if loaded and in keepViewport (prevents flicker)
      if (hasImage && inKeepViewport) {
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
        
        // Center image inside tile (top-left anchored)
        dx = tile.x + (tile.w - dw) / 2;
        dy = tile.y + (tile.h - dh) / 2;
        
        // Draw image
        this.ctx.drawImage(cacheEntry.img, dx, dy, dw, dh);
      } else {
        // Draw placeholder only if image is not loaded or not in keepViewport
        this.ctx.fillStyle = '#e0e0e0';
        this.ctx.strokeStyle = '#d0d0d0';
        this.ctx.lineWidth = 1;
        this.ctx.fillRect(tile.x, tile.y, tile.w, tile.h);
        this.ctx.strokeRect(tile.x, tile.y, tile.w, tile.h);
      }
    }
    
    // Restore transform
    this.camera.restoreTransform(this.ctx);
  }
}
