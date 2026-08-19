const crypto = require("crypto");
const os = require("os");

const APP_VERSION = "2.1.0-rc.1";
const INSTANCE_ID = `inst_${process.pid}_${Date.now().toString(36)}`;
const START_TIME = new Date().toISOString();

/**
 * Anonymously hash an API key using SHA-256.
 * Zero PII or raw key material is ever logged or exposed.
 *
 * @param {string} apiKey
 * @returns {string|null} 64-char hex string or null
 */
function hashApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return null;
  return crypto.createHash("sha256").update(apiKey.trim()).digest("hex");
}

function getTodayUtcString() {
  return new Date().toISOString().slice(0, 10);
}

function createLatencyTracker() {
  return {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    buckets: {
      "<500ms": 0,
      "500ms-1s": 0,
      "1-2s": 0,
      "2-5s": 0,
      "5-10s": 0,
      "10-20s": 0,
      "20-30s": 0,
      "30s+": 0,
    },
  };
}

function recordLatency(tracker, durationMs) {
  if (typeof durationMs !== "number" || isNaN(durationMs) || durationMs < 0) return;
  tracker.count++;
  tracker.totalMs += durationMs;
  if (durationMs > tracker.maxMs) tracker.maxMs = durationMs;

  if (durationMs < 500) tracker.buckets["<500ms"]++;
  else if (durationMs < 1000) tracker.buckets["500ms-1s"]++;
  else if (durationMs < 2000) tracker.buckets["1-2s"]++;
  else if (durationMs < 5000) tracker.buckets["2-5s"]++;
  else if (durationMs < 10000) tracker.buckets["5-10s"]++;
  else if (durationMs < 20000) tracker.buckets["10-20s"]++;
  else if (durationMs < 30000) tracker.buckets["20-30s"]++;
  else tracker.buckets["30s+"]++;
}

function createEmptyDailyMetrics(dateStr) {
  return {
    date: dateStr,
    activeUsers: new Set(), // Set of SHA-256 hashes

    // Traffic counts
    subtitleRequests: 0,
    proxyRequests: 0,
    successfulRequests: 0,
    emptySubtitleResponses: 0,
    failedRequests: 0,

    // Latency trackers
    subtitleDuration: createLatencyTracker(),
    searchDuration: createLatencyTracker(),
    proxyDuration: createLatencyTracker(),
    extractionDuration: createLatencyTracker(),

    // Proxy status classes
    proxyStatus: {
      "200": 0,
      "404": 0,
      other4xx: 0,
      "5xx": 0,
    },

    // Cache effectiveness (separated)
    responseCache: { hit: 0, miss: 0 },
    archiveCache: { hit: 0, miss: 0 },
    singleflight: { leaders: 0, joined: 0 },
    vttCache: { hit: 0, miss: 0 },

    // Upstream work
    subsroSearches: 0,
    archiveDownloads: 0,
    archiveDownloadFailures: 0,
    totalCompressedBytesDownloaded: 0,
    downloadDuration: { count: 0, totalMs: 0, maxMs: 0 },
    zipParsed: 0,
    rarParsed: 0,
    corruptArchiveFailures: 0,
    oversizedArchiveRejects: 0,
    oversizedSelectedSrtRejects: 0,
    wrongSeasonSkipped: 0,
    forcedSplitFiltered: 0,
    usableSrtTracksDiscovered: 0,

    // Limiter / concurrency
    peakGlobalActiveDownloads: 0,
    peakQueuedDownloads: 0,
    maxObservedPerUserActive: 0,
    downloadRetries: 0,
    searchRetries: 0,
  };
}

class MetricsEngine {
  constructor() {
    this.appVersion = APP_VERSION;
    this.instanceId = INSTANCE_ID;
    this.startTime = START_TIME;

    this.currentDate = getTodayUtcString();
    this.today = createEmptyDailyMetrics(this.currentDate);

    this.liveActiveUsers = new Map(); // hash -> timestamp
    this.allTimeUserHashes = new Set(); // Persistent set of all unique hashed installs seen by this RC
    this.history = []; // Array of serialized daily summaries

    this.errors = new Map(); // groupKey -> { type, count, firstSeen, lastSeen, sampleMessage }

    // Bounded process/resource sample window (last 96 samples = 96 minutes)
    this.recentSamples = [];
    this.maxSamples = 96;

    this.peakResources = {
      rss: 0,
      heapUsed: 0,
      heapTotal: 0,
      external: 0,
      globalActiveDownloads: 0,
      queuedDownloads: 0,
    };

    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuSampleTime = Date.now();
  }

