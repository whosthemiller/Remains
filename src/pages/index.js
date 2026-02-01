/**
 * Index Page - Displays a table with all images
 */

import { buildImageUrl } from '../utils/paths.js';
import { navigate } from '../routing.js';

let photosData = [];
let filterChangeListener = null;

/**
 * Format date from Unix timestamp
 */
function formatDate(unixTimestamp) {
  if (!unixTimestamp) return 'N/A';
  const date = new Date(unixTimestamp * 1000);
  return date.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric' 
  });
}

/**
 * Calculate storage duration from upload date (in days only)
 */
function calculateStorageDuration(uploadedUnix) {
  if (!uploadedUnix) return 'N/A';
  
  const uploadDate = new Date(uploadedUnix * 1000);
  const now = new Date();
  const diffMs = now - uploadDate;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  return `${diffDays} days`;
}

/**
 * Calculate navigation bar position and column widths
 */
function calculateColumnWidths() {
  const navRightOffset = 35; // --nav-right-offset
  const navWidth = 1274; // --nav-width
  const windowWidth = window.innerWidth;
  
  // Navigation bar left edge
  const navLeftEdge = windowWidth - navRightOffset - navWidth;
  
  // Left column width (from 0 to nav bar left edge)
  const leftColumnWidth = navLeftEdge;
  
  // Data columns total width (nav bar width)
  const dataColumnsWidth = navWidth;
  
  // Each data column width (5 equal columns)
  const dataColumnWidth = dataColumnsWidth / 5;
  
  return {
    leftColumnWidth,
    dataColumnWidth,
    navLeftEdge
  };
}


/**
 * Create table row for a photo
 */
function createPhotoRow(photo, columnWidths) {
  const imageId = photo.photoId || photo.id || 'N/A';
  const resolution = photo.resolution || 'N/A';
  const fileSize = photo.fileSize || 'N/A';
  const uploadDate = formatDate(photo.uploadedUnix);
  const storageDuration = calculateStorageDuration(photo.uploadedUnix);
  
  // Build image URL using path utility
  const imageSrc = buildImageUrl(photo);
  
  return `
    <tr class="index-table-row index-row-clickable" data-photo-id="${photo.id || ''}" data-user-key="${photo.userKey || ''}">
      <td class="index-table-thumbnail-cell" style="width: ${columnWidths.leftColumnWidth}px;">
        <div class="index-table-thumbnail-wrapper">
          <img src="${imageSrc}" alt="" class="index-table-thumbnail" loading="lazy" />
        </div>
      </td>
      <td class="index-table-data-cell" style="width: ${columnWidths.dataColumnWidth}px;">${imageId}</td>
      <td class="index-table-data-cell" style="width: ${columnWidths.dataColumnWidth}px;">${resolution}</td>
      <td class="index-table-data-cell" style="width: ${columnWidths.dataColumnWidth}px;">${fileSize}</td>
      <td class="index-table-data-cell" style="width: ${columnWidths.dataColumnWidth}px;">${uploadDate}</td>
      <td class="index-table-data-cell" style="width: ${columnWidths.dataColumnWidth}px;">${storageDuration}</td>
    </tr>
  `;
}

/**
 * Load photos data
 */
async function loadPhotosData() {
  try {
    const response = await fetch('data/photos.index.json');
    if (!response.ok) {
      console.error('Failed to load photos.index.json');
      return [];
    }
    const data = await response.json();
    return data.photos || [];
  } catch (error) {
    console.error('Error loading photos data:', error);
    return [];
  }
}

/**
 * Check if a photo matches any value in a set (OR logic within category)
 * Reused from drawer.js logic
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

/**
 * Check if a photo is visible based on active filters
 * Reused from drawer.js logic
 */
function isPhotoVisible(photo, drawerScene) {
  if (!photo || !photo.id) return false;
  if (!drawerScene) return true; // No drawer scene = show all
  
  const {
    activeLocations,
    activeYears,
    activeKeywords,
    locationToPhotoIds,
    allLocatedPhotoIds,
    unknownPhotoIds,
    yearToPhotoIds,
    unknownYearIds,
    keywordToPhotoIds,
    allKeywordPhotoIds,
    unknownKeywordIds
  } = drawerScene;
  
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
  return passesLocation && passesYear && passesKeyword;
}

/**
 * Filter photos based on active filters
 */
