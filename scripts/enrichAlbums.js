const fs = require('fs');
const path = require('path');

const IMG_DIR = path.join(__dirname, '..', 'img');

/**
 * Calculate folder size in MB
 */
function calculateFolderSize(folderPath) {
  let totalSize = 0;
  
  if (!fs.existsSync(folderPath)) {
    return 0;
  }
  
  const files = fs.readdirSync(folderPath);
  
  for (const file of files) {
    const filePath = path.join(folderPath, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      totalSize += calculateFolderSize(filePath);
    } else {
      totalSize += stat.size;
    }
  }
  
  return totalSize;
}

/**
 * Find the latest uploadedUnix timestamp from photos array
 */
function findLastUploadedDate(photos) {
  if (!photos || !Array.isArray(photos) || photos.length === 0) {
    return null;
  }
  
  let maxTimestamp = 0;
  
  for (const photo of photos) {
    if (photo.uploadedUnix && typeof photo.uploadedUnix === 'number') {
      if (photo.uploadedUnix > maxTimestamp) {
        maxTimestamp = photo.uploadedUnix;
      }
    }
  }
  
  return maxTimestamp > 0 ? maxTimestamp : null;
}

/**
 * Enrich a single album.json file
 */
function enrichAlbum(albumPath) {
  try {
    const albumData = JSON.parse(fs.readFileSync(albumPath, 'utf8'));
    
    // Get the album folder path (parent directory of album.json)
    const albumFolder = path.dirname(albumPath);
    
    // Calculate size in MB from img folder
    const folderSizeBytes = calculateFolderSize(albumFolder);
    const sizeMB = Math.round((folderSizeBytes / (1024 * 1024)) * 100) / 100; // Round to 2 decimal places
    
    // Find last uploaded date from photos
    const lastUploadedUnix = findLastUploadedDate(albumData.photos);
    
    // Add new fields to album object
    albumData.album.sizeMB = sizeMB;
    if (lastUploadedUnix) {
      albumData.album.lastUploadedUnix = lastUploadedUnix;
      // Also add a human-readable date string
      albumData.album.lastUploadedDate = new Date(lastUploadedUnix * 1000).toISOString();
    } else {
      albumData.album.lastUploadedUnix = null;
      albumData.album.lastUploadedDate = null;
    }
    
    // Write back to file
    fs.writeFileSync(albumPath, JSON.stringify(albumData, null, 2) + '\n', 'utf8');
    
    return {
      title: albumData.album.title,
      sizeMB,
      lastUploadedUnix,
      photoCount: albumData.album.photoCount
    };
  } catch (error) {
    console.error(`Error processing ${albumPath}:`, error.message);
    return null;
  }
}

/**
 * Find all album.json files recursively
 */
function findAlbumFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      findAlbumFiles(filePath, fileList);
    } else if (file === 'album.json') {
      fileList.push(filePath);
    }
  }
  
  return fileList;
}

/**
 * Main function
 */
function main() {
  console.log('Finding all album.json files...');
  const albumFiles = findAlbumFiles(IMG_DIR);
  console.log(`Found ${albumFiles.length} album.json files`);
  
  const results = [];
  let successCount = 0;
  let errorCount = 0;
  
  for (const albumPath of albumFiles) {
    const result = enrichAlbum(albumPath);
    if (result) {
      results.push(result);
      successCount++;
    } else {
      errorCount++;
    }
  }
  
  console.log('\n=== Summary ===');
  console.log(`Successfully processed: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  
  // Show some examples
  console.log('\n=== Sample Results ===');
  results.slice(0, 5).forEach(r => {
    console.log(`${r.title}: ${r.sizeMB} MB, ${r.photoCount} photos, last uploaded: ${r.lastUploadedUnix ? new Date(r.lastUploadedUnix * 1000).toISOString() : 'N/A'}`);
  });
  
  // Calculate totals
  const totalSizeMB = results.reduce((sum, r) => sum + r.sizeMB, 0);
  const totalPhotos = results.reduce((sum, r) => sum + r.photoCount, 0);
  console.log(`\nTotal: ${results.length} albums, ${totalPhotos} photos, ${Math.round(totalSizeMB * 100) / 100} MB`);
}

main();
