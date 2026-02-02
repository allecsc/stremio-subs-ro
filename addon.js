const { addonBuilder } = require("stremio-addon-sdk");
const SubsRoClient = require("./lib/subsro");
const { matchesEpisode, calculateMatchScore } = require("./lib/matcher");
const { listSrtFiles, getArchiveType } = require("./lib/archiveUtils");
const { getLimiter } = require("./lib/rateLimiter");
const manifest = require("./manifest");

const builder = new addonBuilder(manifest);

// --- CACHE SYSTEM ---
// --- CACHE SYSTEM ---
const { ARCHIVE_CACHE, ARCHIVE_CACHE_TTL } = require("./lib/archiveCache");

// Simple LRU implementation to prevent memory leaks
class SimpleLRU {
  constructor(maxSize, ttl = 0) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.cache = new Map();
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    if (this.ttl > 0 && Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    // Refresh LRU order
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first item in Map iteration order)
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  has(key) {
    return this.cache.has(key);
  }
}

const CACHE = new SimpleLRU(1000); // Max 1000 subtitle responses
const PENDING_REQUESTS = new Map(); // Pending requests are transient, no LRU needed
const CLIENT_CACHE = new SimpleLRU(500); // Max 500 active API clients
const CACHE_TTL = 15 * 60 * 1000;
const EMPTY_CACHE_TTL = 60 * 1000;

const getClient = (apiKey) => {
  let client = CLIENT_CACHE.get(apiKey);
  if (!client) {
    client = new SubsRoClient(apiKey);
    CLIENT_CACHE.set(apiKey, client);
  }
  return client;
};

const LANGUAGE_MAPPING = {
  ro: "ron",
  en: "eng",
  ita: "ita",
  fra: "fra",
  ger: "deu",
  ung: "hun",
  gre: "ell",
  por: "por",
  spa: "spa",
  alt: "und",
};

function parseStremioId(id) {
  const parts = id.split(":");
  return {
    imdbId: parts[0],
    season: parts[1] ? parseInt(parts[1], 10) : null,
    episode: parts[2] ? parseInt(parts[2], 10) : null,
  };
}

/**
 * Download archive via rate limiter and list SRT files.
 * Uses caching to avoid redundant downloads.
 */
async function getArchiveSrtList(apiKey, subId) {
  const cacheKey = `archive_${subId}`;
  const cached = ARCHIVE_CACHE.get(cacheKey);
  if (cached) {
    return cached.srtFiles;
  }

  try {
    const downloadUrl = `https://subs.ro/api/v1.0/subtitle/${subId}/download`;

    // Use per-user rate limiter for safe, queued downloads
    const limiter = getLimiter(apiKey);
    const buffer = await limiter.downloadArchive(downloadUrl, {
      headers: { "X-Subs-Api-Key": apiKey },
    });

    const srtFiles = await listSrtFiles(buffer);
    const archiveType = getArchiveType(buffer);

    ARCHIVE_CACHE.set(cacheKey, {
      buffer,
      srtFiles,
      archiveType,
      timestamp: Date.now(),
    });

    const status = limiter.getQueueStatus();
    const ts = new Date().toISOString().slice(11, 23);

    // Only log in development to prevent disk fill
    if (process.env.NODE_ENV === "development") {
      console.log(
        `[${ts}] [SUBS] Archive ${subId}: ${
          srtFiles.length
        } SRTs (${archiveType.toUpperCase()}) [Active: ${
          status.activeDownloads
        }, Pending: ${status.download}]`,
      );
    }

    return srtFiles;
  } catch (error) {
    console.error(`[SUBS] Error downloading archive ${subId}:`, error.message);
    return [];
  }
}