  _checkDateRollover() {
    const todayStr = getTodayUtcString();
    if (todayStr !== this.currentDate) {
      this.rolloverDay(todayStr);
    }
  }

  rolloverDay(newDateStr = getTodayUtcString()) {
    try {
      const summary = this.serializeDaySummary(this.today);
      this.history.unshift(summary);
      if (this.history.length > 30) this.history.pop();

      this.currentDate = newDateStr;
      this.today = createEmptyDailyMetrics(newDateStr);
    } catch (e) {}
  }

  serializeDaySummary(d) {
    const totalRequests = d.subtitleRequests + d.proxyRequests;
    const avgSubLat = d.subtitleDuration.count > 0 ? Math.round(d.subtitleDuration.totalMs / d.subtitleDuration.count) : 0;
    const avgProxyLat = d.proxyDuration.count > 0 ? Math.round(d.proxyDuration.totalMs / d.proxyDuration.count) : 0;

    return {
      date: d.date,
      uniqueUsers: d.activeUsers.size,
      totalRequests,
      subtitleRequests: d.subtitleRequests,
      proxyRequests: d.proxyRequests,
      successfulRequests: d.successfulRequests,
      emptySubtitleResponses: d.emptySubtitleResponses,
      failedRequests: d.failedRequests,
      avgSubtitleLatencyMs: avgSubLat,
      avgProxyLatencyMs: avgProxyLat,
      responseCacheHitRate: d.responseCache.hit + d.responseCache.miss > 0 ? Math.round((d.responseCache.hit / (d.responseCache.hit + d.responseCache.miss)) * 100) : 0,
      archiveCacheHitRate: d.archiveCache.hit + d.archiveCache.miss > 0 ? Math.round((d.archiveCache.hit / (d.archiveCache.hit + d.archiveCache.miss)) * 100) : 0,
      vttCacheHitRate: d.vttCache.hit + d.vttCache.miss > 0 ? Math.round((d.vttCache.hit / (d.vttCache.hit + d.vttCache.miss)) * 100) : 0,
      archiveDownloads: d.archiveDownloads,
      singleflightJoined: d.singleflight.joined,
      zipParsed: d.zipParsed,
      rarParsed: d.rarParsed,
      corruptFailures: d.corruptArchiveFailures,
    };
  }

  // --- USER TRACKING ---

  recordActiveUser(apiKey) {
    if (!apiKey) return;
    try {
      this._checkDateRollover();
      const hash = hashApiKey(apiKey);
      if (!hash) return;

      const now = Date.now();
      this.liveActiveUsers.set(hash, now);
      this.today.activeUsers.add(hash);
      this.allTimeUserHashes.add(hash);

      // Lightweight lazy purge of live active users older than 30m
      if (this.liveActiveUsers.size > 2000) {
        const threshold = now - 30 * 60 * 1000;
        for (const [h, ts] of this.liveActiveUsers.entries()) {
          if (ts < threshold) this.liveActiveUsers.delete(h);
        }
      }
    } catch (e) {}
  }

  getActiveUsers15m() {
    try {
      const now = Date.now();
      const threshold = now - 15 * 60 * 1000;
      let count = 0;
      for (const ts of this.liveActiveUsers.values()) {
        if (ts >= threshold) count++;
      }
      return count;
    } catch (e) {
      return 0;
    }
  }

  // --- SUBTITLE & LATENCY TRACKING ---

  recordSubtitleRequest({ durationMs, searchDurationMs, resultCount = 0, success = true, error = null }) {
    try {
      this._checkDateRollover();
      this.today.subtitleRequests++;
      if (success) {
        this.today.successfulRequests++;
        if (resultCount === 0) this.today.emptySubtitleResponses++;
      } else {
        this.today.failedRequests++;
        if (error) this.recordError("subtitleRequestFailed", error);
      }

      if (typeof durationMs === "number") recordLatency(this.today.subtitleDuration, durationMs);
      if (typeof searchDurationMs === "number") recordLatency(this.today.searchDuration, searchDurationMs);
    } catch (e) {}
  }

