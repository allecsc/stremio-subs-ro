const express = require("express");
const iconv = require("iconv-lite");
const jschardet = require("jschardet");
const {
  extractSrtFileFromFile,
  getArchiveTypeFromFile,
  listSrtFilesFromFile,
} = require("./archiveUtils");
const { getLimiter } = require("./rateLimiter");
const { ARCHIVE_CACHE, STAGING_DIR } = require("./archiveCache");
const { globalMetrics } = require("./metrics");
const fs = require("fs");
const path = require("path");
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

// Route: /:config?/proxy/:subId/:encodedSrtPath/sub.vtt
router.get(
  "/:config?/proxy/:subId/:encodedSrtPath/sub.vtt",
  async (req, res) => {
    const proxyStart = Date.now();
    const { subId, encodedSrtPath } = req.params;
    let apiKey = req.query.apiKey;

    if (!apiKey && req.params.config) {
      try {
        const base64 = req.params.config
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(
            req.params.config.length +
              ((4 - (req.params.config.length % 4)) % 4),
            "=",
          );
        const config = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
        apiKey = config.apiKey || req.params.config;
      } catch (e) {
        apiKey = req.params.config;
      }
    }

    if (apiKey) {
      globalMetrics.recordActiveUser(apiKey);
    } else {
      globalMetrics.recordProxyRequest({ durationMs: Date.now() - proxyStart, statusCode: 401 });
      return res.status(401).send("API key required");
    }

    if (!/^\d+$/.test(subId)) {
      globalMetrics.recordProxyRequest({ durationMs: Date.now() - proxyStart, statusCode: 400 });
      return res.status(400).send("Invalid subtitle ID");
    }

    let srtPath = "";
    try {
      srtPath = Buffer.from(encodedSrtPath, "base64url").toString("utf-8");
    } catch (e) {
      globalMetrics.recordProxyRequest({ durationMs: Date.now() - proxyStart, statusCode: 400 });
      return res.status(400).send("Invalid SRT path encoding");
    }

    const vttCacheKey = `${subId}_${encodedSrtPath}`;
    const cachedVtt = getVtt(vttCacheKey);
    if (cachedVtt) {
      globalMetrics.recordCacheHit("vttCache");
      globalMetrics.recordProxyRequest({ durationMs: Date.now() - proxyStart, statusCode: 200 });
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Content-Type", "text/vtt; charset=utf-8");
      res.set("Cache-Control", "public, max-age=43200");
      return res.send(cachedVtt.vtt);
    }
    globalMetrics.recordCacheMiss("vttCache");

    let newlyDownloadedPath = null;
    let extractionDurationMs = 0;
    try {
      let archiveFilePath;
      let archiveType;
      const cacheKey = `archive_${subId}`;
      const cachedArchive = ARCHIVE_CACHE.get(cacheKey);

      if (
        cachedArchive &&
        cachedArchive.filePath &&
        fs.existsSync(cachedArchive.filePath)
      ) {
        globalMetrics.recordCacheHit("archiveCache");
        archiveFilePath = cachedArchive.filePath;
        archiveType = cachedArchive.archiveType;
      } else {
        globalMetrics.recordCacheMiss("archiveCache");
        const downloadUrl = `https://api.subs.ro/v1.0/subtitle/${subId}/download`;
        const destPath = path.join(
          STAGING_DIR,
          `archive_${subId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.bin`,
        );
        newlyDownloadedPath = destPath;
        const limiter = getLimiter(apiKey);
        await limiter.downloadArchiveToFile(downloadUrl, destPath, {
          headers: { "X-Subs-Api-Key": apiKey },
        });
        archiveFilePath = destPath;
        archiveType = getArchiveTypeFromFile(destPath);
        const srtFiles = await listSrtFilesFromFile(destPath);

        ARCHIVE_CACHE.set(cacheKey, {
          filePath: destPath,
          archiveType,
          srtFiles,
          timestamp: Date.now(),
        });
        newlyDownloadedPath = null;
      }

      if (process.env.NODE_ENV === "development") {
        console.log(
          `[PROXY] Extracting "${srtPath}" from ${archiveType.toUpperCase()} archive`,
        );
      }

      // Extract single requested SRT directly from file on disk
      const extractStart = Date.now();
      const contentBuffer = await extractSrtFileFromFile(archiveFilePath, srtPath);
      extractionDurationMs = Date.now() - extractStart;

      if (!contentBuffer) {
        globalMetrics.recordProxyRequest({
          durationMs: Date.now() - proxyStart,
          extractionDurationMs,
          statusCode: 404,
        });
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

      globalMetrics.recordProxyRequest({
        durationMs: Date.now() - proxyStart,
        extractionDurationMs,
        statusCode: 200,
      });

      res.set("Access-Control-Allow-Origin", "*");
      res.set("Content-Type", "text/vtt; charset=utf-8");
      res.set("Cache-Control", "public, max-age=43200");
      res.send(contentStr);
    } catch (error) {
      if (newlyDownloadedPath) {
        try {
          if (fs.existsSync(newlyDownloadedPath)) {
            fs.unlinkSync(newlyDownloadedPath);
          }
        } catch (e) {}
      }
      const statusCode = error.response?.status || 500;
      globalMetrics.recordProxyRequest({
        durationMs: Date.now() - proxyStart,
        extractionDurationMs,
        statusCode,
        error,
      });
      res
        .status(statusCode)
        .send(error.response?.data || `Proxy error: ${error.message}`);
    }
  },
);

module.exports = router;
