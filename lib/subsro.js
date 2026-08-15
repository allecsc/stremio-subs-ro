const axios = require("axios");

/**
 * Perform an HTTP request with automatic retries on transient network errors.
 */
async function requestWithRetry(url, options = {}, maxRetries = 2) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return await axios.get(url, {
        timeout: 10000,
        maxContentLength: 50 * 1024 * 1024, // 50MB
        maxBodyLength: 50 * 1024 * 1024, // 50MB
        ...options,
      });
    } catch (error) {
      const isTransient =
        error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNABORTED" ||
        error.code === "ENOTFOUND";

      if (isTransient && attempt < maxRetries) {
        attempt++;
        const backoffMs = attempt * 300;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw error;
    }
  }
}

class SubsRoClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = "https://api.subs.ro/v1.0";
  }

  /**
   * Search subtitles by IMDb ID
   * @param {string} imdbId - IMDb ID (e.g. tt0898266)
   * @param {string} [language] - Optional language code (e.g. ro, en)
   * @returns {Promise<Array>} List of subtitle items
   */
  async searchByImdb(imdbId, language = null) {
    try {
      const langQuery = language ? `?language=${encodeURIComponent(language)}` : "";
      const url = `${this.baseUrl}/search/imdbid/${imdbId}${langQuery}`;
      const response = await requestWithRetry(url, {
        headers: { "X-Subs-Api-Key": this.apiKey },
      });

      if (response.data && Array.isArray(response.data.items)) {
        return response.data.items;
      }
      return [];
    } catch (error) {
      if (error.response?.status === 429) {
        console.warn(`[SUBS] Quota exceeded on search for ${imdbId}`);
      }
      return [];
    }
  }

  /**
   * Search subtitles by TMDB ID
   * @param {number|string} tmdbId - TMDB ID
   * @param {string} [language] - Optional language code
   * @returns {Promise<Array>} List of subtitle items
   */
  async searchByTmdb(tmdbId, language = null) {
    try {
      const langQuery = language ? `?language=${encodeURIComponent(language)}` : "";
      const url = `${this.baseUrl}/search/tmdbid/${tmdbId}${langQuery}`;
      const response = await requestWithRetry(url, {
        headers: { "X-Subs-Api-Key": this.apiKey },
      });

      if (response.data && Array.isArray(response.data.items)) {
        return response.data.items;
      }
      return [];
    } catch (error) {
      if (error.response?.status === 429) {
        console.warn(`[SUBS] Quota exceeded on search for TMDB ${tmdbId}`);
      }
      return [];
    }
  }

  /**
   * Download a subtitle archive buffer (ZIP or RAR)
   * @param {number|string} subId - Subtitle ID
   * @returns {Promise<Buffer>} Archive binary buffer
   */
  async downloadArchive(subId) {
    const url = `${this.baseUrl}/subtitle/${subId}/download`;
    const response = await requestWithRetry(url, {
      headers: { "X-Subs-Api-Key": this.apiKey },
      responseType: "arraybuffer",
    });
    return Buffer.from(response.data);
  }

  /**
   * Validate API key and get quota info
   */
  async validate() {
    try {
      const url = `${this.baseUrl}/quota`;
      const response = await axios.get(url, {
        headers: { "X-Subs-Api-Key": this.apiKey },
        timeout: 5000,
      });

      const data = response.data;
      if (data && data.quota) {
        return {
          valid: true,
          status: 200,
          quota: {
            total_quota: data.quota.total_quota,
            used_quota: data.quota.used_quota,
            remaining_quota: data.quota.remaining_quota,
            quota_type: data.quota.quota_type,
          },
        };
      }

      return {
        valid: false,
        status: 500,
        reason: "invalid_response",
        message: "Unexpected response format from Subs.ro",
      };
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;

      if (status === 403) {
        return {
          valid: false,
          status: 403,
          reason: "invalid_key",
          message: data?.message || "Invalid API key",
        };
      }

      if (status === 429) {
        return {
          valid: false,
          status: 429,
          reason: "quota_exceeded",
          message: data?.message || "Daily quota exceeded",
        };
      }

      return {
        valid: false,
        status: status || 500,
        reason: "network_error",
        message: error.message || "Failed to connect to Subs.ro",
      };
    }
  }
}

module.exports = SubsRoClient;
