const { addonBuilder } = require("stremio-addon-sdk");
const {
  parseStremioId,
  matchesEpisode,
  explicitSeason,
  hasExplicitEpisode,
  calculateMatchScore,
} = require("./lib/matcher");
const manifest = require("./manifest");
const { globalMetrics } = require("./lib/metrics");
const { notifyUpstreamOutage } = require("./lib/alerts");

const builder = new addonBuilder(manifest);

const { getSubtitlePipeline } = require("./lib/subtitlePipeline");

const PENDING_REQUESTS = new Map(); // Transient in-flight request debouncing

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

function metadataText(subtitle) {
  return [subtitle.title, subtitle.release, subtitle.season, subtitle.episode, subtitle.description]
    .filter((value) => value !== undefined && value !== null)
    .join(" ");
}

function numericMetadata(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function packageMetadata(subtitle) {
  return {
    text: metadataText(subtitle),
    season: numericMetadata(subtitle.season),
    episode: numericMetadata(subtitle.episode),
  };
}

function metadataIdentifiesEpisode(metadata, season, episode) {
  return (metadata.season === season && metadata.episode === episode) || hasExplicitEpisode(metadata.text, season, episode);
}

function identifiesAnotherSeason(subtitle, requestedSeason) {
  const numericSeason = Number(subtitle.season);
  if (Number.isInteger(numericSeason) && numericSeason > 0) return numericSeason !== requestedSeason;
  const season = explicitSeason(metadataText(subtitle));
  return season !== null && season !== requestedSeason;
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

  const searchStartTime = Date.now();
  const fetchTask = (async () => {
    try {
      const pipeline = getSubtitlePipeline();
      const subsRo = pipeline.getClient(config.apiKey);
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
      if (isSeries) {
        filteredResults = filteredResults.filter((sub) => !identifiesAnotherSeason(sub, parsed.season));
      }

      // BeamUp URL detection - hardcoded for production, dynamic for local dev
      const BEAMUP_URL =
        "https://cdcd7719a6b3-stremio-subs-ro.baby-beamup.club";
      const baseUrl = pipeline.options.deliveryBaseUrl || (process.env.NODE_ENV
        ? BEAMUP_URL
        : config.baseUrl || "http://localhost:7000");

      // Cold-package scheduling is process-wide inside the shared pipeline.
      const packageResults = await Promise.allSettled(filteredResults.map(async (sub) => {
        const packageMetadataForSub = packageMetadata(sub);
        const tracks = await pipeline.getArchiveTracks(config.apiKey, sub.id, {
          season: isSeries ? parsed.season : null,
          episode: isSeries ? parsed.episode : null,
          metadata: packageMetadataForSub,
          updatedAt: sub.updatedAt,
        });
        const lang = LANGUAGE_MAPPING[sub.language] || sub.language;
        const subTracks = [];

        for (const track of tracks) {
          const srtPath = track.originalPath;
          // For series: filter out SRTs that don't match the episode
          if (isSeries) {
            if (!matchesEpisode(srtPath, parsed.season, parsed.episode) && !metadataIdentifiesEpisode(packageMetadataForSub, parsed.season, parsed.episode)) {
              continue;
            }
          }

          // Calculate 9-tier match score (-1 if excluded like FORCED or Multi-CD)
          let matchScore = calculateMatchScore(videoFilename, srtPath);
          if (matchScore < 0) {
            continue;
          }

          const encodedSrtPath = track.id;

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
      }));
      const allSubtitles = packageResults
        .filter((result) => result.status === "fulfilled" && Array.isArray(result.value))
        .flatMap((result) => result.value);

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

      const topScore = allSubtitles.length > 0 ? allSubtitles[0].matchScore : null;
      globalMetrics.recordSearch({
        apiKey: config.apiKey,
        durationMs: Date.now() - searchStartTime,
        topScore,
      });

      // Remove internal properties before returning
      return {
        subtitles: allSubtitles.map(({ id, url, lang }) => ({
          id,
          url,
          lang,
        })),
        cacheMaxAge: 3600, // Instruct client to cache subtitle availability for 1 hour
      };
    } catch (error) {
      console.error("[SUBS] Error processing request:", error);
      const status = error.response?.status || 500;
      globalMetrics.recordSearch({
        apiKey: config.apiKey,
        durationMs: Date.now() - searchStartTime,
        upstreamError: status,
      });
      globalMetrics.recordError({
        type: status >= 500 ? "UPSTREAM_SERVER_ERROR" : (error.name || "SEARCH_ERROR"),
        message: error.message || "Unknown error during subtitle discovery",
        stack: error.stack,
        context: id,
      });
      if (status >= 500 || error.code === "ECONNRESET" || error.code === "ETIMEDOUT") {
        notifyUpstreamOutage(error.code || `HTTP ${status}`, error.message).catch(() => {});
      }
      return { subtitles: [], cacheMaxAge: 60 };
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
