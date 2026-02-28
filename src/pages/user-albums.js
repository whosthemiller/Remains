/**
 * User Albums Page - Shows albums for a selected user
 */

import { navigate } from '../routing.js';
import { buildUserJsonUrl, buildAlbumJsonUrl, buildImageUrl } from '../utils/paths.js';

let currentUser = null;
let albumsData = [];

/**
 * Get correct path to data file (works from any URL location)
 * Returns relative path for GitHub Pages compatibility
 */
function getDataPath(filename) {
  // Use relative path - works with GitHub Pages subpath deployment
  return `data/${filename}`;
}

let landscapeSrcSet = new Set();

/**
 * Load precomputed landscape index (srcList) for O(1) lookup. Run build:landscape to generate.
 */
async function ensureLandscapeSet() {
  if (landscapeSrcSet.size > 0) return;
  try {
    const res = await fetch(getDataPath('landscape.index.json'));
    if (res.ok) {
      const data = await res.json();
      landscapeSrcSet = new Set(data.srcList || []);
    }
  } catch (e) {
    console.warn('Could not load landscape.index.json:', e);
  }
}

/**
 * Load albums for a user
 */
async function loadUserAlbums(userKey) {
  try {
    await ensureLandscapeSet();
    // Get user data to find album keys
    const response = await fetch(getDataPath('photos.index.json'));
    if (!response.ok) throw new Error('Failed to load photos index');
    const data = await response.json();
    
    // Find user and collect album keys
    const userAlbums = new Set();
    const albumPhotoMap = new Map(); // Map<albumKey, photo[]>
    
    for (const photo of data.photos) {
      if (photo.userKey === userKey && photo.albumKey) {
        userAlbums.add(photo.albumKey);
        
        if (!albumPhotoMap.has(photo.albumKey)) {
          albumPhotoMap.set(photo.albumKey, []);
        }
        albumPhotoMap.get(photo.albumKey).push(photo);
      }
    }
    
    // Load album metadata and get preview photos
    const albums = [];
    for (const albumKey of userAlbums) {
      try {
        // Use centralized path builder
        const albumPath = buildAlbumJsonUrl(userKey, albumKey);
        const albumResponse = await fetch(albumPath);
        
        if (albumResponse.ok) {
          const albumData = await albumResponse.json();
          const album = albumData.album || albumData;
          
          // Get photos for this album
          const albumPhotos = albumPhotoMap.get(albumKey) || [];
          
          // Filter to landscape photos (from precomputed index) and get up to 3
          const landscapePhotos = [];
          for (const photo of albumPhotos) {
            if (photo.src && landscapeSrcSet.has(photo.src)) {
              const encodedSrc = buildImageUrl(photo);
              if (encodedSrc) {
                landscapePhotos.push({
                  src: encodedSrc,
                  photoId: photo.photoId || photo.id, // Keep for display
                  photoFullId: photo.id // Full path ID for opening album
                });
                if (landscapePhotos.length >= 3) break;
              }
            }
          }
          
          // If not enough landscape photos, fill with any photos (use buildImageUrl for proper encoding)
          if (landscapePhotos.length < 3) {
            for (const photo of albumPhotos) {
              if (photo.src && !landscapePhotos.find(p => (p.photoId === (photo.photoId || photo.id)) || (p.photoFullId === photo.id))) {
                const encodedSrc = buildImageUrl(photo);
                if (encodedSrc) {
                  landscapePhotos.push({
                    src: encodedSrc,
                    photoId: photo.photoId || photo.id, // Keep for display
                    photoFullId: photo.id // Full path ID for opening album
                  });
                  if (landscapePhotos.length >= 3) break;
                }
              }
            }
          }
          
          albums.push({
            albumKey,
            title: album.title || albumKey,
            description: album.description || '',
            photoCount: album.photoCount || albumPhotos.length,
            sizeMB: album.sizeMB || null,
            lastUploadedDate: album.lastUploadedDate || null,
            previewPhotos: landscapePhotos.slice(0, 3),
            allPhotos: albumPhotos.map(p => p.src).filter(Boolean)
          });
        }
      } catch (error) {
        console.warn(`Failed to load album ${albumKey} for user ${userKey}:`, error);
      }
    }
    
    // Sort albums by last uploaded date (most recent first)
    albums.sort((a, b) => {
      if (!a.lastUploadedDate && !b.lastUploadedDate) return 0;
      if (!a.lastUploadedDate) return 1;
      if (!b.lastUploadedDate) return -1;
      return new Date(b.lastUploadedDate) - new Date(a.lastUploadedDate);
    });
    
    return albums;
  } catch (error) {
    console.error('Error loading user albums:', error);
    return [];
  }
}

