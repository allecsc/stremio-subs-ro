const { getLimiter } = require("./rateLimiter");

// Cache for page metadata to avoid repeated scraping
const PAGE_METADATA_CACHE = new Map();
const PAGE_METADATA_TTL = 24 * 60 * 60 * 1000; // 24 hours

class SubsRoClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = "https://subs.ro/api/v1.0";
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

  /**
   * Fetch and parse metadata from a subtitle's page.
   * Extracts FPS and formats from the HTML.
   *
   * @param {string} pageUrl - The subtitle page URL (e.g., https://subs.ro/subtitrare/movie-name/12345)
   * @returns {Promise<{fps: string|null, formats: string[]}>}
   */
  async getSubtitleMetadata(pageUrl) {
    if (!pageUrl) return { fps: null, formats: [] };

    // Check cache first
    const cached = PAGE_METADATA_CACHE.get(pageUrl);
    if (cached && Date.now() - cached.timestamp < PAGE_METADATA_TTL) {
      return cached.data;
    }

    try {
      const limiter = getLimiter(this.apiKey);
      const html = await limiter.fetchPage(pageUrl);

      const metadata = this._parsePageMetadata(html);

      // Cache the result
      PAGE_METADATA_CACHE.set(pageUrl, {
        data: metadata,
        timestamp: Date.now(),
      });

      return metadata;
    } catch (error) {
      // Silently fail - metadata is optional enhancement
      return { fps: null, formats: [] };
    }
  }

  /**
   * Parse FPS and formats from subtitle page HTML.
   * @param {string} html - The page HTML content
   * @returns {{fps: string|null, formats: string[]}}
   */
  _parsePageMetadata(html) {
    const result = { fps: null, formats: [] };

    if (!html) return result;

    // Extract FPS from:
    // <div>
    //   <p class="font-semibold text-gray-700">FPS</p>
    //   <p class="text-gray-600">23.976</p>
    // </div>
    const fpsMatch = html.match(/<p[^>]*>FPS<\/p>\s*<p[^>]*>([0-9.]+)<\/p>/i);
    if (fpsMatch) {
      result.fps = fpsMatch[1];
    }

    // Extract formats from:
    // <div class="text-xl font-bold text-gray-700">
    //   WEB-DL / DVDRIP / BluRay
    // </div>
    // <div class="text-sm text-gray-600">Format</div>
    const formatMatch = html.match(
      /<div[^>]*text-xl[^>]*font-bold[^>]*>\s*([^<]+)\s*<\/div>\s*<div[^>]*>Format<\/div>/i
    );
    if (formatMatch) {
      // Parse formats like "WEB-DL / DVDRIP / BluRay"
      const formatStr = formatMatch[1].trim();
      result.formats = formatStr
        .split(/\s*\/\s*/)
        .map((f) => f.trim().toUpperCase())
        .filter((f) => f.length > 0);
    }

    return result;
  }

  async validate() {
    try {
      const url = `${this.baseUrl}/quota`;
      const limiter = getLimiter(this.apiKey);

      const data = await limiter.searchRequest(url, {
        headers: { "X-Subs-Api-Key": this.apiKey },
      });
      return data?.quota?.remaining_quota >= 0;
    } catch (error) {
      return false;
    }
  }
}

module.exports = SubsRoClient;