  recordProxyRequest({ durationMs, extractionDurationMs, statusCode = 200, error = null }) {
    try {
      this._checkDateRollover();
      this.today.proxyRequests++;
      if (statusCode >= 200 && statusCode < 300) {
        this.today.successfulRequests++;
        this.today.proxyStatus["200"]++;
      } else if (statusCode === 404) {
        this.today.proxyStatus["404"]++;
      } else if (statusCode >= 400 && statusCode < 500) {
        this.today.proxyStatus.other4xx++;
      } else if (statusCode >= 500) {
        this.today.failedRequests++;
        this.today.proxyStatus["5xx"]++;
        if (error) this.recordError("proxy5xx", error);
      }

      if (typeof durationMs === "number") recordLatency(this.today.proxyDuration, durationMs);
      if (typeof extractionDurationMs === "number") recordLatency(this.today.extractionDuration, extractionDurationMs);
    } catch (e) {}
  }

  // --- CACHE EFFECTIVENESS ---

  recordCacheHit(type) {
    try {
      this._checkDateRollover();
      if (this.today[type]) this.today[type].hit++;
    } catch (e) {}
  }

  recordCacheMiss(type) {
    try {
      this._checkDateRollover();
      if (this.today[type]) this.today[type].miss++;
    } catch (e) {}
  }

  recordSingleflight(role) {
    try {
      this._checkDateRollover();
      if (role === "leader" || role === "leaders") this.today.singleflight.leaders++;
      else if (role === "joined") this.today.singleflight.joined++;
    } catch (e) {}
  }

  // --- UPSTREAM & ARCHIVE TRACKING ---

  recordSubsroSearch() {
    try {
      this._checkDateRollover();
      this.today.subsroSearches++;
    } catch (e) {}
  }

  recordArchiveDownload({ durationMs = 0, bytes = 0, success = true, error = null }) {
    try {
      this._checkDateRollover();
      if (success) {
        this.today.archiveDownloads++;
        this.today.totalCompressedBytesDownloaded += bytes || 0;
        if (typeof durationMs === "number") {
          this.today.downloadDuration.count++;
          this.today.downloadDuration.totalMs += durationMs;
          if (durationMs > this.today.downloadDuration.maxMs) this.today.downloadDuration.maxMs = durationMs;
        }
      } else {
        this.today.archiveDownloadFailures++;
        if (error) this.recordError("archiveDownloadFailure", error);
      }
    } catch (e) {}
  }

  recordArchiveParsed(type) {
    try {
      this._checkDateRollover();
      if (type === "zip") this.today.zipParsed++;
      else if (type === "rar") this.today.rarParsed++;
    } catch (e) {}
  }

  recordCorruptArchive(type, error) {
    try {
      this._checkDateRollover();
      this.today.corruptArchiveFailures++;
      this.recordError(type === "rar" ? "corruptRar" : "corruptZip", error);
    } catch (e) {}
  }

  recordOversizedArchiveReject() {
    try {
      this._checkDateRollover();
      this.today.oversizedArchiveRejects++;
      this.recordError("oversizedArchive", "Declared/streamed archive exceeded 10 MiB limit");
    } catch (e) {}
  }

  recordOversizedSelectedSrtReject() {
    try {
      this._checkDateRollover();
      this.today.oversizedSelectedSrtRejects++;
      this.recordError("oversizedSelectedSrt", "Selected SRT track exceeded 10 MiB uncompressed limit");
    } catch (e) {}
  }

  recordWrongSeasonSkipped() {
    try {
      this._checkDateRollover();
      this.today.wrongSeasonSkipped++;
    } catch (e) {}
  }

  recordForcedSplitFiltered() {
    try {
      this._checkDateRollover();
      this.today.forcedSplitFiltered++;
    } catch (e) {}
  }

  recordUsableSrtTracks(count) {
    try {
      this._checkDateRollover();
      this.today.usableSrtTracksDiscovered += count || 0;
    } catch (e) {}
  }

  // --- LIMITER & CONCURRENCY ---

