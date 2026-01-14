const fuzz = require("fuzzball");

/**
 * Normalized quality/source tags for matching.
 * Comprehensive list from scene release standards.
 */
const QUALITY_TAGS = [
  // Cam sources
  "CAM", "CAMRIP", "CAM-RIP", "HDCAM",
  // Telesync
  "TS", "HDTS", "TELESYNC", "PDVD", "PREDVDRIP",
  // Workprint
  "WP", "WORKPRINT",
  // Telecine
  "TC", "HDTC", "TELECINE",
  // Pay-Per-View
  "PPV", "PPVRIP",
  // Screener
  "SCR", "SCREENER", "DVDSCR", "DVDSCREENER", "BDSCR", "WEBSCREENER",
  // Digital Distribution
  "DDC",
  // R5
  "R5",
  // DVD sources
  "DVDRIP", "DVDMUX", "DVDR", "DVD-FULL", "FULL-RIP", "DVD-5", "DVD-9",
  // TV/Satellite sources
  "DSR", "DSRIP", "SATRIP", "DTHRIP", "DVBRIP", "HDTV", "PDTV", "DTVRIP", "TVRIP", "HDTVRIP",
  // VOD
  "VODRIP", "VODR",
  // HC/HD-Rip
  "HC", "HDRIP",
  // WEBCap
  "WEBCAP", "WEB-CAP",
  // WEB sources
  "WEB-DL", "WEBDL", "WEBRIP", "WEB-RIP", "WEB-DLRIP",
  // Blu-ray sources
  "BLURAY", "BLU-RAY", "BDRIP", "BRRIP", "BRIP", "BDR",
  "BD25", "BD50", "BD66", "BD100", "BD5", "BD9",
  "BDMV", "BDISO", "COMPLETE.BLURAY",
  // Remux (high quality)
  "REMUX",
].map(tag => tag.toUpperCase());

/**
 * Additional technical tags to filter out when extracting release groups.
 * These are not source types but encoding/resolution/audio indicators.
 */
const TECHNICAL_TAGS = [
  // Resolution tags
  "1080P", "720P", "2160P", "4K", "UHD", "480P", "576P",
  // HDR variants
  "HDR", "HDR10", "HDR10PLUS", "DOLBYVISION", "DV",
  // Video codecs
  "X264", "H264", "X265", "H265", "HEVC", "AVC", "XVID", "DIVX", "VP9", "AV1",
  // Audio codecs
  "AAC", "AC3", "DTS", "DTSHD", "DTSHDMA", "TRUEHD", "ATMOS",
  "DDP5", "DDP2", "DDP", "DD5", "DD2", "EAC3", "FLAC", "MP3", "OPUS",
  // Audio channels
  "5.1", "7.1", "2.0", "1.0",
  // Release tags
  "INTERNAL", "REPACK", "PROPER", "LIMITED", "MULTI", "DUBBED", "SUBBED",
  "SUBS", "RO", "EN", "EXTENDED", "UNRATED", "DIRECTORS", "CUT", "THEATRICAL",
  // Container hints (sometimes in filename)
  "MKV", "MP4", "AVI",
];

/**
 * Combined list of tags to ignore when extracting release groups.
 */
const IGNORED_TAGS = [...QUALITY_TAGS, ...TECHNICAL_TAGS];

/**
 * Extract the release group from a filename.
 * Conventionally, this is the part after the last dash (e.g., Title-GROUP.mkv)
 */