/**
 * Get user data
 */
async function getUserData(userKey) {
  try {
    const response = await fetch(getDataPath('photos.index.json'));
    if (!response.ok) throw new Error('Failed to load photos index');
    const data = await response.json();
    
    let userDataObj = {
      userKey,
      displayName: userKey,
      username: userKey,
      location: '',
      description: '',
      dateJoined: '',
      photosCount: 0,
      localPhotoCount: 0,
      totalMB: null,
      lastModified: null,
      profileUrl: ''
    };
    
    // Find user
    for (const photo of data.photos) {
      if (photo.userKey === userKey) {
        // Load user.json for additional data (optional - use metadata from photos.index.json as fallback)
        try {
          const userJsonPath = buildUserJsonUrl(userKey);
          const userResponse = await fetch(userJsonPath);
          if (userResponse.ok) {
            const userData = await userResponse.json();
            userDataObj = {
              userKey,
              displayName: userData?.user?.realname || photo.meta?.user?.realname || photo.meta?.user?.username || userKey,
              username: photo.meta?.user?.username || userKey,
              location: userData?.user?.location || photo.meta?.user?.location || '',
              description: userData?.user?.description || photo.meta?.user?.description || '',
              dateJoined: userData?.user?.dateJoined || photo.meta?.user?.dateJoined || '',
              photosCount: userData?.stats?.totalPhotos || userData?.user?.photosCount || 0,
              localPhotoCount: 0,
              totalMB: null,
              lastModified: null,
              profileUrl: userData?.user?.profileUrl || ''
            };
          }
        } catch (error) {
          // Fallback to photo metadata
          userDataObj = {
            userKey,
            displayName: photo.meta?.user?.realname || photo.meta?.user?.username || userKey,
            username: photo.meta?.user?.username || userKey,
            location: photo.meta?.user?.location || '',
            description: photo.meta?.user?.description || '',
            dateJoined: photo.meta?.user?.dateJoined || '',
            photosCount: 0,
            localPhotoCount: 0,
            totalMB: null,
            lastModified: null,
            profileUrl: ''
          };
        }
        break;
      }
    }
    
    // Load user statistics (local photo count, total size)
    try {
      const statsResponse = await fetch(getDataPath('userStats.json'));
      if (statsResponse.ok) {
        const stats = await statsResponse.json();
        const userStat = stats[userKey];
        if (userStat) {
          userDataObj.localPhotoCount = userStat.localPhotoCount || 0;
          userDataObj.totalMB = userStat.totalBytes ? (userStat.totalBytes / (1024 * 1024)).toFixed(1) : null;
        }
      }
    } catch (error) {
      console.warn('Error loading userStats.json:', error);
    }
    
    // Calculate last upload date from albums (actual upload date from Flickr, not file modification date)
    try {
      const albums = await loadUserAlbums(userKey);
      if (albums && albums.length > 0) {
        // Find the most recent lastUploadedDate from all albums
        let mostRecentDate = null;
        for (const album of albums) {
          if (album.lastUploadedDate) {
            const albumDate = new Date(album.lastUploadedDate);
            if (!isNaN(albumDate.getTime())) {
              if (!mostRecentDate || albumDate > mostRecentDate) {
                mostRecentDate = albumDate;
              }
            }
          }
        }
        // Set lastModified to the most recent upload date (as ISO string)
        if (mostRecentDate) {
          userDataObj.lastModified = mostRecentDate.toISOString();
        }
      }
    } catch (error) {
      console.warn('Error calculating last upload date from albums:', error);
    }
    
    return userDataObj;
  } catch (error) {
    console.error('Error loading user data:', error);
    return {
      userKey,
      displayName: userKey,
      username: userKey,
      location: '',
      description: '',
      dateJoined: '',
      photosCount: 0,
      localPhotoCount: 0,
      totalMB: null,
      lastModified: null,
      profileUrl: ''
    };
  }
}

