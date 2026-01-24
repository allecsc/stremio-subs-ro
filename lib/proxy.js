const express = require("express");
const iconv = require("iconv-lite");
const jschardet = require("jschardet");
const {
  extractSrtFile,
  getArchiveType,
  listSrtFiles,
} = require("./archiveUtils");
const { getLimiter } = require("./rateLimiter");
const { ARCHIVE_CACHE } = require("./archiveCache");
const router = express.Router();

// LRU-limited VTT cache
const VTT_CACHE_MAX_SIZE = 100;
const VTT_TTL = 12 * 60 * 60 * 1000; // 12 hours
const _vttStore = new Map();
const _vttOrder = [];

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
  if (_vttStore.has(key)) {
    const idx = _vttOrder.indexOf(key);
    if (idx > -1) _vttOrder.splice(idx, 1);
  }
  while (_vttOrder.length >= VTT_CACHE_MAX_SIZE) {
    const oldestKey = _vttOrder.shift();
    _vttStore.delete(oldestKey);
  }
  _vttStore.set(key, { ...value, timestamp: Date.now() });
  _vttOrder.push(key);
}

function deleteVtt(key) {
  _vttStore.delete(key);
  const idx = _vttOrder.indexOf(key);
  if (idx > -1) _vttOrder.splice(idx, 1);
}

// Route: /:apiKey/proxy/:subId/:encodedSrtPath/sub.vtt
router.get(
  "/:apiKey/proxy/:subId/:encodedSrtPath/sub.vtt",
  async (req, res) => {
    const { apiKey, subId, encodedSrtPath } = req.params;

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
    const cachedVtt = getVtt(vttCacheKey);
    if (cachedVtt) {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Content-Type", "text/vtt; charset=utf-8");
      res.set("Cache-Control", "public, max-age=43200");
      return res.send(cachedVtt.vtt);
    }

    try {
      let archiveBuffer;
      let archiveType;
      const cacheKey = `archive_${subId}`;
      const cachedArchive = ARCHIVE_CACHE.get(cacheKey);

      if (cachedArchive && cachedArchive.buffer) {
        archiveBuffer = cachedArchive.buffer;
        archiveType = cachedArchive.archiveType;
      } else {
        const downloadUrl = `https://subs.ro/api/v1.0/subtitle/${subId}/download`;
        const limiter = getLimiter(apiKey);
        archiveBuffer = await limiter.downloadArchive(downloadUrl, {
          headers: { "X-Subs-Api-Key": apiKey },
        });
        archiveType = getArchiveType(archiveBuffer);
        const srtFiles = await listSrtFiles(archiveBuffer);

        ARCHIVE_CACHE.set(cacheKey, {
          buffer: archiveBuffer,
          archiveType,
          srtFiles,
        });
      }

      if (process.env.NODE_ENV === "development") {
        console.log(
          `[PROXY] Extracting "${srtPath}" from ${archiveType.toUpperCase()} archive`,
        );
      }

      const contentBuffer = await extractSrtFile(archiveBuffer, srtPath);

      if (!contentBuffer) {
        return res.status(404).send("SRT file not found in archive");
      }

      const detected = jschardet.detect(contentBuffer);
      let encoding = detected.encoding || "utf-8";
      if (
        encoding.toLowerCase().includes("windows-1252") ||
        detected.confidence < 0.8
      ) {
        encoding = "windows-1250";
      }

      let contentStr = iconv.decode(contentBuffer, encoding);
      contentStr =
        "WEBVTT\n\n" +
        contentStr
          .replace(/\r\n/g, "\n")
          .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
          .replace(/\{\\an\d+\}/gi, ""); // Strip ASS/SSA positioning tags

      setVtt(vttCacheKey, { vtt: contentStr });

      res.set("Access-Control-Allow-Origin", "*");
      res.set("Content-Type", "text/vtt; charset=utf-8");
      res.set("Cache-Control", "public, max-age=43200");
      res.send(contentStr);
    } catch (error) {
      res
        .status(error.response?.status || 500)
        .send(error.response?.data || "Proxy error");
    }
  },
);

module.exports = router;