function getReleaseGroup(filename) {
  if (!filename) return null;

  const name = filename.replace(/\.[a-zA-Z0-9]+$/, "").toLowerCase();

  // Pattern 1: Group after dash, potentially before brackets/tags or at end
  // e.g. "Movie.Title-GROUP.mkv" -> GROUP
  const dashMatch = name.match(/-([a-z0-9]+)(?:[\[\s]|$)/);
  if (dashMatch) return dashMatch[1].toUpperCase();

  // Pattern 2: Brackets at start or end
  // e.g. "[GROUP] Movie Title" or "Movie Title [GROUP]"
  const bracketMatch = name.match(/^\[([a-z0-9.]+)\]|\[([a-z0-9.]+)\]$/);
  if (bracketMatch) return (bracketMatch[1] || bracketMatch[2]).toUpperCase();

  // Pattern 3: Heuristic - check the last 2 words if they aren't technical tags
  const words = name
    .replace(/[.\-_[\]()]/g, " ")
    .trim()
    .split(/\s+/);

  for (let i = words.length - 1; i >= Math.max(0, words.length - 2); i--) {
    const word = words[i].toUpperCase();
    if (
      !IGNORED_TAGS.includes(word) &&
      !/^\d{4}$/.test(word) &&
      word.length >= 2
    ) {
      return word;
    }
  }

  return null;
}

/**
 * Extract quality/source tags from a filename.
 * @param {string} filename - The filename to extract tags from
 * @returns {string[]} - Array of matched quality tags (uppercase)
 */
function getQualityTags(filename) {
  if (!filename) return [];
  const found = [];
  const normalized = filename.toUpperCase();
  for (const tag of QUALITY_TAGS) {
    if (normalized.includes(tag)) found.push(tag);
  }
  return found;
}

/**
 * Extract technical tags from a filename (resolution, codec, audio, etc.)
 * @param {string} filename - The filename to extract tags from
 * @returns {string[]} - Array of matched technical tags (uppercase)
 */
function getTechnicalTags(filename) {
  if (!filename) return [];
  const found = [];
  const normalized = filename.toUpperCase();
  for (const tag of TECHNICAL_TAGS) {
    if (normalized.includes(tag)) found.push(tag);
  }
  return found;
}

/**
 * Calculate weighted match score between video filename and subtitle filename.
 * Based on industry research: Group + Source are primary sync indicators.
 *
 * Scoring (0-100 bounded):
 * - Release Group Match: +50
 * - Source Type Match: +30 (from filename or page metadata)
 * - Technical Tags Match: +5 (resolution, codec, audio match)
 * - Title Fuzzy Similarity: 0-15 (capped, tiebreaker only)
 *
 * @param {string} videoFilename - The video file name
 * @param {string} subtitleFilename - The subtitle file name
 * @param {Object} [metadata] - Optional metadata from subtitle page
 * @param {string|null} [metadata.fps] - Frame rate (e.g., "23.976")
 * @param {string[]} [metadata.formats] - Formats (e.g., ["WEB-DL", "BLURAY"])
 * @returns {number} - Weighted score (0-100)
 */
function calculateMatchScore(videoFilename, subtitleFilename, metadata = null) {
  if (!videoFilename || !subtitleFilename) return 0;

  const vGroup = getReleaseGroup(videoFilename);
  const vTags = getQualityTags(videoFilename);
  const vTechTags = getTechnicalTags(videoFilename);
  const sGroup = getReleaseGroup(subtitleFilename);
  const subNormalized = subtitleFilename.toUpperCase();

  // Normalize metadata formats for comparison
  const metadataFormats = (metadata?.formats || []).map((f) => f.toUpperCase());

  let score = 0;

  // 1. Release Group Match (+50) - Primary sync indicator
  const hasGroupMatch =
    (vGroup && sGroup && vGroup === sGroup) ||
    (vGroup && subNormalized.includes(vGroup));
  if (hasGroupMatch) {
    score += 50;
  }

  // 2. Source Type Match (+30) - Secondary sync indicator
  // Check both subtitle filename AND page metadata formats
  const hasSourceMatchInFilename = vTags.some((tag) =>
    subNormalized.includes(tag)
  );
  const hasSourceMatchInMetadata =
    metadataFormats.length > 0 &&
    vTags.some((tag) =>
      metadataFormats.some(
        (format) => format.includes(tag) || tag.includes(format)
      )
    );

  if (hasSourceMatchInFilename || hasSourceMatchInMetadata) {
    score += 30;
  }

  // 3. Technical Tags Match (+5) - Small bonus for matching resolution/codec/audio
  const techMatchCount = vTechTags.filter((tag) =>
    subNormalized.includes(tag)
  ).length;
  if (techMatchCount > 0) {
    score += 5;
  }

  // 4. Title Fuzzy Similarity (0-15) - Tiebreaker only
  // Cap at 15 since we already filter by IMDB ID
  const fuzzyScore = fuzz.token_set_ratio(
    videoFilename.toLowerCase(),
    subtitleFilename.toLowerCase()
  );
  score += Math.min(15, Math.round(fuzzyScore * 0.15));

  // TODO: Future enhancement - FPS matching for sync precision

  return Math.min(100, score);
}

/**
 * Check if a text contains a specific season/episode pattern.
 * Matches: S01E05, S1E5, 1x05, E05, Ep.5, Episode 5, etc.
 * @param {string} text - Text to search in (title, description, filename)
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @returns {boolean}
 */
function matchesEpisode(text, season, episode) {
  if (!text || episode === undefined || episode === null) return false;

  const normalizedText = text.toLowerCase();
  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");
  const sShort = String(season);
  const eShort = String(episode);

  // Check if text contains ANY season indicator (S##E##, #x##, Season #, etc.)
  const seasonIndicatorRegex =
    /s\d+e\d+|\d+x\d+|(?:season|sezon|stagione|saison|staffel|évad|κύκλος|temporada)\s*\d+/i;
  const hasSeasonInText = seasonIndicatorRegex.test(normalizedText);

  if (hasSeasonInText) {
    // TEXT HAS SEASON: Require exact season+episode match
    const strictPatterns = [
      // S01E05 format
      new RegExp(`s${s}e${e}\\b`, "i"),
      new RegExp(`s${sShort}e${eShort}\\b`, "i"),
      new RegExp(`s${s}e${eShort}\\b`, "i"),
      new RegExp(`s${sShort}e${e}\\b`, "i"),
      // 1x05 format
      new RegExp(`\\b${sShort}x${e}\\b`, "i"),
      new RegExp(`\\b${sShort}x${eShort}\\b`, "i"),
      new RegExp(`\\b${s}x${e}\\b`, "i"),
    ];

    // Multi-language "Season X Episode Y" style
    const seasonKeywords =
      "(?:season|sezon|stagione|saison|staffel|évad|κύκλος|temporada)";
    const episodeKeywords =
      "(?:episode|episod|episodio|épisode|folge|epizód|επεισόδιο|episódio)";
    strictPatterns.push(
      new RegExp(
        `${seasonKeywords}\\s*${sShort}.*?${episodeKeywords}\\s*${eShort}`,
        "i"
      ),
      new RegExp(`${seasonKeywords}\\s*${s}.*?${episodeKeywords}\\s*${e}`, "i")
    );

    return strictPatterns.some((pattern) => pattern.test(normalizedText));
  } else {
    // TEXT HAS NO SEASON: Allow episode-only match (for anime, etc.)
    const episodeOnlyPatterns = [
      new RegExp(`\\be${e}\\b`, "i"),
      new RegExp(`\\be${eShort}\\b`, "i"),
      new RegExp(`\\bep\\.?\\s*${eShort}\\b`, "i"),
      new RegExp(`\\bep\\.?\\s*${e}\\b`, "i"),
      new RegExp(
        `\\b(?:episode|episod|episodio|épisode|folge|epizód|επεισόδιο|episódio)\\s*${eShort}\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:episode|episod|episodio|épisode|folge|epizód|επεισόδιο|episódio)\\s*${e}\\b`,
        "i"
      ),
      // Also match "-04" or ".04" or "_04" patterns common in anime
      new RegExp(`[\\-\\._\\s]${e}[\\-\\._\\s\\[]`, "i"),
    ];

    return episodeOnlyPatterns.some((pattern) => pattern.test(normalizedText));
  }
}

module.exports = {
  matchesEpisode,
  calculateMatchScore,
  getQualityTags,
  getReleaseGroup,
};