function filterPhotos(photos, drawerScene) {
  if (!drawerScene || !drawerScene.filtersActive()) {
    return photos; // No filters active = show all
  }
  
  return photos.filter(photo => isPhotoVisible(photo, drawerScene));
}

// Cache last rendered content to prevent unnecessary re-renders
let lastRenderedContentHash = null;
let lastRenderedPhotoCount = 0;

/**
 * Render Index Page
 */
export async function renderIndexPage() {
  const container = document.getElementById('page-container');
  if (!container) {
    console.error('Page container not found');
    return;
  }
  
  // Load photos data (only if not already loaded)
  if (photosData.length === 0) {
    photosData = await loadPhotosData();
  }
  
  // Get drawer scene instance for filtering
  const drawerScene = window.drawerSceneInstance;
  
  // Filter photos based on active filters
  let filteredPhotos = filterPhotos(photosData, drawerScene);
  
  // Sort photos by Image ID (photoId) numerically
  filteredPhotos.sort((a, b) => {
    const idA = parseInt(a.photoId || a.id || '0', 10);
    const idB = parseInt(b.photoId || b.id || '0', 10);
    return idA - idB;
  });
  
  // Check if container has the correct content (index-page)
  const hasIndexPage = container.querySelector('.index-page') !== null;
  const hasOtherContent = container.querySelector('.users-page, .user-albums-page') !== null;
  
  // Check if content actually changed (prevent unnecessary re-renders)
  const currentPhotoCount = filteredPhotos.length;
  const contentHash = JSON.stringify({
    count: currentPhotoCount,
    firstId: filteredPhotos[0]?.id,
    lastId: filteredPhotos[filteredPhotos.length - 1]?.id
  });
  
  // If content hasn't changed AND container already has index-page, skip re-render
  // BUT if container has other content (users-page, etc.), we MUST re-render to replace it
  if (contentHash === lastRenderedContentHash && currentPhotoCount === lastRenderedPhotoCount && hasIndexPage && !hasOtherContent) {
    return; // Skip re-render if content is the same and container is correct
  }
  
  // Update cache
  lastRenderedContentHash = contentHash;
  lastRenderedPhotoCount = currentPhotoCount;
  
  // Calculate column widths
  const columnWidths = calculateColumnWidths();
  
  // Create table HTML
  const tableRows = filteredPhotos.map(photo => createPhotoRow(photo, columnWidths)).join('');
  
  const html = `
    <div class="index-page">
      <table class="index-table">
        <thead class="index-table-header">
          <tr>
            <th class="index-table-thumbnail-header" style="width: ${columnWidths.leftColumnWidth}px;"></th>
            <th style="width: ${columnWidths.dataColumnWidth}px;">Image ID</th>
            <th style="width: ${columnWidths.dataColumnWidth}px;">Resolution</th>
            <th style="width: ${columnWidths.dataColumnWidth}px;">File size</th>
            <th style="width: ${columnWidths.dataColumnWidth}px;">Upload Date</th>
            <th style="width: ${columnWidths.dataColumnWidth}px;">Storage Duration</th>
          </tr>
        </thead>
        <tbody class="index-table-body">
          ${tableRows}
        </tbody>
      </table>
    </div>
  `;
  
  // Save scroll position before re-rendering (to preserve user's scroll position)
  const oldTableBody = container.querySelector('.index-table-body');
  const savedScrollTop = oldTableBody ? oldTableBody.scrollTop : 0;
  
  container.innerHTML = html;
  
  // Restore scroll position after rendering
  const tableBody = container.querySelector('.index-table-body');
  if (tableBody) {
    // Force a synchronous layout calculation to ensure scrollHeight is accurate
    void tableBody.offsetHeight;
    
    // Restore scroll position immediately (synchronously) to prevent race conditions with wheel events
    tableBody.scrollTop = savedScrollTop;
    
    // Also restore in next frame as a backup (in case layout changes)
    requestAnimationFrame(() => {
      if (tableBody.scrollTop !== savedScrollTop) {
        tableBody.scrollTop = savedScrollTop;
      }
    });
  }
  
  // Handle window resize to recalculate column widths
  const handleResize = () => {
    const newColumnWidths = calculateColumnWidths();
    const table = container.querySelector('.index-table');
    if (table) {
      // Update header widths
      const headerCells = table.querySelectorAll('thead th');
      if (headerCells.length === 6) {
        headerCells[0].style.width = `${newColumnWidths.leftColumnWidth}px`;
        for (let i = 1; i < 6; i++) {
          headerCells[i].style.width = `${newColumnWidths.dataColumnWidth}px`;
        }
      }
      
      // Update body cell widths
      const rows = table.querySelectorAll('tbody tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length === 6) {
          cells[0].style.width = `${newColumnWidths.leftColumnWidth}px`;
          for (let i = 1; i < 6; i++) {
            cells[i].style.width = `${newColumnWidths.dataColumnWidth}px`;
          }
        }
      });
    }
  };
  
  // Remove existing resize handler if any
  if (window.__indexPageResizeHandler) {
    window.removeEventListener('resize', window.__indexPageResizeHandler);
  }
  
  // Store and add new resize handler
  window.__indexPageResizeHandler = handleResize;
  window.addEventListener('resize', handleResize);
  
  // Setup filter change listener to re-render when filters change
  setupFilterChangeListener();
  
  // Setup click on row to open album with this photo first
  setupIndexRowClickHandlers();
}