/**
 * Render User Albums Page
 * Returns a promise that resolves when rendering is complete
 */
export async function renderUserAlbumsPage(params) {
  const container = document.getElementById('page-container');
  if (!container) return;
  
  // Ensure page container has proper scrolling styles
  container.style.height = '100vh';
  container.style.maxHeight = '100vh';
  container.style.overflowY = 'auto';
  container.style.overflowX = 'hidden';
  // Reset scroll position to top
  container.scrollTop = 0;
  
  // Username may be encoded from URL or raw from navigation
  let username = params?.username || 'Unknown';
  // If it looks encoded (contains %), decode it; otherwise use as-is
  if (username.includes('%')) {
    try {
      username = decodeURIComponent(username);
    } catch (e) {
      // If decoding fails, use as-is
    }
  }

  // Ensure nav block (title + user data) is visible (might have been hidden during transition)
  const remainsLogo = document.getElementById('remainsLogo');
  if (remainsLogo) {
    remainsLogo.style.opacity = '';
    remainsLogo.style.visibility = '';
    remainsLogo.style.transition = '';
    const h1 = remainsLogo.querySelector('h1');
    if (h1) {
      h1.style.opacity = '';
      h1.style.visibility = '';
      h1.style.transition = '';
    }
    const userData = remainsLogo.querySelector('.user-data');
    if (userData) {
      userData.style.opacity = '';
      userData.style.visibility = '';
    }
  }
  
  // Load user data
  currentUser = await getUserData(username);
  if (!currentUser) {
    container.innerHTML = `<div class="user-albums-page"><p>User not found</p></div>`;
    return;
  }

  // Update nav title to show username and user data
  updateNavTitle({ view: 'user', username, userData: currentUser });

  // Load albums
  albumsData = await loadUserAlbums(username);

  // Render albums grid
  const albumCards = albumsData.map(album => createAlbumCard(album, currentUser.userKey)).join('');
  
  // Check if body has page-transitioning to add class to new content
  // This ensures elements are created hidden (opacity: 0) for fade-in animation
  const shouldStartHidden = document.body.classList.contains('page-transitioning');
  
  container.innerHTML = `
    <div class="users-page${shouldStartHidden ? ' page-transitioning' : ''}">
      <div class="users-grid">
        ${albumCards}
      </div>
    </div>
  `;
  
  // Ensure scroll position is reset after rendering
  container.scrollTop = 0;
  
  // Setup click handlers
  setupAlbumCardHandlers();
  
  // Setup hover info handlers
  setupAlbumCardHoverInfo();
  
  // Update position on resize
  if (!window.__remainsLeftResizeHandler) {
    window.__remainsLeftResizeHandler = updateRemainsLeftPosition;
    window.addEventListener('resize', window.__remainsLeftResizeHandler);
  }
  updateRemainsLeftPosition();
  
  // Return promise that resolves when rendering is complete
  return Promise.resolve();
}

/**
 * Create album card HTML
 */
