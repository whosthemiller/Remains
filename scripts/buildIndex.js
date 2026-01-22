const fs = require('fs');
const path = require('path');

const IMG_SMALL_WEBP_DIR = path.join(__dirname, '..', 'imgSmallWebp');
const IMG_DIR = path.join(__dirname, '..', 'img');
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'photos.index.json');

// Fallback to data/ if public/ doesn't exist
let finalOutputDir = OUTPUT_DIR;
let finalOutputFile = OUTPUT_FILE;
if (!fs.existsSync(path.join(__dirname, '..', 'public'))) {
  finalOutputDir = path.join(__dirname, '..', 'data');
  finalOutputFile = path.join(finalOutputDir, 'photos.index.json');
}

/**
 * Recursively find all .webp files in a directory
 */
function findWebpFiles(dir, baseDir = dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findWebpFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.webp')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Read JSON file safely, return null if missing or invalid
 */
function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.warn(`Warning: Could not read ${filePath}:`, error.message);
    return null;
  }
}

/**
 * Generate a stable unique ID from the file path
 */
function generateId(userKey, albumKey, fileName) {
  // Use a simple hash-like approach: userKey/albumKey/fileName
  // This ensures stable IDs across runs
  return `${userKey}/${albumKey}/${fileName}`;
}

/**
 * Extract user metadata from user.json
 */
function extractUserMeta(userJson) {
  if (!userJson || !userJson.user) {
    return null;
  }

  return {
    nsid: userJson.user.nsid || null,
    username: userJson.user.username || null,
    realname: userJson.user.realname || null,
  };
}

/**
 * Extract album metadata from album.json
 */
function extractAlbumMeta(albumJson) {
  if (!albumJson || !albumJson.album) {
    return null;
  }

  return {
    id: albumJson.album.id || null,
    title: albumJson.album.title || null,
    url: albumJson.album.url || null,
  };
}

/**
 * Main function to build the index
 */
function buildIndex() {
  console.log('Scanning for WebP files...');
  const webpFiles = findWebpFiles(IMG_SMALL_WEBP_DIR);
  console.log(`Found ${webpFiles.length} WebP files`);

  const photos = [];

  for (const filePath of webpFiles) {
    // Get relative path from imgSmallWebp directory
    const relativePath = path.relative(IMG_SMALL_WEBP_DIR, filePath);
    const parts = relativePath.split(path.sep);

    // Extract userKey, albumKey, and fileName
    if (parts.length < 3) {
      console.warn(`Warning: Unexpected path structure: ${relativePath}`);
      continue;
    }

    const userKey = parts[0];
    const albumKey = parts[1];
    const fileName = parts.slice(2).join(path.sep);

    // Generate web path with forward slashes, including imgSmallWebp/ prefix
    const webPath = `imgSmallWebp/${relativePath.split(path.sep).join('/')}`;

    // Read user.json
    const userJsonPath = path.join(IMG_DIR, userKey, 'user.json');
    const userJson = readJsonSafe(userJsonPath);
    const userMeta = extractUserMeta(userJson);

    // Read album.json
    const albumJsonPath = path.join(IMG_DIR, userKey, albumKey, 'album.json');
    const albumJson = readJsonSafe(albumJsonPath);
    const albumMeta = extractAlbumMeta(albumJson);

    // Generate stable ID
    const id = generateId(userKey, albumKey, fileName);

    // Create photo entry
    photos.push({
      id,
      src: webPath,
      userKey,
      albumKey,
      fileName,
      meta: {
        user: userMeta,
        album: albumMeta,
      },
    });
  }

  // Sort deterministically: userKey, albumKey, fileName
  photos.sort((a, b) => {
    if (a.userKey !== b.userKey) {
      return a.userKey.localeCompare(b.userKey);
    }
    if (a.albumKey !== b.albumKey) {
      return a.albumKey.localeCompare(b.albumKey);
    }
    return a.fileName.localeCompare(b.fileName);
  });

  // Create output directory if it doesn't exist
  if (!fs.existsSync(finalOutputDir)) {
    fs.mkdirSync(finalOutputDir, { recursive: true });
  }

  // Generate output object
  const output = {
    generatedAt: new Date().toISOString(),
    count: photos.length,
    photos,
  };

  // Write to file
  fs.writeFileSync(finalOutputFile, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\n✓ Generated index with ${photos.length} photos`);
  console.log(`  Output: ${path.relative(process.cwd(), finalOutputFile)}`);
}

// Run the script
buildIndex();
