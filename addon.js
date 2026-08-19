const { addonBuilder } = require("stremio-addon-sdk");
const SubsRoClient = require("./lib/subsro");
const { matchesEpisode, calculateMatchScore, isExcludedSubtitle, explicitSeason } = require("./lib/matcher");
const { listSrtFilesFromFile, getArchiveTypeFromFile } = require("./lib/archiveUtils");
const { getLimiter } = require("./lib/rateLimiter");
const { globalMetrics } = require("./lib/metrics");
const manifest = require("./manifest");
const fs = require("fs");
const path = require("path");

const builder = new addonBuilder(manifest);

// --- CACHE SYSTEM ---
const { ARCHIVE_CACHE, ARCHIVE_CACHE_TTL, STAGING_DIR } = require("./lib/archiveCache");

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

  clear() {
    this.cache.clear();
  }
}

const CACHE = new SimpleLRU(1000); // Max 1000 subtitle responses
const PENDING_REQUESTS = new Map(); // Pending response requests (keyed by response cacheKey)
const PENDING_PACKAGES = new Map(); // Pending package preparations (keyed strictly by subId)
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

function metadataText(subtitle) {
  return [
    subtitle.title,
    subtitle.release,
    subtitle.season,
    subtitle.episode,
    subtitle.description,
  ]
    .filter((v) => v !== undefined && v !== null)
    .join(" ");
}

function identifiesAnotherSeason(subtitle, requestedSeason) {
  const numericSeason = Number(subtitle.season);

  if (Number.isInteger(numericSeason) && numericSeason > 0) {
    return numericSeason !== requestedSeason;
  }

  const parsed = explicitSeason(metadataText(subtitle));

  return parsed !== null && parsed !== requestedSeason;
}

/**
 * Download archive via rate limiter and list SRT files.
 * Uses file-backed disk staging and package-level singleflight.
 */
async function getArchiveSrtList(apiKey, subId) {
  const cacheKey = `archive_${subId}`;
  const cached = ARCHIVE_CACHE.get(cacheKey);
  if (cached && cached.filePath && fs.existsSync(cached.filePath)) {
    globalMetrics.recordCacheHit("archiveCache");
    return cached.srtFiles;
  }
  globalMetrics.recordCacheMiss("archiveCache");

  // Check package-level singleflight map
  const existingPromise = PENDING_PACKAGES.get(subId);
  if (existingPromise) {
    globalMetrics.recordSingleflight("joined");
    return existingPromise;
  }
  globalMetrics.recordSingleflight("leaders");

  const prepPromise = (async () => {
    let destPath = null;
    let downloadCompleted = false;
    let archiveType = "unknown";
    try {
      const downloadUrl = `https://subs.ro/api/v1.0/subtitle/${subId}/download`;
      destPath = path.join(
        STAGING_DIR,
        `archive_${subId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.bin`,
      );

      // Use per-user rate limiter for safe, queued streaming downloads
      const limiter = getLimiter(apiKey);
      await limiter.downloadArchiveToFile(downloadUrl, destPath, {
        headers: { "X-Subs-Api-Key": apiKey },
      });
      downloadCompleted = true;

      const srtFiles = await listSrtFilesFromFile(destPath);
      archiveType = getArchiveTypeFromFile(destPath);

      ARCHIVE_CACHE.set(cacheKey, {
        filePath: destPath,
        srtFiles,
        archiveType,
        timestamp: Date.now(),
      });

      globalMetrics.recordArchiveParsed(archiveType);
      globalMetrics.recordUsableSrtTracks(srtFiles.length);

      const status = limiter.getQueueStatus();
      const ts = new Date().toISOString().slice(11, 23);

      // Only log in development to prevent disk fill
      if (process.env.NODE_ENV === "development") {
        console.log(
          `[${ts}] [SUBS] Archive prepared: ${
            srtFiles.length
          } SRTs (${archiveType.toUpperCase()}) [Active: ${
            status.activeDownloads
          }, Pending: ${status.download}]`,
        );
      }

      return srtFiles;
    } catch (error) {
      console.error(`[SUBS] Error preparing archive: ${error.message}`);
      if (downloadCompleted) {
        globalMetrics.recordCorruptArchive(archiveType, error);
      }
      if (destPath) {
        try {
          if (fs.existsSync(destPath)) {
            fs.unlinkSync(destPath);
          }
        } catch (e) {}
      }
      return [];
    } finally {
      PENDING_PACKAGES.delete(subId);
    }
  })();

  PENDING_PACKAGES.set(subId, prepPromise);
  return prepPromise;
}