function createAlbumCard(album, userKey) {
  // Get up to 3 photos for the pile
  const photos = album.previewPhotos.slice(0, 3);
  
  // If we don't have 3 photos, pad with the last photo
  while (photos.length < 3 && photos.length > 0) {
    photos.push(photos[photos.length - 1]);
  }
  
  // Photo pile HTML
  const photoPileHtml = photos.length > 0
    ? `<div class="user-photo-pile">
         <img src="${photos[0].src}" alt="" class="user-photo-pile-sizer" />
         ${photos.map((photo, index) => {
           const offsets = [
             { translateX: 0, translateY: 0, rotate: 0 },
             { translateX: 8, translateY: 6, rotate: 0 },
             { translateX: 16, translateY: 12, rotate: 0 }
           ];
           const offset = offsets[index] || { translateX: 0, translateY: 0, rotate: 0 };
           const zIndex = index + 1;
           
           return `<img src="${photo.src}" alt="" loading="lazy" class="user-photo-pile-img user-photo-pile-img-${index + 1}" data-photo-id="${photo.photoId || ''}" data-user-id="${userKey}" data-album-id="${album.albumKey}" style="transform: translate(${offset.translateX}px, ${offset.translateY}px) rotate(${offset.rotate}deg); z-index: ${zIndex};" />`;
         }).join('')}
       </div>`
    : `<div class="user-photo-pile">
         <div class="user-photo-placeholder"></div>
         <div class="user-photo-placeholder"></div>
         <div class="user-photo-placeholder"></div>
       </div>`;
  
  // Album name label
  const albumName = album.title || album.albumKey;
  
  // Get full ID (path) of the top thumbnail (the one with highest z-index, which is the last one in the array)
  // zIndex = index + 1, so index 2 has zIndex 3 (topmost)
  const topPhotoIndex = photos.length > 0 ? Math.min(2, photos.length - 1) : -1;
  const firstPhotoFullId = topPhotoIndex >= 0 && photos[topPhotoIndex].photoFullId ? photos[topPhotoIndex].photoFullId : null;
  
  return `
    <div class="user-card album-card" data-album-key="${album.albumKey}" data-user-key="${userKey}"${firstPhotoFullId ? ` data-first-photo-id="${firstPhotoFullId}"` : ''}>
      ${photoPileHtml}
      <div class="user-name">${escapeHtml(albumName)}</div>
    </div>
  `;
}

/**
 * Setup album card click handlers
 */
function setupAlbumCardHandlers() {
  const cards = document.querySelectorAll('.album-card');
  cards.forEach(card => {
    card.addEventListener('click', async () => {
      const userKey = card.dataset.userKey;
      const albumKey = card.dataset.albumKey;
      if (userKey && albumKey) {
        // Find a photo from this album in the photos index
        try {
          const response = await fetch(getDataPath('photos.index.json'));
          if (!response.ok) return;
          const data = await response.json();

          // Try to use the stored first photo ID (top thumbnail) if available
          // The stored ID is the full path (photo.id), not just photoId
          const firstPhotoId = card.dataset.firstPhotoId;
          
          let photo = null;
          
          if (firstPhotoId) {
            // Find photo matching the stored full ID (top thumbnail)
            photo = data.photos.find(p => p.id === firstPhotoId);
          }
          
          // Fallback: if not found or no stored photoId, find first photo from this user and album
          if (!photo) {
            photo = data.photos.find(p =>
              p.userKey === userKey &&
              p.albumKey === albumKey
            );
          }

          if (photo && photo.id) {
            // Set flag to prevent drawer from showing
            window.isTransitioningToAlbum = true;
            
            // Same duration for all exit transitions so everything fades out together
            const fadeOutDuration = '0.55s';
            const fadeOutEasing = 'ease-in-out';
            const fadeOutTransition = `opacity ${fadeOutDuration} ${fadeOutEasing}, visibility ${fadeOutDuration} ${fadeOutEasing}`;
            
            // Fade out the small info text at bottom (same timing as everything else)
            const albumHoverInfo = document.getElementById('albumHoverInfo');
            if (albumHoverInfo) {
              albumHoverInfo.style.transition = `opacity ${fadeOutDuration} ${fadeOutEasing}, transform ${fadeOutDuration} ${fadeOutEasing}`;
              albumHoverInfo.classList.remove('isVisible');
            }
            
            // Fade out the entire nav block (title + user data) as one unit so nothing "leads"
            const remainsLogo = document.getElementById('remainsLogo');
            if (remainsLogo) {
              remainsLogo.style.transition = fadeOutTransition;
              remainsLogo.style.opacity = '0';
              remainsLogo.style.visibility = 'hidden';
            }
            
            // Fade out page container (same timing – all exit together)
            const pageContainer = document.getElementById('page-container');
            if (pageContainer) {
              pageContainer.style.transition = fadeOutTransition;
              pageContainer.classList.remove('fade-in');
              pageContainer.style.opacity = '0';
              pageContainer.style.visibility = 'hidden';
            }
            
            // Hide canvas after fade-out (no transition needed)
            const canvas = document.getElementById('canvas');
            if (canvas) {
              canvas.style.display = 'none';
            }
            
            navigate('drawer');
            
            setTimeout(() => {
              if (window.drawerSceneInstance) {
                window.drawerSceneInstance.enterAlbumModeWithTransition(photo.id, currentUser?.userKey || userKey);
                window.isTransitioningToAlbum = false;
              }
              if (albumHoverInfo) {
                albumHoverInfo.style.transition = '';
              }
              if (remainsLogo) {
                remainsLogo.style.transition = '';
                remainsLogo.style.opacity = '';
                remainsLogo.style.visibility = '';
              }
            }, 550);
          }
        } catch (error) {
          console.error('Error opening album:', error);
        }
      }
    });
  });
}

