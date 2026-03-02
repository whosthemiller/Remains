/**
 * Dynamic favicon: 3 random photos stacked with tiny offset and 70% opacity.
 * Regenerates on each page load.
 */
import { buildImageUrl } from './paths.js';

const FAVICON_SIZE = 64;
const STACK_OFFSET_X = 6;
const STACK_OFFSET_Y = 4;
/** Opacity per layer: back (0) = 80%, middle = 60%, front (2) = 40% */
const OPACITIES = [0.8, 0.6, 0.4];

function pickRandom(photos, n) {
  if (!photos || photos.length === 0) return [];
  const copy = [...photos];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

function drawStackedFavicon(ctx, images) {
  const size = FAVICON_SIZE;
  const maxW = size - (images.length - 1) * STACK_OFFSET_X;
  const maxH = size - (images.length - 1) * STACK_OFFSET_Y;

  // One scale so every image fits inside the bounds when stacked
  let scale = 1;
  images.forEach((img) => {
    const s = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
    scale = Math.min(scale, s);
  });

  ctx.clearRect(0, 0, size, size);

  images.forEach((img, i) => {
    const dx = i * STACK_OFFSET_X;
    const dy = i * STACK_OFFSET_Y;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const w = iw * scale;
    const h = ih * scale;

    ctx.save();
    ctx.globalAlpha = OPACITIES[i] ?? OPACITIES[OPACITIES.length - 1];
    ctx.drawImage(img, 0, 0, iw, ih, dx, dy, w, h);
    ctx.restore();
  });
}

/**
 * Initialize dynamic favicon. Fetches photos index, picks 3 random photos,
 * draws them stacked on a canvas, and sets the favicon. Runs once on load.
 */
export async function initDynamicFavicon() {
  let link = document.querySelector('link#favicon');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.id = 'favicon';
    document.head.appendChild(link);
  }

  try {
    const response = await fetch('data/photos.index.json');
    if (!response.ok) return;
    const data = await response.json();
    const photos = data.photos;
    if (!photos || photos.length === 0) return;

    const picked = pickRandom(photos, 3);
    const urls = picked.map((p) => buildImageUrl(p)).filter(Boolean);
    if (urls.length === 0) return;

    const images = await Promise.all(urls.map((src) => loadImage(src)));
    if (images.length === 0) return;

    const canvas = document.createElement('canvas');
    canvas.width = FAVICON_SIZE;
    canvas.height = FAVICON_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    drawStackedFavicon(ctx, images);
    link.href = canvas.toDataURL('image/png');
  } catch (_) {
    // Silently skip if fetch or image load fails (e.g. offline, CORS)
  }
}
