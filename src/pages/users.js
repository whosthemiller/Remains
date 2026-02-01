/**
 * Users Page - Displays a grid of users with search and sort
 */

import { navigate } from '../routing.js';
import { buildUserJsonUrl, encodePathSegments } from '../utils/paths.js';

let usersData = [];
let filteredUsers = [];
let currentSort = 'recent';
let hasLoadedLandscapeIndex = false;

const SORT_OPTIONS = {
  recent: { label: 'Most recently updated', fn: (a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0) },
  alphabetical: { label: 'A–Z', fn: (a, b) => a.displayName.localeCompare(b.displayName) },
  albums: { label: 'Most albums', fn: (a, b) => b.albumCount - a.albumCount }
};

let landscapeByUser = {};
let usersPageIsActive = false;

/**
 * Load precomputed landscape index (byUser). Run build:landscape to generate.
 */
async function loadLandscapeIndex() {
  if (hasLoadedLandscapeIndex) return;
  try {
    const res = await fetch('data/landscape.index.json');
    if (res.ok) {
      const data = await res.json();
      landscapeByUser = data.byUser || {};
      hasLoadedLandscapeIndex = true;
    }
  } catch (e) {
    console.warn('Could not load landscape.index.json:', e);
  }
}

/**
 * Pick up to 3 landscape preview photos for a user from the precomputed index.
 * Encodes paths for use in img src (relative paths for GitHub Pages compatibility).
 */
function pickPreviewPhotos(userKey) {
  const list = landscapeByUser[userKey] || [];
  const shuffled = [...list].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3).map(src => {
    // Remove leading slash if present to ensure relative path
    const p = src.startsWith('/') ? src.substring(1) : src;
    return encodePathSegments(p);
  });
}

/**
 * Load dateJoined, description, and location from each user's user.json file
 */
async function loadUserJoinDates(users) {
  const loadPromises = users.map(async (user) => {
    try {
      // Use centralized path builder
      const userJsonPath = buildUserJsonUrl(user.userKey);
      const response = await fetch(userJsonPath);
      
      // Only proceed if file exists (404 is expected for many users)
      if (response.ok) {
        const userData = await response.json();
        // Extract dateJoined, description, and location from user.user
        if (userData?.user) {
          if (userData.user.dateJoined) {
            user.dateJoined = userData.user.dateJoined;
          }
          if (userData.user.description) {
            user.description = userData.user.description;
          }
          if (userData.user.location) {
            user.location = userData.user.location;
          }
        }
      }
      // Silently skip if 404 (user.json doesn't exist for all users)
    } catch (error) {
      // Silently fail - user.json is optional
    }
  });
  
  await Promise.all(loadPromises);
}

/**
 * Load user statistics (local photo count, total size, last modified)
 */
async function loadUserStats(users) {
  try {
    const response = await fetch('data/userStats.json');
    if (!response.ok) {
      console.warn('userStats.json not found, skipping user stats');
      return;
    }
    
    const stats = await response.json();
    
    for (const user of users) {
      const userStat = stats[user.userKey];
      if (userStat) {
        user.localPhotoCount = userStat.localPhotoCount || 0;
        user.totalMB = userStat.totalBytes ? (userStat.totalBytes / (1024 * 1024)).toFixed(1) : null;
      }
      // Don't use lastModified from userStats.json - it's the file modification date, not the actual upload date
      // Instead, use lastUpdated which comes from photos' uploadedUnix (actual upload date from Flickr)
      if (user.lastUpdated && user.lastUpdated > 0) {
        // Convert Unix timestamp to ISO string
        user.lastModified = new Date(user.lastUpdated * 1000).toISOString();
      } else {
        user.lastModified = null;
      }
    }
  } catch (error) {
    console.warn('Error loading userStats.json:', error);
  }
}

/**
 * Load users data from photos index
 */