  recordLimiterObservation({ globalActive = 0, queued = 0, maxUserActive = 0 }) {
    try {
      this._checkDateRollover();
      if (globalActive > this.today.peakGlobalActiveDownloads) this.today.peakGlobalActiveDownloads = globalActive;
      if (queued > this.today.peakQueuedDownloads) this.today.peakQueuedDownloads = queued;
      if (maxUserActive > this.today.maxObservedPerUserActive) this.today.maxObservedPerUserActive = maxUserActive;

      if (globalActive > this.peakResources.globalActiveDownloads) this.peakResources.globalActiveDownloads = globalActive;
      if (queued > this.peakResources.queuedDownloads) this.peakResources.queuedDownloads = queued;
    } catch (e) {}
  }

  recordRetry(type) {
    try {
      this._checkDateRollover();
      if (type === "download") this.today.downloadRetries++;
      else if (type === "search") this.today.searchRetries++;
    } catch (e) {}
  }

  // --- GROUPED ERRORS ---

  recordError(groupType, err) {
    try {
      const now = new Date().toISOString();
      const sanitizedMsg = typeof err === "string" ? err.slice(0, 150) : (err?.message || "Unknown error").slice(0, 150);

      const existing = this.errors.get(groupType);
      if (existing) {
        existing.count++;
        existing.lastSeen = now;
        existing.sampleMessage = sanitizedMsg;
      } else {
        this.errors.set(groupType, {
          type: groupType,
          count: 1,
          firstSeen: now,
          lastSeen: now,
          sampleMessage: sanitizedMsg,
        });
      }
    } catch (e) {}
  }

  // --- 60-SECOND PROCESS & RESOURCE SAMPLER ---

  sampleResources(opts = {}) {
    try {
      if (!opts || typeof opts !== "object") opts = {};
      const {
        archiveCacheEntries = 0,
        stagedFileCount = 0,
        stagedTotalBytes = 0,
        pendingPackages = 0,
        pendingRequests = 0,
        activeLimiters = 0,
        globalActiveDownloads = 0,
        queuedDownloads = 0,
        eventLoopLagMs = 0,
      } = opts;
      const mem = process.memoryUsage();
      const now = Date.now();
      const timeDiff = Math.max(1, now - this.lastCpuSampleTime);
      const cpuUsage = process.cpuUsage(this.lastCpuUsage);
      this.lastCpuUsage = process.cpuUsage();
      this.lastCpuSampleTime = now;

      const cpuTotalMs = Math.round((cpuUsage.user + cpuUsage.system) / 1000);

      if (mem.rss > this.peakResources.rss) this.peakResources.rss = mem.rss;
      if (mem.heapUsed > this.peakResources.heapUsed) this.peakResources.heapUsed = mem.heapUsed;
      if (mem.heapTotal > this.peakResources.heapTotal) this.peakResources.heapTotal = mem.heapTotal;
      if (mem.external > this.peakResources.external) this.peakResources.external = mem.external;

      const sample = {
        ts: new Date().toISOString(),
        rssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
        heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
        heapTotalMb: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
        externalMb: Number((mem.external / 1024 / 1024).toFixed(2)),
        cpuIntervalMs: cpuTotalMs,
        eventLoopLagMs: Number(eventLoopLagMs.toFixed(2)),
        archiveCacheEntries,
        stagedFileCount,
        stagedTotalMb: Number((stagedTotalBytes / 1024 / 1024).toFixed(2)),
        pendingPackages,
        pendingRequests,
        activeLimiters,
        globalActiveDownloads,
        queuedDownloads,
      };

      this.recentSamples.push(sample);
      if (this.recentSamples.length > this.maxSamples) {
        this.recentSamples.shift();
      }

      this.recordLimiterObservation({ globalActive: globalActiveDownloads, queued: queuedDownloads });
      return sample;
    } catch (e) {
      return null;
    }
  }

  // --- EXPORT SNAPSHOT ---

