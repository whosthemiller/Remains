const fs = require('fs');
const path = require('path');

const PHOTOS_INDEX = path.join(__dirname, '..', 'data', 'photos.index.json');
const SEEDMAP_FILE = path.join(__dirname, '..', 'data', 'location.seedmap.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'location.audit.json');

// Stopwords to filter out
const STOPWORDS = new Set([
  'christmas', 'holiday', 'vacation', 'trip', 'album', 'photos', 'photo', 'party',
  'family', 'birthday', 'wedding', 'year', 'day', 'summer', 'winter', 'spring',
  'fall', 'autumn', 'home', 'friends', 'the', 'and', 'in', 'at', 'of', 'with',
  'a', 'an', 'to', 'for', 'on', 'from', 'as', 'is', 'was', 'are', 'were',
  'beach', 'dog', 'cat', 'pets', 'animals', 'nature', 'flowers', 'trees',
  'food', 'camera', 'picture', 'image', 'collection', 'portrait', 'landscape',
  'art', 'design', 'color', 'old', 'new', 'vintage', 'modern', 'classic',
  'love', 'life', 'people', 'person', 'man', 'woman', 'child', 'baby', 'kids',
  'children', 'group', 'team', 'event', 'celebration', 'music', 'dance',
  'sport', 'sports', 'game', 'games', 'play', 'fun', 'random', 'best', 'misc',
  'untitled', 'show', 'slide', 'garden', 'cats', 'quicke', 'marixay', 'colinchang'
]);

// US States (full names only, no abbreviations to avoid false positives)
const US_STATES = {
  'alabama': 'Alabama',
  'alaska': 'Alaska',
  'arizona': 'Arizona',
  'arkansas': 'Arkansas',
  'california': 'California',
  'colorado': 'Colorado',
  'connecticut': 'Connecticut',
  'delaware': 'Delaware',
  'florida': 'Florida',
  'georgia': 'Georgia',
  'hawaii': 'Hawaii',
  'idaho': 'Idaho',
  'illinois': 'Illinois',
  'indiana': 'Indiana',
  'iowa': 'Iowa',
  'kansas': 'Kansas',
  'kentucky': 'Kentucky',
  'louisiana': 'Louisiana',
  'maine': 'Maine',
  'maryland': 'Maryland',
  'massachusetts': 'Massachusetts',
  'michigan': 'Michigan',
  'minnesota': 'Minnesota',
  'mississippi': 'Mississippi',
  'missouri': 'Missouri',
  'montana': 'Montana',
  'nebraska': 'Nebraska',
  'nevada': 'Nevada',
  'new hampshire': 'New Hampshire',
  'new jersey': 'New Jersey',
  'new mexico': 'New Mexico',
  'new york': 'New York',
  'north carolina': 'North Carolina',
  'north dakota': 'North Dakota',
  'ohio': 'Ohio',
  'oklahoma': 'Oklahoma',
  'oregon': 'Oregon',
  'pennsylvania': 'Pennsylvania',
  'rhode island': 'Rhode Island',
  'south carolina': 'South Carolina',
  'south dakota': 'South Dakota',
  'tennessee': 'Tennessee',
  'texas': 'Texas',
  'utah': 'Utah',
  'vermont': 'Vermont',
  'virginia': 'Virginia',
  'washington': 'Washington',
  'west virginia': 'West Virginia',
  'wisconsin': 'Wisconsin',
  'wyoming': 'Wyoming',
  'district of columbia': 'District of Columbia'
};

// Conservative country list (only countries we know exist in dataset)
const COUNTRIES = {
  'china': 'China',
  'taiwan': 'Taiwan',
  'spain': 'Spain',
  'united states': 'United States',
  'usa': 'United States',
  'us': 'United States'
};

// Continents/Regions
const CONTINENTS = {
  'africa': 'Africa'
};

// Normalize token
function normalizeToken(str) {
  if (!str || typeof str !== 'string') return null;
  return str.toLowerCase().trim().replace(/_/g, ' ');
}

// Tokenize album title into safe tokens
function tokenizeAlbumTitle(title) {
  if (!title || typeof title !== 'string') return [];
  
  const tokens = new Set();
  
  // Split by separators: /, -, —, |, :, ,, (, ), ., !
  const separators = /[/\-\—\|:,\(\)\.!]/g;
  const parts = title.split(separators);
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    
    // Extract words (unigrams)
    const words = trimmed.split(/\s+/).filter(w => w.length >= 2);
    for (const word of words) {
      const normalized = normalizeToken(word);
      if (normalized && normalized.length >= 3 && !STOPWORDS.has(normalized)) {
        tokens.add(normalized);
      }
    }
    
    // Extract safe bigrams (only if both words are alphabetical and not stopwords)
    for (let i = 0; i < words.length - 1; i++) {
      const word1 = normalizeToken(words[i]);
      const word2 = normalizeToken(words[i + 1]);
      if (word1 && word2 && 
          /^[a-z]+$/.test(word1) && /^[a-z]+$/.test(word2) &&
          !STOPWORDS.has(word1) && !STOPWORDS.has(word2)) {
        const bigram = `${word1} ${word2}`;
        if (bigram.length >= 3) {
          tokens.add(bigram);
        }
      }
    }
  }
  
  return Array.from(tokens);
}