/**
 * Setup click handlers on index rows: open album with selected photo as first.
 * Uses one delegated listener on page-container to avoid duplicate handlers on re-render.
 */
function setupIndexRowClickHandlers() {
  const container = document.getElementById('page-container');
  if (!container) return;
  if (container.hasAttribute('data-index-click-bound')) return;
  container.setAttribute('data-index-click-bound', 'true');
  
  container.addEventListener('click', (e) => {
    const row = e.target.closest('.index-row-clickable');
    if (!row) return;
    
    const photoId = row.dataset.photoId;
    const userKey = row.dataset.userKey;
    if (!photoId || !userKey) return;
    
    const photo = photosData.find(p => p.id === photoId);
    if (!photo || !photo.id) return;
    
    // Same flow as user-albums: fade out, navigate to drawer, enter album with this photo first
    window.isTransitioningToAlbum = true;
    
    const remainsLogo = document.getElementById('remainsLogo');
    if (remainsLogo) {
      const h1 = remainsLogo.querySelector('h1');
      if (h1) {
        h1.style.opacity = '0';
        h1.style.visibility = 'hidden';
      }
    }
    
    const pageContainer = document.getElementById('page-container');
    if (pageContainer) {
      pageContainer.style.transition = 'opacity 0.3s ease-out, visibility 0.3s ease-out';
      pageContainer.classList.remove('fade-in');
      pageContainer.style.opacity = '0';
      pageContainer.style.visibility = 'hidden';
    }
    
    const canvas = document.getElementById('canvas');
    if (canvas) {
      canvas.style.display = 'none';
    }
    
    navigate('drawer');
    
    setTimeout(() => {
      if (window.drawerSceneInstance) {
        window.drawerSceneInstance.enterAlbumModeWithTransition(photo.id, photo.userKey, { fromIndex: true });
        window.isTransitioningToAlbum = false;
      }
    }, 300);
  });
}

/**
 * Setup listener for filter changes to re-render index view
 */
function setupFilterChangeListener() {
  // Remove existing listener if any
  if (window.__indexPageFilterListener) {
    clearInterval(window.__indexPageFilterListener);
    window.__indexPageFilterListener = null;
    filterChangeListener = null;
  }
  
  // Poll for filter changes when on index view
  // This is simpler than trying to hook into all filter change events
  let lastFilterState = null;
  
  filterChangeListener = setInterval(() => {
    // Only check if we're currently on the index view
    if (!document.body.classList.contains('view-index')) {
      return;
    }
    
    const drawerScene = window.drawerSceneInstance;
    if (!drawerScene) {
      return;
    }
    
    // Create a simple hash of current filter state
    const currentFilterState = JSON.stringify({
      locations: Array.from(drawerScene.activeLocations || []).sort(),
      years: Array.from(drawerScene.activeYears || []).sort(),
      keywords: Array.from(drawerScene.activeKeywords || []).sort()
    });
    
    // If filter state changed, re-render
    if (currentFilterState !== lastFilterState) {
      lastFilterState = currentFilterState;
      renderIndexPage();
    }
  }, 100); // Check every 100ms
  
  // Store interval ID for cleanup
  window.__indexPageFilterListener = filterChangeListener;
}

/**
 * Cleanup filter change listener
 */
export function cleanupFilterChangeListener() {
  if (window.__indexPageFilterListener) {
    clearInterval(window.__indexPageFilterListener);
    window.__indexPageFilterListener = null;
    filterChangeListener = null;
  }
}
