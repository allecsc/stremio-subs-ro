/**
 * @name Subs.ro Rate Limiter
 * @description Per-user rate limiting with centralized tick loop for high scalability.
 * Each API key gets its own isolated limiter, but tick intervals are managed globally
 * to prevent event loop lag with thousands of active users.
 *
 * Search: 1 request/second (sequential)
 * Download: Up to 3 concurrent requests with 200ms stagger
 */

const axios = require("axios");
const fs = require("fs");
const { globalMetrics } = require("./metrics");

// Timestamp helper
const ts = () => new Date().toISOString().slice(11, 23);

class SubsRoRateLimiter {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.lastUsed = Date.now();

    this.queues = {
      search: {
        queue: [],
        processing: false,
        lastRequest: 0,
        interval: 1000, // 1 request per second
      },
      download: {
        queue: [],
        activeCount: 0,
        maxConcurrent: 3, // Allow 3 parallel downloads
        staggerMs: 200, // 200ms between starting each download
        lastStart: 0,
      },
    };

    this.timeout = 30000;
    this.maxRetries = 2;
  }

  // NOTE: Intervals are no longer managed here to avoid 1000s of timers

  async searchRequest(url, options = {}) {
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      this.queues.search.queue.push({
        url,
        options,
        resolve,
        reject,
        retries: 0,
      });
    });
  }

  async downloadArchive(url, options = {}) {
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      this.queues.download.queue.push({
        url,
        options: { ...options, responseType: "arraybuffer" },
        resolve,
        reject,
        retries: 0,
      });
    });
  }

  async downloadArchiveToFile(url, destPath, options = {}) {
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      this.queues.download.queue.push({
        url,
        destPath,
        options: { ...options, responseType: "stream" },
        resolve,
        reject,
        retries: 0,
      });
    });
  }

  /**
   * Called by the central manager tick loop
   */
  processTick() {
    this.processSearchQueue();
    this.processDownloadQueue();
  }

  /**
   * Process search queue (sequential, 1/sec)
   */
  async processSearchQueue() {
    const config = this.queues.search;
    if (config.queue.length === 0 || config.processing) return;

    const now = Date.now();
    if (now - config.lastRequest < config.interval) return;

    config.processing = true;
    config.lastRequest = now;

    const request = config.queue.shift();
    try {
      await this.executeRequest(request, "SEARCH");
    } finally {
      config.processing = false;
    }
  }

  /**
   * Process download queue (parallel with stagger)
   */
  async processDownloadQueue() {
    const config = this.queues.download;
    if (config.queue.length === 0) return;
    if (config.activeCount >= config.maxConcurrent) return;

    const now = Date.now();
    if (now - config.lastStart < config.staggerMs) return;

    // Check global limit before starting attempt or shifting from queue
    if (this.manager && !this.manager.tryAcquireDownloadSlot()) {
      return;
    }

    config.lastStart = now;
    config.activeCount++;
    globalMetrics.recordLimiterObservation({ maxUserActive: config.activeCount });

    const request = config.queue.shift();

    // Execute without blocking the loop
    this.executeRequest(request, "DOWNLOAD").finally(() => {
      config.activeCount--;
      // Release global slot
      if (this.manager) {
        this.manager.releaseDownloadSlot();
      }
    });
  }

  setManager(manager) {
    this.manager = manager;
  }

  async executeRequest(request, queueName) {
    const { url, destPath, options, resolve, reject, retries } = request;
    const downloadStart = Date.now();

    // Only log errors in production to keep logs clean
    const keyPrefix = this.apiKey.slice(0, 8);
    // const logPrefix = `[${ts()}] [${keyPrefix}] [${queueName}]`; // Disabled for prod performance

    try {
      if (destPath) {
        const MAX_ARCHIVE_SIZE = 10 * 1024 * 1024; // 10 MiB limit

        const response = await axios.get(url, {
          ...options,
          responseType: "stream",
          timeout: this.timeout,
        });

        const contentLength = Number(response.headers?.["content-length"]);
        if (contentLength && contentLength > MAX_ARCHIVE_SIZE) {
          if (response.data && typeof response.data.destroy === "function") {
            response.data.destroy();
          }
          globalMetrics.recordOversizedArchiveReject();
          throw new Error(
            `Archive exceeds 10MB limit (Content-Length: ${contentLength})`,
          );
        }

        let bytesTotal = 0;
        await new Promise((res, rej) => {
          let bytesReceived = 0;
          const writer = fs.createWriteStream(destPath);
          let finished = false;

          const cleanupFile = () => {
            try {
              if (fs.existsSync(destPath)) {
                fs.unlinkSync(destPath);
              }
            } catch (e) {}
          };

          response.data.on("data", (chunk) => {
            bytesReceived += chunk.length;
            bytesTotal = bytesReceived;
            if (bytesReceived > MAX_ARCHIVE_SIZE) {
              finished = true;
              response.data.destroy();
              writer.destroy();
              cleanupFile();
              globalMetrics.recordOversizedArchiveReject();
              rej(
                new Error(
                  `Archive exceeds 10MB limit (Received: ${bytesReceived})`,
                ),
              );
            }
          });

          response.data.on("error", (err) => {
            if (!finished) {
              finished = true;
              writer.destroy();
              cleanupFile();
              rej(err);
            }
          });

          writer.on("error", (err) => {
            if (!finished) {
              finished = true;
              cleanupFile();
              rej(err);
            }
          });

          writer.on("finish", () => {
            if (!finished) {
              finished = true;
              res();
            }
          });

          response.data.pipe(writer);
        });

        globalMetrics.recordArchiveDownload({
          durationMs: Date.now() - downloadStart,
          bytes: bytesTotal,
          success: true,
        });

        resolve({ filePath: destPath });
      } else {
        const response = await axios.get(url, {
          ...options,
          timeout: this.timeout,
          maxContentLength: 10 * 1024 * 1024,
        });

        resolve(response.data);
      }
    } catch (error) {
      if (destPath) {
        globalMetrics.recordArchiveDownload({
          durationMs: Date.now() - downloadStart,
          success: false,
          error,
        });
        try {
          if (fs.existsSync(destPath)) {
            fs.unlinkSync(destPath);
          }
        } catch (e) {}
      }

      const status = error.response?.status;
      const isTransient =
        error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNABORTED";

      const logPrefix = `[${ts()}] [${queueName}]`;

      if (isTransient && retries < this.maxRetries) {
        console.warn(
          `${logPrefix} ${error.code || "timeout"}, retry ${retries + 1}/${this.maxRetries}`,
        );
        globalMetrics.recordRetry(queueName === "SEARCH" ? "search" : "download");
        request.retries = retries + 1;
        // Re-add to front based on queue type
        if (queueName === "SEARCH") {
          this.queues.search.queue.unshift(request);
        } else {
          this.queues.download.queue.unshift(request);
        }
        return;
      }

      if (status === 429) {
        console.error(`${logPrefix} upstream 429`);
      } else if (status === 401 || status === 403) {
        console.error(`${logPrefix} upstream ${status}`);
      } else if (isTransient) {
        console.error(`${logPrefix} ${error.code || "timeout"} (retries exhausted)`);
      } else {
        console.error(`${logPrefix} upstream ${status || error.code || "error"}`);
      }

      reject(error);
    }
  }

  hasLiveWork() {
    return (
      this.queues.search.processing ||
      this.queues.search.queue.length > 0 ||
      this.queues.download.activeCount > 0 ||
      this.queues.download.queue.length > 0
    );
  }

  getQueueStatus() {
    return {
      search: this.queues.search.queue.length,
      download: this.queues.download.queue.length,
      activeDownloads: this.queues.download.activeCount,
    };
  }
}

