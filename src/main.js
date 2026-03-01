/**
 * Main entry point for the app
 * Creates/selects canvas and starts the Drawer scene
 */
import { DrawerScene } from './scenes/drawer.js';
import { initRouter, navigate, registerRoute, getCurrentRoute } from './routing.js';
import { renderUsersPage, loadUsersData, cleanupUsersPage } from './pages/users.js';
import { renderUserAlbumsPage, updateNavTitle, restoreUserNav } from './pages/user-albums.js';
import { renderIndexPage } from './pages/index.js';
import { initPixelLoader, setPixelLoaderProgress, destroyPixelLoader } from './utils/pixelLoader.js';

// Store drawer scene instance for filter UI access
let drawerSceneInstance = null;
let isInitialLoad = true;
let previousRoute = null;
let isTransitioningToAlbum = false; // Track if we're transitioning to album mode

// Store filters-wrap animations
let filtersWrapCloseAnimation = null;
let filtersWrapOpenAnimation = null;

// About page state
let isAboutActive = false;
let previousViewBeforeAbout = null;

// About page mouse trail state
let trailPhotos = null; // Cached photos for trail
let trailMouseHandler = null; // Reference to mousemove handler for cleanup
let lastTrailX = 0;
let lastTrailY = 0;
const TRAIL_SPAWN_DISTANCE = 30; // Spawn image every 30px of mouse movement

/**
 * Animate filters-wrap closing (mechanical shutter effect from top)
 */
function animateFiltersWrapClose() {
  const filtersWrap = domCache.filtersWrap;
  if (!filtersWrap) return;
  
  // Check if already closed - if so, don't animate again
  const computedStyle = window.getComputedStyle(filtersWrap);
  const currentTransform = computedStyle.transform;
  // If transform contains scaleY(0.02) or translateY is negative and significant, it's already closed
  if (currentTransform && currentTransform !== 'none') {
    // Try to parse translateY value
    const translateMatch = currentTransform.match(/translateY\(([^)]+)\)/);
    if (translateMatch) {
      const translateY = parseFloat(translateMatch[1]);
      // If translateY is significantly negative (more than -50px), it's likely already closed
      if (translateY < -50 && currentTransform.includes('scaleY(0.02)')) {
        // Already closed, don't animate again
        return;
      }
    }
  }
  
  // Cancel any existing animations
  if (filtersWrapCloseAnimation) {
    filtersWrapCloseAnimation.cancel();
  }
  if (filtersWrapOpenAnimation) {
    filtersWrapOpenAnimation.cancel();
  }
  
  // Ensure element is visible before closing
  filtersWrap.style.display = 'block';
  filtersWrap.style.visibility = 'visible';
  filtersWrap.style.opacity = '1';
  
  // Clear CSS variable that might interfere with animation
  document.documentElement.style.setProperty('--navTranslateY', '0px');
  
  // Reset to starting position (fully open) before animation
  // Use requestAnimationFrame to ensure CSS is applied before animation starts
  requestAnimationFrame(() => {
    filtersWrap.style.transform = 'translateY(0) scaleY(1)';
    filtersWrap.style.filter = 'blur(0px)';
    
    // Force a reflow to ensure transform is applied
    filtersWrap.offsetHeight;
    
    // Calculate distance to move up to disappear under top-nav
    // Use CSS variables for responsive design
    const computedStyle = window.getComputedStyle(filtersWrap);
    const rootStyles = getComputedStyle(document.documentElement);
    const navHeight = parseFloat(rootStyles.getPropertyValue('--nav-height')) || 12;
    const centerNavHeight = parseFloat(rootStyles.getPropertyValue('--center-nav-height')) || 36;
    const filtersNavGap = parseFloat(rootStyles.getPropertyValue('--filters-nav-gap')) || 8;
    const filtersHeight = parseFloat(computedStyle.getPropertyValue('--filters-nav-height')) || 24;
    // Original top position: nav-height + center-nav-height + gap
    const originalTop = navHeight + centerNavHeight + filtersNavGap;
    // Move up by originalTop + filtersHeight to disappear completely under top-nav
    const finalTranslateY = -(originalTop + filtersHeight);
    
    // Two-stage mechanical animation using keyframes (moving up to disappear under top-nav)
    // This is the exact reverse of the opening animation - mirror the stages perfectly
    // Opening: startTranslateY -> startTranslateY*0.15 -> startTranslateY*0.3 -> 0
    // Closing: 0 -> finalTranslateY*0.15 -> finalTranslateY*0.3 -> finalTranslateY
    // Note: Since finalTranslateY is negative, 0.15 is closer to 0 than 0.3
    filtersWrapCloseAnimation = filtersWrap.animate([
      // Stage 1: Start moving up (0-50%) - exact reverse of opening stage 2
      // Opening stage 2: 50% -> 100%: translateY(start*0.15)->start*0.3->0, scaleY(0.3)->0.95->1, blur(0.8px)->0.3px->0px
      // Closing stage 1: 0% -> 50%: translateY(0)->final*0.15, scaleY(1)->0.95, blur(0px)->0.3px
      {
        transform: `translateY(0) scaleY(1)`,
        filter: 'blur(0px)'
      },
      {
        transform: `translateY(${finalTranslateY * 0.15}px) scaleY(0.95)`,
        filter: 'blur(0.3px)',
        offset: 0.5
      },
      // Stage 2: Continue up and disappear (50-100%) - exact reverse of opening stage 1
      // Opening stage 1: 0% -> 50%: translateY(start)->start*0.15, scaleY(0.02)->0.3, blur(0px)->0.8px
      // Closing stage 2: 50% -> 100%: translateY(final*0.15)->final*0.3->final, scaleY(0.95)->0.3->0.02, blur(0.3px)->0.8px->0px
      {
        transform: `translateY(${finalTranslateY * 0.3}px) scaleY(0.3)`,
        filter: 'blur(0.8px)',
        offset: 0.85
      },
      {
        transform: `translateY(${finalTranslateY}px) scaleY(0.02)`,
        filter: 'blur(0px)',
        offset: 1.0
      }
    ], {
      duration: 650, // ms - slower than opening animation for more controlled feel
      easing: 'cubic-bezier(0.25, 0.8, 0.25, 1.0)', // Slower, more controlled easing
      fill: 'forwards' // Keep final state
    });
    
    // Update CSS after animation completes
    filtersWrapCloseAnimation.onfinish = () => {
      filtersWrap.style.transform = `translateY(${finalTranslateY}px) scaleY(0.02)`;
      filtersWrap.style.filter = 'blur(0px)';
      filtersWrap.style.pointerEvents = 'none';
    };
  });
}

/**
 * Animate filters-wrap opening (reverse mechanical shutter effect)
 */
