/**
 * Simple client-side routing system
 */

let currentRoute = 'drawer';
let routeHandlers = {};
/** When true, the hash was just set by navigate() - skip handling in hashchange to avoid double run */
let hashUpdateByNavigate = false;

export function initRouter() {
  // Handle initial route
  handleRouteChange();
  
  // Handle browser back/forward and hash changes
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash;
    if (hashUpdateByNavigate) {
      hashUpdateByNavigate = false;
      return;
    }
    if (hash === '#/users') {
      navigate('users', {}, false);
    } else if (hash.startsWith('#/users/')) {
      const username = decodeURIComponent(hash.substring('#/users/'.length));
      navigate('user-albums', { username }, false);
    } else if (hash === '#/index') {
      navigate('index', {}, false);
    } else {
      navigate('drawer', {}, false);
    }
  });
}

export function navigate(route, params = {}, updateHash = true) {
  currentRoute = route;
  // Update URL hash (if updateHash is true)
  if (updateHash) {
    hashUpdateByNavigate = true;
    if (route === 'users') {
      window.location.hash = '#/users';
    } else if (route === 'user-albums' && params.username) {
      window.location.hash = `#/users/${encodeURIComponent(params.username)}`;
    } else if (route === 'index') {
      window.location.hash = '#/index';
    } else {
      window.location.hash = '';
    }
  }
  
  handleRouteChange(route, params);
}

function handleRouteChange(route = null, params = {}) {
  const activeRoute = route || currentRoute;
  const handler = routeHandlers[activeRoute];
  if (handler) {
    handler(params);
  }
}

export function registerRoute(route, handler) {
  routeHandlers[route] = handler;
}

export function getCurrentRoute() {
  return currentRoute;
}