  exportSnapshot() {
    try {
      const uptimeSec = Math.round(process.uptime());
      const t = this.today;
      const mem = process.memoryUsage();

      return {
        header: "#SUBSRO_TELEMETRY_V2",
        appVersion: this.appVersion,
        instanceId: this.instanceId,
        startTime: this.startTime,
        exportedAt: new Date().toISOString(),
        uptimeSeconds: uptimeSec,
        users: {
          activeNow15m: this.getActiveUsers15m(),
          uniqueToday: t.activeUsers.size,
          uniqueRcInstalls: this.allTimeUserHashes.size,
        },
        traffic: {
          subtitleRequests: t.subtitleRequests,
          proxyRequests: t.proxyRequests,
          successfulRequests: t.successfulRequests,
          emptySubtitleResponses: t.emptySubtitleResponses,
          failedRequests: t.failedRequests,
        },
        latency: {
          subtitle: {
            avgMs: t.subtitleDuration.count > 0 ? Math.round(t.subtitleDuration.totalMs / t.subtitleDuration.count) : 0,
            maxMs: t.subtitleDuration.maxMs,
            buckets: t.subtitleDuration.buckets,
          },
          search: {
            avgMs: t.searchDuration.count > 0 ? Math.round(t.searchDuration.totalMs / t.searchDuration.count) : 0,
            maxMs: t.searchDuration.maxMs,
            buckets: t.searchDuration.buckets,
          },
          proxy: {
            avgMs: t.proxyDuration.count > 0 ? Math.round(t.proxyDuration.totalMs / t.proxyDuration.count) : 0,
            maxMs: t.proxyDuration.maxMs,
            buckets: t.proxyDuration.buckets,
          },
          extraction: {
            avgMs: t.extractionDuration.count > 0 ? Math.round(t.extractionDuration.totalMs / t.extractionDuration.count) : 0,
            maxMs: t.extractionDuration.maxMs,
            buckets: t.extractionDuration.buckets,
          },
          proxyStatus: t.proxyStatus,
        },
        cache: {
          responseCache: {
            hit: t.responseCache.hit,
            miss: t.responseCache.miss,
            hitRate: t.responseCache.hit + t.responseCache.miss > 0 ? Math.round((t.responseCache.hit / (t.responseCache.hit + t.responseCache.miss)) * 100) : 0,
          },
          archiveCache: {
            hit: t.archiveCache.hit,
            miss: t.archiveCache.miss,
            hitRate: t.archiveCache.hit + t.archiveCache.miss > 0 ? Math.round((t.archiveCache.hit / (t.archiveCache.hit + t.archiveCache.miss)) * 100) : 0,
          },
          singleflight: {
            leaders: t.singleflight.leaders,
            joined: t.singleflight.joined,
          },
          vttCache: {
            hit: t.vttCache.hit,
            miss: t.vttCache.miss,
            hitRate: t.vttCache.hit + t.vttCache.miss > 0 ? Math.round((t.vttCache.hit / (t.vttCache.hit + t.vttCache.miss)) * 100) : 0,
          },
        },
        upstream: {
          searches: t.subsroSearches,
          downloads: t.archiveDownloads,
          downloadFailures: t.archiveDownloadFailures,
          totalCompressedMb: Number((t.totalCompressedBytesDownloaded / 1024 / 1024).toFixed(2)),
          avgDownloadMs: t.downloadDuration.count > 0 ? Math.round(t.downloadDuration.totalMs / t.downloadDuration.count) : 0,
          maxDownloadMs: t.downloadDuration.maxMs,
          zipParsed: t.zipParsed,
          rarParsed: t.rarParsed,
          corruptFailures: t.corruptArchiveFailures,
          oversizedArchiveRejects: t.oversizedArchiveRejects,
          oversizedSelectedSrtRejects: t.oversizedSelectedSrtRejects,
          wrongSeasonSkipped: t.wrongSeasonSkipped,
          forcedSplitFiltered: t.forcedSplitFiltered,
          usableSrtTracksDiscovered: t.usableSrtTracksDiscovered,
        },
        limiter: {
          peakGlobalActive: t.peakGlobalActiveDownloads,
          peakQueued: t.peakQueuedDownloads,
          maxObservedPerUserActive: t.maxObservedPerUserActive,
          downloadRetries: t.downloadRetries,
          searchRetries: t.searchRetries,
        },
        resources: {
          currentRssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
          currentHeapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
          peakRssMb: Number((this.peakResources.rss / 1024 / 1024).toFixed(2)),
          peakHeapUsedMb: Number((this.peakResources.heapUsed / 1024 / 1024).toFixed(2)),
        },
        errors: Array.from(this.errors.values()),
        recentSamples: this.recentSamples,
        history: this.history,
      };
    } catch (e) {
      return { header: "#SUBSRO_TELEMETRY_V2", error: e.message };
    }
  }
}

const globalMetrics = new MetricsEngine();

module.exports = {
  APP_VERSION,
  INSTANCE_ID,
  hashApiKey,
  globalMetrics,
  MetricsEngine,
};
