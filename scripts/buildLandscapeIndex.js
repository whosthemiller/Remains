/**
 * Build landscape.index.json: precomputed list of landscape (width >= height) photos.
 * Used by Users and User-albums pages to avoid loading images at runtime.
 *
 * Run: npm run build:landscape
 * (Run after build:index when photos change.)
 */

const fs = require('fs');
const path = require('path');
const sizeOf = require('image-size');

const BASE = path.join(__dirname, '..');
const DATA_DIR = path.join(BASE, 'data');
const PHOTOS_INDEX = path.join(DATA_DIR, 'photos.index.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'landscape.index.json');

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function buildLandscapeIndex() {
  if (!fs.existsSync(PHOTOS_INDEX)) {
    console.error('photos.index.json not found. Run "npm run build:index" first.');
    process.exit(1);
  }

  console.log('Reading photos index...');
  const data = readJson(PHOTOS_INDEX);
  const photos = data.photos || [];

  const byUser = {};
  const srcList = [];
  let checked = 0;
  let landscape = 0;
  let skipped = 0;

  for (const photo of photos) {
    const src = photo.src;
    const userKey = photo.userKey;
    if (!src || !userKey) continue;

    const filePath = path.join(BASE, src);
    if (!fs.existsSync(filePath)) {
      skipped++;
      continue;
    }

    let dims;
    try {
      dims = sizeOf(filePath);
    } catch (e) {
      skipped++;
      continue;
    }

    checked++;
    if (dims.width >= dims.height) {
      landscape++;
      if (!byUser[userKey]) byUser[userKey] = [];
      byUser[userKey].push(src);
      srcList.push(src);
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    byUser,
    srcList,
    stats: { checked, landscape, skipped },
  };

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\n✓ Landscape index: ${landscape} landscape of ${checked} checked (${skipped} skipped)`);
  console.log(`  Output: ${path.relative(process.cwd(), OUTPUT_FILE)}`);
}

buildLandscapeIndex();
