const fs = require("fs");
const path = require("path");
const os = require("os");

const ARCHIVE_CACHE_MAX_SIZE = 30;
const ARCHIVE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const STAGING_DIR = path.join(os.tmpdir(), "stremio-subsro-staging");
try {
  fs.mkdirSync(STAGING_DIR, { recursive: true });
} catch (e) {}

// Internal storage: key -> { filePath, srtFiles, archiveType, timestamp }
const _cacheStore = new Map();
const _cacheOrder = []; // LRU keys

function removeArchiveFile(item) {
  if (item && item.filePath) {
    try {
      if (fs.existsSync(item.filePath)) {
        fs.unlinkSync(item.filePath);
      }
    } catch (e) {}
  }
}

function getArchive(key) {
  const item = _cacheStore.get(key);
  if (!item) return null;

  // Check TTL or deleted file
  if (
    Date.now() - item.timestamp > ARCHIVE_CACHE_TTL ||
    !fs.existsSync(item.filePath)
  ) {
    deleteArchive(key);
    return null;
  }

  // Move to end (MRU)
  const idx = _cacheOrder.indexOf(key);
  if (idx > -1) {
    _cacheOrder.splice(idx, 1);
    _cacheOrder.push(key);
  }

  return item;
}

function setArchive(key, value) {
  if (_cacheStore.has(key)) {
    const existing = _cacheStore.get(key);
    if (existing.filePath !== value.filePath) {
      removeArchiveFile(existing);
    }
    const idx = _cacheOrder.indexOf(key);
    if (idx > -1) _cacheOrder.splice(idx, 1);
  }

  // Evict oldest if at capacity
  while (_cacheOrder.length >= ARCHIVE_CACHE_MAX_SIZE) {
    const oldestKey = _cacheOrder.shift();
    const oldItem = _cacheStore.get(oldestKey);
    removeArchiveFile(oldItem);
    _cacheStore.delete(oldestKey);
  }

  _cacheStore.set(key, { ...value, timestamp: Date.now() });
  _cacheOrder.push(key);
}

function deleteArchive(key) {
  const item = _cacheStore.get(key);
  removeArchiveFile(item);
  _cacheStore.delete(key);
  const idx = _cacheOrder.indexOf(key);
  if (idx > -1) _cacheOrder.splice(idx, 1);
}

function getCacheStats() {
  return {
    size: _cacheStore.size,
    maxSize: ARCHIVE_CACHE_MAX_SIZE,
    keys: [..._cacheOrder],
  };
}

function clearCache() {
  for (const key of [..._cacheOrder]) {
    deleteArchive(key);
  }
}

const ARCHIVE_CACHE = {
  get: getArchive,
  set: setArchive,
  delete: deleteArchive,
  clear: clearCache,
  has: (key) => _cacheStore.has(key),
  get size() {
    return _cacheStore.size;
  },
  stats: getCacheStats,
  STAGING_DIR,
};

module.exports = {
  ARCHIVE_CACHE,
  ARCHIVE_CACHE_MAX_SIZE,
  ARCHIVE_CACHE_TTL,
  STAGING_DIR,
};
