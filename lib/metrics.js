const crypto = require("crypto");

/**
 * Anonymously hash an API key using SHA-256.
 * Zero PII or raw key material is retained.
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

function createEmptyBucket(dateStr) {
  return {
    date: dateStr,
    activeUsers: new Set(),
    searchRequests: 0,
    proxyRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    searchLatencyTotalMs: 0,
    proxyLatencyTotalMs: 0,
    archiveFormats: {
      zip: 0,
      rar: 0,
    },
    matchTiers: {
      exact: 0,     // Tier 1 (100)
      highSync: 0,  // Tiers 2-4 (85-99)
      medSync: 0,   // Tiers 5-7 (70-84)
      lowSync: 0,   // Tiers 8-9 (45-69)
      fallback: 0,  // Tier 10 (1-20)
    },
    upstreamErrors: {
      quota429: 0,
      invalid403: 0,
      networkErrors: 0,
    },
  };
}

class MetricsEngine {
  constructor(maxHistoryDays = 30) {
    this.maxHistoryDays = maxHistoryDays;
    this.currentDate = getTodayUtcString();
    this.today = createEmptyBucket(this.currentDate);
    this.liveActiveUsers = new Map(); // hash -> lastSeenTimestamp
    this.history = []; // Array of serialized daily summaries
    this.errorLog = []; // Array of 7-day distinct error diagnostic objects
  }

  _checkDateRollover() {
    const todayStr = getTodayUtcString();
    if (todayStr !== this.currentDate) {
      this.rolloverDay(todayStr, this.currentDate);
    }
  }

  /**
   * Record a structured error diagnostic entry (grouped by signature)
   */
  recordError({ type = "UNKNOWN_ERROR", message = "", stack = "", context = "" }) {
    try {
      this.pruneErrors(7);
      const cleanMsg = String(message || "Unknown error").slice(0, 250);
      const cleanType = String(type || "UNKNOWN_ERROR").slice(0, 50);
      const signature = `${cleanType}:${cleanMsg}`.trim();
      const nowIso = new Date().toISOString();
      const nowMs = Date.now();

      const existing = this.errorLog.find((e) => e.signature === signature);
      if (existing) {
        existing.count++;
        existing.lastSeen = nowIso;
        existing.lastSeenMs = nowMs;
        if (context) existing.context = String(context).slice(0, 100);
        if (stack) existing.stackSnippet = String(stack).slice(0, 600);
      } else {
        this.errorLog.unshift({
          signature,
          type: cleanType,
          message: cleanMsg,
          stackSnippet: stack ? String(stack).slice(0, 600) : "",
          context: context ? String(context).slice(0, 100) : "",
          count: 1,
          firstSeen: nowIso,
          lastSeen: nowIso,
          lastSeenMs: nowMs,
        });

        // Bounded safety cap of 200 distinct signatures
        if (this.errorLog.length > 200) {
          this.errorLog.length = 200;
        }
      }
    } catch (_) {
      // Isolate logging errors
    }
  }

  /**
   * Prune error diagnostic records older than maxDays (default: 7 days)
   */
  pruneErrors(maxDays = 7) {
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    this.errorLog = this.errorLog.filter((e) => e.lastSeenMs >= cutoff);
  }

  /**
   * Prune active users seen more than 15 minutes ago
   */
  pruneLiveActive(now = Date.now()) {
    const CUTOFF = 15 * 60 * 1000; // 15 minutes
    for (const [hash, timestamp] of this.liveActiveUsers.entries()) {
      if (now - timestamp > CUTOFF) {
        this.liveActiveUsers.delete(hash);
      }
    }
  }

  /**
   * Record a subtitle search event
   */
  recordSearch({ apiKey, durationMs = 0, topScore = null, upstreamError = null }) {
    try {
      this._checkDateRollover();
      const hash = hashApiKey(apiKey);
      const now = Date.now();

      if (hash) {
        this.today.activeUsers.add(hash);
        this.liveActiveUsers.set(hash, now);
      }

      this.today.searchRequests++;
      this.today.searchLatencyTotalMs += Math.max(0, durationMs);

      if (topScore !== null && topScore !== undefined) {
        if (topScore === 100) {
          this.today.matchTiers.exact++;
        } else if (topScore >= 85) {
          this.today.matchTiers.highSync++;
        } else if (topScore >= 70) {
          this.today.matchTiers.medSync++;
        } else if (topScore >= 45) {
          this.today.matchTiers.lowSync++;
        } else if (topScore > 0) {
          this.today.matchTiers.fallback++;
        }
      }

      if (upstreamError) {
        if (upstreamError === 429) this.today.upstreamErrors.quota429++;
        else if (upstreamError === 403) this.today.upstreamErrors.invalid403++;
        else this.today.upstreamErrors.networkErrors++;
      }
    } catch (_) {
      // Isolate telemetry errors from search path
    }
  }

  /**
   * Record a subtitle stream playback proxy event
   */
  recordProxy({ apiKey, durationMs = 0, cacheHit = false, archiveType = "zip", error = null }) {
    try {
      this._checkDateRollover();
      const hash = hashApiKey(apiKey);
      const now = Date.now();

      if (hash) {
        this.today.activeUsers.add(hash);
        this.liveActiveUsers.set(hash, now);
      }

      this.today.proxyRequests++;
      this.today.proxyLatencyTotalMs += Math.max(0, durationMs);

      if (cacheHit) {
        this.today.cacheHits++;
      } else {
        this.today.cacheMisses++;
      }

      if (archiveType === "rar") {
        this.today.archiveFormats.rar++;
      } else {
        this.today.archiveFormats.zip++;
      }

      if (error) {
        this.today.upstreamErrors.networkErrors++;
      }
    } catch (_) {
      // Isolate telemetry errors from proxy path
    }
  }

  /**
   * Complete the active day and archive into rolling history
   */
  rolloverDay(newDateStr = getTodayUtcString(), previousDateStr = this.currentDate) {
    const totalRequests = this.today.searchRequests + this.today.proxyRequests;
    const totalProxy = this.today.proxyRequests;
    const cacheHitRate = totalProxy > 0 ? Math.round((this.today.cacheHits / totalProxy) * 100) : 0;
    const avgSearchLatency = this.today.searchRequests > 0
      ? Math.round(this.today.searchLatencyTotalMs / this.today.searchRequests)
      : 0;
    const avgProxyLatency = this.today.proxyRequests > 0
      ? Math.round(this.today.proxyLatencyTotalMs / this.today.proxyRequests)
      : 0;

    const summary = {
      date: previousDateStr,
      uniqueActiveUsers: this.today.activeUsers.size,
      totalRequests,
      searchRequests: this.today.searchRequests,
      proxyRequests: this.today.proxyRequests,
      cacheHitRate,
      avgSearchLatencyMs: avgSearchLatency,
      avgProxyLatencyMs: avgProxyLatency,
      matchTiers: { ...this.today.matchTiers },
      archiveFormats: { ...this.today.archiveFormats },
      upstreamErrors: { ...this.today.upstreamErrors },
    };

    this.history.unshift(summary);
    this.trimHistory(this.maxHistoryDays);

    this.currentDate = newDateStr;
    this.today = createEmptyBucket(newDateStr);
  }

  trimHistory(maxDays = this.maxHistoryDays) {
    if (this.history.length > maxDays) {
      this.history.length = maxDays;
    }
  }

  /**
   * Get live metrics snapshot for dashboard and debugging
   */
  getLiveStats() {
    this.pruneLiveActive();
    this.pruneErrors(7);
    const totalRequests = this.today.searchRequests + this.today.proxyRequests;
    const totalProxy = this.today.proxyRequests;
    const cacheHitRate = totalProxy > 0 ? Math.round((this.today.cacheHits / totalProxy) * 100) : 0;
    const avgSearchLatency = this.today.searchRequests > 0
      ? Math.round(this.today.searchLatencyTotalMs / this.today.searchRequests)
      : 0;
    const avgProxyLatency = this.today.proxyRequests > 0
      ? Math.round(this.today.proxyLatencyTotalMs / this.today.proxyRequests)
      : 0;

    return {
      activeNow15m: this.liveActiveUsers.size,
      today: {
        date: this.currentDate,
        uniqueActiveUsers: this.today.activeUsers.size,
        totalRequests,
        searchRequests: this.today.searchRequests,
        proxyRequests: this.today.proxyRequests,
        cacheHits: this.today.cacheHits,
        cacheMisses: this.today.cacheMisses,
        cacheHitRate,
        avgSearchLatencyMs: avgSearchLatency,
        avgProxyLatencyMs: avgProxyLatency,
        matchTiers: { ...this.today.matchTiers },
        archiveFormats: { ...this.today.archiveFormats },
        upstreamErrors: { ...this.today.upstreamErrors },
      },
      history: [...this.history],
      recentErrors: [...this.errorLog],
    };
  }

  reset() {
    this.currentDate = getTodayUtcString();
    this.today = createEmptyBucket(this.currentDate);
    this.liveActiveUsers.clear();
    this.history = [];
    this.errorLog = [];
  }
}

// Global process-lifetime singleton instance
const globalMetrics = new MetricsEngine();

module.exports = {
  MetricsEngine,
  globalMetrics,
  hashApiKey,
};
