/**
 * LRU-limited transient cache for pre-converted WebVTT subtitle maps.
 * Max 30 archive entries with 60-second TTL to bridge search to playback.
 * Holds lightweight ~50KB WebVTT strings, zero binary archive buffers in memory.
 */

const ARCHIVE_CACHE_MAX_SIZE = 30;
const ARCHIVE_CACHE_TTL = 60 * 1000; // 60 seconds transient bridge

// Internal storage
const _archiveStore = new Map(); // key -> { vttMap: Map<srtPath, vttString>, srtFiles: string[], timestamp }
const _archiveOrder = []; // Track insertion order for LRU eviction

/**
 * Get an item from cache (updates access order)
 */
function getArchive(key) {
  const item = _archiveStore.get(key);
  if (!item) return null;

  // Check TTL
  if (Date.now() - item.timestamp > ARCHIVE_CACHE_TTL) {
    deleteArchive(key);
    return null;
  }

  // Move to end of order (most recently used)
  const idx = _archiveOrder.indexOf(key);
  if (idx > -1) {
    _archiveOrder.splice(idx, 1);
    _archiveOrder.push(key);
  }

  return item;
}

/**
 * Set an item in cache (evicts oldest if at capacity)
 */
function setArchive(key, value) {
  // If key already exists, remove from order tracking
  if (_archiveStore.has(key)) {
    const idx = _archiveOrder.indexOf(key);
    if (idx > -1) _archiveOrder.splice(idx, 1);
  }

  // Evict oldest if at capacity
  while (_archiveOrder.length >= ARCHIVE_CACHE_MAX_SIZE) {
    const oldestKey = _archiveOrder.shift();
    _archiveStore.delete(oldestKey);
  }

  // Add new item
  _archiveStore.set(key, { ...value, timestamp: Date.now() });
  _archiveOrder.push(key);
}

/**
 * Delete an item from cache
 */
function deleteArchive(key) {
  _archiveStore.delete(key);
  const idx = _archiveOrder.indexOf(key);
  if (idx > -1) _archiveOrder.splice(idx, 1);
}

/**
 * Get cache stats for debugging
 */
function getArchiveCacheStats() {
  return {
    size: _archiveStore.size,
    maxSize: ARCHIVE_CACHE_MAX_SIZE,
    keys: [..._archiveOrder],
  };
}

// Backwards-compatible exports (Map-like interface)
const ARCHIVE_CACHE = {
  get: getArchive,
  set: setArchive,
  delete: deleteArchive,
  has: (key) => _archiveStore.has(key),
  stats: getArchiveCacheStats,
};

module.exports = {
  ARCHIVE_CACHE,
  ARCHIVE_CACHE_TTL,
};