/**
 * Manager for per-user rate limiters with CENTRALIZED TICK LOOP.
 * Replaces 1000s of timers with a single master loop.
 */
class RateLimiterManager {
  constructor() {
    this.limiters = new Map(); // apiKey -> SubsRoRateLimiter
    this.maxLimiters = 500;
    this.idleTimeoutMs = 30 * 60 * 1000; // 30 minutes

    // Lifecycle telemetry stats
    this.stats = {
      idleEvictions: 0,
      busyEvictionAttempts: 0,
      actualBusyEvictions: 0,
      overCapacityCount: 0,
      peakLimiters: 0,
    };

    // Global Concurrency Limit (Skeptic Guard)
    this.globalActiveDownloads = 0;
    this.MAX_GLOBAL_DOWNLOADS = 500; // Max concurrent sockets server-wide

    // Single master loop for ALL limiters (Every 50ms)
    // 50ms = 20 ticks/sec, sufficient for 200ms stagger and 1s interval
    this._masterInterval = setInterval(() => this.tick(), 50);
    if (this._masterInterval.unref) this._masterInterval.unref();

    // Cleanup idle limiters every 10 minutes
    const cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    if (cleanupInterval.unref) cleanupInterval.unref();
  }

  /**
   * The Master Heartbeat
   * Iterates all active limiters and processes their queues.
   * Efficient: Iterating 5000 items in memory takes <1ms.
   */
  tick() {
    for (const limiter of this.limiters.values()) {
      limiter.processTick();
    }
  }

