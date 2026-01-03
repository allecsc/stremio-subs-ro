const axios = require("axios");

class SubsRoClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = "https://subs.ro/api/v1.0";
  }

  async searchByImdb(imdbId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/search/imdbid/${imdbId}`,
        {
          headers: { "X-Subs-Api-Key": this.apiKey },
        }
      );

      const data = response.data;
      if (data && Array.isArray(data.items)) {
        return data.items;
      }
      return [];
    } catch (error) {
      // Handle specific status codes
      if (error.response) {
        const status = error.response.status;
        if (status === 429) {
          console.error(`[SUBSRO] Quota exceeded for ${imdbId}`);
        } else if (status === 401) {
          console.error(`[SUBSRO] Invalid API key for ${imdbId}`);
        } else {
          console.error(`[SUBSRO] API error ${status} for ${imdbId}`);
        }
      } else {
        console.error(`[SUBSRO] Network error for ${imdbId}:`, error.message);
      }
      return [];
    }
  }

  async validate() {
    try {
      // Use /quota endpoint - doesn't consume request quota
      const response = await axios.get(`${this.baseUrl}/quota`, {
        headers: { "X-Subs-Api-Key": this.apiKey },
      });
      // If we get a 200, the key is valid
      return response.data?.quota?.remaining_quota >= 0;
    } catch (error) {
      const status = error.response?.status;
      if (status === 401) {
        console.error(`[SUBSRO] Invalid API key`);
      } else if (status === 429) {
        console.error(`[SUBSRO] Quota exceeded during validation`);
      } else {
        console.error(`[SUBSRO] Validation failed:`, error.message);
      }
      return false;
    }
  }
}

module.exports = SubsRoClient;
