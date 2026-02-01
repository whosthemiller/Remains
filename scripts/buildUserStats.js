/**
 * Build user statistics from local image files
 * Scans img/ folders and calculates:
 * - localPhotoCount: number of images per user
 * - totalBytes: total file size in bytes
 * - lastModified: most recent file modification time
 */

const fs = require('fs');
const path = require('path');

const IMG_DIR = path.join(__dirname, '..', 'img');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'userStats.json');

function getAllImageFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      getAllImageFiles(filePath, fileList);
    } else if (/\.(jpg|jpeg|png|webp)$/i.test(file)) {
      fileList.push({
        path: filePath,
        size: stat.size,
        mtime: stat.mtime.getTime()
      });
    }
  }
  
  return fileList;
}

function buildUserStats() {
  console.log('Scanning image files...');
  
  if (!fs.existsSync(IMG_DIR)) {
    console.error(`Error: ${IMG_DIR} does not exist`);
    process.exit(1);
  }
  
  const userStats = {};
  const imageFiles = getAllImageFiles(IMG_DIR);
  
  console.log(`Found ${imageFiles.length} image files`);
  
  // Group files by user (first directory level)
  for (const file of imageFiles) {
    const relativePath = path.relative(IMG_DIR, file.path);
    const parts = relativePath.split(path.sep);
    
    if (parts.length < 2) continue; // Skip files not in user/album structure
    
    const userKey = parts[0];
    
    if (!userStats[userKey]) {
      userStats[userKey] = {
        localPhotoCount: 0,
        totalBytes: 0,
        lastModified: 0
      };
    }
    
    userStats[userKey].localPhotoCount++;
    userStats[userKey].totalBytes += file.size;
    userStats[userKey].lastModified = Math.max(
      userStats[userKey].lastModified,
      file.mtime
    );
  }
  
  // Convert lastModified from timestamp to ISO string for easier frontend use
  const output = {};
  for (const [userKey, stats] of Object.entries(userStats)) {
    output[userKey] = {
      localPhotoCount: stats.localPhotoCount,
      totalBytes: stats.totalBytes,
      lastModified: stats.lastModified > 0 ? new Date(stats.lastModified).toISOString() : null
    };
  }
  
  // Ensure data directory exists
  const dataDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  
  console.log(`\nUser statistics generated:`);
  console.log(`  Total users: ${Object.keys(output).length}`);
  console.log(`  Output file: ${OUTPUT_FILE}`);
  
  // Summary
  let totalPhotos = 0;
  let totalMB = 0;
  for (const stats of Object.values(output)) {
    totalPhotos += stats.localPhotoCount;
    totalMB += stats.totalBytes / (1024 * 1024);
  }
  console.log(`  Total local photos: ${totalPhotos}`);
  console.log(`  Total size: ${totalMB.toFixed(2)} MB`);
}

buildUserStats();
