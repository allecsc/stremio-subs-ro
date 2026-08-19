const { getLimiter } = require("./rateLimiter");

class SubsRoClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = "https://api.subs.ro/v1.0";
  }

  async searchByImdb(imdbId) {
    try {
      const url = `${this.baseUrl}/search/imdbid/${imdbId}`;
      const limiter = getLimiter(this.apiKey);

      const data = await limiter.searchRequest(url, {
        headers: { "X-Subs-Api-Key": this.apiKey },
      });

      if (data && Array.isArray(data.items)) {
        return data.items;
      }
      return [];
    } catch (error) {
      // Errors are already logged explicitly by RateLimiter
      return [];
    }
  }

  async validate() {
    try {
      const url = `${this.baseUrl}/quota`;
      const limiter = getLimiter(this.apiKey);

      const data = await limiter.searchRequest(url, {
        headers: { "X-Subs-Api-Key": this.apiKey },
      });

      if (data && data.quota) {
        const remaining = Number(data.quota.remaining_quota);
        if (remaining <= 0 && Number(data.quota.total_quota) > 0) {
          return { valid: false, reason: "quota_exceeded", quota: data.quota };
        }
        return { valid: true, quota: data.quota };
      }
      return { valid: false, reason: "invalid_key" };
    } catch (error) {
      if (error.response?.status === 429) {
        return { valid: false, reason: "quota_exceeded" };
      }
      if (error.response?.status === 403 || error.response?.status === 401) {
        return { valid: false, reason: "invalid_key" };
      }
      return { valid: false, reason: "network_error" };
    }
  }
}

module.exports = SubsRoClient;