function animateFiltersWrapOpen() {
  const filtersWrap = domCache.filtersWrap;
  if (!filtersWrap) return;
  
  // Check if already open - if so, don't animate again
  const computedStyle = window.getComputedStyle(filtersWrap);
  const currentTransform = computedStyle.transform;
  // If transform is translateY(0) scaleY(1) or close to it, it's already open
  if (currentTransform && currentTransform !== 'none') {
    // Try to parse translateY value
    const translateMatch = currentTransform.match(/translateY\(([^)]+)\)/);
    if (translateMatch) {
      const translateY = parseFloat(translateMatch[1]);
      // If translateY is close to 0 (within 5px) and scaleY is 1, it's already open
      if (Math.abs(translateY) < 5 && currentTransform.includes('scaleY(1)')) {
        // Already open, don't animate again
        return;
      }
    } else if (currentTransform.includes('scaleY(1)')) {
      // If no translateY but scaleY is 1, it's likely already open
      return;
    }
  }
  
  // Cancel any existing animations
  if (filtersWrapCloseAnimation) {
    filtersWrapCloseAnimation.cancel();
  }
  if (filtersWrapOpenAnimation) {
    filtersWrapOpenAnimation.cancel();
  }
  
  // Calculate start position (where it was when closed - under top-nav)
  // Use CSS variables for responsive design
  const rootStyles = getComputedStyle(document.documentElement);
  const navHeight = parseFloat(rootStyles.getPropertyValue('--nav-height')) || 12;
  const centerNavHeight = parseFloat(rootStyles.getPropertyValue('--center-nav-height')) || 36;
  const filtersNavGap = parseFloat(rootStyles.getPropertyValue('--filters-nav-gap')) || 8;
  const originalTop = navHeight + centerNavHeight + filtersNavGap;
  // Use CSS variable for consistent height calculation (same as closing animation)
  const filtersHeight = parseFloat(computedStyle.getPropertyValue('--filters-nav-height')) || 24;
  // When closed, it's moved up by originalTop + filtersHeight (same as finalTranslateY in close)
  const startTranslateY = -(originalTop + filtersHeight);
  
  // Ensure element is visible and positioned correctly before animation
  filtersWrap.style.display = 'block';
  filtersWrap.style.visibility = 'visible';
  filtersWrap.style.opacity = '1';
  filtersWrap.style.transform = `translateY(${startTranslateY}px) scaleY(0.02)`;
  filtersWrap.style.filter = 'blur(0px)';
  
  // Two-stage mechanical animation (reverse of close - coming down from under top-nav)
  filtersWrapOpenAnimation = filtersWrap.animate([
    // Stage 1: Start coming down (0-50%)
    {
      transform: `translateY(${startTranslateY}px) scaleY(0.02)`,
      filter: 'blur(0px)'
    },
    {
      transform: `translateY(${startTranslateY * 0.15}px) scaleY(0.3)`,
      filter: 'blur(0.8px)',
      offset: 0.5
    },
    // Stage 2: Continue down and settle into place (50-100%)
    {
      transform: `translateY(${startTranslateY * 0.3}px) scaleY(0.95)`,
      filter: 'blur(0.3px)',
      offset: 0.85
    },
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
  
  // Update CSS after animation completes
  filtersWrapOpenAnimation.onfinish = () => {
    filtersWrap.style.transform = 'translateY(0) scaleY(1)';
    filtersWrap.style.filter = 'blur(0px)';
    filtersWrap.style.pointerEvents = '';
  };
}

// Cache DOM elements to avoid repeated queries
const domCache = {
  canvas: null,
  pageContainer: null,
  filtersWrap: null,
  remainsLogo: null,
  topNav: null,
  centerNav: null,
  get canvas() {
    if (!this._canvas) this._canvas = document.getElementById('canvas');
    return this._canvas;
  },
  get pageContainer() {
    if (!this._pageContainer) this._pageContainer = document.getElementById('page-container');
    return this._pageContainer;
  },
  get filtersWrap() {
    if (!this._filtersWrap) this._filtersWrap = document.getElementById('filters-wrap');
    return this._filtersWrap;
  },
  get remainsLogo() {
    if (!this._remainsLogo) this._remainsLogo = document.getElementById('remainsLogo');
    return this._remainsLogo;
  },
  get topNav() {
    if (!this._topNav) this._topNav = document.getElementById('top-nav');
    return this._topNav;
  },
  get centerNav() {
    if (!this._centerNav) this._centerNav = document.getElementById('center-nav');
    return this._centerNav;
  }
};

function init() {
  // Initialize router
  initRouter();
  
  // Register routes
  registerRoute('drawer', () => {
    showDrawerView();
  });
  
  registerRoute('users', () => {
    showUsersView();
  });
  
  registerRoute('user-albums', (params) => {
    showUserAlbumsView(params);
  });
  
  registerRoute('index', () => {
    showIndexView();
  });
  
  // Initialize drawer (but don't show it yet)
  const canvas = domCache.canvas;
  if (canvas) {
    drawerSceneInstance = new DrawerScene(canvas);
    // Make drawer scene instance globally accessible for album opening
    window.drawerSceneInstance = drawerSceneInstance;
    drawerSceneInstance.initialize().then(async () => {
      // Build filter UI after photos are loaded
      await Promise.all([
        setupLocationFilter(),
        setupDateFilter(),
        setupKeywordsFilter()
      ]);
      applyFiltersBarCollapsedState();
      
      // Register UI reset callbacks for when filters are cleared after release animation
      drawerSceneInstance.resetLocationUI = resetLocationUI;
      drawerSceneInstance.resetDateUI = resetDateUI;
      drawerSceneInstance.resetKeywordsUI = resetKeywordsUI;
    });
  }
  
  // Always start from the initial drawer view on page load/refresh
  // Clear hash and navigate to drawer
  if (window.location.hash) {
    window.history.replaceState({}, '', window.location.pathname);
  }
  navigate('drawer', {}, false);
  
  // Mark initial load as complete after first navigation
  setTimeout(() => {
    isInitialLoad = false;
  }, 100);
}

function showDrawerView() {
  const canvas = domCache.canvas;
  const pageContainer = domCache.pageContainer;
  
  // Check if we're coming from users view BEFORE updating classes
  const isComingFromUsers = previousRoute === 'users' || document.body.classList.contains('view-users');
  // Check if we're coming from user-albums view (album list for a user) BEFORE updating classes
  const isComingFromUserAlbums = previousRoute === 'user-albums' || document.body.classList.contains('view-user-albums');
  // Check if we're coming from index view BEFORE updating classes
  const isComingFromIndex = previousRoute === 'index' || document.body.classList.contains('view-index');
  // Check if already in drawer view BEFORE updating classes
  const isAlreadyInDrawerView = document.body.classList.contains('view-drawer');

  // If we're leaving users or user-albums, cleanup heavy/global handlers immediately.
  if (isComingFromUsers || isComingFromUserAlbums) {
    try {
      cleanupUsersPage();
    } catch (e) {
      // ignore
    }
  }
  // When leaving users/user-albums, same fast path as index: no long fade-out (skip page-transitioning).
  
  // Remove view classes to allow date label to show
  document.body.classList.remove('view-users', 'view-user-albums', 'view-index');
  document.body.classList.add('view-drawer');
  
  // Reset drawer scene "from index" / album state so opening drawer from user-albums doesn't redirect to index
  if (drawerSceneInstance) {
    drawerSceneInstance.fromIndex = false;
    drawerSceneInstance.viewMode = 'drawer';
    // Clear album→user state so opening a new album from user page doesn't get a stale fade setTimeout from a previous "click username"
    drawerSceneInstance.navigateToUserAfterExit = null;
    drawerSceneInstance.fromUserAlbums = false;
    drawerSceneInstance.userAlbumsUsername = null;
  }
  
  // Remove mode-album class if present (when returning from album mode)
  if (document.body.classList.contains('mode-album')) {
    document.body.classList.remove('mode-album');
    document.documentElement.style.setProperty('--uiAlpha', '1');
    document.documentElement.style.setProperty('--navTranslateY', '0px');
    
    // Ensure nav elements are visible
    const topNav = domCache.topNav;
    const centerNav = domCache.centerNav;
    const filtersWrap = domCache.filtersWrap;
    const remainsLogo = domCache.remainsLogo;
    
    if (topNav) {
      topNav.style.opacity = '1';
      topNav.style.visibility = 'visible';
      topNav.style.pointerEvents = 'auto';
    }
    if (centerNav) {
      centerNav.style.opacity = '1';
      centerNav.style.visibility = 'visible';
      centerNav.style.pointerEvents = 'auto';
    }
    if (filtersWrap) {
      filtersWrap.style.opacity = '1';
      filtersWrap.style.visibility = 'visible';
      filtersWrap.style.pointerEvents = 'auto';
    }
    if (remainsLogo) {
      const h1 = remainsLogo.querySelector('h1');
      if (h1) {
        h1.style.opacity = '1';
        h1.style.visibility = 'visible';
        h1.style.transition = '';
      }
    }
  }
  
  // Update previous route
  previousRoute = 'drawer';
  
  // If transitioning to album, fade the whole nav block (title + user data) together; do not hide only h1
  if (window.isTransitioningToAlbum) {
    const remainsLogo = domCache.remainsLogo;
    if (remainsLogo) {
      const fadeOutTransition = 'opacity 0.55s ease-in-out, visibility 0.55s ease-in-out';
      remainsLogo.style.transition = fadeOutTransition;
      remainsLogo.style.opacity = '0';
      remainsLogo.style.visibility = 'hidden';
    }
    return; // Don't update nav title or do anything else
  }
  
  // Restore nav title to "Remains" only if we're not returning from album mode
  // (when returning from album, the user albums view will update the title directly)
  if (!window.returningFromAlbum) {
    updateNavTitle({ view: 'drawer' });
  }
  
  // Do not re-enable center date label here: the drawer's render loop calls
  // updateCenterDateLabel each frame and will show the date only when the center
  // tile is computed and images are ready, avoiding "date first, then images" flash.
  
  if (isInitialLoad) {
    // On initial load, show immediately without fade
    if (pageContainer) {
      pageContainer.style.display = 'none';
      pageContainer.classList.remove('fade-in');
    }
    if (canvas) {
      canvas.style.display = 'block';
      canvas.style.visibility = 'visible';
      canvas.style.pointerEvents = 'auto';
      canvas.classList.remove('fade-out');
    }
  } else {
    // Hide old screen immediately (same fast path as index→drawer)
    const fromPage = isComingFromUsers || isComingFromUserAlbums || isComingFromIndex;
    if (pageContainer && fromPage) {
      pageContainer.style.visibility = 'hidden';
      pageContainer.style.opacity = '0';
      pageContainer.style.pointerEvents = 'none';
      pageContainer.classList.remove('fade-in');
      pageContainer.classList.add('fade-out');
      // From users/user-albums: hide display in same frame so drawer shows instantly
      if (isComingFromUsers || isComingFromUserAlbums) {
        pageContainer.style.display = 'none';
      } else {
        setTimeout(() => { pageContainer.style.display = 'none'; }, 80);
      }
    }
    
    // Ensure "Remains" logo stays visible (no fade out/in)
    const remainsLogo = domCache.remainsLogo;
    if (remainsLogo) {
      const h1 = remainsLogo.querySelector('h1');
      if (h1) {
        h1.style.opacity = '1';
        h1.style.visibility = 'visible';
        h1.style.transition = 'none'; // No transition - keep visible
      }
    }
    
    // From users/user-albums: show canvas and panel immediately (same as index→drawer).
    // From index: short delay then fade-in for consistency.
    const instantFromPage = isComingFromUsers || isComingFromUserAlbums;
    if (canvas && !window.isTransitioningToAlbum) {
      canvas.style.display = 'block';
      canvas.classList.remove('fade-out');
      if (instantFromPage) {
        canvas.style.visibility = 'visible';
        canvas.style.pointerEvents = 'auto';
        canvas.classList.remove('fade-in');
        // Fade-in via CSS transition so it runs even when RAF is throttled (e.g. tab background)
        canvas.style.transition = 'opacity 0.25s ease-out';
        canvas.style.opacity = '0';
        requestAnimationFrame(() => {
          if (canvas && canvas.style.opacity === '0') {
            canvas.style.opacity = '1';
          }
        });
        const clearTransition = () => {
          if (canvas) {
            canvas.style.transition = '';
            canvas.removeEventListener('transitionend', clearTransition);
          }
        };
        canvas.addEventListener('transitionend', clearTransition);
        setTimeout(clearTransition, 300);
        // No tile-level fade: canvas CSS fade shows full content immediately, so no long wait when RAF is throttled
      } else {
        canvas.style.visibility = 'hidden';
        canvas.style.opacity = '0';
        canvas.style.pointerEvents = 'none';
        canvas.classList.add('fade-out');
        canvas.offsetHeight;
      }
    } else if (canvas && window.isTransitioningToAlbum) {
      canvas.style.display = 'none';
    }
    
    if (!instantFromPage) {
      // After page container is hidden, fade in canvas (index path)
      setTimeout(() => {
        if (pageContainer && isComingFromIndex) {
          pageContainer.classList.remove('fade-out');
        }
        if (canvas && !window.isTransitioningToAlbum) {
          canvas.style.visibility = 'visible';
          canvas.style.opacity = '1';
          canvas.style.pointerEvents = 'auto';
          canvas.classList.remove('fade-out');
          canvas.classList.add('fade-in');
        }
      }, 50);
    } else if (pageContainer) {
      pageContainer.classList.remove('fade-out');
    }
  }
  
  // Ensure render loop is running to display images
  if (drawerSceneInstance && drawerSceneInstance.startRenderLoop) {
    try {
      // Force at least one draw after making the canvas visible
      drawerSceneInstance.forceRenderOnce = true;
    } catch (e) {}
    drawerSceneInstance.startRenderLoop();
  }
  
  // Filters panel: from users/user-albums show immediately (same as index→drawer). No 480ms animation.
  // Cancel any running animations first - their fill:'forwards' overrides inline styles
  if (filtersWrapCloseAnimation) {
    filtersWrapCloseAnimation.cancel();
    filtersWrapCloseAnimation = null;
  }
  if (filtersWrapOpenAnimation) {
    filtersWrapOpenAnimation.cancel();
    filtersWrapOpenAnimation = null;
  }
  const filtersWrap = domCache.filtersWrap;
  if (filtersWrap) {
    filtersWrap.style.display = 'block';
    filtersWrap.style.visibility = 'visible';
    filtersWrap.style.opacity = '1';
    filtersWrap.style.transform = 'translateY(0) scaleY(1)';
    filtersWrap.style.filter = 'blur(0px)';
    filtersWrap.style.pointerEvents = '';
  }
  
  // Update markers (highlights first, then arrow)
  positionDotHighlights();
  positionRadioMarker('drawer');
}

function showUsersView() {
  const canvas = domCache.canvas;
  const pageContainer = domCache.pageContainer;
  const isTransitioningFromUserAlbums = previousRoute === 'user-albums';

  // Cancel any pending "navigate to user" from drawer (e.g. album exit setTimeout) so Collections stays
  if (drawerSceneInstance) {
    drawerSceneInstance.navigateToUserAfterExit = null;
  }

  // Hide canvas immediately to prevent it from blocking page container
  if (canvas) {
    canvas.style.display = 'none';
    canvas.style.visibility = 'hidden';
    canvas.style.pointerEvents = 'none';
  }
  
  // Reset page container scrolling styles and ensure visibility
  if (pageContainer) {
    pageContainer.style.display = 'block'; // CRITICAL: Must be visible before focus
    pageContainer.style.height = '100vh';
    pageContainer.style.maxHeight = '100vh';
    pageContainer.style.overflowY = 'auto';
    pageContainer.style.overflowX = 'hidden';
    pageContainer.style.visibility = 'visible'; // Ensure container is visible for scrolling
    pageContainer.style.opacity = '1'; // Ensure container is opaque
    pageContainer.style.pointerEvents = 'auto'; // Ensure pointer events are enabled
    pageContainer.style.position = 'fixed'; // Ensure position is fixed (from CSS)
    pageContainer.style.zIndex = '1'; // Ensure z-index is set
    // Make container focusable to enable scrolling without requiring a click
    if (!pageContainer.hasAttribute('tabindex')) {
      pageContainer.setAttribute('tabindex', '-1');
    }
    
    // Try multiple focus strategies to ensure one works
    if (typeof pageContainer.focus === 'function') {
      // Strategy 1: Immediate synchronous focus
      try {
        pageContainer.focus();
      } catch (e) {
        // Focus failed, continue with other strategies
      }
      
      // Strategy 2: requestAnimationFrame focus
      requestAnimationFrame(() => {
        try {
          pageContainer.focus();
        } catch (e) {
          // Focus failed
        }
      });
      
      // Strategy 3: setTimeout(0) focus
      setTimeout(() => {
        try {
          pageContainer.focus();
        } catch (e) {
          // Focus failed
        }
      }, 0);
    }
    
    // Set up wheel event handler immediately to catch early scroll attempts
    // This ensures scrolling works even before renderUsersPage sets up its handler
    // We manually scroll the container instead of relying on focus
    const handleBodyWheel = (e) => {
      if (pageContainer && pageContainer.scrollHeight > pageContainer.clientHeight && 
          getComputedStyle(pageContainer).visibility === 'visible' &&
          getComputedStyle(pageContainer).display !== 'none') {
        const target = e.target;
        const isBodyOrDocument = target === document.body || 
                                  target === document.documentElement || 
                                  !pageContainer.contains(target);
        
        // If wheel event is on body/document or within the container, manually scroll
        if (isBodyOrDocument || pageContainer.contains(target) || target === pageContainer) {
          // Check if we can scroll in the requested direction
          const canScrollDown = pageContainer.scrollTop < (pageContainer.scrollHeight - pageContainer.clientHeight);
          const canScrollUp = pageContainer.scrollTop > 0;
          
          if ((e.deltaY > 0 && canScrollDown) || (e.deltaY < 0 && canScrollUp)) {
            // Prevent default scrolling behavior
            e.preventDefault();
            e.stopPropagation();
            
            // Manually scroll the container
            const newScroll = pageContainer.scrollTop + e.deltaY;
            pageContainer.scrollTop = Math.max(0, Math.min(newScroll, pageContainer.scrollHeight - pageContainer.clientHeight));
          }
        }
      }
    };
    
    // Remove any existing handler
    if (window.__usersPageWheelHandler) {
      document.body.removeEventListener('wheel', window.__usersPageWheelHandler, { passive: false, capture: true });
    }
    // Store handler reference
    window.__usersPageWheelHandler = handleBodyWheel;
    // Add handler immediately with passive: false to allow preventDefault
    document.body.addEventListener('wheel', handleBodyWheel, { passive: false, capture: true });
  }
  
  // Check if already in users view - if so, don't animate again
  const isAlreadyInUsersView = document.body.classList.contains('view-users');
  
  // CRITICAL: Hide pageContainer immediately to prevent flash of old content
  // Skip when transitioning from user-albums so the container stays visible for the fade-out then render
  if (pageContainer && !isTransitioningFromUserAlbums) {
    // Remove any fade classes that might make it visible
    pageContainer.classList.remove('fade-in', 'fade-out');
    // Hide immediately with !important inline styles to override any CSS
    pageContainer.style.setProperty('visibility', 'hidden', 'important');
    pageContainer.style.setProperty('opacity', '0', 'important');
    pageContainer.style.setProperty('pointer-events', 'none', 'important');
    // Also set display to none to completely hide it
    pageContainer.style.setProperty('display', 'none', 'important');
    // Force immediate reflow to apply styles
    pageContainer.offsetHeight;
  }
  
  // Add view class to hide date label
  document.body.classList.remove('view-drawer', 'view-user-albums', 'view-index', 'from-album');
  document.body.classList.add('view-users');
  
  // Animate filters-wrap closing (mechanical shutter from top)
  // Only if we're not already in users view
  if (!isAlreadyInUsersView) {
    animateFiltersWrapClose();
  }
  
  // Restore nav title to "Remains"
  updateNavTitle({ view: 'drawer' });
  
  // Hide center date label when leaving drawer view
  if (drawerSceneInstance && drawerSceneInstance.centerDateEl) {
    drawerSceneInstance.centerDateEl.style.display = 'none';
    drawerSceneInstance.centerDateEl.style.opacity = '0';
    drawerSceneInstance.centerDateEl.style.visibility = 'hidden';
  }
  
  if (isInitialLoad) {
    // On initial load we must still call renderUsersPage() so the users grid and images load
    if (canvas) {
      canvas.style.display = 'none';
      canvas.style.visibility = 'hidden';
      canvas.classList.add('fade-out');
    }
    if (pageContainer) {
      pageContainer.style.removeProperty('visibility');
      pageContainer.style.removeProperty('opacity');
      pageContainer.style.removeProperty('display');
      pageContainer.style.removeProperty('pointer-events');
      pageContainer.style.display = 'block';
      pageContainer.style.height = '100vh';
      pageContainer.style.maxHeight = '100vh';
      pageContainer.style.overflowY = 'auto';
      pageContainer.style.overflowX = 'hidden';
      if (!pageContainer.hasAttribute('tabindex')) {
        pageContainer.setAttribute('tabindex', '-1');
      }
      document.body.classList.add('page-transitioning');
      renderUsersPage().then(() => {
        if (typeof pageContainer.focus === 'function') {
          pageContainer.focus();
        }
        pageContainer.classList.add('fade-in');
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            document.body.classList.remove('page-transitioning');
            const usersPageEl = pageContainer.querySelector('.users-page');
            if (usersPageEl) {
              usersPageEl.classList.remove('page-transitioning');
            }
          });
        });
      });
    }
  } else if (isTransitioningFromUserAlbums) {
    // Hide canvas immediately to prevent it from blocking page container
    if (canvas) {
      canvas.style.display = 'none';
      canvas.style.visibility = 'hidden';
      canvas.style.pointerEvents = 'none';
    }
    
    // Soft transition: fade out title and cards, then render and fade in new content
    if (pageContainer) {
      // Clear any inline styles left from user-albums fade-out (after multiple album↔user cycles)
      pageContainer.style.transition = '';
      pageContainer.classList.remove('fade-in', 'fade-out', 'page-exiting');
      pageContainer.style.removeProperty('visibility');
      pageContainer.style.removeProperty('opacity');
      pageContainer.style.removeProperty('pointer-events');
      pageContainer.style.removeProperty('display');
      pageContainer.style.setProperty('display', 'block', 'important');
      pageContainer.style.setProperty('opacity', '1', 'important');
      pageContainer.style.setProperty('visibility', 'visible', 'important');
      pageContainer.style.setProperty('pointer-events', 'auto', 'important');
      // Ensure scrolling styles are set
      pageContainer.style.height = '100vh';
      pageContainer.style.maxHeight = '100vh';
      pageContainer.style.overflowY = 'auto';
      pageContainer.style.overflowX = 'hidden';
      pageContainer.style.pointerEvents = 'auto';
      pageContainer.style.zIndex = '1';
      pageContainer.classList.add('fade-in');
      pageContainer.classList.remove('fade-out');
      
      // Update title immediately (no animation)
      updateNavTitle({ view: 'drawer' });
      
      // Fade out the existing album cards smoothly
      const existingUsersPage = pageContainer.querySelector('.users-page');
      if (existingUsersPage) {
        // Add fade-out class to existing content
        existingUsersPage.classList.add('page-exiting');
        
        // Wait for fade-out animation to complete (450ms), then render new content
        setTimeout(() => {
          // Add transitioning class to prepare for new content
          document.body.classList.add('page-transitioning');
          
          // Focus container before rendering to enable scrolling
          if (pageContainer && typeof pageContainer.focus === 'function') {
            if (!pageContainer.hasAttribute('tabindex')) {
              pageContainer.setAttribute('tabindex', '-1');
            }
            pageContainer.focus();
          }
          
          // Render new content (user cards)
          renderUsersPage().then(() => {
            // Force container visible after render (Collections must always show)
            if (pageContainer) {
              pageContainer.style.setProperty('display', 'block', 'important');
              pageContainer.style.setProperty('opacity', '1', 'important');
              pageContainer.style.setProperty('visibility', 'visible', 'important');
              pageContainer.style.setProperty('pointer-events', 'auto', 'important');
              pageContainer.classList.add('fade-in');
              pageContainer.classList.remove('fade-out');
            }
            // Focus again after rendering to ensure it persists
            if (pageContainer && typeof pageContainer.focus === 'function') {
              pageContainer.focus();
            }
            
            // Remove transitioning class to trigger fade-in
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                document.body.classList.remove('page-transitioning');
                const usersPageEl = pageContainer.querySelector('.users-page');
                if (usersPageEl) {
                  usersPageEl.classList.remove('page-transitioning');
                }
              });
            });
          });
        }, 450);
      } else {
        // No existing content, update title already done above, render normally
        document.body.classList.add('page-transitioning');
        
        // Focus container before rendering
        if (pageContainer && typeof pageContainer.focus === 'function') {
          if (!pageContainer.hasAttribute('tabindex')) {
            pageContainer.setAttribute('tabindex', '-1');
          }
          pageContainer.focus();
        }
        
        renderUsersPage().then(() => {
            // Force container visible after render (Collections must always show)
            if (pageContainer) {
              pageContainer.style.setProperty('display', 'block', 'important');
              pageContainer.style.setProperty('opacity', '1', 'important');
              pageContainer.style.setProperty('visibility', 'visible', 'important');
              pageContainer.style.setProperty('pointer-events', 'auto', 'important');
              pageContainer.classList.add('fade-in');
              pageContainer.classList.remove('fade-out');
            }
            if (pageContainer && typeof pageContainer.focus === 'function') {
              pageContainer.focus();
            }
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              document.body.classList.remove('page-transitioning');
              const usersPageEl = pageContainer.querySelector('.users-page');
              if (usersPageEl) {
                usersPageEl.classList.remove('page-transitioning');
              }
            });
          });
        });
      }
    }
  } else {
    // Hide old screen immediately to prevent flash
    if (canvas) {
      canvas.style.display = 'none';
      canvas.style.visibility = 'hidden';
      canvas.style.pointerEvents = 'none';
      canvas.classList.remove('fade-in');
      canvas.classList.add('fade-out');
    }
    
    // Ensure "Remains" logo stays visible (no fade out/in)
    const remainsLogo = domCache.remainsLogo;
    if (remainsLogo) {
      const h1 = remainsLogo.querySelector('h1');
      if (h1) {
        h1.style.opacity = '1';
        h1.style.visibility = 'visible';
        h1.style.transition = 'none'; // No transition - keep visible
      }
    }
    
    // Show and fade in page container - START HIDDEN
    if (pageContainer) {
      // Ensure it stays hidden (override any CSS) - but don't use display:none yet
      // We need display:block for layout, but keep it invisible
      pageContainer.style.setProperty('visibility', 'hidden', 'important');
      pageContainer.style.setProperty('opacity', '0', 'important');
      pageContainer.style.setProperty('display', 'block', 'important');
      pageContainer.style.setProperty('pointer-events', 'none', 'important');
      // Ensure scrolling styles are set
      pageContainer.style.height = '100vh';
      pageContainer.style.maxHeight = '100vh';
      pageContainer.style.overflowY = 'auto';
      pageContainer.style.overflowX = 'hidden';
      pageContainer.style.pointerEvents = 'auto';
      pageContainer.style.zIndex = '1';
      // Make container focusable to enable scrolling
      if (!pageContainer.hasAttribute('tabindex')) {
        pageContainer.setAttribute('tabindex', '-1');
      }
      
      // Add transitioning class to body and page to trigger initial hidden state for user images
      document.body.classList.add('page-transitioning');
      
      // Force reflow to ensure display change is applied
      pageContainer.offsetHeight;
      
      // DON'T make visible yet - wait for renderUsersPage to complete
      // The fade-in will be triggered after rendering
    }
    // Focus container immediately before rendering to enable scrolling
    if (pageContainer && typeof pageContainer.focus === 'function') {
      if (!pageContainer.hasAttribute('tabindex')) {
        pageContainer.setAttribute('tabindex', '-1');
      }
      pageContainer.focus();
    }
    
    // Render users page and then trigger fade-in animations for user images
    renderUsersPage().then(() => {
      // Force container visible (Collections must always show)
      if (pageContainer) {
        pageContainer.style.setProperty('display', 'block', 'important');
        pageContainer.style.setProperty('opacity', '1', 'important');
        pageContainer.style.setProperty('visibility', 'visible', 'important');
        pageContainer.style.setProperty('pointer-events', 'auto', 'important');
        pageContainer.classList.add('fade-in');
      }
      // Focus again after rendering to ensure it persists
      if (pageContainer && typeof pageContainer.focus === 'function') {
        pageContainer.focus();
      }
      
      // Note: page-transitioning class is now added in renderUsersPage() immediately after innerHTML
      // to ensure elements start in hidden state (opacity: 0)
      
      // Ensure visible for fade-in animation
      if (pageContainer) {
        pageContainer.style.visibility = 'visible';
        pageContainer.style.opacity = '1';
        pageContainer.style.pointerEvents = 'auto';
        pageContainer.classList.add('fade-in');
      }
      
      // Start animation immediately after page is rendered (don't wait for canvas fade-out)
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const usersPageEl = pageContainer.querySelector('.users-page');
          
          document.body.classList.remove('page-transitioning');
          if (usersPageEl) {
            usersPageEl.classList.remove('page-transitioning');
          }
        });
      });
    });
  }
  
  // Show filters nav on users view
  const filtersWrap = domCache.filtersWrap;
  if (filtersWrap) {
    filtersWrap.style.display = 'block';
  }
  
  // Update markers (highlights first, then arrow)
  positionDotHighlights();
  positionRadioMarker('users');
  
  // NOTE: renderUsersPage() is already called above in the transition branches
  // (line 786 for isTransitioningFromUserAlbums, line 863 for isTransitioningFromDrawer)
  // Do NOT call it again here to avoid duplicate renders and page-transitioning class issues
  
  // Update previous route
  previousRoute = 'users';
}