// Tokenize albumKey
function tokenizeAlbumKey(albumKey) {
  if (!albumKey || typeof albumKey !== 'string') return [];
  
  const tokens = new Set();
  
  // Split on / _ - .
  const parts = albumKey.split(/[/_\-\.]/);
  
  for (const part of parts) {
    const normalized = normalizeToken(part);
    if (normalized && normalized.length >= 3 && !STOPWORDS.has(normalized)) {
      tokens.add(normalized);
    }
  }
  
  return Array.from(tokens);
}

// Map token to location label (conservative, exact matches only)
function mapTokenToLocation(token, seedmap) {
  if (!token) return null;
  
  const normalized = normalizeToken(token);
  if (!normalized) return null;
  
  // Check seedmap first
  if (seedmap[normalized]) {
    return seedmap[normalized];
  }
  
  // Check US states
  if (US_STATES[normalized]) {
    return `US State: ${US_STATES[normalized]}`;
  }
  
  // Check countries
  if (COUNTRIES[normalized]) {
    return COUNTRIES[normalized];
  }
  
  // Check continents/regions
  if (CONTINENTS[normalized]) {
    return CONTINENTS[normalized];
  }
  
  return null;
}

// Main function
function buildLocationAudit() {
  console.log('Loading photos index...');
  const photosData = JSON.parse(fs.readFileSync(PHOTOS_INDEX, 'utf8'));
  console.log(`Loaded ${photosData.count} photos`);
  
  // Load seedmap
  let seedmap = {};
  if (fs.existsSync(SEEDMAP_FILE)) {
    seedmap = JSON.parse(fs.readFileSync(SEEDMAP_FILE, 'utf8'));
    // Normalize keys to lowercase
    const normalized = {};
    for (const [key, value] of Object.entries(seedmap)) {
      normalized[key.toLowerCase().trim()] = value;
    }
    seedmap = normalized;
  }
  console.log(`Loaded ${Object.keys(seedmap).length} seedmap entries`);
  
  // Process photos
  const locationPhotoMap = new Map(); // label -> Set of photo IDs
  const locationSources = new Map(); // label -> Set of source types
  const locationTokens = new Map(); // label -> Set of example tokens
  const unmappedTokens = new Map(); // token -> count (for reporting)
  
  let photosWithAnyLocation = 0;
  
  for (const photo of photosData.photos) {
    const locationTokenMap = new Map(); // location -> { sources: Set, tokens: Set }
    
    // Extract tokens from tags
    if (Array.isArray(photo.tags)) {
      for (const tag of photo.tags) {
        const normalized = normalizeToken(tag);
        if (normalized && !STOPWORDS.has(normalized)) {
          const location = mapTokenToLocation(normalized, seedmap);
          if (location) {
            if (!locationTokenMap.has(location)) {
              locationTokenMap.set(location, { sources: new Set(), tokens: new Set() });
            }
            locationTokenMap.get(location).sources.add('tags');
            locationTokenMap.get(location).tokens.add(normalized);
          } else {
            // Track unmapped tokens that look location-like (3+ chars, not stopword)
            if (normalized.length >= 3) {
              unmappedTokens.set(normalized, (unmappedTokens.get(normalized) || 0) + 1);
            }
          }
        }
      }
    }
    
    // Extract tokens from album title
    const albumTitle = photo.meta?.album?.title;
    if (albumTitle) {
      const tokens = tokenizeAlbumTitle(albumTitle);
      for (const token of tokens) {
        const location = mapTokenToLocation(token, seedmap);
        if (location) {
          if (!locationTokenMap.has(location)) {
            locationTokenMap.set(location, { sources: new Set(), tokens: new Set() });
          }
          locationTokenMap.get(location).sources.add('album.title');
          locationTokenMap.get(location).tokens.add(token);
        } else {
          if (token.length >= 3) {
            unmappedTokens.set(token, (unmappedTokens.get(token) || 0) + 1);
          }
        }
      }
    }
    
    // Extract tokens from albumKey
    const albumKey = photo.albumKey;
    if (albumKey) {
      const tokens = tokenizeAlbumKey(albumKey);
      for (const token of tokens) {
        const location = mapTokenToLocation(token, seedmap);
        if (location) {
          if (!locationTokenMap.has(location)) {
            locationTokenMap.set(location, { sources: new Set(), tokens: new Set() });
          }
          locationTokenMap.get(location).sources.add('albumKey');
          locationTokenMap.get(location).tokens.add(token);
        } else {
          if (token.length >= 3) {
            unmappedTokens.set(token, (unmappedTokens.get(token) || 0) + 1);
          }
        }
      }
    }
    
    // Update location maps
    if (locationTokenMap.size > 0) {
      photosWithAnyLocation++;
      for (const [location, data] of locationTokenMap.entries()) {
        if (!locationPhotoMap.has(location)) {
          locationPhotoMap.set(location, new Set());
          locationSources.set(location, new Set());
          locationTokens.set(location, new Set());
        }
        locationPhotoMap.get(location).add(photo.id);
        // Add sources for this location
        for (const source of data.sources) {
          locationSources.get(location).add(source);
        }
        // Add tokens for this location
        for (const token of data.tokens) {
          locationTokens.get(location).add(token);
        }
      }
    }
  }
  
  // Build locations array
  const locations = [];
  for (const [label, photoIds] of locationPhotoMap.entries()) {
    const photoArray = Array.from(photoIds).map(id => {
      const photo = photosData.photos.find(p => p.id === id);
      return {
        id: photo.id,
        src: photo.src
      };
    });
    
    const sources = Array.from(locationSources.get(label));
    const exampleTokens = Array.from(locationTokens.get(label)).slice(0, 10);
    
    locations.push({
      label,
      photoCount: photoIds.size,
      sources,
      exampleTokensFound: exampleTokens,
      photos: photoArray
    });
  }
  
  // Sort by photoCount desc
  locations.sort((a, b) => b.photoCount - a.photoCount);
  
  // Top unmapped tokens
  const unmappedTopTokens = Array.from(unmappedTokens.entries())
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);
  
  // Generate audit report
  const audit = {
    generatedAt: new Date().toISOString(),
    totalPhotos: photosData.count,
    photosWithAnyLocation,
    locations,
    unmappedTopTokens
  };
  
  // Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(audit, null, 2), 'utf8');
  console.log(`\nAudit written to: ${path.relative(process.cwd(), OUTPUT_FILE)}`);
  
  // Console summary
  console.log('\n=== SUMMARY ===');
  console.log(`Total photos: ${audit.totalPhotos}`);
  console.log(`Photos with location info: ${audit.photosWithAnyLocation} (${(audit.photosWithAnyLocation / audit.totalPhotos * 100).toFixed(1)}%)`);
  console.log(`Unique locations: ${locations.length}`);
  
  console.log('\nTop 15 locations by photo count:');
  locations.slice(0, 15).forEach((loc, index) => {
    console.log(`  ${index + 1}. ${loc.label}: ${loc.photoCount} photos`);
    console.log(`     Sources: ${loc.sources.join(', ')}`);
    console.log(`     Example tokens: ${loc.exampleTokensFound.slice(0, 5).join(', ')}`);
  });
  
  console.log('\nTop 30 unmapped tokens (for seedmap extension):');
  unmappedTopTokens.forEach((item, index) => {
    console.log(`  ${index + 1}. "${item.token}": ${item.count} occurrences`);
  });
}

// Run the script
buildLocationAudit();
