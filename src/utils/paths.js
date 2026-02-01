/**
 * Centralized path utilities for building image and resource URLs
 * Handles encoding correctly to avoid double-encoding and 404s
 */

/**
 * Encode path segments separately (don't encode "/" characters)
 * @param {string} path - Path like "imgSmallWebp/user/album/file.webp"
 * @returns {string} - Encoded path like "imgSmallWebp/user%20name/album%20name/file.webp"
 */
export function encodePathSegments(path) {
  if (!path) return '';
  
  // Split by "/" and encode each segment, then rejoin
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

/**
 * Build image URL from photo object
 * Returns a relative path under imgSmallWebp/...
 * @param {Object} photo - Photo object from photos.index.json
 * @returns {string} - Relative URL path (works with GitHub Pages subpath deployment)
 */
export function buildImageUrl(photo) {
  if (!photo) return '';
  
  // Use photo.src if it exists and is complete
  if (photo.src) {
    // photo.src is already a relative path like "imgSmallWebp/user/album/file.webp"
    // Remove leading slash if present to ensure relative path
    const path = photo.src.startsWith('/') ? photo.src.substring(1) : photo.src;
    return path;
  }
  
  // Fallback: construct from userKey, albumKey, fileName
  if (photo.userKey && photo.albumKey && photo.fileName) {
    const path = `imgSmallWebp/${photo.userKey}/${photo.albumKey}/${photo.fileName}`;
    // Don't encode - use as-is
    return path;
  }
  
  // Last resort: if we only have fileName, that's an error (shouldn't happen)
  console.warn('[buildImageUrl] Incomplete photo data:', photo);
  return '';
}

/**
 * Build user.json URL
 * @param {string} userKey - User key (unencoded)
 * @returns {string} - Relative URL path (works with GitHub Pages subpath deployment)
 */
export function buildUserJsonUrl(userKey) {
  if (!userKey) return '';
  const path = `img/${userKey}/user.json`;
  return encodePathSegments(path);
}

/**
 * Build album.json URL
 * @param {string} userKey - User key (unencoded)
 * @param {string} albumKey - Album key (unencoded)
 * @returns {string} - Relative URL path (works with GitHub Pages subpath deployment)
 */
export function buildAlbumJsonUrl(userKey, albumKey) {
  if (!userKey || !albumKey) return '';
  const path = `img/${userKey}/${albumKey}/album.json`;
  return encodePathSegments(path);
}
