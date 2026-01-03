const { addonBuilder } = require("stremio-addon-sdk");
const SubsRoClient = require("./lib/subsro");
const { matchesEpisode, tokenSimilarity } = require("./lib/matcher");
const manifest = require("./manifest");

const builder = new addonBuilder(manifest);

// --- CACHE SYSTEM ---
const CACHE = new Map(); // cacheKey -> { data, timestamp, ttl }
const PENDING_REQUESTS = new Map(); // cacheKey -> Promise
const CLIENT_CACHE = new Map(); // apiKey -> SubsRoClient instance
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes (Standard navigation cache)
const EMPTY_CACHE_TTL = 60 * 1000; // 1 minute for "no results"

// Get or create cached client instance
const getClient = (apiKey) => {
  if (!CLIENT_CACHE.has(apiKey)) {
    CLIENT_CACHE.set(apiKey, new SubsRoClient(apiKey));
  }
  return CLIENT_CACHE.get(apiKey);
};

const LANGUAGE_MAPPING = {
  // subs.ro code -> ISO 639-2 (Stremio expects)
  ro: "ron", // Romanian (ISO 639-2)
  en: "eng", // English
  ita: "ita", // Italian
  fra: "fra", // French
  ger: "deu", // German (ISO 639-2)
  ung: "hun", // Hungarian
  gre: "ell", // Greek (Modern, ISO 639-2)
  por: "por", // Portuguese
  spa: "spa", // Spanish
  alt: "und", // Undetermined (for "other")
};

/**
 * Parse Stremio ID to extract IMDB ID, season, and episode.
 * Format: tt1234567:1:5 (IMDB:season:episode)
 */
function parseStremioId(id) {
  const parts = id.split(":");
  return {
    imdbId: parts[0],
    season: parts[1] ? parseInt(parts[1], 10) : null,
    episode: parts[2] ? parseInt(parts[2], 10) : null,
  };
}

const subtitlesHandler = async ({ type, id, extra, config }) => {
  if (!config || !config.apiKey) return { subtitles: [] };

  const { imdbId, season, episode } = parseStremioId(id);
  const isSeries = type === "series" && episode !== null;
  const videoFilename = extra?.filename || "";

  // Include season/episode in cache key for series
  const cacheKey = isSeries
    ? `${imdbId}_s${season}e${episode}_${config.languages || "all"}`
    : `${imdbId}_${config.languages || "all"}`;

  // 1. Check Cache
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    return { subtitles: cached.data };
  }

  // 2. Debounce Pending Requests
  if (PENDING_REQUESTS.has(cacheKey)) {
    return PENDING_REQUESTS.get(cacheKey);
  }

  const fetchTask = (async () => {
    try {
      const subsRo = getClient(config.apiKey);
      const results = await subsRo.searchByImdb(imdbId);

      // Filter by language (if configured)
      let filtered = results;
      const languages = Array.isArray(config.languages)
        ? config.languages
        : config.languages
        ? [config.languages]
        : [];

      if (languages.length > 0) {
        filtered = results.filter((sub) => languages.includes(sub.language));
      }

      // Process results based on type
      if (isSeries) {
        const strictMatches = filtered.filter((sub) => {
          const searchText = `${sub.description || ""} ${sub.title || ""}`;
          return matchesEpisode(searchText, season, episode);
        });

        if (strictMatches.length > 0) {
          console.log(
            `[SUBS] Series ${imdbId} S${season}E${episode}: Found ${strictMatches.length} matching subs`
          );
          filtered = strictMatches;
        } else if (filtered.length > 0) {
          console.log(
            `[SUBS] Series ${imdbId} S${season}E${episode}: No strict matches, serving all ${filtered.length} subs for this title as fallback`
          );
          // Keep all subs for this title as fallback
        }
      } else {
        console.log(
          `[SUBS] Movie ${imdbId}: Serving all ${filtered.length} subs for selected languages`
        );
      }

      // Rank by filename similarity if videoFilename is available
      if (videoFilename && filtered.length > 1) {
        filtered.sort((a, b) => {
          const textA = `${a.title || ""} ${a.description || ""}`;
          const textB = `${b.title || ""} ${b.description || ""}`;
          const scoreA = tokenSimilarity(videoFilename, textA);
          const scoreB = tokenSimilarity(videoFilename, textB);
          return scoreB - scoreA; // Higher score first
        });
      }

      // Map to Stremio subtitle format
      const baseUrl =
        config.baseUrl || process.env.BASE_URL || "http://localhost:7000";

      // Encode filename for URL (base64url-safe)
      const encodedFilename = videoFilename
        ? Buffer.from(videoFilename).toString("base64url")
        : "_";

      const subtitles = filtered.map((sub) => ({
        id: `subsro_${sub.id}`,
        url: `${baseUrl}/${config.apiKey}/proxy/${sub.id}/${encodedFilename}/sub.vtt`,
        lang: LANGUAGE_MAPPING[sub.language] || sub.language,
        name: sub.title || sub.description || "Subtitle",
      }));

      // Store in Cache
      CACHE.set(cacheKey, {
        data: subtitles,
        timestamp: Date.now(),
        ttl: subtitles.length > 0 ? CACHE_TTL : EMPTY_CACHE_TTL,
      });

      return { subtitles };
    } catch (error) {
      console.error(`[SUBS] Error for ${imdbId}:`, error.message);
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