function showUserAlbumsView(params) {
  const canvas = domCache.canvas;
  const pageContainer = domCache.pageContainer;
  const isTransitioningFromUsers = previousRoute === 'users';
  // Check if we're returning from album mode
  const isReturningFromAlbum = window.returningFromAlbum || 
                                (previousRoute === 'drawer' && document.body.classList.contains('mode-album'));
  
  // If we're transitioning TO album mode (from clicking an album card),
  // don't render the user-albums page - it would appear behind the album
  if (window.isTransitioningToAlbum) {
    return;
  }
  
  // If returning from album, update nav title IMMEDIATELY and synchronously
  // BEFORE removing mode-album class, to prevent any flash of wrong text
  if (isReturningFromAlbum && params?.username) {
    // Decode username if needed
    let username = params.username;
    if (username.includes('%')) {
      try {
        username = decodeURIComponent(username);
      } catch (e) {
          // If decoding fails, use as-is
        }
    }
    updateNavTitle({ view: 'user', username });
    
    // Ensure nav title is visible (it might have been hidden during transition)
    const remainsLogo = domCache.remainsLogo;
    if (remainsLogo) {
      const h1 = remainsLogo.querySelector('h1');
      if (h1) {
        h1.style.opacity = '1';
        h1.style.visibility = 'visible';
        h1.style.transition = ''; // Reset transition to use CSS defaults
      }
    }
  }
  
  // Clear the flag
  window.returningFromAlbum = false;
  
  // Add view class to hide date label
  document.body.classList.remove('view-drawer', 'view-users', 'view-index');
  document.body.classList.add('view-user-albums');

  // Forward wheel events to the scroll container so scrolling works even when the
  // pointer is over fixed UI (body is overflow:hidden).
  if (pageContainer) {
    const handleUserAlbumsWheel = (e) => {
      const pc = domCache.pageContainer;
      if (!pc) return;
      const cs = getComputedStyle(pc);
      const canScroll = pc.scrollHeight > pc.clientHeight &&
        cs.visibility === 'visible' &&
        cs.display !== 'none' &&
        cs.pointerEvents !== 'none';
      if (!canScroll) return;

      const target = e.target;
      const targetIsOutside = target === document.body ||
        target === document.documentElement ||
        (target && !pc.contains(target));

      if (targetIsOutside || target === pc || pc.contains(target)) {
        const prev = pc.scrollTop;
        const max = pc.scrollHeight - pc.clientHeight;
        const next = Math.max(0, Math.min(prev + e.deltaY, max));

        if (next !== prev) {
          e.preventDefault();
          e.stopPropagation();
          pc.scrollTop = next;
        }
      }
    };

    if (window.__userAlbumsWheelHandler) {
      document.body.removeEventListener('wheel', window.__userAlbumsWheelHandler, { passive: false, capture: true });
    }
    window.__userAlbumsWheelHandler = handleUserAlbumsWheel;
    document.body.addEventListener('wheel', handleUserAlbumsWheel, { passive: false, capture: true });
  }
  
  // Remove mode-album class if present (from album view)
  // Do this AFTER updating nav title to ensure title is set before it becomes visible
  const hadModeAlbum = document.body.classList.contains('mode-album');
  if (hadModeAlbum) {
    const albumMetaEl = document.querySelector('.album-meta-ui');
    
    // Hide album-meta-ui IMMEDIATELY before removing mode-album class to prevent overlap
    if (albumMetaEl) {
      albumMetaEl.style.display = 'none';
    }
    
    document.body.classList.remove('mode-album');
  }

  // Ensure navigation bars are visible and properly positioned when returning from album mode
  // This fixes the issue where nav bars stay hidden when navigating from album to user page
  // Also handle the case where mode-album was just removed (even if isReturningFromAlbum is false)
  if (isReturningFromAlbum || hadModeAlbum) {
    // Reset nav bar position to fully visible (down)
    document.documentElement.style.setProperty('--navTranslateY', '0px');
    document.documentElement.style.setProperty('--uiAlpha', '1');
    
    // Explicitly show and position navigation bars (top-nav and center-nav)
    const topNav = domCache.topNav;
    const centerNav = domCache.centerNav;
    
    if (topNav) {
      topNav.style.opacity = '1';
      topNav.style.visibility = 'visible';
      topNav.style.display = 'block';
      topNav.style.transform = 'translateY(0px)';
    }
    
    if (centerNav) {
      centerNav.style.opacity = '1';
      centerNav.style.visibility = 'visible';
      centerNav.style.display = 'flex';
      centerNav.style.transform = 'translateY(0px)';
    }
    
    // Ensure filters-wrap is visible first, then close it (it should be closed on user page)
    const filtersWrap = domCache.filtersWrap;
    if (filtersWrap) {
      filtersWrap.style.display = 'block';
      filtersWrap.style.visibility = 'visible';
      filtersWrap.style.opacity = '1';
      // Reset transform to start position before closing animation
      filtersWrap.style.transform = 'translateY(0px) scaleY(1)';
    }
  }
  
  // Animate filters-wrap closing (mechanical shutter from top)
  // Always close it on user albums page, whether coming from drawer or album mode
  animateFiltersWrapClose();
  
  // Hide center date label when leaving drawer view
  if (drawerSceneInstance && drawerSceneInstance.centerDateEl) {
    drawerSceneInstance.centerDateEl.style.display = 'none';
    drawerSceneInstance.centerDateEl.style.opacity = '0';
    drawerSceneInstance.centerDateEl.style.visibility = 'hidden';
  }
  
  if (isInitialLoad) {
    // On initial load, show immediately without fade
    if (canvas) {
      canvas.style.display = 'none';
      canvas.classList.add('fade-out');
    }
    if (pageContainer) {
      pageContainer.style.display = 'block';
      pageContainer.classList.add('fade-in');
    }
    renderUserAlbumsPage(params);
  } else if (isTransitioningFromUsers) {
    // Soft transition: fade out title and cards, then render and fade in new content
    if (pageContainer) {
      pageContainer.classList.remove('fade-in', 'fade-out');
      pageContainer.style.display = 'block';
      pageContainer.style.opacity = '1';
      pageContainer.style.visibility = 'visible';
      
      // Update title immediately (no animation) - decode username so we never show % in the title
      let titleUsername = params?.username;
      if (typeof titleUsername === 'string' && titleUsername.includes('%')) {
        try {
          titleUsername = decodeURIComponent(titleUsername);
        } catch (e) {
          // keep as-is
        }
      }
      updateNavTitle({ view: 'user', username: titleUsername });
      
      // Fade out the existing users grid smoothly
      const existingUsersPage = pageContainer.querySelector('.users-page');
      if (existingUsersPage) {
        // Add fade-out class to existing content
        existingUsersPage.classList.add('page-exiting');
        
        // Wait for fade-out animation to complete (450ms - slightly longer for smoother effect)
        setTimeout(async () => {
          // Add transitioning class to body BEFORE rendering
          document.body.classList.add('page-transitioning');
          
          // Render new content (album cards) - AWAIT the async function!
          await renderUserAlbumsPage(params);
          
          // The page-transitioning class is now added in renderUserAlbumsPage when body has page-transitioning
          // Just ensure it's there and force reflow
          const newUsersPage = pageContainer.querySelector('.users-page');
          if (newUsersPage && !newUsersPage.classList.contains('page-transitioning')) {
            newUsersPage.classList.add('page-transitioning');
          }
          // Force reflow to ensure styles are applied
          if (newUsersPage) {
            void newUsersPage.offsetHeight;
          }
          
          // Remove transitioning class after a brief moment to trigger fade-in
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              document.body.classList.remove('page-transitioning');
              const usersPageEl = pageContainer.querySelector('.users-page');
              if (usersPageEl) {
                usersPageEl.classList.remove('page-transitioning');
              }
            });
          });
        }, 450);
      } else {
        // No existing content, title already updated above, render normally
        document.body.classList.add('page-transitioning');
        renderUserAlbumsPage(params);
        
        const usersPage = pageContainer.querySelector('.users-page');
        if (usersPage) {
          usersPage.classList.add('page-transitioning');
        }
        
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            document.body.classList.remove('page-transitioning');
            const usersPageEl = pageContainer.querySelector('.users-page');
            if (usersPageEl) {
              usersPageEl.classList.remove('page-transitioning');
            }
          });
        });
      }
    }
  } else if (isReturningFromAlbum) {
    // Returning from album mode - start invisible, render, then fade in
    document.body.classList.add('from-album');
    if (pageContainer) {
      // Reset any inline styles that might have been set
      pageContainer.style.transition = '';
      pageContainer.style.height = '';
      pageContainer.style.maxHeight = '';
      pageContainer.style.overflowY = '';
      pageContainer.style.overflowX = '';
      pageContainer.classList.remove('fade-in', 'fade-out');
      pageContainer.style.display = 'block';
      // Start invisible - let fade-in animation handle visibility
      pageContainer.style.opacity = '0';
      pageContainer.style.visibility = 'hidden';
    }
    
    // Ensure canvas is hidden
    if (canvas) {
      canvas.style.display = 'none';
    }
    
    // Render user albums page (async - wait for it to complete)
    renderUserAlbumsPage(params).then(() => {
      // Short delay before fade-in so the transition feels smoother (not instant cut)
      const fadeInDelay = 180;
      setTimeout(() => {
        if (pageContainer) {
          // Clear inline opacity/visibility so CSS can take over
          pageContainer.style.opacity = '';
          pageContainer.style.visibility = '';
          void pageContainer.offsetHeight; // Force reflow
          pageContainer.classList.add('fade-in');
        }
      }, fadeInDelay);
      
      // After albums are loaded and rendered, add transitioning class to trigger animations
      document.body.classList.add('page-transitioning');
      const usersPage = pageContainer?.querySelector('.users-page');
      if (usersPage) {
        usersPage.classList.add('page-transitioning');
      }
      
      // Remove transitioning class after a brief moment to trigger animations
      // Use a slightly longer delay for smoother transition
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            document.body.classList.remove('page-transitioning');
            const usersPageEl = pageContainer?.querySelector('.users-page');
            if (usersPageEl) {
              usersPageEl.classList.remove('page-transitioning');
            }
            // Remove from-album after fade-in so future transitions use default
            setTimeout(() => document.body.classList.remove('from-album'), 1200);
          });
        });
      }, 50);
    });
  } else {
    // Fade out canvas first
    if (canvas) {
      canvas.classList.remove('fade-in');
      canvas.classList.add('fade-out');
      // Hide after fade out completes
      setTimeout(() => {
        canvas.style.display = 'none';
        canvas.style.visibility = 'hidden';
      }, 800); // Match the fade-out transition duration (800ms from CSS)
    }
    
    // Show and fade in page container
    if (pageContainer) {
      pageContainer.style.display = 'block';
      // Force reflow to ensure display change is applied
      pageContainer.offsetHeight;
      pageContainer.classList.add('fade-in');
    }
    renderUserAlbumsPage(params);
  }
  
  // Note: filters-wrap visibility is already handled above:
  // - When returning from album: it's shown and then closed via animateFiltersWrapClose()
  // - When coming from other views: it's closed via animateFiltersWrapClose()
  // No need to show it again here as it should be closed (hidden) on user albums page
  
  // Update markers (highlights first, then arrow)
  positionDotHighlights();
  positionRadioMarker('users');
  
  // Render user albums page - only if not transitioning and not returning from album
  // (isReturningFromAlbum already calls renderUserAlbumsPage in its branch)
  if (!isTransitioningFromUsers && !isReturningFromAlbum) {
    renderUserAlbumsPage(params);
  }
  
  // Update previous route
  previousRoute = 'user-albums';
}