export async function loadUsersData() {
  try {
    // Cache: if we already computed usersData once, reuse it.
    if (usersData.length > 0) {
      return usersData;
    }

    const response = await fetch('data/photos.index.json');
    if (!response.ok) throw new Error('Failed to load photos index');
    const data = await response.json();
    
    // Group photos by user
    const userMap = new Map();
    
    for (const photo of data.photos) {
      const userKey = photo.userKey;
      if (!userKey) continue;
      
      if (!userMap.has(userKey)) {
        userMap.set(userKey, {
          userKey,
          displayName: photo.meta?.user?.realname || photo.meta?.user?.username || userKey,
          username: photo.meta?.user?.username || userKey,
          albums: new Set(),
          lastUpdated: 0,
          previewPhotos: [],
          dateJoined: null, // Will be loaded from user.json
          description: null, // Will be loaded from user.json
          location: null, // Will be loaded from user.json
          localPhotoCount: 0, // Will be loaded from userStats.json
          totalMB: null, // Will be loaded from userStats.json
          lastModified: null // Will be loaded from userStats.json
        });
      }
      
      const user = userMap.get(userKey);
      
      // Track albums
      if (photo.albumKey) {
        user.albums.add(photo.albumKey);
      }
      
      // Track last updated (use uploadedUnix or taken date)
      const timestamp = photo.uploadedUnix || (photo.taken ? new Date(photo.taken).getTime() / 1000 : 0);
      if (timestamp > user.lastUpdated) {
        user.lastUpdated = timestamp;
      }
    }
    
    // Convert to array and add album count
    usersData = Array.from(userMap.values()).map(user => ({
      ...user,
      albumCount: user.albums.size,
      albums: Array.from(user.albums),
    }));
    
    // Load precomputed landscape index and set preview photos
    await loadLandscapeIndex();
    for (const user of usersData) {
      user.previewPhotos = pickPreviewPhotos(user.userKey);
    }
    
    // Load user statistics (local photo count, total size, last modified)
    await loadUserStats(usersData);
    
    return usersData;
  } catch (error) {
    console.error('Error loading users data:', error);
    return [];
  }
}

/**
 * Render Users page
 */
export async function renderUsersPage() {
  usersPageIsActive = true;
  const container = document.getElementById('page-container');
  if (!container) return;
  
  // Ensure page container has proper scrolling styles
  // NOTE: Do NOT set visibility/opacity here - let main.js control when to show it
  container.style.height = '100vh';
  container.style.maxHeight = '100vh';
  container.style.overflowY = 'auto';
  container.style.overflowX = 'hidden';
  // Reset scroll position to top
  container.scrollTop = 0;
  // Make container focusable to enable scrolling without requiring a click
  if (!container.hasAttribute('tabindex')) {
    container.setAttribute('tabindex', '-1');
  }
  
  // Load users data
  const users = await loadUsersData();

  // Create single hover info element (reused for all cards)
  createUserHoverInfoElement();
  
  // Ensure user hover info is visible (it might have been hidden on user-albums page)
  const userHoverInfo = document.getElementById('userHoverInfo');
  if (userHoverInfo) {
    userHoverInfo.style.display = 'block';
    userHoverInfo.style.opacity = '';
    userHoverInfo.style.visibility = '';
    userHoverInfo.classList.remove('isVisible'); // Reset visibility state
  }
  
  // Hide album hover info if it exists
  const albumHoverInfo = document.getElementById('albumHoverInfo');
  if (albumHoverInfo) {
    albumHoverInfo.classList.remove('isVisible');
    albumHoverInfo.style.display = 'none';
  }
  
  // Update remains-left CSS variable
  updateRemainsLeftPosition();
  
  // Render user cards
  const userCards = users.map(user => createUserCard(user)).join('');
  
  container.innerHTML = `
    <div class="users-page">
      <div class="users-grid">
        ${userCards}
      </div>
    </div>
  `;
  
  // Immediately add page-transitioning class to ensure elements start in hidden state
  // This must happen right after innerHTML, before any other operations
  const usersPage = container.querySelector('.users-page');
  if (usersPage) {
    usersPage.classList.add('page-transitioning');
    // Force a reflow to ensure the class is applied before any other operations
    usersPage.offsetHeight;
  }
  
  // Ensure scroll position is reset after rendering
  container.scrollTop = 0;
  
  // Focus the page container to enable scrolling immediately
  // This ensures scrolling works without requiring a click first
  if (container && typeof container.focus === 'function') {
    // Set tabindex to make it focusable if needed
    if (!container.hasAttribute('tabindex')) {
      container.setAttribute('tabindex', '-1');
    }
    
    // Focus immediately, then again after a brief delay to ensure it sticks
    container.focus();
    
    // Also focus after a brief delay to ensure it's fully rendered and focus persists
    setTimeout(() => {
      container.focus();
    }, 100);
  }
  
  // Add a global wheel event handler to forward wheel events to the container
  // This ensures scrolling works even if the container doesn't have focus
  const handleBodyWheel = (e) => {
    // Only handle if container is scrollable and visible
    if (container && container.scrollHeight > container.clientHeight && 
        getComputedStyle(container).visibility === 'visible' &&
        getComputedStyle(container).display !== 'none') {
      // Check if the event target is within the container or body/document
      const target = e.target;
      const isBodyOrDocument = target === document.body || 
                                target === document.documentElement || 
                                !container.contains(target);
      
      if (isBodyOrDocument || container.contains(target) || target === container) {
        // Ensure container is focused to receive wheel events
        if (document.activeElement !== container && typeof container.focus === 'function') {
          container.focus();
        }
      }
    }
  };
  
  // Remove any existing handler (use the same function reference if stored)
  if (window.__usersPageWheelHandler) {
    document.body.removeEventListener('wheel', window.__usersPageWheelHandler, { passive: true });
  }
  // Store handler reference for cleanup
  window.__usersPageWheelHandler = handleBodyWheel;
  // Add handler to body to catch wheel events (use capture phase to catch early)
  document.body.addEventListener('wheel', handleBodyWheel, { passive: true, capture: true });
  
  // Also add click handler to focus container when clicked
  const handleContainerClick = (e) => {
    if (container && typeof container.focus === 'function' && document.activeElement !== container) {
      container.focus();
    }
  };
  container.addEventListener('click', handleContainerClick, { once: false, capture: true });
  
  // Setup click handlers for navigation
  setupUserCardHandlers();
  
  // Setup hover info handlers
  setupUserCardHoverInfo();
  
  // Update position on resize (only add once)
  if (!window.__remainsLeftResizeHandler) {
    window.__remainsLeftResizeHandler = updateRemainsLeftPosition;
    window.addEventListener('resize', window.__remainsLeftResizeHandler);
  }
}

