const { addonBuilder } = require("stremio-addon-sdk");
const SubsRoClient = require("./lib/subsro");
const {
  parseStremioId,
  matchesEpisode,
  calculateMatchScore,
} = require("./lib/matcher");
const { listSrtFiles, getArchiveType } = require("./lib/archiveUtils");
const manifest = require("./manifest");

const builder = new addonBuilder(manifest);

// --- CACHE SYSTEM ---
const { ARCHIVE_CACHE } = require("./lib/archiveCache");

// Simple LRU implementation for API clients
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
      // Evict oldest
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  has(key) {
    return this.cache.has(key);
  }
}

const PENDING_REQUESTS = new Map(); // Transient in-flight request debouncing
const CLIENT_CACHE = new SimpleLRU(500); // Max 500 active API clients

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

/**
 * Concurrency helper: processes items in parallel with a bounded concurrency cap.
 */
async function mapConcurrent(items, limit, fn) {
  const results = [];
  const executing = [];

  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);

    if (limit <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }

  const settled = await Promise.allSettled(results);
  return settled
    .filter((res) => res.status === "fulfilled" && Array.isArray(res.value))
    .flatMap((res) => res.value);
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
    const client = getClient(apiKey);
    const buffer = await client.downloadArchive(subId);

    const srtFiles = await listSrtFiles(buffer);
    const archiveType = getArchiveType(buffer);

    ARCHIVE_CACHE.set(cacheKey, {
      buffer,
      srtFiles,
      archiveType,
      timestamp: Date.now(),
    });

    const ts = new Date().toISOString().slice(11, 23);
    console.log(
      `[${ts}] [SUBS] Archive ${subId}: ${
        srtFiles.length
      } SRTs (${archiveType.toUpperCase()})`
    );

    return srtFiles;
  } catch (error) {
    console.error(`[SUBS] Error downloading archive ${subId}:`, error.message);
    return [];
  }
}

const subtitlesHandler = async ({ type, id, extra, config }) => {
  if (!config || !config.apiKey) return { subtitles: [] };

  const parsed = parseStremioId(id);
  if (!parsed.isValid) {
    // Fast-fail on unsupported streams (e.g. IPTV) without hitting Subs.ro
    return { subtitles: [] };
  }

  const isSeries = type === "series" && parsed.episode !== null;
  const videoFilename = extra?.filename || "";
  const primaryLanguage =
    config.languages && config.languages.length > 0 ? config.languages[0] : null;

  // Transient in-flight debounce key (prevents identical concurrent requests)
  const debounceKey = `${config.apiKey}_${parsed.type}_${parsed.id}_${
    isSeries ? `s${parsed.season}e${parsed.episode}` : "movie"
  }_${videoFilename}_${config.languages || "all"}`;

  if (PENDING_REQUESTS.has(debounceKey)) {
    return PENDING_REQUESTS.get(debounceKey);
  }

  const fetchTask = (async () => {
    try {
      const subsRo = getClient(config.apiKey);
      let results = [];

      if (parsed.type === "imdb") {
        results = await subsRo.searchByImdb(parsed.id, primaryLanguage);
      } else if (parsed.type === "tmdb") {
        results = await subsRo.searchByTmdb(parsed.id, primaryLanguage);
      }

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

      // Process up to 4 archives concurrently in parallel
      const allSubtitles = await mapConcurrent(filteredResults, 4, async (sub) => {
        const srtFiles = await getArchiveSrtList(config.apiKey, sub.id);
        const lang = LANGUAGE_MAPPING[sub.language] || sub.language;
        const subTracks = [];

        for (const srtPath of srtFiles) {
          // For series: filter out SRTs that don't match the episode
          if (isSeries) {
            if (!matchesEpisode(srtPath, parsed.season, parsed.episode)) {
              continue;
            }
          }

          // Calculate 9-tier match score (-1 if excluded like FORCED or Multi-CD)
          let matchScore = calculateMatchScore(videoFilename, srtPath);
          if (matchScore < 0) {
            continue;
          }

          const encodedSrtPath = Buffer.from(srtPath).toString("base64url");

          // RETAIL BONUS: +5 points for retail/official syncs
          const isRetail =
            (sub.translator &&
              sub.translator.toLowerCase().includes("retail")) ||
            (sub.title && sub.title.toLowerCase().includes("retail"));

          if (isRetail) {
            matchScore += 5;
          }

          subTracks.push({
            id: `subsro_${sub.id}_${encodedSrtPath.slice(0, 8)}`,
            url: `${baseUrl}/${config.apiKey}/proxy/${sub.id}/${encodedSrtPath}/sub.vtt`,
            lang,
            srtPath,
            matchScore,
            isRetail,
          });
        }

        return subTracks;
      });

      // Sort by 9-tier match score (highest first)
      allSubtitles.sort((a, b) => b.matchScore - a.matchScore);

      // Log matched subtitle rankings with scores
      if (allSubtitles.length > 0) {
        const ts = new Date().toISOString().slice(11, 23);
        console.log(
          `[${ts}] [MATCH] Ordered results for "${videoFilename || "N/A"}" (${allSubtitles.length} tracks):`
        );
        allSubtitles.forEach((s, i) => {
          console.log(`  ${i + 1}. [Score: ${s.matchScore}] ${s.srtPath}`);
        });
      }

      // Remove internal properties before returning
      return {
        subtitles: allSubtitles.map(({ id, url, lang }) => ({
          id,
          url,
          lang,
        })),
      };
    } catch (error) {
      console.error("[SUBS] Error processing request:", error);
      return { subtitles: [] };
    } finally {
      PENDING_REQUESTS.delete(debounceKey);
    }
  })();

  PENDING_REQUESTS.set(debounceKey, fetchTask);
  return fetchTask;
};

builder.defineSubtitlesHandler(subtitlesHandler);

module.exports = {
  builder,
  addonInterface: builder.getInterface(),
  subtitlesHandler,
};