async function showIndexView() {
  if (window.returningToIndex) {
    window.returningToIndex = false;
  }
  
  const canvas = domCache.canvas;
  const pageContainer = domCache.pageContainer;
  
  // Check if we're coming from drawer view
  const isComingFromDrawer = previousRoute === 'drawer' || document.body.classList.contains('view-drawer');
  // Check if we're coming from users view
  const isComingFromUsers = previousRoute === 'users' || document.body.classList.contains('view-users');
  
  // CRITICAL: Hide pageContainer immediately to prevent flash of old content
  if (pageContainer) {
    // Remove any fade classes that might make it visible
    pageContainer.classList.remove('fade-in', 'fade-out');
    // Hide immediately with !important inline styles to override any CSS
    pageContainer.style.setProperty('visibility', 'hidden', 'important');
    pageContainer.style.setProperty('opacity', '0', 'important');
    pageContainer.style.setProperty('pointer-events', 'none', 'important');
    // Also set display to none to completely hide it
    pageContainer.style.setProperty('display', 'none', 'important');
    // Force immediate reflow to apply styles
    pageContainer.offsetHeight;
  }
  
  // Add view class
  document.body.classList.remove('view-drawer', 'view-users', 'view-user-albums');
  document.body.classList.add('view-index');
  
  // Show filters nav on index view. When coming from drawer, bar is already visible — skip animation.
  // Cancel any running animations first - their fill:'forwards' overrides inline styles
  if (filtersWrapCloseAnimation) {
    filtersWrapCloseAnimation.cancel();
    filtersWrapCloseAnimation = null;
  }
  if (filtersWrapOpenAnimation) {
    filtersWrapOpenAnimation.cancel();
    filtersWrapOpenAnimation = null;
  }
  const filtersWrap = domCache.filtersWrap;
  if (filtersWrap) {
    filtersWrap.style.display = 'block';
    if (isComingFromDrawer) {
      // Bar is already visible from drawer - just ensure styles are correct
      filtersWrap.style.visibility = 'visible';
      filtersWrap.style.opacity = '1';
      filtersWrap.style.transform = 'translateY(0) scaleY(1)';
      filtersWrap.style.filter = 'blur(0px)';
      filtersWrap.style.pointerEvents = '';
    } else {
      // Coming from users - animate the bar open
      animateFiltersWrapOpen();
    }
  }
  
  // Restore nav title to "Remains"
  updateNavTitle({ view: 'drawer' });
  
  // Hide center date label
  if (drawerSceneInstance && drawerSceneInstance.centerDateEl) {
    drawerSceneInstance.centerDateEl.style.display = 'none';
    drawerSceneInstance.centerDateEl.style.opacity = '0';
    drawerSceneInstance.centerDateEl.style.visibility = 'hidden';
  }
  
  // Setup page container
  if (pageContainer) {
    pageContainer.style.height = '100vh';
    pageContainer.style.maxHeight = '100vh';
    pageContainer.style.overflowY = 'auto';
    pageContainer.style.overflowX = 'hidden';
    pageContainer.style.position = 'fixed';
    pageContainer.style.zIndex = '1';
    
    if (!pageContainer.hasAttribute('tabindex')) {
      pageContainer.setAttribute('tabindex', '-1');
    }
  }
  
  if (isInitialLoad) {
    // On initial load, hide canvas immediately and show page container
    if (canvas) {
      canvas.style.display = 'none';
      canvas.style.visibility = 'hidden';
      canvas.style.pointerEvents = 'none';
    }
    
    // Add transitioning class to start rows in hidden state
    document.body.classList.add('page-transitioning');
    
    if (pageContainer) {
      pageContainer.style.display = 'block';
      pageContainer.style.removeProperty('opacity');
      pageContainer.style.removeProperty('visibility');
      pageContainer.style.pointerEvents = 'auto';
      pageContainer.classList.add('fade-in');
    }
    await renderIndexPage();
    
    // Add class to trigger image fade-in (images appear immediately)
    document.body.classList.add('index-images-fade-in');
    
    // Remove transitioning class to trigger row animations (after rows are in DOM)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.body.classList.remove('page-transitioning');
      });
    });
    
    // Remove image fade-in class after animation completes
    setTimeout(() => {
      document.body.classList.remove('index-images-fade-in');
    }, 600);
  } else if (isComingFromUsers) {
    // Transition from users view - fade out user images, fade in index images
    // First, add transitioning class to fade out user images
    document.body.classList.add('page-transitioning');
    const usersPage = pageContainer.querySelector('.users-page');
    if (usersPage) {
      usersPage.classList.add('page-transitioning');
    }
    
    // Prepare page container for fade-in (start hidden/transparent)
    if (pageContainer) {
      pageContainer.style.display = 'block';
      pageContainer.style.visibility = 'hidden'; // Start hidden
      pageContainer.style.opacity = '0';
      pageContainer.style.pointerEvents = 'none';
      pageContainer.classList.remove('fade-in', 'fade-out');
      // Force reflow
      pageContainer.offsetHeight;
    }
    
    // Render index page content first (while hidden) - wait so rows exist before we remove page-transitioning
    await renderIndexPage();
    
    // Wait for user images to fade out (300ms), then fade in index images
    setTimeout(() => {
      // Remove transitioning class to stop fade-out animation and trigger fade-in
      document.body.classList.remove('page-transitioning');
      if (usersPage) {
        usersPage.classList.remove('page-transitioning');
      }
      
      // Add a class to trigger index images fade-in animation
      document.body.classList.add('index-images-fade-in');
      
      // Now fade in index page container via CSS transition (no inline opacity/visibility so transition runs)
      if (pageContainer) {
        pageContainer.style.removeProperty('opacity');
        pageContainer.style.removeProperty('visibility');
        pageContainer.style.pointerEvents = 'auto';
        pageContainer.classList.add('fade-in');
      }
      
      // Remove the trigger class after animation completes to prevent re-triggering
      setTimeout(() => {
        document.body.classList.remove('index-images-fade-in');
      }, 600); // After animation completes
      
      // Note: page-transitioning was already removed above, so row animations will trigger
    }, 300); // Match the fade-out transition duration (300ms from CSS)
  } else {
    // Hide old screen immediately to prevent flash
    if (canvas && isComingFromDrawer) {
      canvas.style.display = 'none';
      canvas.style.visibility = 'hidden';
      canvas.style.pointerEvents = 'none';
      canvas.classList.remove('fade-in');
      canvas.classList.add('fade-out');
    }
    
    // Prepare page container for fade-in (start hidden/transparent)
    if (pageContainer) {
      pageContainer.style.display = 'block';
      pageContainer.style.visibility = 'hidden'; // Start hidden
      pageContainer.style.opacity = '0';
      pageContainer.style.pointerEvents = 'none'; // Don't block canvas during fade-out
      pageContainer.classList.remove('fade-in', 'fade-out');
      // Force reflow
      pageContainer.offsetHeight;
    }
    
    // Add transitioning class to start rows in hidden state
    document.body.classList.add('page-transitioning');
    
    // Render index page content first (while hidden) - wait so rows exist before we remove page-transitioning
    await renderIndexPage();
    
    // Fade in page container after a brief delay
    if (canvas && isComingFromDrawer) {
      // After canvas is hidden, fade in page container via CSS transition (no inline opacity/visibility so transition runs)
      setTimeout(() => {
        if (pageContainer) {
          pageContainer.style.removeProperty('opacity');
          pageContainer.style.removeProperty('visibility');
          pageContainer.style.pointerEvents = 'auto';
          pageContainer.classList.add('fade-in');
          
          // Add class to trigger image fade-in (images appear immediately)
          document.body.classList.add('index-images-fade-in');
          
          // Remove transitioning class to trigger row animations
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              document.body.classList.remove('page-transitioning');
            });
          });
          
          // Remove image fade-in class after animation completes
          setTimeout(() => {
            document.body.classList.remove('index-images-fade-in');
          }, 600);
        }
      }, 50); // Small delay to ensure canvas is hidden
    } else if (canvas) {
      // If not coming from drawer, hide immediately and show page container
      canvas.style.display = 'none';
      canvas.style.visibility = 'hidden';
      canvas.style.pointerEvents = 'none';
      
      // Show page container via CSS fade-in (no inline opacity/visibility so transition runs)
      if (pageContainer) {
        pageContainer.style.removeProperty('opacity');
        pageContainer.style.removeProperty('visibility');
        pageContainer.style.pointerEvents = 'auto';
        pageContainer.classList.add('fade-in');
        
        // Add class to trigger image fade-in (images appear immediately)
        document.body.classList.add('index-images-fade-in');
        
        // Remove transitioning class to trigger row animations
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            document.body.classList.remove('page-transitioning');
          });
        });
        
        // Remove image fade-in class after animation completes
        setTimeout(() => {
          document.body.classList.remove('index-images-fade-in');
        }, 600);
      }
    }
  }
  
  // Setup wheel event handler for index view (similar to users view)
  // Remove any existing handler
  if (window.__indexPageWheelHandler) {
    document.body.removeEventListener('wheel', window.__indexPageWheelHandler, { passive: false, capture: true });
  }
  
  // Create wheel event handler
  const handleIndexWheel = (e) => {
    // When in album view, do not handle wheel — let drawer handle album scroll
    if (document.body.classList.contains('mode-album')) {
      return;
    }
    // Find the scrollable table body element
    const tableBody = pageContainer?.querySelector('.index-table-body');
    if (!tableBody) {
      return;
    }
    
    // Check if we can scroll
    if (tableBody.scrollHeight > tableBody.clientHeight) {
      const target = e.target;
      const isBodyOrDocument = target === document.body || 
                                target === document.documentElement || 
                                !pageContainer.contains(target);
      
      // If wheel event is on body/document or within the container, manually scroll
      if (isBodyOrDocument || pageContainer.contains(target) || target === pageContainer || target === tableBody || tableBody.contains(target)) {
        const canScrollDown = tableBody.scrollTop < (tableBody.scrollHeight - tableBody.clientHeight);
        const canScrollUp = tableBody.scrollTop > 0;
        
        if ((e.deltaY > 0 && canScrollDown) || (e.deltaY < 0 && canScrollUp)) {
          // Prevent default scrolling behavior
          e.preventDefault();
          e.stopPropagation();
          // Manually scroll the table body
          const newScroll = tableBody.scrollTop + e.deltaY;
          tableBody.scrollTop = Math.max(0, Math.min(newScroll, tableBody.scrollHeight - tableBody.clientHeight));
        }
      }
    }
  };
  
  // Store handler reference
  window.__indexPageWheelHandler = handleIndexWheel;
  // Add handler with passive: false to allow preventDefault
  document.body.addEventListener('wheel', handleIndexWheel, { passive: false, capture: true });
  
  // Filters nav is already shown above
  
  // Update markers
  positionDotHighlights();
  positionRadioMarker('albums');
  
  // Update previous route
  previousRoute = 'index';
}

// Handle About toggle click
function setupAboutToggle() {
  const aboutToggle = document.querySelector('.about-toggle');
  if (aboutToggle) {
    aboutToggle.addEventListener('click', () => {
      if (!isAboutActive) {
        // Enter about mode
        enterAboutMode(aboutToggle);
      } else {
        // Exit about mode - return to previous view
        exitAboutMode(aboutToggle);
      }
    });
  }

  // Wheel handler: when in about mode, scroll about-content from anywhere on screen
  const aboutContent = document.getElementById('about-content');
  if (aboutContent) {
    document.addEventListener('wheel', function aboutWheel(e) {
      if (!document.body.classList.contains('mode-about')) return;
      const el = aboutContent;
      const canScrollUp = el.scrollTop > 0;
      const canScrollDown = el.scrollTop < el.scrollHeight - el.clientHeight;
      const delta = e.deltaY;
      if ((delta < 0 && canScrollUp) || (delta > 0 && canScrollDown)) {
        e.preventDefault();
        el.scrollTop += delta;
      }
    }, { passive: false, capture: true });
  }
}

/**
 * Enter about mode - fade out current content, show about text
 */
function enterAboutMode(aboutToggle) {
  // Store current view before entering about mode
  previousViewBeforeAbout = previousRoute || 'drawer';
  
  // Set about active state
  isAboutActive = true;
  
  // Restore nav title to "Remains" and hide user-data when entering about (e.g. from user-albums)
  updateNavTitle({ view: 'drawer' });
  
  // Toggle the active class on the about toggle
  aboutToggle.classList.add('active');
  
  // Add mode-about class to body (this triggers CSS transitions)
  document.body.classList.add('mode-about');
  
  // Animate filters bar closing
  animateFiltersWrapClose();
  
  // Start mouse trail effect
  startAboutMouseTrail();
  
  // Focus about content so it receives scroll when opened from Index/Collections (page-container scroll)
  const aboutContent = document.getElementById('about-content');
  if (aboutContent) {
    document.activeElement?.blur?.();
    // Focus after transition (0.4s)—element may not accept focus until fully visible when opened from Index/Collections
    setTimeout(() => {
      aboutContent.focus({ preventScroll: true });
    }, 450);
  }
}

/**
 * Exit about mode - fade out about text, return to previous view
 */
function exitAboutMode(aboutToggle) {
  // Remove active state
  isAboutActive = false;
  
  // Stop mouse trail effect
  stopAboutMouseTrail();
  
  // Remove active class from toggle
  aboutToggle.classList.remove('active');
  
  // Get the view to restore BEFORE removing mode-about
  const viewToRestore = previousViewBeforeAbout || 'drawer';
  
  // Check if we're already in the view we want to restore to
  // If so, we don't need to navigate - just remove mode-about and let CSS handle the fade-in
  const currentViewClass = document.body.classList.contains('view-users') ? 'users' :
                           document.body.classList.contains('view-user-albums') ? 'user-albums' :
                           document.body.classList.contains('view-index') ? 'index' : 'drawer';
  
  const needsNavigation = currentViewClass !== viewToRestore;
  
  // Remove mode-about class (this triggers CSS fade out of about content and fade in of current view)
  document.body.classList.remove('mode-about');
  
  // When staying on the same view (no navigation), restore the filter bar if we're on Gallery (drawer)
  // or Index — we closed it when entering about, so we need to open it again when exiting.
  if (!needsNavigation && (viewToRestore === 'drawer' || viewToRestore === 'index')) {
    animateFiltersWrapOpen();
  }
  
  // Only navigate if we need to switch to a different view
  if (needsNavigation) {
    // Small delay to allow about content to fade out before navigating
    setTimeout(() => {
      if (viewToRestore === 'users') {
        navigate('users');
      } else if (viewToRestore === 'user-albums') {
        // For user-albums, we need to get the username from the current URL hash or stored state
        const hash = window.location.hash;
        if (hash.startsWith('#/users/')) {
          const username = decodeURIComponent(hash.substring('#/users/'.length));
          navigate('user-albums', { username });
        } else {
          navigate('users');
        }
      } else if (viewToRestore === 'index') {
        navigate('index');
      } else {
        navigate('drawer');
      }
    }, 100);
  } else if (viewToRestore === 'user-albums') {
    // Same view (already on user-albums): restore nav title and user data without full re-render
    const hash = window.location.hash;
    if (hash.startsWith('#/users/')) {
      const username = hash.substring('#/users/'.length);
      restoreUserNav(username);
    }
  }
  // If no navigation needed for other views, CSS transitions will handle fading the content back in
}

/**
 * Close about mode when switching views via radio buttons
 */
function closeAboutModeIfActive() {
  if (isAboutActive) {
    isAboutActive = false;
    
    // Stop the mouse trail
    stopAboutMouseTrail();
    
    // Remove active class from about toggle
    const aboutToggle = document.querySelector('.about-toggle');
    if (aboutToggle) {
      aboutToggle.classList.remove('active');
    }
    
    // Remove mode-about class
    document.body.classList.remove('mode-about');
  }
}

/**
 * Start the mouse trail effect for About page
 */
async function startAboutMouseTrail() {
  // Load photos if not already cached
  if (!trailPhotos) {
    try {
      const response = await fetch('data/photos.index.json');
      const data = await response.json();
      trailPhotos = data.photos;
    } catch (error) {
      console.error('Failed to load photos for trail:', error);
      return;
    }
  }
  
  // Get container
  const container = document.getElementById('about-trail-container');
  if (!container) return;
  
  // Initialize last position
  lastTrailX = -1000;
  lastTrailY = -1000;
  
  // Create mousemove handler
  trailMouseHandler = (e) => {
    const dx = e.clientX - lastTrailX;
    const dy = e.clientY - lastTrailY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // Only create trail image if mouse moved enough distance
    if (distance >= TRAIL_SPAWN_DISTANCE) {
      createTrailImage(e.clientX, e.clientY, container);
      lastTrailX = e.clientX;
      lastTrailY = e.clientY;
    }
  };
  
  // Add listener
  document.addEventListener('mousemove', trailMouseHandler);
}

/**
 * Stop the mouse trail effect
 */
function stopAboutMouseTrail() {
  // Remove listener
  if (trailMouseHandler) {
    document.removeEventListener('mousemove', trailMouseHandler);
    trailMouseHandler = null;
  }
  
  // Clear existing trail images
  const container = document.getElementById('about-trail-container');
  if (container) {
    container.innerHTML = '';
  }
}

/**
 * Create a single trail image at the given position
 */
function createTrailImage(x, y, container) {
  if (!trailPhotos || trailPhotos.length === 0) return;
  
  // Pick random photo
  const randomIndex = Math.floor(Math.random() * trailPhotos.length);
  const photo = trailPhotos[randomIndex];
  
  // Create image element
  const img = document.createElement('img');
  img.className = 'about-trail-image';
  img.src = photo.src;
  img.alt = '';
  
  // Random size between 40-60px
  const size = 40 + Math.random() * 20;
  img.style.width = `${size}px`;
  img.style.height = `${size}px`;
  
  // Position centered on mouse with slight random offset
  const offsetX = (Math.random() - 0.5) * 20;
  const offsetY = (Math.random() - 0.5) * 20;
  img.style.left = `${x - size / 2 + offsetX}px`;
  img.style.top = `${y - size / 2 + offsetY}px`;
  
  // Set random drift direction (small movement like album photos)
  const driftX = (Math.random() - 0.5) * 12; // -6px to +6px
  const driftY = (Math.random() - 0.5) * 12;
  img.style.setProperty('--drift-x', `${driftX}px`);
  img.style.setProperty('--drift-y', `${driftY}px`);
  
  // Add to container
  container.appendChild(img);
  
  // Remove after animation completes (3.5s)
  setTimeout(() => {
    if (img.parentNode) {
      img.parentNode.removeChild(img);
    }
  }, 3600);
}

// Position dot highlights to align with button text centers and update dots row boundaries
function positionDotHighlights() {
  const nav = document.querySelector('.main-radio-nav');
  if (!nav) return;
  
  const buttons = nav.querySelectorAll('.nav-radio-button');
  const highlights = nav.querySelectorAll('.radio-dot-highlight');
  const dotsRow = document.querySelector('.radio-dots');
  
  if (buttons.length !== highlights.length || !dotsRow) return;
  
  const navRect = nav.getBoundingClientRect();
  
  // Get initial button center positions
  const initialPositions = [];
  buttons.forEach((button) => {
    const buttonRect = button.getBoundingClientRect();
    const centerX = buttonRect.left + buttonRect.width / 2 - navRect.left;
    initialPositions.push(centerX);
  });
  
  // Squares are on a 4px grid (2px square + 2px gap)
  // Snap to square centers at 1, 5, 9, 13... so the dots row gradient lines sit on the same grid
  const gridPeriod = 4;
  const gridPhase = 1; // square center is 1px into each 4px cell
  
  // Calculate aligned positions (snap each button center to nearest grid point 1 + n*4)
  const alignedPositions = [];
  buttons.forEach((button, index) => {
    const highlight = highlights[index];
    if (!highlight) return;
    
    const initialX = initialPositions[index];
    const alignedX = Math.round((initialX - gridPhase) / gridPeriod) * gridPeriod + gridPhase;
    alignedPositions.push(alignedX);
    
    const adjustment = alignedX - initialX;
    const clampedAdjustment = Math.max(-2, Math.min(2, adjustment));
    
    if (Math.abs(clampedAdjustment) > 0.1) {
      button.style.transform = `translateX(${clampedAdjustment}px)`;
    } else {
      button.style.transform = '';
    }
  });
  
  // Position highlights on the same 4px grid so squares and gradient lines share spacing
  buttons.forEach((button, index) => {
    const highlight = highlights[index];
    if (!highlight) return;
    
    // Center each highlight on the grid: segment centers are at alignedPosition + 1 (1px into each 4px cell)
    const gridCenterX = alignedPositions[index] + 1;
    highlight.style.left = `${Math.round(gridCenterX)}px`;
    highlight.style.transform = 'translateX(-50%)';
  });
  
  // Update dots row to span from Users to Albums; use integer pixels so gradient lines sit on square pixels
  if (alignedPositions.length >= 2) {
    const usersPosition = alignedPositions[0];
    const albumsPosition = alignedPositions[alignedPositions.length - 1];
    
    dotsRow.style.left = `${Math.round(usersPosition)}px`;
    dotsRow.style.width = `${Math.round(albumsPosition - usersPosition)}px`;
    dotsRow.style.transform = 'none';
  }
}