const subtitlesHandler = async ({ type, id, extra, config }) => {
  if (!config || !config.apiKey) return { subtitles: [] };

  // NOTE: Removed globalLimiter.clearQueues() - it was causing users to cancel each other's downloads

  const { imdbId, season, episode } = parseStremioId(id);
  const isSeries = type === "series" && episode !== null;
  const videoFilename = extra?.filename || "";

  const cacheKey = isSeries
    ? `${imdbId}_s${season}e${episode}_${config.languages || "all"}`
    : `${imdbId}_${config.languages || "all"}`;

  // 1. Check Cache
  const cachedData = CACHE.get(cacheKey);
  if (cachedData && Date.now() - cachedData.timestamp < cachedData.ttl) {
    return { subtitles: cachedData.data };
  }

  // 2. Debounce Pending Requests
  if (PENDING_REQUESTS.has(cacheKey)) {
    return PENDING_REQUESTS.get(cacheKey);
  }

  const fetchTask = (async () => {
    try {
      const subsRo = getClient(config.apiKey);
      const results = await subsRo.searchByImdb(imdbId);

      // Filter by language
      let filteredResults = results;
      if (config.languages && config.languages.length > 0) {
        filteredResults = results.filter((sub) =>
          config.languages.includes(sub.language),
        );
      }

      // BeamUp URL detection - hardcoded for production, dynamic for local dev
      const BEAMUP_URL =
        "https://cdcd7719a6b3-stremio-subs-ro.baby-beamup.club";
      const baseUrl = process.env.NODE_ENV
        ? BEAMUP_URL
        : config.baseUrl || "http://localhost:7000";

      const allSubtitles = [];

      // Process archives sequentially (rate limiter handles timing)
      for (const sub of filteredResults) {
        const srtFiles = await getArchiveSrtList(config.apiKey, sub.id);
        const lang = LANGUAGE_MAPPING[sub.language] || sub.language;

        for (const srtPath of srtFiles) {
          // For series: filter out SRTs that don't match the episode
          if (isSeries) {
            if (!matchesEpisode(srtPath, season, episode)) {
              continue;
            }
          }

          const encodedSrtPath = Buffer.from(srtPath).toString("base64url");

          // Calculate weighted match score (release group +50, source +20, base fuzzy)
          let matchScore = calculateMatchScore(videoFilename, srtPath);

          // RETAIL BONUS (KISS Approach): +5 points
          // Acts as tie-breaker for identical matches, but won't override Group/Source matches
          const isRetail =
            (sub.translator &&
              sub.translator.toLowerCase().includes("retail")) ||
            (sub.title && sub.title.toLowerCase().includes("retail"));

          if (isRetail) {
            matchScore += 5;
          }

          allSubtitles.push({
            id: `subsro_${sub.id}_${encodedSrtPath.slice(0, 8)}`,
            url: `${baseUrl}/${config.apiKey}/proxy/${sub.id}/${encodedSrtPath}/sub.vtt`,
            lang,
            srtPath,
            matchScore,
            isRetail, // Passed for debugging/logging
          });
        }
      }

      // Sort by weighted match score (highest first)
      allSubtitles.sort((a, b) => b.matchScore - a.matchScore);

      // Log top matches for debugging (Dev only)
      if (
        process.env.NODE_ENV === "development" &&
        allSubtitles.length > 0 &&
        videoFilename
      ) {
        const top = allSubtitles.slice(0, 5); // Show top 5
        console.log(`[SUBS] Matching results for "${videoFilename}":`);
        top.forEach((s, i) => {
          console.log(`  ${i + 1}. [Score: ${s.matchScore}] ${s.srtPath}`);
        });
      }

      // Remove internal properties before returning
      const subtitles = allSubtitles.map(({ id, url, lang }) => ({
        id,
        url,
        lang,
      }));

      // Store in Cache
      CACHE.set(cacheKey, {
        data: subtitles,
        timestamp: Date.now(),
        ttl: subtitles.length > 0 ? CACHE_TTL : EMPTY_CACHE_TTL,
      });

      if (process.env.NODE_ENV === "development") {
        console.log(
          `[SUBS] Served ${subtitles.length} subs for ${imdbId}${
            isSeries ? ` S${season}E${episode}` : ""
          } (Status: OK)`,
        );
      }

      return { subtitles };
    } catch (error) {
      // Errors are already logged by globalLimiter
      return { subtitles: [] };
    } finally {
      PENDING_REQUESTS.delete(cacheKey);
    }
  })();

  PENDING_REQUESTS.set(cacheKey, fetchTask);
  return fetchTask;
};

builder.defineSubtitlesHandler(subtitlesHandler);

module.exports = {
  builder,
  addonInterface: builder.getInterface(),
  subtitlesHandler,
};
