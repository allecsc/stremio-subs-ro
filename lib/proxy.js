const express = require("express");
const {
  extractSingleVtt,
  getArchiveType,
} = require("./subtitleExtractor");
const SubsRoClient = require("./subsro");
const { ARCHIVE_CACHE } = require("./archiveCache");
const { globalMetrics } = require("./metrics");
const router = express.Router();

// Short-lived, byte-bounded VTT cache for replaying a recently served track.
const VTT_CACHE_MAX_SIZE = 20;
const VTT_TTL = 60 * 1000;
const VTT_CACHE_MAX_ENTRY_BYTES = 512 * 1024;
const VTT_CACHE_MAX_RETAINED_BYTES = 4 * 1024 * 1024;
const _vttStore = new Map();
const _vttOrder = [];
let _retainedVttBytes = 0;

function getVttByteSize(value) {
  return Buffer.byteLength(String(value?.vtt || ""), "utf8");
}

function pruneExpiredVtt(now = Date.now()) {
  for (const key of [..._vttOrder]) {
    const item = _vttStore.get(key);
    if (item && now - item.timestamp > VTT_TTL) {
      deleteVtt(key);
    }
  }
}

function getVtt(key) {
  const item = _vttStore.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > VTT_TTL) {
    deleteVtt(key);
    return null;
  }
  // Move to end (most recently used)
  const idx = _vttOrder.indexOf(key);
  if (idx > -1) {
    _vttOrder.splice(idx, 1);
    _vttOrder.push(key);
  }
  return item;
}

function setVtt(key, value) {
  pruneExpiredVtt();

  if (_vttStore.has(key)) {
    deleteVtt(key);
  }

  const vttBytes = getVttByteSize(value);
  if (vttBytes > VTT_CACHE_MAX_ENTRY_BYTES) {
    return;
  }

  while (_vttOrder.length >= VTT_CACHE_MAX_SIZE) {
    deleteVtt(_vttOrder[0]);
  }
  while (
    _retainedVttBytes + vttBytes > VTT_CACHE_MAX_RETAINED_BYTES &&
    _vttOrder.length > 0
  ) {
    deleteVtt(_vttOrder[0]);
  }

  _vttStore.set(key, { ...value, timestamp: Date.now(), vttBytes });
  _vttOrder.push(key);
  _retainedVttBytes += vttBytes;
}

function deleteVtt(key) {
  const item = _vttStore.get(key);
  _retainedVttBytes -= item?.vttBytes || 0;
  _vttStore.delete(key);
  const idx = _vttOrder.indexOf(key);
  if (idx > -1) _vttOrder.splice(idx, 1);
}

function getVttCacheStats() {
  pruneExpiredVtt();
  return {
    size: _vttStore.size,
    maxSize: VTT_CACHE_MAX_SIZE,
    retainedVttBytes: _retainedVttBytes,
    maxRetainedVttBytes: VTT_CACHE_MAX_RETAINED_BYTES,
  };
}

const VTT_CACHE = {
  get: getVtt,
  set: setVtt,
  delete: deleteVtt,
  prune: pruneExpiredVtt,
  stats: getVttCacheStats,
};

// Route: /:apiKey/proxy/:subId/:encodedSrtPath/sub.vtt
router.get(
  "/:apiKey/proxy/:subId/:encodedSrtPath/sub.vtt",
  async (req, res) => {
    const { apiKey, subId, encodedSrtPath } = req.params;
    const proxyStartTime = Date.now();

    if (!/^\d+$/.test(subId)) {
      return res.status(400).send("Invalid subtitle ID");
    }

    let srtPath = "";
    try {
      srtPath = Buffer.from(encodedSrtPath, "base64url").toString("utf-8");
    } catch (e) {
      return res.status(400).send("Invalid SRT path encoding");
    }

    const vttCacheKey = `${subId}_${encodedSrtPath}`;
    const cachedVtt = VTT_CACHE.get(vttCacheKey);
    if (cachedVtt) {
      globalMetrics.recordProxy({
        apiKey,
        durationMs: Date.now() - proxyStartTime,
        cacheHit: true,
        archiveType: "zip",
      });
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Content-Type", "text/vtt; charset=utf-8");
      res.set("Cache-Control", "public, max-age=43200");
      return res.send(cachedVtt.vtt);
    }

    try {
      // Check 60s transient extracted archive cache
      const cacheKey = `archive_${subId}`;
      const cachedArchive = ARCHIVE_CACHE.get(cacheKey);

      let vttContent = null;
      let archiveType = "zip";
      let cacheHit = false;

      if (
        cachedArchive &&
        cachedArchive.vttMap &&
        cachedArchive.vttMap.has(srtPath)
      ) {
        vttContent = cachedArchive.vttMap.get(srtPath);
        archiveType = cachedArchive.archiveType || "zip";
        cacheHit = true;
      } else {
        // Fallback: download on-demand
        const client = new SubsRoClient(apiKey);
        const archiveBuffer = await client.downloadArchive(subId);
        archiveType = getArchiveType(archiveBuffer);
        vttContent = await extractSingleVtt(archiveBuffer, srtPath);
      }

      if (!vttContent) {
        return res.status(404).send("Subtitle file not found in archive");
      }

      VTT_CACHE.set(vttCacheKey, { vtt: vttContent });

      globalMetrics.recordProxy({
        apiKey,
        durationMs: Date.now() - proxyStartTime,
        cacheHit,
        archiveType,
      });

      res.set("Access-Control-Allow-Origin", "*");
      res.set("Content-Type", "text/vtt; charset=utf-8");
      res.set("Cache-Control", "public, max-age=43200");
      res.send(vttContent);
    } catch (error) {
      globalMetrics.recordProxy({
        apiKey,
        durationMs: Date.now() - proxyStartTime,
        cacheHit: false,
        error: true,
      });
      globalMetrics.recordError({
        type: "PROXY_STREAM_ERROR",
        message: error.message || "Failed to serve WebVTT stream",
        stack: error.stack,
        context: `subId:${req.query.subId || "unknown"}`,
      });
      res
        .status(error.response?.status || 500)
        .send(error.response?.data || error.message || "Proxy error");
    }
  },
);

router.vttCache = VTT_CACHE;

module.exports = router;