/**
 * Cleanup (called when leaving users view).
 * Keeps it lightweight: stop treating page as active and remove global wheel handler.
 */
export function cleanupUsersPage() {
  usersPageIsActive = false;
  if (window.__usersPageWheelHandler) {
    document.body.removeEventListener('wheel', window.__usersPageWheelHandler, { passive: true, capture: true });
    window.__usersPageWheelHandler = null;
  }
}

/**
 * Create single hover info element (reused for all user cards)
 */
function createUserHoverInfoElement() {
  // Check if already exists
  let hoverInfo = document.getElementById('userHoverInfo');
  if (!hoverInfo) {
    hoverInfo = document.createElement('div');
    hoverInfo.id = 'userHoverInfo';
    hoverInfo.className = 'album-meta-details';
    hoverInfo.setAttribute('aria-hidden', 'true');
    document.body.appendChild(hoverInfo);
  }
}

/**
 * Update CSS variable for remains logo left position
 */
function updateRemainsLeftPosition() {
  const remainsLogo = document.getElementById('remainsLogo');
  if (remainsLogo) {
    const left = remainsLogo.getBoundingClientRect().left;
    document.documentElement.style.setProperty('--remains-left', `${left}px`);
  }
}

function setupUserCardHandlers() {
  const cards = document.querySelectorAll('.user-card');
  cards.forEach(card => {
    card.addEventListener('click', () => {
      const userKey = card.dataset.userKey;
      if (userKey) {
        navigate('user-albums', { username: userKey });
      }
    });
  });
}

function setupUsersPageHandlers() {
  const searchInput = document.getElementById('users-search-input');
  const sortSelect = document.getElementById('users-sort-select');
  
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      filterAndRenderUsers(e.target.value);
    });
  }
  
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      currentSort = e.target.value;
      filterAndRenderUsers(searchInput?.value || '');
    });
  }
}

function filterAndRenderUsers(searchQuery = '') {
  const query = searchQuery.toLowerCase().trim();
  
  if (query === '') {
    filteredUsers = [...usersData];
  } else {
    filteredUsers = usersData.filter(user => 
      user.displayName.toLowerCase().includes(query) ||
      user.username.toLowerCase().includes(query)
    );
  }
  
  // Sort
  const sortFn = SORT_OPTIONS[currentSort]?.fn || SORT_OPTIONS.recent.fn;
  filteredUsers.sort(sortFn);
  
  renderUsersGrid();
}