// Derive current radio from body view classes (used when no explicit radio is passed, e.g. on resize)
function getCurrentRadioFromView() {
  const body = document.body;
  if (body.classList.contains('view-users') || body.classList.contains('view-user-albums')) return 'users';
  if (body.classList.contains('view-index')) return 'albums';
  if (body.classList.contains('view-albums')) return 'albums';
  return 'drawer';
}

// Position radio marker to point to selected option
function positionRadioMarker(selectedRadio) {
  const radio = selectedRadio ?? getCurrentRadioFromView();
  const selectedButton = document.querySelector(`[data-radio="${radio}"]`);
  const markerLine = document.getElementById('radio-marker-line');
  const markerArrow = document.getElementById('radio-marker-arrow');
  const topNav = domCache.topNav;
  const centerNav = domCache.centerNav;
  
  if (!selectedButton || !markerLine || !markerArrow || !topNav || !centerNav) return;
  
  // Get button's actual center position (accounting for any transforms applied by positionDotHighlights)
  const buttonRect = selectedButton.getBoundingClientRect();
  let buttonCenterX = buttonRect.left + buttonRect.width / 2;
  // Offset: users 0 (align with text), index (albums) -2px left
  if (radio === 'albums') buttonCenterX -= 2;
  
  const topNavRect = topNav.getBoundingClientRect();
  const centerNavRect = centerNav.getBoundingClientRect();
  
  // Position vertical line in top-nav - centered on button
  markerLine.style.left = `${buttonCenterX}px`;
  markerLine.style.top = `${topNavRect.top}px`;
  // Use top-nav height, but fallback to 15px if it's 0 (shouldn't happen, but safety)
  const topNavHeight = topNavRect.height > 0 ? topNavRect.height : 15;
  markerLine.style.height = `${topNavHeight}px`;
  
  // Position arrow head attached to top of center-nav - centered on button
  markerArrow.style.left = `${buttonCenterX}px`;
  markerArrow.style.top = `${centerNavRect.top}px`; // Start at top edge, no gap
}

// Setup radio button click handlers
function setupRadioButtons() {
  const radioButtons = document.querySelectorAll('.nav-radio-button[data-radio]');
  
  radioButtons.forEach(button => {
    button.addEventListener('click', () => {
      const radioValue = button.getAttribute('data-radio');
      
      // Close about mode if active
      closeAboutModeIfActive();
      
      // Update markers (highlights first, then arrow)
      positionDotHighlights();
      positionRadioMarker(radioValue);
      // Navigate to the selected view
      if (radioValue === 'users') {
        navigate('users');
      } else if (radioValue === 'drawer') {
        navigate('drawer');
      } else if (radioValue === 'albums') {
        navigate('index');
      }
    });
  });

  // Click on "Remains" logo navigates to gallery (drawer)
  const remainsLogo = document.getElementById('remainsLogo');
  if (remainsLogo) {
    remainsLogo.addEventListener('click', () => {
      closeAboutModeIfActive();
      positionDotHighlights();
      positionRadioMarker('drawer');
      navigate('drawer');
    });
  }
}

// Initialize pixel loader bar (called before init so bar is visible when loader shows)
function fillLoaderPixels() {
  initPixelLoader('#pixel-loader');
}

// Generate pixel-fill grid for filter navigation and loader bar
function generatePixelFills() {
  const pixelFills = document.querySelectorAll('#filters-nav .pixel-fill');
  
  pixelFills.forEach(pixelFill => {
    // Measure available width (use offsetWidth for more reliable measurement)
    const available = pixelFill.offsetWidth || pixelFill.clientWidth;
    
    if (available <= 0) return; // Skip if not yet laid out
    
    // Each column width = 2px square + 2px gap = 4px
    const columnWidth = 4;
    const columnsCount = Math.floor(available / columnWidth);
    
    if (columnsCount <= 0) return; // Skip if no room for columns
    
    // Clear existing content
    pixelFill.innerHTML = '';
    
    // Create columns with 3 squares each
    for (let i = 0; i < columnsCount; i++) {
      const column = document.createElement('div');
      column.className = 'pixel-column';
      
      // Add 3 pixel squares to the column
      for (let j = 0; j < 3; j++) {
        const pixel = document.createElement('div');
        pixel.className = 'pixel';
        column.appendChild(pixel);
      }
      
      pixelFill.appendChild(column);
    }
  });

}

// Debounced resize handler for pixel fills
let resizeTimeout;
function handleResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    generatePixelFills();
    updateMarkers();
  }, 100);
}

const CATEGORY_TO_OPTIONS_ID = {
  location: 'location-filter-options',
  tags: 'keywords-filter-options',
  date: 'date-filter-options'
};

/** Return display label of selected filter for a category, or null if none. */
function getSelectedFilterLabel(category) {
  const optionsId = CATEGORY_TO_OPTIONS_ID[category];
  if (!optionsId) return null;
  const sel = document.querySelector(`#${optionsId} .filter-option.is-selected .word`);
  return sel ? sel.textContent.trim() : null;
}

/** Apply collapsed state: when panel is closed, replace category title with selected filter name and hide pixel-fill. */
function applyFiltersBarCollapsedState() {
  const wrap = domCache.filtersWrap;
  if (!wrap) return;
  const cells = wrap.querySelectorAll('#filters-nav .filter-cell');
  cells.forEach((cell) => {
    const category = cell.dataset.filterCategory;
    const defaultLabel = cell.dataset.categoryLabel || '';
    const labelEl = cell.querySelector('.filter-label');
    const selected = getSelectedFilterLabel(category);
    if (selected && labelEl) {
      labelEl.textContent = selected;
      cell.classList.add('filter-cell--collapsed', 'filter-cell--marked');
    } else {
      labelEl.textContent = defaultLabel;
      cell.classList.remove('filter-cell--collapsed', 'filter-cell--marked');
    }
  });
}

/** Apply expanded state: when panel is open, restore category titles and show pixel-fill. */
function applyFiltersBarExpandedState() {
  const wrap = domCache.filtersWrap;
  if (!wrap) return;
  const cells = wrap.querySelectorAll('#filters-nav .filter-cell');
  cells.forEach((cell) => {
    const defaultLabel = cell.dataset.categoryLabel || '';
    const labelEl = cell.querySelector('.filter-label');
    if (labelEl) labelEl.textContent = defaultLabel;
    cell.classList.remove('filter-cell--collapsed', 'filter-cell--marked');
  });
}

/** Clear filter for a single category (used by panel × on selected row). */
function clearCategoryFilter(category) {
  if (!drawerSceneInstance) return;
  const wasFilterActive = drawerSceneInstance.filtersActive();

  if (category === 'location') {
    drawerSceneInstance.activeLocations.clear();
    updateLocationFilterSelection();
    const opts = document.querySelectorAll('#location-filter-options .filter-option');
    const cont = document.getElementById('location-filter-options');
    if (cont) cont.classList.remove('has-selection');
    opts.forEach((o) => {
      o.classList.remove('is-selected');
      o.style.setProperty('visibility', 'visible', 'important');
      o.style.setProperty('opacity', '1', 'important');
    });
  } else if (category === 'date') {
    drawerSceneInstance.activeYears.clear();
    updateDateFilterSelection();
    const opts = document.querySelectorAll('#date-filter-options .filter-option');
    const cont = document.getElementById('date-filter-options');
    if (cont) cont.classList.remove('has-selection');
    opts.forEach((o) => {
      o.classList.remove('is-selected');
      o.style.setProperty('visibility', 'visible', 'important');
      o.style.setProperty('opacity', '1', 'important');
    });
  } else if (category === 'tags') {
    drawerSceneInstance.activeKeywords.clear();
    updateKeywordsFilterSelection();
    const opts = document.querySelectorAll('#keywords-filter-options .filter-option');
    const cont = document.getElementById('keywords-filter-options');
    if (cont) cont.classList.remove('has-selection');
    opts.forEach((o) => {
      o.classList.remove('is-selected');
      o.style.setProperty('visibility', 'visible', 'important');
      o.style.setProperty('opacity', '1', 'important');
    });
  }

  const isNowFilterActive = drawerSceneInstance.filtersActive();
  if (wasFilterActive && !isNowFilterActive) {
    drawerSceneInstance.focusAlphaTarget = 0;
    drawerSceneInstance.resetFocusState();
  } else if (wasFilterActive && isNowFilterActive) {
    drawerSceneInstance.shouldSyncFocusAlpha = true;
  }

  updateActiveFilterChips();
  updateCrossFilterAvailability();
  applyFiltersBarCollapsedState();
  if (drawerSceneInstance.startRenderLoop) drawerSceneInstance.startRenderLoop();
}

/** Setup mouseenter/mouseleave on filters-wrap to toggle collapsed vs expanded bar state. */
function setupFiltersPanelMouseHandlers() {
  const wrap = domCache.filtersWrap;
  if (!wrap) return;
  wrap.addEventListener('mouseenter', () => applyFiltersBarExpandedState());
  wrap.addEventListener('mouseleave', () => applyFiltersBarCollapsedState());
}

// Setup filters panel hover behavior (grayscale removed)
function setupFiltersPanel() {
  setupFiltersPanelMouseHandlers();

  const panel = document.getElementById('filters-panel');
  if (!panel) return;
  panel.addEventListener('click', (e) => {
    const clearEl = e.target.closest('.filter-option-clear');
    if (!clearEl) return;
    e.preventDefault();
    e.stopPropagation();
    const option = clearEl.closest('.filter-option');
    const cat = option?.dataset.filterCategory;
    if (!cat) return;
    const wordSpan = option.querySelector('.word');
    if (!wordSpan) {
      clearCategoryFilter(cat);
      return;
    }
    let hasCommitted = false;
    const commitPending = () => {
      if (hasCommitted) return;
      hasCommitted = true;
      clearCategoryFilter(cat);
    };
    wordSpan.classList.remove('blink-twice');
    void wordSpan.offsetWidth;
    wordSpan.classList.add('blink-twice');
    const animationDurationMs = 500;
    wordSpan.addEventListener('animationend', (ev) => {
      if (ev.target !== wordSpan || ev.animationName !== 'blinkTwice') return;
      wordSpan.classList.remove('blink-twice');
      commitPending();
    }, { once: true });
    setTimeout(() => {
      wordSpan.classList.remove('blink-twice');
      commitPending();
    }, animationDurationMs + 50);
  });
}

// US States list (full names and common abbreviations)
const US_STATES = {
  'alabama': 'Alabama', 'al': 'Alabama',
  'alaska': 'Alaska', 'ak': 'Alaska',
  'arizona': 'Arizona', 'az': 'Arizona',
  'arkansas': 'Arkansas', 'ar': 'Arkansas',
  'california': 'California', 'ca': 'California',
  'colorado': 'Colorado', 'co': 'Colorado',
  'connecticut': 'Connecticut', 'ct': 'Connecticut',
  'delaware': 'Delaware', 'de': 'Delaware',
  'florida': 'Florida', 'fl': 'Florida',
  'georgia': 'Georgia', 'ga': 'Georgia',
  'hawaii': 'Hawaii', 'hi': 'Hawaii',
  'idaho': 'Idaho', 'id': 'Idaho',
  'illinois': 'Illinois', 'il': 'Illinois',
  'indiana': 'Indiana', 'in': 'Indiana',
  'iowa': 'Iowa', 'ia': 'Iowa',
  'kansas': 'Kansas', 'ks': 'Kansas',
  'kentucky': 'Kentucky', 'ky': 'Kentucky',
  'louisiana': 'Louisiana', 'la': 'Louisiana',
  'maine': 'Maine', 'me': 'Maine',
  'maryland': 'Maryland', 'md': 'Maryland',
  'massachusetts': 'Massachusetts', 'ma': 'Massachusetts',
  'michigan': 'Michigan', 'mi': 'Michigan',
  'minnesota': 'Minnesota', 'mn': 'Minnesota',
  'mississippi': 'Mississippi', 'ms': 'Mississippi',
  'missouri': 'Missouri', 'mo': 'Missouri',
  'montana': 'Montana', 'mt': 'Montana',
  'nebraska': 'Nebraska', 'ne': 'Nebraska',
  'nevada': 'Nevada', 'nv': 'Nevada',
  'new hampshire': 'New Hampshire', 'nh': 'New Hampshire',
  'new jersey': 'New Jersey', 'nj': 'New Jersey',
  'new mexico': 'New Mexico', 'nm': 'New Mexico',
  'new york': 'New York', 'ny': 'New York',
  'north carolina': 'North Carolina', 'nc': 'North Carolina',
  'north dakota': 'North Dakota', 'nd': 'North Dakota',
  'ohio': 'Ohio', 'oh': 'Ohio',
  'oklahoma': 'Oklahoma', 'ok': 'Oklahoma',
  'oregon': 'Oregon', 'or': 'Oregon',
  'pennsylvania': 'Pennsylvania', 'pa': 'Pennsylvania',
  'rhode island': 'Rhode Island', 'ri': 'Rhode Island',
  'south carolina': 'South Carolina', 'sc': 'South Carolina',
  'south dakota': 'South Dakota', 'sd': 'South Dakota',
  'tennessee': 'Tennessee', 'tn': 'Tennessee',
  'texas': 'Texas', 'tx': 'Texas',
  'utah': 'Utah', 'ut': 'Utah',
  'vermont': 'Vermont', 'vt': 'Vermont',
  'virginia': 'Virginia', 'va': 'Virginia',
  'washington': 'Washington', 'wa': 'Washington',
  'west virginia': 'West Virginia', 'wv': 'West Virginia',
  'wisconsin': 'Wisconsin', 'wi': 'Wisconsin',
  'wyoming': 'Wyoming', 'wy': 'Wyoming',
  'district of columbia': 'District of Columbia', 'dc': 'District of Columbia'
};

// Common countries list
const COUNTRIES = {
  'afghanistan': 'Afghanistan', 'af': 'Afghanistan',
  'albania': 'Albania', 'al': 'Albania',
  'algeria': 'Algeria', 'dz': 'Algeria',
  'argentina': 'Argentina', 'ar': 'Argentina',
  'australia': 'Australia', 'au': 'Australia',
  'austria': 'Austria', 'at': 'Austria',
  'bangladesh': 'Bangladesh', 'bd': 'Bangladesh',
  'belgium': 'Belgium', 'be': 'Belgium',
  'brazil': 'Brazil', 'br': 'Brazil',
  'bulgaria': 'Bulgaria', 'bg': 'Bulgaria',
  'canada': 'Canada', 'ca': 'Canada',
  'chile': 'Chile', 'cl': 'Chile',
  'china': 'China', 'cn': 'China',
  'colombia': 'Colombia', 'co': 'Colombia',
  'croatia': 'Croatia', 'hr': 'Croatia',
  'czech republic': 'Czech Republic', 'cz': 'Czech Republic',
  'denmark': 'Denmark', 'dk': 'Denmark',
  'egypt': 'Egypt', 'eg': 'Egypt',
  'finland': 'Finland', 'fi': 'Finland',
  'france': 'France', 'fr': 'France',
  'germany': 'Germany', 'de': 'Germany',
  'greece': 'Greece', 'gr': 'Greece',
  'hungary': 'Hungary', 'hu': 'Hungary',
  'iceland': 'Iceland', 'is': 'Iceland',
  'india': 'India', 'in': 'India',
  'indonesia': 'Indonesia', 'id': 'Indonesia',
  'iran': 'Iran', 'ir': 'Iran',
  'iraq': 'Iraq', 'iq': 'Iraq',
  'ireland': 'Ireland', 'ie': 'Ireland',
  'israel': 'Israel', 'il': 'Israel',
  'italy': 'Italy', 'it': 'Italy',
  'japan': 'Japan', 'jp': 'Japan',
  'kenya': 'Kenya', 'ke': 'Kenya',
  'mexico': 'Mexico', 'mx': 'Mexico',
  'morocco': 'Morocco', 'ma': 'Morocco',
  'netherlands': 'Netherlands', 'nl': 'Netherlands',
  'new zealand': 'New Zealand', 'nz': 'New Zealand',
  'nigeria': 'Nigeria', 'ng': 'Nigeria',
  'norway': 'Norway', 'no': 'Norway',
  'pakistan': 'Pakistan', 'pk': 'Pakistan',
  'peru': 'Peru', 'pe': 'Peru',
  'philippines': 'Philippines', 'ph': 'Philippines',
  'poland': 'Poland', 'pl': 'Poland',
  'portugal': 'Portugal', 'pt': 'Portugal',
  'romania': 'Romania', 'ro': 'Romania',
  'russia': 'Russia', 'ru': 'Russia',
  'saudi arabia': 'Saudi Arabia', 'sa': 'Saudi Arabia',
  'singapore': 'Singapore', 'sg': 'Singapore',
  'south africa': 'South Africa', 'za': 'South Africa',
  'south korea': 'South Korea', 'kr': 'South Korea',
  'spain': 'Spain', 'es': 'Spain',
  'sweden': 'Sweden', 'se': 'Sweden',
  'switzerland': 'Switzerland', 'ch': 'Switzerland',
  'thailand': 'Thailand', 'th': 'Thailand',
  'turkey': 'Turkey', 'tr': 'Turkey',
  'ukraine': 'Ukraine', 'ua': 'Ukraine',
  'united kingdom': 'United Kingdom', 'uk': 'United Kingdom', 'gb': 'United Kingdom',
  'vietnam': 'Vietnam', 'vn': 'Vietnam'
};