const subtitlesHandler = async ({ type, id, extra, config }) => {
  if (!config || !config.apiKey) return { subtitles: [] };

  const reqStart = Date.now();
  globalMetrics.recordActiveUser(config.apiKey);

  const { imdbId, season, episode } = parseStremioId(id);
  const isSeries = type === "series" && episode !== null;
  const videoFilename = extra?.filename || "";
  const languages = config.languages || "all";
  const cacheKey = isSeries
    ? `${config.apiKey}#series#${imdbId}#s${season}e${episode}#${languages}#${videoFilename}`
    : `${config.apiKey}#movie#${imdbId}#${languages}#${videoFilename}`;

  // 1. Check Cache
  const cachedData = CACHE.get(cacheKey);
  if (cachedData && Date.now() - cachedData.timestamp < cachedData.ttl) {
    globalMetrics.recordCacheHit("responseCache");
    globalMetrics.recordSubtitleRequest({
      durationMs: Date.now() - reqStart,
      resultCount: cachedData.data?.length || 0,
      success: true,
    });
    return { subtitles: cachedData.data };
  }
  globalMetrics.recordCacheMiss("responseCache");

  // 2. Debounce Pending Requests
  if (PENDING_REQUESTS.has(cacheKey)) {
    return PENDING_REQUESTS.get(cacheKey);
  }

  const fetchTask = (async () => {
    let searchDurationMs = 0;
    try {
      const subsRo = getClient(config.apiKey);
      const searchStart = Date.now();
      const results = await subsRo.searchByImdb(imdbId);
      searchDurationMs = Date.now() - searchStart;
      globalMetrics.recordSubsroSearch();

      // Filter by language
      let filteredResults = results;
      if (config.languages && config.languages.length > 0) {
        filteredResults = results.filter((sub) =>
          config.languages.includes(sub.language),
        );
      }

      // For series: skip packages whose metadata explicitly identifies a different season
      if (isSeries && season !== null) {
        filteredResults = filteredResults.filter((sub) => {
          const skip = identifiesAnotherSeason(sub, season);
          if (skip) globalMetrics.recordWrongSeasonSkipped();
          return !skip;
        });
      }

      // BeamUp URL detection - hardcoded for production, dynamic for local dev
      const BEAMUP_URL =
        "https://cdcd7719a6b3-stremio-subs-ro.baby-beamup.club";
      const baseUrl = process.env.NODE_ENV
        ? BEAMUP_URL
        : config.baseUrl || "http://localhost:7000";

      const allSubtitles = [];

      // Submit all package preparations concurrently; per-user rate limiter enforces maxConcurrent=3 & 200ms stagger
      const packageResults = await Promise.all(
        filteredResults.map(async (sub) => {
          const srtFiles = await getArchiveSrtList(config.apiKey, sub.id);
          return { sub, srtFiles };
        }),
      );

      for (const { sub, srtFiles } of packageResults) {
        const lang = LANGUAGE_MAPPING[sub.language] || sub.language;

        for (const srtPath of srtFiles) {
          // Permanently exclude forced and split/multi-disc tracks
          if (isExcludedSubtitle(srtPath)) {
            globalMetrics.recordForcedSplitFiltered();
            continue;
          }

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

      globalMetrics.recordSubtitleRequest({
        durationMs: Date.now() - reqStart,
        searchDurationMs,
        resultCount: subtitles.length,
        success: true,
      });

      return { subtitles };
    } catch (error) {
      globalMetrics.recordSubtitleRequest({
        durationMs: Date.now() - reqStart,
        searchDurationMs,
        success: false,
        error,
      });
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
  PENDING_PACKAGES,
  PENDING_REQUESTS,
  CACHE,
};