function renderUsersGrid() {
  const grid = document.getElementById('users-grid');
  if (!grid) return;
  
  if (filteredUsers.length === 0) {
    grid.innerHTML = '<div class="users-empty">No users found</div>';
    return;
  }
  
  grid.innerHTML = filteredUsers.map(user => createUserCard(user)).join('');
  
  // Setup click handlers
  setupUserCardHandlers();
  
  // Setup hover info handlers
  setupUserCardHoverInfo();
}

/**
 * Setup hover info - single element reused for all cards
 */
function setupUserCardHoverInfo() {
  const hoverInfo = document.getElementById('userHoverInfo');
  if (!hoverInfo) return;
  
  // Ensure hover info is visible and properly styled
  hoverInfo.style.display = 'block';
  hoverInfo.style.opacity = '';
  hoverInfo.style.visibility = '';
  
  // Only select user cards, exclude album cards
  const userCards = document.querySelectorAll('.user-card:not(.album-card)');
  
  userCards.forEach(card => {
    const showInfo = () => {
      // Get user data from data attribute
      const userDataStr = card.dataset.userData;
      if (!userDataStr) return;
      
      try {
        const userData = JSON.parse(userDataStr);
        
        // Build info content
        const infoItems = [];
        
        // 1. Description (only if exists)
        if (userData.description && userData.description.trim()) {
          infoItems.push(`<div class="meta-detail-item">${escapeHtml(userData.description)}</div>`);
        }
        
        // 2. Local photos count
        if (userData.localPhotoCount > 0) {
          infoItems.push(`<div class="meta-detail-item"><span class="meta-label">${userData.localPhotoCount} photos</span></div>`);
        }
        
        // 3. Joined Flickr date (if exists)
        if (userData.dateJoined) {
          // Add comma after month (e.g., "September 2008" -> "September, 2008")
          const formattedDate = userData.dateJoined.replace(/^(\w+)\s+(\d+)$/, '$1, $2');
          infoItems.push(`<div class="meta-detail-item"><span class="meta-label">Joined</span> <span class="meta-value">${escapeHtml(formattedDate)}</span></div>`);
        }
        
        // 4. Location (only if exists)
        if (userData.location && userData.location.trim()) {
          infoItems.push(`<div class="meta-detail-item"><span class="meta-label">Location:</span> <span class="meta-value">${escapeHtml(userData.location)}</span></div>`);
        }
        
        // 5. Total size in MB
        if (userData.totalMB) {
          infoItems.push(`<div class="meta-detail-item"><span class="meta-label">Total size:</span> <span class="meta-value">${userData.totalMB} MB</span></div>`);
        }
        
        // 6. Last modified date
        if (userData.lastModified) {
          const daysSince = calculateDaysSinceUpload(userData.lastModified);
          if (daysSince) {
            infoItems.push(`<div class="meta-detail-item"><span class="meta-label">Last upload:</span> <span class="meta-value">${daysSince}</span></div>`);
          }
        }
        
        if (infoItems.length > 0) {
          hoverInfo.innerHTML = infoItems.join('');
          hoverInfo.classList.add('isVisible');
        }
      } catch (error) {
        console.warn('Error parsing user data:', error);
      }
    };
    
    const hideInfo = () => {
      hoverInfo.classList.remove('isVisible');
    };
    
    // Show/hide on hover/focus
    card.addEventListener('mouseenter', showInfo);
    card.addEventListener('mouseleave', hideInfo);
    card.addEventListener('focus', showInfo);
    card.addEventListener('blur', hideInfo);
  });
}

