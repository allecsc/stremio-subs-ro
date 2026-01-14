const { addonBuilder } = require("stremio-addon-sdk");
const SubsRoClient = require("./lib/subsro");
const {
  matchesEpisode,
  calculateMatchScore,
  getQualityTags,
  getReleaseGroup,
} = require("./lib/matcher");
const { listSrtFiles, getArchiveType } = require("./lib/archiveUtils");
const { getLimiter } = require("./lib/rateLimiter");
const manifest = require("./manifest");

const builder = new addonBuilder(manifest);

// --- CACHE SYSTEM ---
const { ARCHIVE_CACHE, ARCHIVE_CACHE_TTL } = require("./lib/archiveCache");
const CACHE = new Map();
const PENDING_REQUESTS = new Map();
const CLIENT_CACHE = new Map();
const CACHE_TTL = 15 * 60 * 1000;
const EMPTY_CACHE_TTL = 60 * 1000;

const getClient = (apiKey) => {
  if (!CLIENT_CACHE.has(apiKey)) {
    CLIENT_CACHE.set(apiKey, new SubsRoClient(apiKey));
  }
  return CLIENT_CACHE.get(apiKey);
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
    console.log(
      `[${ts}] [SUBS] Archive ${subId}: ${
        srtFiles.length
      } SRTs (${archiveType.toUpperCase()}) [Active: ${
        status.activeDownloads
      }, Pending: ${status.download}]`
    );

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
      console.log(`[SUBS] Search results for ${imdbId}:`, results);

      // Filter by language
      let filteredResults = results;
      if (config.languages && config.languages.length > 0) {
        filteredResults = results.filter((sub) =>
          config.languages.includes(sub.language)
        );
      }

      // BeamUp URL detection - hardcoded for production, dynamic for local dev
      const BEAMUP_URL =
        "https://cdcd7719a6b3-stremio-subs-ro.baby-beamup.club";
      const baseUrl = process.env.NODE_ENV
        ? BEAMUP_URL
        : config.baseUrl || `http://localhost:${process.env.PORT || 7000}`;

      const allSubtitles = [];

      // Process archives sequentially (rate limiter handles timing)
      for (const sub of filteredResults) {
        const srtFiles = await getArchiveSrtList(config.apiKey, sub.id);
        const lang = LANGUAGE_MAPPING[sub.language] || sub.language;

        // Check if any SRT file lacks release group/format info
        // Only fetch metadata if needed (saves HTTP requests)
        const needsMetadata = srtFiles.some((srtPath) => {
          const group = getReleaseGroup(srtPath);
          const tags = getQualityTags(srtPath);
          return !group || tags.length === 0;
        });

        // Fetch page metadata only if SRT files lack release info
        const metadata = needsMetadata
          ? await subsRo.getSubtitleMetadata(sub.link)
          : null;

        for (const srtPath of srtFiles) {
          // For series: filter out SRTs that don't match the episode
          if (isSeries) {
            if (!matchesEpisode(srtPath, season, episode)) {
              continue;
            }
          }

          const encodedSrtPath = Buffer.from(srtPath).toString("base64url");

          // Calculate weighted match score (release group +50, source +30, tech +5, fuzzy)
          // Pass metadata only if it was fetched
          const matchScore = calculateMatchScore(
            videoFilename,
            srtPath,
            metadata
          );

          allSubtitles.push({
            id: `subsro_${sub.id}_${encodedSrtPath.slice(0, 8)}`,
            url: `${baseUrl}/${config.apiKey}/proxy/${sub.id}/${encodedSrtPath}/sub.vtt`,
            lang,
            srtPath,
            matchScore,
            metadata, // Store for potential future use
          });
        }
      }

      // Sort by weighted match score (highest first)
      allSubtitles.sort((a, b) => b.matchScore - a.matchScore);

      // Log top matches for debugging
      if (allSubtitles.length > 0 && videoFilename) {
        const top = allSubtitles.slice(0, 5); // Show top 5
        console.log(`[SUBS] Matching results for "${videoFilename}":`);
        top.forEach((s, i) => {
          const fps = s.metadata?.fps || "-";
          const formats =
            s.metadata?.formats?.length > 0
              ? s.metadata.formats.join("/")
              : "-";
          console.log(
            `  ${i + 1}. [Score: ${
              s.matchScore
            }] [FPS: ${fps}] [Formats: ${formats}] ${s.srtPath}`
          );
        });
      }

      // Return only top 5 matches, remove internal properties
      const subtitles = allSubtitles.slice(0, 5).map(({ id, url, lang }) => ({
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

      console.log(
        `[SUBS] Served ${subtitles.length} subs for ${imdbId}${
          isSeries ? ` S${season}E${episode}` : ""
        } (Status: OK)`
      );

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