  tryAcquireDownloadSlot() {
    if (this.globalActiveDownloads < this.MAX_GLOBAL_DOWNLOADS) {
      this.globalActiveDownloads++;
      globalMetrics.recordLimiterObservation({
        globalActive: this.globalActiveDownloads,
      });
      return true;
    }
    return false;
  }

  releaseDownloadSlot() {
    if (this.globalActiveDownloads > 0) {
      this.globalActiveDownloads--;
    }
  }

  /**
   * Get or create a limiter for the given API key
   */
  getLimiter(apiKey) {
    if (!apiKey) {
      throw new Error("API key is required for rate limiting");
    }

    if (this.limiters.has(apiKey)) {
      const limiter = this.limiters.get(apiKey);
      limiter.lastUsed = Date.now();
      return limiter;
    }

    // Evict oldest if at capacity
    if (this.limiters.size >= this.maxLimiters) {
      this.evictOldest();
    }

    // Create new limiter (No internal timers anymore!)
    const limiter = new SubsRoRateLimiter(apiKey);
    limiter.setManager(this); // Link to manager for global limits
    this.limiters.set(apiKey, limiter);

    if (this.limiters.size > this.stats.peakLimiters) {
      this.stats.peakLimiters = this.limiters.size;
    }

    if (process.env.NODE_ENV === "development") {
      console.log(
        `[${ts()}] [RateLimiterManager] Created limiter for key ${apiKey.slice(
          0,
          8,
        )}... (total: ${this.limiters.size})`,
      );
    }

    return limiter;
  }

  /**
   * Remove limiters that have been idle for too long
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [apiKey, limiter] of this.limiters.entries()) {
      // Never clean up a limiter that has active or queued work
      if (limiter.hasLiveWork()) {
        continue;
      }

      if (now - limiter.lastUsed > this.idleTimeoutMs) {
        // No destroy needed since no timers
        this.limiters.delete(apiKey);
        cleaned++;
      }
    }

    if (cleaned > 0 && process.env.NODE_ENV === "development") {
      console.log(
        `[${ts()}] [RateLimiterManager] Cleaned up ${cleaned} idle limiters (remaining: ${
          this.limiters.size
        })`,
      );
    }
  }

  /**
   * Evict the oldest (least recently used) truly IDLE limiter
   */
  evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [apiKey, limiter] of this.limiters.entries()) {
      // Never evict a limiter that has active or queued work
      if (limiter.hasLiveWork()) {
        continue;
      }

      if (limiter.lastUsed < oldestTime) {
        oldestTime = limiter.lastUsed;
        oldestKey = apiKey;
      }
    }

    if (oldestKey) {
      this.limiters.delete(oldestKey);
      this.stats.idleEvictions++;
      if (process.env.NODE_ENV === "development") {
        console.log(
          `[${ts()}] [RateLimiterManager] Evicted oldest idle limiter (key: ${oldestKey.slice(
            0,
            8,
          )}...)`,
        );
      }
      return true;
    }

    // If all limiters currently have live work, do not evict any of them.
    // Allow the map to temporarily exceed maxLimiters until work finishes.
    this.stats.busyEvictionAttempts++;
    this.stats.overCapacityCount++;
    return false;
  }

  /**
   * Get stats for debugging
   */
  getStats() {
    return {
      activeLimiters: this.limiters.size,
      maxLimiters: this.maxLimiters,
      stats: this.stats,
    };
  }
}

// Singleton manager instance
const limiterManager = new RateLimiterManager();

// Helper function to get limiter for an API key
const getLimiter = (apiKey) => limiterManager.getLimiter(apiKey);

module.exports = {
  SubsRoRateLimiter,
  RateLimiterManager,
  limiterManager,
  getLimiter,
};
