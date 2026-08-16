/**
 * LRU-limited transient cache for pre-converted WebVTT subtitle maps.
 * Max 30 archive entries with a 60-second TTL to bridge search to playback.
 * Converted VTT text is limited to 1 MiB per archive and 8 MiB in total.
 * Oversized archives retain only their subtitle file list, so playback falls
 * back to the existing on-demand extraction path.
 */

const ARCHIVE_CACHE_MAX_SIZE = 30;
const ARCHIVE_CACHE_TTL = 60 * 1000;
const ARCHIVE_CACHE_MAX_ENTRY_VTT_BYTES = 1 * 1024 * 1024;
const ARCHIVE_CACHE_MAX_RETAINED_VTT_BYTES = 8 * 1024 * 1024;

// Internal storage
const _archiveStore = new Map(); // key -> { vttMap: Map<srtPath, vttString>, srtFiles: string[], timestamp }
const _archiveOrder = []; // Track insertion order for LRU eviction
let _retainedVttBytes = 0;

function getVttMapByteSize(vttMap) {
  if (!(vttMap instanceof Map)) return 0;

  let totalBytes = 0;
  for (const [srtPath, vttContent] of vttMap) {
    totalBytes += Buffer.byteLength(String(srtPath), "utf8");
    totalBytes += Buffer.byteLength(String(vttContent), "utf8");
  }
  return totalBytes;
}

function pruneExpiredArchives(now = Date.now()) {
  for (const key of [..._archiveOrder]) {
    const item = _archiveStore.get(key);
    if (item && now - item.timestamp > ARCHIVE_CACHE_TTL) {
      deleteArchive(key);
    }
  }
}

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
  pruneExpiredArchives();

  // If key already exists, remove from order tracking
  if (_archiveStore.has(key)) {
    deleteArchive(key);
  }

  let vttBytes = getVttMapByteSize(value.vttMap);
  let cacheValue = value;

  if (vttBytes > ARCHIVE_CACHE_MAX_ENTRY_VTT_BYTES) {
    const { vttMap, ...metadata } = value;
    cacheValue = metadata;
    vttBytes = 0;
  }

  // Evict oldest if at capacity or above the retained VTT text budget.
  while (_archiveOrder.length >= ARCHIVE_CACHE_MAX_SIZE) {
    const oldestKey = _archiveOrder.shift();
    deleteArchive(oldestKey);
  }
  while (
    _retainedVttBytes + vttBytes > ARCHIVE_CACHE_MAX_RETAINED_VTT_BYTES &&
    _archiveOrder.length > 0
  ) {
    deleteArchive(_archiveOrder[0]);
  }

  // Add new item
  _archiveStore.set(key, { ...cacheValue, timestamp: Date.now(), vttBytes });
  _archiveOrder.push(key);
  _retainedVttBytes += vttBytes;
}

/**
 * Delete an item from cache
 */
function deleteArchive(key) {
  const item = _archiveStore.get(key);
  _retainedVttBytes -= item?.vttBytes || 0;
  _archiveStore.delete(key);
  const idx = _archiveOrder.indexOf(key);
  if (idx > -1) _archiveOrder.splice(idx, 1);
}

/**
 * Get cache stats for debugging
 */
function getArchiveCacheStats() {
  pruneExpiredArchives();

  return {
    size: _archiveStore.size,
    maxSize: ARCHIVE_CACHE_MAX_SIZE,
    retainedVttBytes: _retainedVttBytes,
    maxRetainedVttBytes: ARCHIVE_CACHE_MAX_RETAINED_VTT_BYTES,
    keys: [..._archiveOrder],
  };
}

// Backwards-compatible exports (Map-like interface)
const ARCHIVE_CACHE = {
  get: getArchive,
  set: setArchive,
  delete: deleteArchive,
  has: (key) => _archiveStore.has(key),
  prune: pruneExpiredArchives,
  stats: getArchiveCacheStats,
};

module.exports = {
  ARCHIVE_CACHE,
  ARCHIVE_CACHE_TTL,
  ARCHIVE_CACHE_MAX_ENTRY_VTT_BYTES,
  ARCHIVE_CACHE_MAX_RETAINED_VTT_BYTES,
};