/**
 * Setup album card hover info
 */
function setupAlbumCardHoverInfo() {
  // Create hover info element if it doesn't exist
  createAlbumHoverInfoElement();
  
  const hoverInfo = document.getElementById('albumHoverInfo');
  if (!hoverInfo) return;
  
  // Explicitly hide user hover info on this page
  const userHoverInfo = document.getElementById('userHoverInfo');
  if (userHoverInfo) {
    userHoverInfo.classList.remove('isVisible');
    userHoverInfo.style.display = 'none';
    userHoverInfo.style.opacity = '0';
    userHoverInfo.style.visibility = 'hidden';
  }
  
  const cards = document.querySelectorAll('.album-card');
  let hideTimeout = null; // Store timeout reference to prevent race conditions
  
  cards.forEach(card => {
    const albumKey = card.dataset.albumKey;
    const album = albumsData.find(a => a.albumKey === albumKey);
    if (!album) return;
    
    const showInfo = () => {
      // Clear any pending hide timeout
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
      
      // Ensure user hover info is hidden
      if (userHoverInfo) {
        userHoverInfo.classList.remove('isVisible');
        userHoverInfo.style.display = 'none';
        userHoverInfo.style.opacity = '0';
        userHoverInfo.style.visibility = 'hidden';
      }
      
      updateAlbumHoverInfo(album);
      hoverInfo.style.display = 'block';
      hoverInfo.classList.add('isVisible'); // Use CSS class instead of inline style
    };
    
    const hideInfo = () => {
      hoverInfo.classList.remove('isVisible'); // Use CSS class instead of inline style
      hideTimeout = setTimeout(() => {
        hoverInfo.style.display = 'none';
        hideTimeout = null;
      }, 200);
    };
    
    card.addEventListener('mouseenter', showInfo);
    card.addEventListener('mouseleave', hideInfo);
    card.addEventListener('focus', showInfo);
    card.addEventListener('blur', hideInfo);
  });
}

/**
 * Create album hover info element
 */
function createAlbumHoverInfoElement() {
  let hoverInfo = document.getElementById('albumHoverInfo');
  if (!hoverInfo) {
    hoverInfo = document.createElement('div');
    hoverInfo.id = 'albumHoverInfo';
    hoverInfo.className = 'album-meta-details';
    hoverInfo.setAttribute('aria-hidden', 'true');
    document.body.appendChild(hoverInfo);
  }
}