// Location mapping cache (loaded from JSON)
let locationMap = null;

// Location map is no longer used - filtering now uses location.audit.json directly
// async function loadLocationMap() { ... } // Removed - no longer needed

// Map tag to geo label (country or US state)
function mapTagToGeoLabel(tag) {
  if (!tag) return null;
  
  const normalized = tag.toLowerCase().trim();
  
  // Skip generic USA tags
  if (normalized === 'usa' || normalized === 'united states' || normalized === 'us') {
    return null;
  }
  
  // Check US states first
  if (US_STATES[normalized]) {
    return US_STATES[normalized];
  }
  
  // Check countries
  if (COUNTRIES[normalized]) {
    return COUNTRIES[normalized];
  }
  
  // Check location map
  if (locationMap && locationMap[normalized]) {
    return locationMap[normalized];
  }
  
  return null;
}

// Setup Location filter UI using location.audit.json
async function setupLocationFilter() {
  if (!drawerSceneInstance || !drawerSceneInstance.photos) {
    console.warn('DrawerScene not ready for filter setup');
    return;
  }
  
  const optionsContainer = document.getElementById('location-filter-options');
  if (!optionsContainer) return;
  
  // Load location audit data
  let auditData = null;
  try {
    const response = await fetch('data/location.audit.json');
    if (!response.ok) {
      console.warn('Could not load location.audit.json');
      return;
    }
    auditData = await response.json();
  } catch (error) {
    console.warn('Error loading location.audit.json:', error);
    return;
  }
  
  // Build locationToPhotoIds Map and allLocatedPhotoIds Set
  const locationToPhotoIds = new Map(); // Map<label, Set<photoId>>
  const allLocatedPhotoIds = new Set(); // Set<photoId>
  
  if (auditData.locations && Array.isArray(auditData.locations)) {
    for (const location of auditData.locations) {
      const label = location.label;
      const photoIds = new Set();
      
      if (location.photos && Array.isArray(location.photos)) {
        for (const photo of location.photos) {
          if (photo.id) {
            photoIds.add(photo.id);
            allLocatedPhotoIds.add(photo.id);
          }
        }
      }
      
      locationToPhotoIds.set(label, photoIds);
    }
  }
  
  // Store Maps/Sets in DrawerScene for filtering
  drawerSceneInstance.locationToPhotoIds = locationToPhotoIds;
  drawerSceneInstance.allLocatedPhotoIds = allLocatedPhotoIds;
  
  // Build all photo IDs set for Unknown calculation
  const allPhotoIds = new Set(drawerSceneInstance.photos.map(p => p.id));
  
  // Helper function to clean label for display
  function getDisplayLabel(label) {
    // Strip "US State: " prefix
    if (label.startsWith('US State: ')) {
      return label.substring('US State: '.length);
    }
    return label;
  }
  
  // Prepare location entries with display labels for sorting
  const locationEntries = Array.from(locationToPhotoIds.entries()).map(([label, photoIds]) => ({
    label,
    displayLabel: getDisplayLabel(label),
    photoCount: photoIds.size,
  }));
  
  // Exclude "United States" from UI (but keep in data structure)
  const filteredLocationEntries = locationEntries.filter(entry => entry.label !== 'United States');
  
  // Sort alphabetically by display label (A → Z)
  filteredLocationEntries.sort((a, b) => {
    return a.displayLabel.localeCompare(b.displayLabel, 'en', { sensitivity: 'base' });
  });
  
  // Clear container
  optionsContainer.innerHTML = '';
  
  // Add location buttons
  for (const entry of filteredLocationEntries) {
    const label = entry.label;
    const displayLabel = entry.displayLabel;
    
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'filter-option';
    option.dataset.geoLabel = label;
    option.dataset.filterCategory = 'location';
    
    const wordSpan = document.createElement('span');
    wordSpan.className = 'word';
    wordSpan.textContent = displayLabel;
    option.appendChild(wordSpan);
    
    const clearSpan = document.createElement('span');
    clearSpan.className = 'filter-option-clear';
    clearSpan.setAttribute('aria-label', 'Clear location filter');
    clearSpan.textContent = 'X';
    option.appendChild(clearSpan);
    
    option.addEventListener('click', (e) => {
      if (e.target.closest('.filter-option-clear')) return;
      handleLocationFilterClick(option, label);
    });
    
    optionsContainer.appendChild(option);
  }
  
  // Add "Unknown" button
  const unknownPhotoIds = new Set();
  for (const photoId of allPhotoIds) {
    if (!allLocatedPhotoIds.has(photoId)) {
      unknownPhotoIds.add(photoId);
    }
  }
  
  if (unknownPhotoIds.size > 0) {
    const unknownOption = document.createElement('button');
    unknownOption.type = 'button';
    unknownOption.className = 'filter-option';
    unknownOption.dataset.geoLabel = 'Unknown';
    unknownOption.dataset.filterCategory = 'location';
    
    const wordSpan = document.createElement('span');
    wordSpan.className = 'word';
    wordSpan.textContent = 'Unknown';
    unknownOption.appendChild(wordSpan);
    
    const clearSpan = document.createElement('span');
    clearSpan.className = 'filter-option-clear';
    clearSpan.setAttribute('aria-label', 'Clear location filter');
    clearSpan.textContent = 'X';
    unknownOption.appendChild(clearSpan);
    
    unknownOption.addEventListener('click', (e) => {
      if (e.target.closest('.filter-option-clear')) return;
      handleLocationFilterClick(unknownOption, 'Unknown');
    });
    
    optionsContainer.appendChild(unknownOption);
    
    // Store Unknown photo IDs in DrawerScene
    drawerSceneInstance.unknownPhotoIds = unknownPhotoIds;
  }
  
  // Update selection state
  updateLocationFilterSelection();
}

// Handle location filter click with mechanical blink animation
function handleLocationFilterClick(optionElement, geoLabel) {
  if (!drawerSceneInstance) return;
  
  const optionsContainer = document.getElementById('location-filter-options');
  const wordSpan = optionElement.querySelector('.word');
  
  if (!wordSpan) {
    // Safety: if word span not found, apply immediately
    const isCurrentlySelected = drawerSceneInstance.activeLocations.has(geoLabel);
    if (isCurrentlySelected) {
      drawerSceneInstance.activeLocations.delete(geoLabel);
    } else {
      // Clear previous selection (only one filter per category)
      drawerSceneInstance.activeLocations.clear();
      drawerSceneInstance.activeLocations.add(geoLabel);
    }
    updateLocationFilterSelection();
    // Update UI with opacity
    const optionsContainer = document.getElementById('location-filter-options');
    if (optionsContainer) {
      const allOptions = document.querySelectorAll('#location-filter-options .filter-option');
      if (drawerSceneInstance.activeLocations.size > 0) {
        allOptions.forEach(option => {
          const label = option.dataset.geoLabel;
          if (drawerSceneInstance.activeLocations.has(label)) {
            option.style.setProperty('opacity', '1', 'important');
          } else {
            option.style.setProperty('opacity', '0.5', 'important');
          }
        });
      } else {
        allOptions.forEach(option => {
          option.style.setProperty('opacity', '1', 'important');
        });
      }
    }
    updateCrossFilterAvailability();
    return;
  }
  
  const isCurrentlySelected = drawerSceneInstance.activeLocations.has(geoLabel);
  
  // Ensure word span is visible for animation (especially when deselecting)
  // Make sure the option and word span are visible before animating
  if (isCurrentlySelected) {
    // When deselecting, ensure option is visible
    optionElement.style.visibility = 'visible';
    wordSpan.style.visibility = 'visible';
  }
  
  // Commit function (MUST run exactly once after blink)
  let hasCommitted = false;
  const commitPending = () => {
    if (hasCommitted) return;
    hasCommitted = true;
    
    const wasFilterActive = drawerSceneInstance.filtersActive();
    
    // Single selection per category: if present → remove, if absent → clear previous and add new
    if (isCurrentlySelected) {
      drawerSceneInstance.activeLocations.delete(geoLabel);
      optionElement.classList.remove('is-selected');
    } else {
      drawerSceneInstance.activeLocations.clear();
      drawerSceneInstance.activeLocations.add(geoLabel);
      optionElement.classList.add('is-selected');
    }
    
    // Handle focus behavior
    const isNowFilterActive = drawerSceneInstance.filtersActive();
    
    if (!wasFilterActive && isNowFilterActive) {
      // Transitioning from no filter → filter: capture baseline
      drawerSceneInstance.captureFocusBaseZoom();
    } else if (wasFilterActive && isNowFilterActive) {
      // Switching filters while already active: sync alpha after layout recomputes
      drawerSceneInstance.shouldSyncFocusAlpha = true;
    } else if (wasFilterActive && !isNowFilterActive) {
      // All filters cleared: reset focus
      drawerSceneInstance.focusAlphaTarget = 0;
      drawerSceneInstance.resetFocusState();
    }
    
    // Update UI - show non-selected options with 50% opacity, selected with 100%
    const optionsContainer = document.getElementById('location-filter-options');
    if (optionsContainer) {
      const allOptions = document.querySelectorAll('#location-filter-options .filter-option');
      
      if (drawerSceneInstance.activeLocations.size > 0) {
        optionsContainer.classList.add('has-selection');
        
        // First remove is-selected from ALL options
        allOptions.forEach(option => {
          option.classList.remove('is-selected');
        });
        
        // Then add is-selected only to options in the Set and set opacity
        allOptions.forEach(option => {
          const geoLabel = option.dataset.geoLabel;
          const isInSet = drawerSceneInstance.activeLocations.has(geoLabel);
          if (isInSet) {
            option.classList.add('is-selected');
            // Selected: full opacity
            option.style.setProperty('visibility', 'visible', 'important');
            option.style.setProperty('opacity', '1', 'important');
            option.style.pointerEvents = 'auto';
          } else {
            // Not selected: 50% opacity (visible but dimmed)
            option.classList.remove('is-selected');
            option.style.setProperty('visibility', 'visible', 'important');
            option.style.setProperty('opacity', '0.5', 'important');
            option.style.pointerEvents = 'auto';
          }
        });
      } else {
        optionsContainer.classList.remove('has-selection');
        // Show all options with full opacity
        allOptions.forEach(option => {
          option.classList.remove('is-selected');
          option.style.setProperty('visibility', 'visible', 'important');
          option.style.setProperty('opacity', '1', 'important');
          option.style.pointerEvents = 'auto';
        });
      }
    }
    updateActiveFilterChips();
    
    // Update cross-filter availability (show unavailable filters in other categories)
    updateCrossFilterAvailability();
    
    // Force render
    if (drawerSceneInstance.startRenderLoop) {
      drawerSceneInstance.startRenderLoop();
    }
  };
  
  // Trigger blink animation on the selection highlight (word span)
  // Remove any existing blink class first
  wordSpan.classList.remove('blink-twice');
  // Force reflow to ensure class removal is processed
  void wordSpan.offsetWidth;
  // Add blink class to start animation
  wordSpan.classList.add('blink-twice');
  
  // Animation duration: 500ms (0.5s from CSS)
  const animationDurationMs = 500;
  
  // Listen for animation end event
  const handleAnimationEnd = (event) => {
    if (event.target !== wordSpan) return;
    if (event.animationName === 'blinkTwice') {
      wordSpan.classList.remove('blink-twice');
      commitPending();
    }
  };
  
  wordSpan.addEventListener('animationend', handleAnimationEnd, { once: true });
  
  // Fallback timer: ensure commit happens even if animationend fails
  setTimeout(() => {
    wordSpan.classList.remove('blink-twice');
    commitPending();
  }, animationDurationMs + 50);
}

// Update selected state of location filter options
function updateLocationFilterSelection() {
  if (!drawerSceneInstance) return;
  
  const optionsContainer = document.getElementById('location-filter-options');
  const options = document.querySelectorAll('#location-filter-options .filter-option');
  
  // First, remove is-selected from ALL options
  options.forEach(option => {
    option.classList.remove('is-selected');
  });
  
  // Then, add is-selected only to options in the Set
  options.forEach(option => {
    const geoLabel = option.dataset.geoLabel;
    if (drawerSceneInstance.activeLocations.has(geoLabel)) {
      option.classList.add('is-selected');
    }
  });
}

// Clear all filters and restore everything (robust reset)
function clearFilter() {
  if (!drawerSceneInstance) return;
  
  // Force render by ensuring filter change is detected BEFORE clearing Sets
  // Set lastFilterActive to true BEFORE clearing, so the change from true->false is detected
  const wasFilterActive = drawerSceneInstance.filtersActive();
  if (wasFilterActive) {
    drawerSceneInstance.lastFilterActive = true; // Set to true so change is detected
  }
  drawerSceneInstance.lastFilterSizes = null;
  
  // Reset filter state (clear all Sets)
  drawerSceneInstance.activeLocations.clear();
  drawerSceneInstance.activeYears.clear();
  drawerSceneInstance.activeKeywords.clear();
  
  // Reset focus state - smoothly return to unfocused state
  drawerSceneInstance.focusAlphaTarget = 0;
  // Allow focusAlpha to smoothly return to 0 (don't reset immediately)
  drawerSceneInstance.resetFocusState(); // This also clears focusPos (hasFocusData = false, focusPositions = null)
  
  // Force a render by setting focusVel AFTER resetFocusState (ensures early exit doesn't skip)
  // This is necessary because when filters are cleared, there's no animation, so early exit would skip rendering
  // Set a velocity that will decay naturally, ensuring at least one render frame runs
  drawerSceneInstance.focusVel = 0.01; // Small but non-zero velocity
  
  // Reset release animation state
  drawerSceneInstance.isReleasingFilters = false;
  drawerSceneInstance.clearLocationAfterRelease = false;
  drawerSceneInstance.clearYearAfterRelease = false;
  drawerSceneInstance.clearKeywordAfterRelease = false;
  
  // Restore everything (showAllPhotos and showAllTags - handled by clearing Sets)
  // Photos are automatically shown when all Sets are empty
  // Tags are restored via resetLocationUI and resetDateUI
  
  // UI reset - remove .active class (we use .is-selected, but also check for .active)
  document.querySelectorAll('[data-filter-id].active, .filter-option.active').forEach(el => {
    el.classList.remove('active');
  });
  
  // Reset UI for all filters (removes .is-selected and restores tag visibility)
  resetLocationUI();
  resetDateUI();
  resetKeywordsUI();
  
  // Update cross-filter availability (resets all to available since no filters active)
  updateCrossFilterAvailability();
  
  // Restore filter bar: category labels and pixel-fill (collapsed state with no selection)
  applyFiltersBarCollapsedState();
  
  // Render (force re-render to show all photos)
  if (drawerSceneInstance.startRenderLoop) {
    drawerSceneInstance.startRenderLoop();
  }
}

// Reset location filter UI to default state (show all options)
function resetLocationUI() {
  const optionsContainer = document.getElementById('location-filter-options');
  if (!optionsContainer) return;
  
  // Remove has-selection class to show all options
  optionsContainer.classList.remove('has-selection');
  
  // Remove is-selected from all options and show all
  const options = document.querySelectorAll('#location-filter-options .filter-option');
  options.forEach(option => {
    option.classList.remove('is-selected');
    option.classList.remove('filter-unavailable');
    // Reset any inline styles that might hide options
    option.style.visibility = '';
    option.style.display = '';
    option.style.opacity = '';
    option.style.height = '';
  });
}

// Helper to update location filter visibility after selection changes
function updateLocationFilterVisibility() {
  const optionsContainer = document.getElementById('location-filter-options');
  if (!optionsContainer) return;
  
  const options = document.querySelectorAll('#location-filter-options .filter-option');
  
  if (drawerSceneInstance.activeLocations.size > 0) {
    optionsContainer.classList.add('has-selection');
    // Set opacity: selected = 100%, non-selected = 50%
    options.forEach(option => {
      const geoLabel = option.dataset.geoLabel;
      if (drawerSceneInstance.activeLocations.has(geoLabel)) {
        option.style.setProperty('opacity', '1', 'important');
        option.style.setProperty('visibility', 'visible', 'important');
      } else {
        option.style.setProperty('opacity', '0.5', 'important');
        option.style.setProperty('visibility', 'visible', 'important');
      }
    });
  } else {
    optionsContainer.classList.remove('has-selection');
    // Show all options with full opacity
    options.forEach(option => {
      option.style.setProperty('opacity', '1', 'important');
      option.style.setProperty('visibility', 'visible', 'important');
    });
  }
}

// Update active filter chips display
function updateActiveFilterChips() {
  // TODO: Implement chip UI
  // This will show active filters as chips with remove buttons
}

