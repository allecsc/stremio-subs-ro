/**
 * @name Subs.ro Rate Limiter
 * @description Per-user rate limiting with automatic cleanup of idle limiters.
 * Each API key gets its own isolated limiter instance.
 *
 * Search: 1 request/second (sequential)
 * Download: Up to 3 concurrent requests with 200ms stagger
 */

const axios = require("axios");

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

    // Process queues
    this._searchInterval = setInterval(() => this.processSearchQueue(), 100);
    this._downloadInterval = setInterval(() => this.processDownloadQueue(), 50);
  }

  /**
   * Clean up intervals when limiter is destroyed
   */
  destroy() {
    clearInterval(this._searchInterval);
    clearInterval(this._downloadInterval);
  }

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

  /**
   * Fetch a page (HTML) with rate limiting.
   * Uses the search queue to avoid overwhelming the server.
   * @param {string} url - Page URL to fetch
   * @returns {Promise<string>} - HTML content
   */
  async fetchPage(url) {
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      this.queues.search.queue.push({
        url,
        options: {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; StremioSubsRo/1.0)",
            Accept: "text/html,application/xhtml+xml",
          },
        },
        resolve,
        reject,
        retries: 0,
      });
    });
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

    config.lastStart = now;
    config.activeCount++;

    const request = config.queue.shift();

    // Execute without blocking the loop
    this.executeRequest(request, "DOWNLOAD").finally(() => {
      config.activeCount--;
    });
  }

  async executeRequest(request, queueName) {
    const { url, options, resolve, reject, retries } = request;
    const keyPrefix = this.apiKey.slice(0, 8);
    const logPrefix = `[${ts()}] [${keyPrefix}] [${queueName}]`;

    try {
      const response = await axios.get(url, {
        ...options,
        timeout: this.timeout,
        maxContentLength: 15 * 1024 * 1024,
      });

      resolve(response.data);
    } catch (error) {
      const status = error.response?.status;
      const body = error.response?.data;
      const retryAfter = error.response?.headers?.["retry-after"];
      const isTransient =
        error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNABORTED";

      if (isTransient && retries < this.maxRetries) {
        console.warn(
          `${logPrefix} [${error.code}] Retrying (${retries + 1}/${
            this.maxRetries
          })...`
        );
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
        console.error(
          `${logPrefix} [429 RATE LIMITED] Retry-After: ${
            retryAfter || "not specified"
          }`
        );
      } else if (status === 401) {
        console.error(`${logPrefix} [401 UNAUTHORIZED] Invalid API key`);
      } else if (isTransient) {
        console.error(
          `${logPrefix} [${error.code}] ${error.message} (retries exhausted)`
        );
      } else {
        console.error(
          `${logPrefix} [ERROR ${status || error.code}] ${error.message}`
        );
      }

      console.error(`${logPrefix} URL: ${url}`);
      if (body) console.error(`${logPrefix} Body: ${JSON.stringify(body)}`);

      reject(error);
    }
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
 * Manager for per-user rate limiters
 * Creates isolated limiters per API key with automatic cleanup
 */
class RateLimiterManager {
  constructor() {
    this.limiters = new Map(); // apiKey -> SubsRoRateLimiter
    this.maxLimiters = 500;
    this.idleTimeoutMs = 30 * 60 * 1000; // 30 minutes

    // Cleanup idle limiters every 10 minutes
    setInterval(() => this.cleanup(), 10 * 60 * 1000);
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

    // Create new limiter
    const limiter = new SubsRoRateLimiter(apiKey);
    this.limiters.set(apiKey, limiter);

    console.log(
      `[${ts()}] [RateLimiterManager] Created limiter for key ${apiKey.slice(
        0,
        8
      )}... (total: ${this.limiters.size})`
    );

    return limiter;
  }

  /**
   * Remove limiters that have been idle for too long
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [apiKey, limiter] of this.limiters.entries()) {
      if (now - limiter.lastUsed > this.idleTimeoutMs) {
        limiter.destroy();
        this.limiters.delete(apiKey);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(
        `[${ts()}] [RateLimiterManager] Cleaned up ${cleaned} idle limiters (remaining: ${
          this.limiters.size
        })`
      );
    }
  }

  /**
   * Evict the oldest (least recently used) limiter
   */
  evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [apiKey, limiter] of this.limiters.entries()) {
      if (limiter.lastUsed < oldestTime) {
        oldestTime = limiter.lastUsed;
        oldestKey = apiKey;
      }
    }

    if (oldestKey) {
      const limiter = this.limiters.get(oldestKey);
      limiter.destroy();
      this.limiters.delete(oldestKey);
      console.log(
        `[${ts()}] [RateLimiterManager] Evicted oldest limiter (key: ${oldestKey.slice(
          0,
          8
        )}...)`
      );
    }
  }

  /**
   * Get stats for debugging
   */
  getStats() {
    return {
      activeLimiters: this.limiters.size,
      maxLimiters: this.maxLimiters,
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