/**
 * Update album hover info content
 */
function updateAlbumHoverInfo(album) {
  const hoverInfo = document.getElementById('albumHoverInfo');
  if (!hoverInfo) return;
  
  const items = [];
  
  if (album.description && album.description.trim()) {
    items.push(`<div class="meta-detail-item"><span class="meta-label">${escapeHtml(album.description)}</span></div>`);
  }
  
  if (album.photoCount) {
    items.push(`<div class="meta-detail-item"><span class="meta-label">${album.photoCount} photos</span></div>`);
  }
  
  if (album.sizeMB) {
    items.push(`<div class="meta-detail-item"><span class="meta-label">${album.sizeMB.toFixed(2)} MB</span></div>`);
  }
  
  if (album.lastUploadedDate) {
    const date = formatDateFromISO(album.lastUploadedDate);
    if (date) {
      items.push(`<div class="meta-detail-item"><span class="meta-label">Last updated: ${date}</span></div>`);
    }
  }
  
  hoverInfo.innerHTML = items.join('');
  
  // Position at bottom-left, aligned with nav title
  const remainsLeft = getComputedStyle(document.documentElement).getPropertyValue('--remains-left') || '30px';
  hoverInfo.style.left = remainsLeft;
  hoverInfo.style.bottom = '25px';
  hoverInfo.style.top = 'auto';
  hoverInfo.style.right = 'auto';
}

/**
 * Update remains left position for hover info alignment
 */
function updateRemainsLeftPosition() {
  const remainsLogo = document.getElementById('remainsLogo');
  if (remainsLogo) {
    const rect = remainsLogo.getBoundingClientRect();
    document.documentElement.style.setProperty('--remains-left', `${rect.left}px`);
  }
}

/**
 * Format date from ISO string
 */