/**
 * Compute which filters in OTHER categories are available based on current selection.
 * A filter is "available" if there are photos that pass the current selection AND also
 * belong to that filter option.
 * 
 * Returns: { 
 *   locations: Set<label> or null (null = all available, Set = only these are available),
 *   years: Set<year> or null,
 *   keywords: Set<keyword> or null
 * }
 */
function computeAvailableFilters() {
  if (!drawerSceneInstance) return { locations: null, years: null, keywords: null };
  
  const activeLocations = drawerSceneInstance.activeLocations;
  const activeYears = drawerSceneInstance.activeYears;
  const activeKeywords = drawerSceneInstance.activeKeywords;
  
  // If no filters are active, all options are available
  if (activeLocations.size === 0 && activeYears.size === 0 && activeKeywords.size === 0) {
    return { locations: null, years: null, keywords: null };
  }
  
  const locationToPhotoIds = drawerSceneInstance.locationToPhotoIds;
  const yearToPhotoIds = drawerSceneInstance.yearToPhotoIds;
  const keywordToPhotoIds = drawerSceneInstance.keywordToPhotoIds;
  const unknownPhotoIds = drawerSceneInstance.unknownPhotoIds;
  const unknownYearIds = drawerSceneInstance.unknownYearIds;
  const unknownKeywordIds = drawerSceneInstance.unknownKeywordIds;
  
  // Helper: get photo IDs that match a filter category
  const getMatchingPhotoIds = (activeSet, indexMap, unknownSet) => {
    if (activeSet.size === 0) return null; // No filter = all pass
    
    const matchingIds = new Set();
    for (const value of activeSet) {
      if (value === 'Unknown') {
        if (unknownSet) {
          for (const id of unknownSet) matchingIds.add(id);
        }
      } else if (indexMap && indexMap.has(value)) {
        for (const id of indexMap.get(value)) matchingIds.add(id);
      }
    }
    return matchingIds;
  };
  
  // Helper: intersect sets (null means "all")
  const intersectSets = (...sets) => {
    const nonNullSets = sets.filter(s => s !== null);
    if (nonNullSets.length === 0) return null;
    if (nonNullSets.length === 1) return nonNullSets[0];
    
    let result = new Set(nonNullSets[0]);
    for (let i = 1; i < nonNullSets.length; i++) {
      const next = nonNullSets[i];
      result = new Set([...result].filter(x => next.has(x)));
    }
    return result;
  };
  
  // Get photo IDs matching each category
  const locationMatchingIds = getMatchingPhotoIds(activeLocations, locationToPhotoIds, unknownPhotoIds);
  const yearMatchingIds = getMatchingPhotoIds(activeYears, yearToPhotoIds, unknownYearIds);
  const keywordMatchingIds = getMatchingPhotoIds(activeKeywords, keywordToPhotoIds, unknownKeywordIds);
  
  // For each category, compute available options based on OTHER categories
  // A filter option is available if its photo IDs intersect with photos passing other filters
  
  // Available locations: photos that pass year AND keyword filters
  let availableLocations = null;
  if (activeYears.size > 0 || activeKeywords.size > 0) {
    const baseSet = intersectSets(yearMatchingIds, keywordMatchingIds);
    if (baseSet !== null && baseSet.size > 0) {
      availableLocations = new Set();
      // Check each location option
      if (locationToPhotoIds) {
        for (const [label, photoIds] of locationToPhotoIds) {
          for (const id of photoIds) {
            if (baseSet.has(id)) {
              availableLocations.add(label);
              break;
            }
          }
        }
      }
      // Check Unknown
      if (unknownPhotoIds) {
        for (const id of unknownPhotoIds) {
          if (baseSet.has(id)) {
            availableLocations.add('Unknown');
            break;
          }
        }
      }
    } else if (baseSet !== null && baseSet.size === 0) {
      // No photos pass the other filters, so no locations are available
      availableLocations = new Set();
    }
  }
  
  // Available years: photos that pass location AND keyword filters
  let availableYears = null;
  if (activeLocations.size > 0 || activeKeywords.size > 0) {
    const baseSet = intersectSets(locationMatchingIds, keywordMatchingIds);
    if (baseSet !== null && baseSet.size > 0) {
      availableYears = new Set();
      if (yearToPhotoIds) {
        for (const [year, photoIds] of yearToPhotoIds) {
          for (const id of photoIds) {
            if (baseSet.has(id)) {
              availableYears.add(year);
              break;
            }
          }
        }
      }
    } else if (baseSet !== null && baseSet.size === 0) {
      availableYears = new Set();
    }
  }
  
  // Available keywords: photos that pass location AND year filters
  let availableKeywords = null;
  if (activeLocations.size > 0 || activeYears.size > 0) {
    const baseSet = intersectSets(locationMatchingIds, yearMatchingIds);
    if (baseSet !== null && baseSet.size > 0) {
      availableKeywords = new Set();
      if (keywordToPhotoIds) {
        for (const [keyword, photoIds] of keywordToPhotoIds) {
          for (const id of photoIds) {
            if (baseSet.has(id)) {
              availableKeywords.add(keyword);
              break;
            }
          }
        }
      }
    } else if (baseSet !== null && baseSet.size === 0) {
      availableKeywords = new Set();
    }
  }
  
  return { locations: availableLocations, years: availableYears, keywords: availableKeywords };
}

/**
 * Update the UI to show which filters in other categories are available.
 * Filters that have no overlap with current selection are shown as "disabled" (lower opacity).
 */
function updateCrossFilterAvailability() {
  if (!drawerSceneInstance) return;
  
  const { locations: availableLocations, years: availableYears, keywords: availableKeywords } = computeAvailableFilters();
  
  // Update location filter options
  const locationOptions = document.querySelectorAll('#location-filter-options .filter-option');
  const hasLocationFilter = drawerSceneInstance.activeLocations.size > 0;
  
  locationOptions.forEach(option => {
    const label = option.dataset.geoLabel;
    const isSelected = drawerSceneInstance.activeLocations.has(label);
    
    if (hasLocationFilter) {
      // When this category has a selection, use normal selected/unselected styling
      if (isSelected) {
        option.style.setProperty('opacity', '1', 'important');
        option.classList.remove('filter-unavailable');
      } else {
        option.style.setProperty('opacity', '0.5', 'important');
        option.classList.remove('filter-unavailable');
      }
    } else if (availableLocations !== null) {
      // When other categories have selections, show availability
      if (availableLocations.has(label)) {
        option.style.setProperty('opacity', '1', 'important');
        option.classList.remove('filter-unavailable');
      } else {
        option.style.setProperty('opacity', '0.25', 'important');
        option.classList.add('filter-unavailable');
      }
    } else {
      // No filters active, all available
      option.style.setProperty('opacity', '1', 'important');
      option.classList.remove('filter-unavailable');
    }
  });
  
  // Update date filter options
  const dateOptions = document.querySelectorAll('#date-filter-options .filter-option');
  const hasDateFilter = drawerSceneInstance.activeYears.size > 0;
  
  dateOptions.forEach(option => {
    const label = option.dataset.yearLabel;
    const isSelected = drawerSceneInstance.activeYears.has(label);
    
    if (hasDateFilter) {
      if (isSelected) {
        option.style.setProperty('opacity', '1', 'important');
        option.classList.remove('filter-unavailable');
      } else {
        option.style.setProperty('opacity', '0.5', 'important');
        option.classList.remove('filter-unavailable');
      }
    } else if (availableYears !== null) {
      if (availableYears.has(label)) {
        option.style.setProperty('opacity', '1', 'important');
        option.classList.remove('filter-unavailable');
      } else {
        option.style.setProperty('opacity', '0.25', 'important');
        option.classList.add('filter-unavailable');
      }
    } else {
      option.style.setProperty('opacity', '1', 'important');
      option.classList.remove('filter-unavailable');
    }
  });
  
  // Update keywords filter options
  const keywordOptions = document.querySelectorAll('#keywords-filter-options .filter-option');
  const hasKeywordFilter = drawerSceneInstance.activeKeywords.size > 0;
  
  keywordOptions.forEach(option => {
    const label = option.dataset.keywordLabel;
    const isSelected = drawerSceneInstance.activeKeywords.has(label);
    
    if (hasKeywordFilter) {
      if (isSelected) {
        option.style.setProperty('opacity', '1', 'important');
        option.classList.remove('filter-unavailable');
      } else {
        option.style.setProperty('opacity', '0.5', 'important');
        option.classList.remove('filter-unavailable');
      }
    } else if (availableKeywords !== null) {
      if (availableKeywords.has(label)) {
        option.style.setProperty('opacity', '1', 'important');
        option.classList.remove('filter-unavailable');
      } else {
        option.style.setProperty('opacity', '0.25', 'important');
        option.classList.add('filter-unavailable');
      }
    } else {
      option.style.setProperty('opacity', '1', 'important');
      option.classList.remove('filter-unavailable');
    }
  });
}

// Setup Date filter UI using yearToPhotoIds from DrawerScene
async function setupDateFilter() {
  if (!drawerSceneInstance || !drawerSceneInstance.photos) {
    console.warn('DrawerScene not ready for Date filter setup');
    return;
  }
  
  const optionsContainer = document.getElementById('date-filter-options');
  if (!optionsContainer) {
    console.warn('Date filter options container not found');
    return;
  }
  
  // Get year index from DrawerScene (built during initialize)
  const yearToPhotoIds = drawerSceneInstance.yearToPhotoIds;
  const unknownYearIds = drawerSceneInstance.unknownYearIds;
  
  if (!yearToPhotoIds || !unknownYearIds) {
    console.warn('Year index not available');
    return;
  }
  
  // Prepare year entries for sorting
  const yearEntries = Array.from(yearToPhotoIds.entries()).map(([year, photoIds]) => ({
    year,
    photoCount: photoIds.size,
  }));
  
  // Sort years numerically (ascending - earliest first)
  yearEntries.sort((a, b) => {
    const yearA = parseInt(a.year, 10);
    const yearB = parseInt(b.year, 10);
    return yearA - yearB; // Ascending
  });
  
  // Clear container
  optionsContainer.innerHTML = '';
  
  // Add year buttons
  for (const entry of yearEntries) {
    const year = entry.year;
    
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'filter-option';
    option.dataset.yearLabel = year;
    option.dataset.filterCategory = 'date';
    
    const scaleMark = document.createElement('div');
    scaleMark.className = 'scale-mark';
    option.appendChild(scaleMark);
    
    const wordSpan = document.createElement('span');
    wordSpan.className = 'word';
    wordSpan.textContent = year;
    option.appendChild(wordSpan);
    
    const clearSpan = document.createElement('span');
    clearSpan.className = 'filter-option-clear';
    clearSpan.setAttribute('aria-label', 'Clear date filter');
    clearSpan.textContent = 'X';
    option.appendChild(clearSpan);
    
    option.addEventListener('click', (e) => {
      if (e.target.closest('.filter-option-clear')) return;
      handleDateFilterClick(option, year);
    });
    
    optionsContainer.appendChild(option);
  }
  
  // Update selection state
  updateDateFilterSelection();
}

// Handle date filter click with mechanical blink animation
function handleDateFilterClick(optionElement, yearLabel) {
  if (!drawerSceneInstance) return;
  
  const optionsContainer = document.getElementById('date-filter-options');
  const wordSpan = optionElement.querySelector('.word');
  
  if (!wordSpan) {
    // Safety: if word span not found, apply immediately
    const isCurrentlySelected = drawerSceneInstance.activeYears.has(yearLabel);
    if (isCurrentlySelected) {
      drawerSceneInstance.activeYears.delete(yearLabel);
    } else {
      // Clear previous selection (only one filter per category)
      drawerSceneInstance.activeYears.clear();
      drawerSceneInstance.activeYears.add(yearLabel);
    }
    updateDateFilterSelection();
    // Update UI with opacity
    const optionsContainer = document.getElementById('date-filter-options');
    if (optionsContainer) {
      const allOptions = document.querySelectorAll('#date-filter-options .filter-option');
      if (drawerSceneInstance.activeYears.size > 0) {
        allOptions.forEach(option => {
          const label = option.dataset.yearLabel;
          if (drawerSceneInstance.activeYears.has(label)) {
            option.style.setProperty('opacity', '1', 'important');
          } else {
            option.style.setProperty('opacity', '0.5', 'important');
          }
        });
      } else {
        allOptions.forEach(option => {
          option.style.setProperty('opacity', '1', 'important');
        });
      }
    }
    updateCrossFilterAvailability();
    return;
  }
  
  const isCurrentlySelected = drawerSceneInstance.activeYears.has(yearLabel);
  
  // Ensure word span is visible for animation (especially when deselecting)
  // Make sure the option and word span are visible before animating
  if (isCurrentlySelected) {
    // When deselecting, ensure option is visible
    optionElement.style.visibility = 'visible';
    wordSpan.style.visibility = 'visible';
  }
  
  // Commit function (MUST run exactly once after blink)
  let hasCommitted = false;
  const commitPending = () => {
    if (hasCommitted) return;
    hasCommitted = true;
    
    const wasFilterActive = drawerSceneInstance.filtersActive();
    
    // Single selection per category: if present → remove, if absent → clear previous and add new
    if (isCurrentlySelected) {
      drawerSceneInstance.activeYears.delete(yearLabel);
      // Update UI: remove selection
      optionElement.classList.remove('is-selected');
    } else {
      // Clear previous selection (only one filter per category)
      drawerSceneInstance.activeYears.clear();
      drawerSceneInstance.activeYears.add(yearLabel);
      // Update UI: add selection
      optionElement.classList.add('is-selected');
    }
    
    // Handle focus behavior
    const isNowFilterActive = drawerSceneInstance.filtersActive();
    
    if (!wasFilterActive && isNowFilterActive) {
      // Transitioning from no filter → filter: capture baseline
      drawerSceneInstance.captureFocusBaseZoom();
    } else if (wasFilterActive && isNowFilterActive) {
      // Switching filters while already active: sync alpha after layout recomputes
      drawerSceneInstance.shouldSyncFocusAlpha = true;
    } else if (wasFilterActive && !isNowFilterActive) {
      // All filters cleared: reset focus
      drawerSceneInstance.focusAlphaTarget = 0;
      drawerSceneInstance.resetFocusState();
    }
    
    // Update UI - show non-selected options with 50% opacity, selected with 100%
    const optionsContainer = document.getElementById('date-filter-options');
    if (optionsContainer) {
      const allOptions = document.querySelectorAll('#date-filter-options .filter-option');
      
      if (drawerSceneInstance.activeYears.size > 0) {
        optionsContainer.classList.add('has-selection');
        
        // First remove is-selected from ALL options
        allOptions.forEach(option => {
          option.classList.remove('is-selected');
        });
        
        // Then add is-selected only to options in the Set and set opacity
        allOptions.forEach(option => {
          const yearLabel = option.dataset.yearLabel;
          const isInSet = drawerSceneInstance.activeYears.has(yearLabel);
          if (isInSet) {
            option.classList.add('is-selected');
            // Selected: full opacity
            option.style.setProperty('visibility', 'visible', 'important');
            option.style.setProperty('opacity', '1', 'important');
            option.style.pointerEvents = 'auto';
          } else {
            // Not selected: 50% opacity (visible but dimmed)
            option.classList.remove('is-selected');
            option.style.setProperty('visibility', 'visible', 'important');
            option.style.setProperty('opacity', '0.5', 'important');
            option.style.pointerEvents = 'auto';
          }
        });
      } else {
        optionsContainer.classList.remove('has-selection');
        // Show all options with full opacity
        allOptions.forEach(option => {
          option.classList.remove('is-selected');
          option.style.setProperty('visibility', 'visible', 'important');
          option.style.setProperty('opacity', '1', 'important');
          option.style.pointerEvents = 'auto';
        });
      }
    }
    updateActiveFilterChips();
    
    // Update cross-filter availability (show unavailable filters in other categories)
    updateCrossFilterAvailability();
    
    // Force render
    if (drawerSceneInstance.startRenderLoop) {
      drawerSceneInstance.startRenderLoop();
    }
  };
  
  // Trigger blink animation on the selection highlight (word span)
  // Remove any existing blink class first
  wordSpan.classList.remove('blink-twice');
  // Force reflow to ensure class removal is processed
  void wordSpan.offsetWidth;
  // Add blink class to start animation
  wordSpan.classList.add('blink-twice');
  
  // Animation duration: 500ms (0.5s from CSS)
  const animationDurationMs = 500;
  
  // Listen for animation end event
  const handleAnimationEnd = (event) => {
    if (event.target !== wordSpan) return;
    if (event.animationName === 'blinkTwice') {
      wordSpan.classList.remove('blink-twice');
      commitPending();
    }
  };
  
  wordSpan.addEventListener('animationend', handleAnimationEnd, { once: true });
  
  // Fallback timer: ensure commit happens even if animationend fails
  setTimeout(() => {
    wordSpan.classList.remove('blink-twice');
    commitPending();
  }, animationDurationMs + 50);
}

// Update selected state of date filter options
function updateDateFilterSelection() {
  if (!drawerSceneInstance) return;
  
  const optionsContainer = document.getElementById('date-filter-options');
  const options = document.querySelectorAll('#date-filter-options .filter-option');
  
  // First, remove is-selected from ALL options
  options.forEach(option => {
    option.classList.remove('is-selected');
  });
  
  // Then, add is-selected only to options in the Set
  options.forEach(option => {
    const yearLabel = option.dataset.yearLabel;
    if (drawerSceneInstance.activeYears.has(yearLabel)) {
      option.classList.add('is-selected');
    }
  });
}