function createUserCard(user) {
  // Get up to 3 photos for the pile
  const photos = user.previewPhotos.slice(0, 3);
  
  // If we don't have 3 photos, pad with the last photo or use placeholder
  while (photos.length < 3 && photos.length > 0) {
    photos.push(photos[photos.length - 1]); // Repeat last photo
  }
  
  // If no photos at all, use placeholder (empty divs that will be styled)
  const photoPileHtml = photos.length > 0
    ? `<div class="user-photo-pile">
         <img src="${photos[0]}" alt="" class="user-photo-pile-sizer" />
         ${photos.map((src, index) => {
           // Base offsets: subtle stacking (rest state)
           // image1: (0, 0) rotate(0deg), image2: (8, 6) rotate(0deg), image3: (16, 12) rotate(0deg)
           const offsets = [
             { translateX: 0, translateY: 0, rotate: 0 },
             { translateX: 8, translateY: 6, rotate: 0 },
             { translateX: 16, translateY: 12, rotate: 0 }
           ];
           const offset = offsets[index] || { translateX: 0, translateY: 0, rotate: 0 };
           const zIndex = index + 1; // Layer order: first image on bottom, last on top
           
           return `<img src="${src}" alt="" loading="lazy" class="user-photo-pile-img user-photo-pile-img-${index + 1}" style="transform: translate(${offset.translateX}px, ${offset.translateY}px) rotate(${offset.rotate}deg); z-index: ${zIndex};" />`;
         }).join('')}
       </div>`
    : `<div class="user-photo-pile">
         <div class="user-photo-placeholder"></div>
         <div class="user-photo-placeholder"></div>
         <div class="user-photo-placeholder"></div>
       </div>`;
  
  // Username label
  const username = user.displayName || user.username || user.userKey;
  
  // Build hover info content
  const infoItems = [];
  
  // 1. Description (only if exists)
  if (user.description && user.description.trim()) {
    infoItems.push(`<div class="meta-detail-item">${escapeHtml(user.description)}</div>`);
  }
  
  // 2. Joined Flickr date (if exists)
  if (user.dateJoined) {
    // Add comma after month (e.g., "September 2008" -> "September, 2008")
    const formattedDate = user.dateJoined.replace(/^(\w+)\s+(\d+)$/, '$1, $2');
    infoItems.push(`<div class="meta-detail-item"><span class="meta-label">Joined:</span> <span class="meta-value">${escapeHtml(formattedDate)}</span></div>`);
  }
  
  // 3. Location (only if exists)
  if (user.location && user.location.trim()) {
    infoItems.push(`<div class="meta-detail-item"><span class="meta-label">Location:</span> <span class="meta-value">${escapeHtml(user.location)}</span></div>`);
  }
  
  // 4. Local photos count
  if (user.localPhotoCount > 0) {
    infoItems.push(`<div class="meta-detail-item"><span class="meta-label">Local photos:</span> <span class="meta-value">${user.localPhotoCount}</span></div>`);
  }
  
  // 5. Total size in MB
  if (user.totalMB) {
    infoItems.push(`<div class="meta-detail-item"><span class="meta-label">Total size:</span> <span class="meta-value">${user.totalMB} MB</span></div>`);
  }
  
  // 6. Last modified date
  if (user.lastModified) {
    const daysSince = calculateDaysSinceUpload(user.lastModified);
    if (daysSince) {
      infoItems.push(`<div class="meta-detail-item"><span class="meta-label">Last upload:</span> <span class="meta-value">${daysSince}</span></div>`);
    }
  }
  
  // Store user data for hover info (no HTML in card)
  return `
    <div class="user-card" data-user-key="${encodeURIComponent(user.userKey)}" data-user-data='${JSON.stringify({
      description: user.description,
      dateJoined: user.dateJoined,
      location: user.location,
      localPhotoCount: user.localPhotoCount,
      totalMB: user.totalMB,
      lastModified: user.lastModified
    })}'>
      ${photoPileHtml}
      <div class="user-name">${escapeHtml(username)}</div>
    </div>
  `;
}

/**
 * Format date from ISO string to dd.mm.yyyy
 */
function formatDateFromISO(isoString) {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return null;
    
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}.${month}.${year}`;
  } catch (error) {
    return null;
  }
}

/**
 * Calculate days since last upload from the actual date to today
 */
function calculateDaysSinceUpload(isoString) {
  if (!isoString) return null;
  try {
    // Parse the ISO date string (e.g., "2026-01-18T12:05:00.000Z")
    const uploadDate = new Date(isoString);
    if (isNaN(uploadDate.getTime())) return null;
    
    // Get today's date at midnight (local time)
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Get upload date at midnight (local time) - using the actual date from the ISO string
    const upload = new Date(uploadDate.getFullYear(), uploadDate.getMonth(), uploadDate.getDate());
    
    // Calculate difference in milliseconds, then convert to days
    const diffTime = today - upload;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    // Handle edge cases
    if (diffDays < 0) {
      // Future date (shouldn't happen, but handle gracefully)
      return 'today';
    } else if (diffDays === 0) {
      return 'today';
    } else if (diffDays === 1) {
      return '1 day ago';
    } else {
      return `${diffDays} days ago`;
    }
  } catch (error) {
    return null;
  }
}

function formatDate(timestamp) {
  const date = new Date(timestamp * 1000);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