function formatDateFromISO(isoString) {
  if (!isoString) return null;
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
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

/**
 * Escape HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Update nav title
 */
function updateNavTitle({ view, username, albumTitle, userData }) {
  const remainsLogo = document.getElementById('remainsLogo');
  if (!remainsLogo) return;
  
  const h1 = remainsLogo.querySelector('h1');
  if (!h1) return;
  
  // Decode username if it's URL-encoded (e.g. from hash) so the title never shows % in the UI
  // Decode repeatedly in case of double-encoding (e.g. #/users/Alaine%2520%2526...)
  let displayUsername = username;
  if (view === 'user' && typeof username === 'string' && username.includes('%')) {
    try {
      let decoded = username;
      for (let i = 0; i < 3; i++) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
      displayUsername = decoded;
    } catch (e) {
      displayUsername = username;
    }
  }
  
  // Set positioning class atomically with content to prevent body/content desync jump
  remainsLogo.classList.toggle('site-title--user-view', view === 'user' && !!displayUsername);
  // Long single-word usernames (e.g. petersen.andrea): never truncate; use smaller title font so it fits and spacing proportion is kept
  const longNoCutUsernames = ['petersen.andrea', 'paterson.andrea'];
  const isLongNoCut = view === 'user' && typeof displayUsername === 'string' &&
    longNoCutUsernames.includes(displayUsername.toLowerCase());
  remainsLogo.classList.toggle('title-long-username', !!isLongNoCut);
  // Update text content FIRST, synchronously, to prevent any flash of wrong text
  let newText = 'Remains';
  if (view === 'user' && displayUsername) {
    newText = displayUsername;
  } else if (view === 'album' && albumTitle) {
    newText = albumTitle;
  }
  
  // Set text content synchronously
  if (view === 'user' && displayUsername === 'Alaine & Joe Chang') {
    h1.classList.add('title-allow-orphan');
    h1.innerHTML = 'Alaine &amp;<br>Joe Chang';
  } else {
    h1.classList.remove('title-allow-orphan');
    h1.textContent = newText;
  }
  
  // Force a synchronous reflow to ensure the text is updated before any visibility changes
  void h1.offsetHeight;
  
  // Handle user data display - same format as hover info
  let userDataElement = remainsLogo.querySelector('.user-data');
  if (view === 'user' && userData) {
    // Build user data text - same order and format as hover info
    const dataParts = [];
    
    // 1. Last modified date (moved to first, bold)
    let lastUploadLine = null;
    if (userData.lastModified) {
      const daysSince = calculateDaysSinceUpload(userData.lastModified);
      if (daysSince) {
        lastUploadLine = `<span class="user-data-bold">Last upload: ${escapeHtml(daysSince)}</span><br>`;
      }
    }
    
    // Add last upload first if it exists
    if (lastUploadLine) {
      dataParts.push(lastUploadLine);
    }
    
    // 2. Description (only if exists)
    if (userData.description && userData.description.trim()) {
      dataParts.push(escapeHtml(userData.description));
    }
    
    // 3. Local photos count
    if (userData.localPhotoCount > 0) {
      dataParts.push(`${userData.localPhotoCount} photos`);
    }
    
    // 4. Joined Flickr date (if exists)
    if (userData.dateJoined) {
      // Add comma after month (e.g., "September 2008" -> "September, 2008")
      const formattedDate = userData.dateJoined.replace(/^(\w+)\s+(\d+)$/, '$1, $2');
      dataParts.push(`Joined ${escapeHtml(formattedDate)}`);
    }
    
    // 5. Location (only if exists)
    if (userData.location && userData.location.trim()) {
      dataParts.push(`Location: ${escapeHtml(userData.location)}`);
    }
    
    // 6. Total size in MB
    if (userData.totalMB) {
      dataParts.push(`Total size: ${userData.totalMB} MB`);
    }
    
    // 7. Flickr profile link (last line)
    if (userData.profileUrl && userData.profileUrl.trim()) {
      dataParts.push(`<a class="user-data-link" href="${escapeHtml(userData.profileUrl)}" target="_blank" rel="noopener">View on Flickr</a>`);
    }
    
    // Only show if there's data to display
    if (dataParts.length > 0) {
      // Create or update user data element
      if (!userDataElement) {
        userDataElement = document.createElement('div');
        userDataElement.className = 'user-data';
        remainsLogo.appendChild(userDataElement);
      }
      
      // Create HTML with each part on a separate line
      userDataElement.innerHTML = dataParts.join('<br>');
      userDataElement.style.display = 'block';
    } else {
      // Hide if no data
      if (userDataElement) {
        userDataElement.style.display = 'none';
      }
    }
  } else {
    // Hide user data element for other views
    if (userDataElement) {
      userDataElement.style.display = 'none';
    }
  }
  
  // Remove existing click listener if any
  const existingHandler = h1._navTitleClickHandler;
  if (existingHandler) {
    h1.removeEventListener('click', existingHandler);
    h1._navTitleClickHandler = null;
  }
  
  // Make it clickable to go back only when viewing an album (not when viewing user's album list)
  if (view === 'album') {
    h1.style.cursor = 'pointer';
    const clickHandler = () => {
      // Go back to user view if we came from there, or to drawer
      navigate('drawer');
    };
    h1.addEventListener('click', clickHandler);
    h1._navTitleClickHandler = clickHandler;
  } else {
    h1.style.cursor = 'default';
  }
}

/**
 * Restore nav title and user data when returning from about mode to user-albums view
 * (no full re-render, just update the header)
 */
export async function restoreUserNav(username) {
  if (!username) return;
  let decoded = username;
  if (typeof username === 'string' && username.includes('%')) {
    try {
      for (let i = 0; i < 3; i++) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    } catch (e) {
      decoded = username;
    }
  }
  const userData = await getUserData(decoded);
  if (userData) {
    updateNavTitle({ view: 'user', username: decoded, userData });
  } else {
    updateNavTitle({ view: 'user', username: decoded });
  }
}

// Export for use in main.js
export { updateNavTitle };