// Reset date filter UI to default state (show all options)
function resetDateUI() {
  const optionsContainer = document.getElementById('date-filter-options');
  if (!optionsContainer) return;
  
  // Remove has-selection class to show all options
  optionsContainer.classList.remove('has-selection');
  
  // Remove is-selected from all options
  const options = document.querySelectorAll('#date-filter-options .filter-option');
  options.forEach(option => {
    option.classList.remove('is-selected');
    option.classList.remove('filter-unavailable');
    // Reset any inline styles that might hide options
    option.style.visibility = '';
    option.style.display = '';
    option.style.opacity = '';
    option.style.height = '';
  });
}

// Setup Keywords filter UI using keywordToPhotoIds from DrawerScene
async function setupKeywordsFilter() {
  if (!drawerSceneInstance || !drawerSceneInstance.photos) {
    console.warn('DrawerScene not ready for Keywords filter setup');
    return;
  }
  
  const optionsContainer = document.getElementById('keywords-filter-options');
  if (!optionsContainer) {
    console.warn('Keywords filter options container not found');
    return;
  }
  
  // Get keyword index from DrawerScene (loaded from keywords.filters.json)
  const keywordToPhotoIds = drawerSceneInstance.keywordToPhotoIds;
  const unknownKeywordIds = drawerSceneInstance.unknownKeywordIds;
  
  if (!keywordToPhotoIds || !unknownKeywordIds) {
    console.warn('Keyword index not available');
    return;
  }
  
  // Prepare keyword entries for sorting
  const keywordEntries = Array.from(keywordToPhotoIds.entries()).map(([keyword, photoIds]) => ({
    keyword,
    photoCount: photoIds.size,
  }));
  
  // Sort keywords alphabetically (A → Z)
  keywordEntries.sort((a, b) => {
    return a.keyword.localeCompare(b.keyword, 'en', { sensitivity: 'base' });
  });
  
  // Clear container
  optionsContainer.innerHTML = '';
  
  // Add keyword buttons
  for (const entry of keywordEntries) {
    const keyword = entry.keyword;
    const displayKeyword = keyword.charAt(0).toUpperCase() + keyword.slice(1);
    
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'filter-option';
    option.dataset.keywordLabel = keyword;
    option.dataset.filterCategory = 'tags';
    
    const wordSpan = document.createElement('span');
    wordSpan.className = 'word';
    wordSpan.textContent = displayKeyword;
    option.appendChild(wordSpan);
    
    const clearSpan = document.createElement('span');
    clearSpan.className = 'filter-option-clear';
    clearSpan.setAttribute('aria-label', 'Clear tags filter');
    clearSpan.textContent = 'X';
    option.appendChild(clearSpan);
    
    option.addEventListener('click', (e) => {
      if (e.target.closest('.filter-option-clear')) return;
      handleKeywordsFilterClick(option, keyword);
    });
    
    optionsContainer.appendChild(option);
  }
  
  // Update selection state
  updateKeywordsFilterSelection();
}

// Handle keywords filter click with mechanical blink animation
function handleKeywordsFilterClick(optionElement, keywordLabel) {
  if (!drawerSceneInstance) return;
  
  const optionsContainer = document.getElementById('keywords-filter-options');
  const wordSpan = optionElement.querySelector('.word');
  
  if (!wordSpan) {
    // Safety: if word span not found, apply immediately
    const isCurrentlySelected = drawerSceneInstance.activeKeywords.has(keywordLabel);
    if (isCurrentlySelected) {
      drawerSceneInstance.activeKeywords.delete(keywordLabel);
    } else {
      // Clear previous selection (only one filter per category)
      drawerSceneInstance.activeKeywords.clear();
      drawerSceneInstance.activeKeywords.add(keywordLabel);
    }
    updateKeywordsFilterSelection();
    // Update UI with opacity
    const optionsContainer = document.getElementById('keywords-filter-options');
    if (optionsContainer) {
      const allOptions = document.querySelectorAll('#keywords-filter-options .filter-option');
      if (drawerSceneInstance.activeKeywords.size > 0) {
        allOptions.forEach(option => {
          const label = option.dataset.keywordLabel;
          if (drawerSceneInstance.activeKeywords.has(label)) {
            option.style.setProperty('opacity', '1', 'important');
          } else {
            option.style.setProperty('opacity', '0.5', 'important');
          }
        });
      } else {
        allOptions.forEach(option => {
          option.style.setProperty('opacity', '1', 'important');
        });
      }
    }
    updateCrossFilterAvailability();
    return;
  }
  
  const isCurrentlySelected = drawerSceneInstance.activeKeywords.has(keywordLabel);
  
  // Ensure word span is visible for animation (especially when deselecting)
  // Make sure the option and word span are visible before animating
  if (isCurrentlySelected) {
    // When deselecting, ensure option is visible
    optionElement.style.visibility = 'visible';
    wordSpan.style.visibility = 'visible';
  }
  
  // Commit function (MUST run exactly once after blink)
  let hasCommitted = false;
  const commitPending = () => {
    if (hasCommitted) return;
    hasCommitted = true;
    
    const wasFilterActive = drawerSceneInstance.filtersActive();
    
    // Single selection per category: if present → remove, if absent → clear previous and add new
    if (isCurrentlySelected) {
      drawerSceneInstance.activeKeywords.delete(keywordLabel);
      // Update UI: remove selection
      optionElement.classList.remove('is-selected');
    } else {
      // Clear previous selection (only one filter per category)
      drawerSceneInstance.activeKeywords.clear();
      drawerSceneInstance.activeKeywords.add(keywordLabel);
      // Update UI: add selection
      optionElement.classList.add('is-selected');
    }
    
    // Handle focus behavior
    const isNowFilterActive = drawerSceneInstance.filtersActive();
    
    if (!wasFilterActive && isNowFilterActive) {
      // Transitioning from no filter → filter: capture baseline
      drawerSceneInstance.captureFocusBaseZoom();
    } else if (wasFilterActive && isNowFilterActive) {
      // Switching filters while already active: sync alpha after layout recomputes
      drawerSceneInstance.shouldSyncFocusAlpha = true;
    } else if (wasFilterActive && !isNowFilterActive) {
      // All filters cleared: reset focus
      drawerSceneInstance.focusAlphaTarget = 0;
      drawerSceneInstance.resetFocusState();
    }
    
    // Update UI - show non-selected options with 50% opacity, selected with 100%
    const optionsContainer = document.getElementById('keywords-filter-options');
    if (optionsContainer) {
      const allOptions = document.querySelectorAll('#keywords-filter-options .filter-option');
      
      if (drawerSceneInstance.activeKeywords.size > 0) {
        optionsContainer.classList.add('has-selection');
        
        // First remove is-selected from ALL options
        allOptions.forEach(option => {
          option.classList.remove('is-selected');
        });
        
        // Then add is-selected only to options in the Set and set opacity
        allOptions.forEach(option => {
          const keywordLabel = option.dataset.keywordLabel;
          const isInSet = drawerSceneInstance.activeKeywords.has(keywordLabel);
          if (isInSet) {
            option.classList.add('is-selected');
            // Selected: full opacity
            option.style.setProperty('visibility', 'visible', 'important');
            option.style.setProperty('opacity', '1', 'important');
            option.style.pointerEvents = 'auto';
          } else {
            // Not selected: 50% opacity (visible but dimmed)
            option.classList.remove('is-selected');
            option.style.setProperty('visibility', 'visible', 'important');
            option.style.setProperty('opacity', '0.5', 'important');
            option.style.pointerEvents = 'auto';
          }
        });
      } else {
        optionsContainer.classList.remove('has-selection');
        // Show all options with full opacity
        allOptions.forEach(option => {
          option.classList.remove('is-selected');
          option.style.setProperty('visibility', 'visible', 'important');
          option.style.setProperty('opacity', '1', 'important');
          option.style.pointerEvents = 'auto';
        });
      }
    }
    updateActiveFilterChips();
    
    // Update cross-filter availability (show unavailable filters in other categories)
    updateCrossFilterAvailability();
    
    // Force render
    if (drawerSceneInstance.startRenderLoop) {
      drawerSceneInstance.startRenderLoop();
    }
  };
  
  // Trigger blink animation on the selection highlight (word span)
  // Remove any existing blink class first
  wordSpan.classList.remove('blink-twice');
  // Force reflow to ensure class removal is processed
  void wordSpan.offsetWidth;
  // Add blink class to start animation
  wordSpan.classList.add('blink-twice');
  
  // Animation duration: 500ms (0.5s from CSS)
  const animationDurationMs = 500;
  
  // Listen for animation end event
  const handleAnimationEnd = (event) => {
    if (event.target !== wordSpan) return;
    if (event.animationName === 'blinkTwice') {
      wordSpan.classList.remove('blink-twice');
      commitPending();
    }
  };
  
  wordSpan.addEventListener('animationend', handleAnimationEnd, { once: true });
  
  // Fallback timer: ensure commit happens even if animationend fails
  setTimeout(() => {
    wordSpan.classList.remove('blink-twice');
    commitPending();
  }, animationDurationMs + 50);
}

// Update selected state of keywords filter options
function updateKeywordsFilterSelection() {
  if (!drawerSceneInstance) return;
  
  const optionsContainer = document.getElementById('keywords-filter-options');
  const options = document.querySelectorAll('#keywords-filter-options .filter-option');
  
  // First, remove is-selected from ALL options
  options.forEach(option => {
    option.classList.remove('is-selected');
  });
  
  // Then, add is-selected only to options in the Set
  options.forEach(option => {
    const keywordLabel = option.dataset.keywordLabel;
    if (drawerSceneInstance.activeKeywords.has(keywordLabel)) {
      option.classList.add('is-selected');
    }
  });
}

// Reset keywords filter UI to default state (show all options)
function resetKeywordsUI() {
  const optionsContainer = document.getElementById('keywords-filter-options');
  if (!optionsContainer) return;
  
  // Remove has-selection class to show all options
  optionsContainer.classList.remove('has-selection');
  
  // Remove is-selected from all options
  const options = document.querySelectorAll('#keywords-filter-options .filter-option');
  options.forEach(option => {
    option.classList.remove('is-selected');
    option.classList.remove('filter-unavailable');
    // Reset any inline styles that might hide options
    option.style.visibility = '';
    option.style.display = '';
    option.style.opacity = '';
    option.style.height = '';
  });
}

// Update markers after fonts load for accurate positioning
function updateMarkers() {
  positionDotHighlights();
  positionRadioMarker();
}

/**
 * Splash overlay: show after loader hides. On first scroll: CSS zoom-in (GPU), hide splash, show UI,
 * then hand off to drawer camera.zoom after 400ms.
 */
function setupSplashOverlay() {
  const splashEl = document.getElementById('splash-overlay');
  const canvasEl = document.getElementById('canvas');
  if (!splashEl || !canvasEl) return;

  // Get nav heights from CSS variables for responsive design
  const rootStyles = getComputedStyle(document.documentElement);
  const navHeight = parseFloat(rootStyles.getPropertyValue('--nav-height')) || 12;
  const centerNavHeight = parseFloat(rootStyles.getPropertyValue('--center-nav-height')) || 36;
  const filtersNavHeight = parseFloat(rootStyles.getPropertyValue('--filters-nav-height')) || 24;
  const NAV_HEIGHT = navHeight + centerNavHeight + filtersNavHeight;
  
  const SPLASH_ZOOM_MS = 400;
  const SPLASH_SCALE = 1.12;
  const FADE_MS = 300;

  window.splashVisible = false;
  let splashExitZoomActive = false;

  window.addEventListener('splashShow', () => {
    window.splashVisible = true;
    splashEl.classList.add('splash-visible');
    splashEl.setAttribute('aria-hidden', 'false');
    document.documentElement.style.setProperty('--uiAlpha', '0');
    document.documentElement.style.setProperty('--navTranslateY', `-${NAV_HEIGHT}px`);
    
    // Clear inline styles that override CSS variables - ensure elements are actually hidden
    const topNav = document.getElementById('top-nav');
    const centerNav = document.getElementById('center-nav');
    const filtersWrap = document.getElementById('filters-wrap');
    const remainsLogo = document.getElementById('remainsLogo');
    
    if (topNav) {
      topNav.style.transform = '';
      topNav.style.opacity = '0';
    }
    if (centerNav) {
      centerNav.style.transform = `translateY(-${NAV_HEIGHT}px)`;
      centerNav.style.opacity = '0';
    }
    if (filtersWrap) {
      filtersWrap.style.transform = `translateY(-${NAV_HEIGHT}px)`;
      filtersWrap.style.opacity = '0';
    }
    if (remainsLogo) {
      remainsLogo.style.opacity = '0';
    }
  });

  const onWheelCapture = (e) => {
    if (splashExitZoomActive) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!window.splashVisible) return;
    window.splashVisible = false;
    splashExitZoomActive = true;
    e.preventDefault();
    e.stopPropagation();

    splashEl.classList.remove('splash-visible');
    splashEl.classList.add('splash-hiding');
    
    // Keep nav hidden during splash fade - will remove when animation starts
    document.body.classList.add('nav-entering');

    canvasEl.classList.add('splash-zoom-in');

    // Wait for splash to fade out before animating UI in
    setTimeout(() => {
      // Get elements for animation
      const topNav = document.getElementById('top-nav');
      const centerNav = document.getElementById('center-nav');
      const filtersWrap = document.getElementById('filters-wrap');
      const remainsLogo = document.getElementById('remainsLogo');
      
      splashEl.classList.remove('splash-hiding');
      splashEl.setAttribute('aria-hidden', 'true');
      
      // Now animate UI layer in with its normal animation
      document.documentElement.style.setProperty('--navTranslateY', '0px');
      document.documentElement.style.setProperty('--uiAlpha', '1');
      
      // Use double RAF to ensure browser has fully rendered hidden state before transitioning
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Remove nav-entering class RIGHT BEFORE animations start
          document.body.classList.remove('nav-entering');
          
          // Animate using Web Animations API for consistent behavior
          if (topNav) {
            topNav.style.visibility = 'visible';
            topNav.animate([
              { opacity: 0 },
              { opacity: 1 }
            ], { duration: 400, easing: 'ease-out', fill: 'forwards' });
          }
          if (centerNav) {
            centerNav.style.visibility = 'visible';
            centerNav.animate([
              { transform: 'translateY(-90px)', opacity: 0 },
              { transform: 'translateY(0)', opacity: 1 }
            ], { duration: 450, easing: 'ease-out', fill: 'forwards' }).onfinish = () => {
              centerNav.style.transform = 'translateY(0)';
              centerNav.style.opacity = '1';
            };
          }
          if (remainsLogo) {
            remainsLogo.style.visibility = 'visible';
            remainsLogo.animate([
              { opacity: 0 },
              { opacity: 1 }
            ], { duration: 400, easing: 'ease-out', fill: 'forwards' });
          }
          if (filtersWrap) {
            filtersWrap.style.visibility = 'visible';
            // Use simple slide animation from current position (matches center-nav)
            filtersWrap.animate([
              { transform: 'translateY(-90px)', opacity: 0 },
              { transform: 'translateY(0)', opacity: 1 }
            ], { duration: 450, easing: 'ease-out', fill: 'forwards' }).onfinish = () => {
              filtersWrap.style.transform = 'translateY(0)';
              filtersWrap.style.opacity = '1';
            };
          }
        });
      });
    }, FADE_MS);

    setTimeout(() => {
      canvasEl.style.transition = 'none';
      canvasEl.classList.remove('splash-zoom-in');
      canvasEl.offsetHeight; // force reflow
      canvasEl.style.transition = '';
      const drawer = window.drawerSceneInstance;
      if (drawer && drawer.camera) {
        drawer.camera.zoom *= SPLASH_SCALE;
        drawer.targetZoom = drawer.camera.zoom;
      }
      splashExitZoomActive = false;
    }, SPLASH_ZOOM_MS);
  };

  window.addEventListener('wheel', onWheelCapture, { capture: true, passive: false });
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    init();
    setupAboutToggle();
    setupRadioButtons();
    setupFiltersPanel();
    setupSplashOverlay();

    // Initialize pixel loader immediately
    fillLoaderPixels();

    // Generate pixel fills after layout is ready
    requestAnimationFrame(() => {
      generatePixelFills();
      fillLoaderPixels(); // Rebuild with correct width after layout
      updateMarkers();
    });
    
    // Update after fonts load
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        generatePixelFills();
        updateMarkers();
      });
    }
    
    window.addEventListener('resize', handleResize);
    
    // Add ESC key to clear filters
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        clearFilter();
      }
    });
  });
} else {
  init();
  setupAboutToggle();
  setupRadioButtons();
  setupFiltersPanel();
  setupSplashOverlay();

  // Initialize pixel loader immediately
  fillLoaderPixels();

  // Generate pixel fills after layout is ready
  requestAnimationFrame(() => {
    generatePixelFills();
    fillLoaderPixels(); // Rebuild with correct width after layout
    updateMarkers();
  });
  
  // Update after fonts load
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      generatePixelFills();
      updateMarkers();
    });
  }
  
  window.addEventListener('resize', handleResize);
}
