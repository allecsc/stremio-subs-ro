const fuzz = require("fuzzball");

/**
 * Parse and validate a Stremio ID.
 * Supports IMDb (tt1234567, tt1234567:1:2) and TMDB (tmdb:12345, tmdb:12345:1:2).
 * Fast-fails on unsupported stream IDs (e.g. IPTV, random hashes).
 *
 * @param {string} id - The Stremio ID
 * @returns {{ type: "imdb"|"tmdb"|null, id: string|null, season: number|null, episode: number|null, isValid: boolean }}
 */
function parseStremioId(id) {
  if (!id || typeof id !== "string") {
    return { type: null, id: null, season: null, episode: null, isValid: false };
  }

  // TMDB format: tmdb:12345 or tmdb:12345:1:2
  if (id.startsWith("tmdb:")) {
    const parts = id.split(":");
    const tmdbId = parts[1];
    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
      return { type: null, id: null, season: null, episode: null, isValid: false };
    }
    return {
      type: "tmdb",
      id: tmdbId,
      season: parts[2] ? parseInt(parts[2], 10) : null,
      episode: parts[3] ? parseInt(parts[3], 10) : null,
      isValid: true,
    };
  }

  // IMDb format: tt1234567 or tt1234567:1:2
  if (/^tt\d+/.test(id)) {
    const parts = id.split(":");
    const imdbId = parts[0];
    return {
      type: "imdb",
      id: imdbId,
      season: parts[1] ? parseInt(parts[1], 10) : null,
      episode: parts[2] ? parseInt(parts[2], 10) : null,
      isValid: true,
    };
  }

  // Unsupported or invalid ID (e.g. IPTV stream)
  return { type: null, id: null, season: null, episode: null, isValid: false };
}

/**
 * Check if a subtitle filename represents a partial or forced track that should be excluded.
 * Rejects FORCED, CD1-CD9, DISC1-DISC9, D1-D9 disc parts, PART1-PART9.
 *
 * @param {string} filename - Subtitle filename or path
 * @returns {boolean} - True if excluded
 */
function isExcludedSubtitle(filename) {
  if (!filename) return true;

  const normalized = filename.toLowerCase().replace(/[._\-\[\]()\/]/g, " ");

  // 1. Forced subtitles (dialogue incomplete)
  if (/\bforced\b/i.test(normalized)) {
    return true;
  }

  // 2. Multi-CD or split parts (CD1-9, Disc1-9, Part1-9, Pt1-9, D1-9)
  const splitPatterns = [
    /\bcd\s*\d+\b/i,
    /\bdisc\s*\d+\b/i,
    /\bdisk\s*\d+\b/i,
    /\bpart\s*\d+\b/i,
    /\bpt\s*\d+\b/i,
    /\d+\s*cd/i,
    /[\.\-_\s\/]d[1-9](?:\.srt|\.vtt|[\.\-_\s\/]|$)/i,
  ];

  for (const pattern of splitPatterns) {
    if (pattern.test(filename) || pattern.test(normalized)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract Movie Edition / Cut tags from a filename.
 * @param {string} filename
 * @returns {string[]}
 */
function getEditionTags(filename) {
  if (!filename) return [];
  const normalized = filename.toUpperCase().replace(/[._\[\]()]/g, " ");
  const found = [];

  const editions = [
    { tag: "EXTENDED", regex: /\bEXTENDED\b/i },
    { tag: "UNRATED", regex: /\bUNRATED\b/i },
    { tag: "DIRECTORS CUT", regex: /\b(?:DIRECTORS?[\s\-_]?CUT|DC)\b/i },
    { tag: "REMASTERED", regex: /\bREMASTERED\b/i },
    { tag: "IMAX", regex: /\bIMAX\b/i },
    { tag: "THEATRICAL", regex: /\bTHEATRICAL\b/i },
    { tag: "SPECIAL EDITION", regex: /\bSPECIAL[\s\-_]?EDITION\b/i },
    { tag: "FINAL CUT", regex: /\bFINAL[\s\-_]?CUT\b/i },
  ];

  for (const ed of editions) {
    if (ed.regex.test(normalized) || ed.regex.test(filename)) {
      found.push(ed.tag);
    }
  }

  return found;
}

/**
 * Extract Streaming Network / Platform tags from a filename.
 * @param {string} filename
 * @returns {string[]}
 */
function getNetworkTags(filename) {
  if (!filename) return [];
  const normalized = filename.toUpperCase().replace(/[._\[\]()]/g, " ");
  const found = [];

  const networks = [
    "AMZN",
    "NF",
    "DSNP",
    "ATVP",
    "HMAX",
    "HULU",
    "MAX",
    "CR",
    "BBC",
    "ITV",
    "STAN",
    "CRAVE",
  ];

  for (const net of networks) {
    const regex = new RegExp(`\\b${net}\\b`, "i");
    if (regex.test(normalized) || regex.test(filename)) {
      found.push(net);
    }
  }

  return found;
}

/**
 * Extract source / quality tags from a filename.
 * @param {string} filename
 * @returns {string[]}
 */
function getQualityTags(filename) {
  if (!filename) return [];
  const normalized = filename.toUpperCase().replace(/[._\[\]()]/g, " ");
  const found = [];

  const sources = [
    { tag: "REMUX", regex: /\bREMUX\b/i },
    { tag: "BLURAY", regex: /\b(?:BLURAY|BLU[\s\-_]?RAY|BD50|BD25)\b/i },
    { tag: "BDRIP", regex: /\bBDRIP\b/i },
    { tag: "BRRIP", regex: /\bBRRIP\b/i },
    { tag: "WEB-DL", regex: /\b(?:WEB[\s\-_]?DL)\b/i },
    { tag: "WEBRIP", regex: /\bWEBRIP\b/i },
    { tag: "HDRIP", regex: /\bHDRIP\b/i },
    { tag: "DVDRIP", regex: /\bDVDRIP\b/i },
    { tag: "HDTV", regex: /\bHDTV\b/i },
    { tag: "PDTV", regex: /\bPDTV\b/i },
    { tag: "CAM", regex: /\bCAM\b/i },
    { tag: "TS", regex: /\bTS\b/i },
    { tag: "TC", regex: /\bTC\b/i },
    { tag: "SCR", regex: /\bSCR\b/i },
  ];

  for (const src of sources) {
    if (src.regex.test(normalized) || src.regex.test(filename)) {
      found.push(src.tag);
    }
  }

  return found;
}

/**
 * Extract the release group from a filename.
 * Conventionally, this is the part after the last dash (e.g., Title-GROUP.mkv)
 */
function getReleaseGroup(filename) {
  if (!filename) return null;

  const name = filename.replace(/\.[a-zA-Z0-9]+$/, "").trim();

  const STOP_WORDS = [
    "MKV", "MP4", "AVI", "SRT", "VTT", "SUB", "IDX",
    "THE", "A", "AN", "OF", "AND", "IN", "ON", "FOR", "TO", "WITH",
    "RO", "EN", "ENG", "ROM", "SUBS", "SUBTITRARI",
    "TITLE", "MOVIE", "SERIES", "SEASON", "EPISODE", "SEZON", "EPISOD",
    "EXTENDED", "UNRATED", "REMASTERED", "THEATRICAL",
    "REMUX", "BLURAY", "BDRIP", "BRRIP", "WEB-DL", "WEBRIP", "WEBDL",
    "HDRIP", "DVDRIP", "HDTV", "PDTV", "CAM", "TS", "TC", "SCR",
    "1080P", "720P", "2160P", "4K", "UHD", "HDR", "DV", "DOVI",
    "X264", "H264", "X265", "H265", "HEVC", "AAC", "DDP5", "DDP2", "DD5",
    "AC3", "DTS", "TRUEHD", "ATMOS", "INTERNAL", "REPACK", "PROPER", "LIMITED", "MULTI"
  ];

  // Pattern 1: Group after the LAST dash before optional brackets/end
  const lastDashMatch = name.match(/-([a-zA-Z0-9_]+)(?:\s*\[[^\]]*\])*$/i);
  if (lastDashMatch) {
    const candidate = lastDashMatch[1].toUpperCase();
    if (!STOP_WORDS.includes(candidate) && !/^\d+$/.test(candidate) && candidate.length >= 2) {
      return candidate;
    }
  }

  // Pattern 2: Brackets at start or end
  const bracketMatch = name.match(/^\[([a-zA-Z0-9._]+)\]|\[([a-zA-Z0-9._]+)\]$/i);
  if (bracketMatch) {
    const candidate = (bracketMatch[1] || bracketMatch[2]).toUpperCase();
    if (!STOP_WORDS.includes(candidate) && !/^\d+$/.test(candidate) && candidate.length >= 2) {
      return candidate;
    }
  }

  // Pattern 3: Check last word if not a stop word
  const words = name
    .replace(/[.\-_[\]()\/]/g, " ")
    .trim()
    .split(/\s+/);

  for (let i = words.length - 1; i >= Math.max(0, words.length - 2); i--) {
    const word = words[i].toUpperCase();
    if (!STOP_WORDS.includes(word) && !/^\d+$/.test(word) && word.length >= 2) {
      return word;
    }
  }

  return null;
}

/**
 * Clean a filename for exact comparison (strip extension, trim, lowercase).
 */
function cleanBaseName(filename) {
  if (!filename) return "";
  return filename.replace(/\.[a-zA-Z0-9]+$/, "").trim().toLowerCase();
}

/**
 * Extract video resolution tag (2160p, 1080p, 720p, 480p).
 * @param {string} filename
 * @returns {string|null}
 */
function getResolution(filename) {
  if (!filename) return null;
  const normalized = filename.toUpperCase();
  if (/\b(?:2160P|4K|UHD)\b/i.test(normalized)) return "2160P";
  if (/\b(?:1080P|1080I|FHD)\b/i.test(normalized)) return "1080P";
  if (/\b(?:720P|HD)\b/i.test(normalized)) return "720P";
  if (/\b(?:480P|576P|SD)\b/i.test(normalized)) return "480P";
  return null;
}

/**
 * Calculate weighted match score between video filename and subtitle filename
 * using the finalized 9-Tier Scene Matching Hierarchy with UHD/Remux master tiebreakers.
 *
 * Excluded subtitles (FORCED, Multi-CD) return -1.
 *
 * @param {string} videoFilename - The video file name
 * @param {string} subtitleFilename - The subtitle file name
 * @returns {number} - Weighted score (-1 if excluded, otherwise 1-100)
 */
function calculateMatchScore(videoFilename, subtitleFilename) {
  if (!videoFilename || !subtitleFilename) return 0;

  // Check exclusion filter first
  if (isExcludedSubtitle(subtitleFilename)) {
    return -1;
  }

  // Tier 1: Exact Filename Match
  if (cleanBaseName(videoFilename) === cleanBaseName(subtitleFilename)) {
    return 100;
  }

  const vEditions = getEditionTags(videoFilename);
  const sEditions = getEditionTags(subtitleFilename);
  const vNetworks = getNetworkTags(videoFilename);
  const sNetworks = getNetworkTags(subtitleFilename);
  const vSources = getQualityTags(videoFilename);
  const sSources = getQualityTags(subtitleFilename);
  const vGroup = getReleaseGroup(videoFilename);
  const sGroup = getReleaseGroup(subtitleFilename);

  const vRes = getResolution(videoFilename);
  const sRes = getResolution(subtitleFilename);
  const vIsRemux = /\bremux\b/i.test(videoFilename);
  const sIsRemux = /\bremux\b/i.test(subtitleFilename);
  const vIsUhd = vRes === "2160P" || /\b(?:2160p|4k|uhd)\b/i.test(videoFilename);
  const sIsUhd = sRes === "2160P" || /\b(?:2160p|4k|uhd)\b/i.test(subtitleFilename);

  // Calculate master tiebreaker bonus (0-4 max points inside tier)
  let tieBonus = 0;
  if (vIsUhd && sIsUhd) tieBonus += 2;
  if (vIsRemux && sIsRemux) tieBonus += 1;
  if (vRes && sRes && vRes === sRes) tieBonus += 1;

  const subNormalized = subtitleFilename.toUpperCase();

  const hasEditionMatch =
    vEditions.length > 0 &&
    sEditions.some((ed) => vEditions.includes(ed));

  const hasNetworkMatch =
    vNetworks.length > 0 &&
    sNetworks.some((net) => vNetworks.includes(net));

  const hasSourceMatch =
    vSources.length > 0 &&
    sSources.some((src) => vSources.includes(src));

  const hasGroupMatch =
    Boolean(vGroup && sGroup && vGroup === sGroup) ||
    Boolean(vGroup && new RegExp(`\\b${vGroup}\\b`, "i").test(subNormalized));

  // Tier 2: Edition + Source + Network + Group (95 - 99)
  if (hasEditionMatch && hasSourceMatch && hasNetworkMatch && hasGroupMatch) {
    return Math.min(99, 95 + tieBonus);
  }

  // Tier 3: Edition + Source + Network (90 - 94)
  if (hasEditionMatch && hasSourceMatch && hasNetworkMatch) {
    return Math.min(94, 90 + tieBonus);
  }

  // Tier 4: Edition + Source + Group (85 - 89)
  if (hasEditionMatch && hasSourceMatch && hasGroupMatch) {
    return Math.min(89, 85 + tieBonus);
  }

  // Tier 5: Edition + Source (80 - 84)
  if (hasEditionMatch && hasSourceMatch) {
    return Math.min(84, 80 + tieBonus);
  }

  // Tier 6: Source + Network + Group (76 - 79)
  if (hasSourceMatch && hasNetworkMatch && hasGroupMatch) {
    return Math.min(79, 76 + tieBonus);
  }

  // Tier 7: Source + Network (72 - 75)
  if (hasSourceMatch && hasNetworkMatch) {
    return Math.min(75, 72 + tieBonus);
  }

  // Tier 8: Source + Group (60 - 64)
  if (hasSourceMatch && hasGroupMatch) {
    return Math.min(64, 60 + tieBonus);
  }

  // Tier 9: Source Only (45 - 49)
  if (hasSourceMatch) {
    return Math.min(49, 45 + tieBonus);
  }

  // Tier 10: Fuzzy Fallback with Source Quality Weighting (1 - 20)
  // When no direct release tags match the video, prioritize standard sync sources:
  // BluRay / Remux (+6) > WEB-DL / WEBRip (+4) > HDTV (+2) > DVDRip / Others (+0)
  let fallbackSourceWeight = 0;
  if (sSources.some((s) => ["BLURAY", "REMUX", "BDRIP", "BRRIP"].includes(s))) {
    fallbackSourceWeight = 6;
  } else if (sSources.some((s) => ["WEB-DL", "WEBRip", "WEBDL", "HDRIP"].includes(s))) {
    fallbackSourceWeight = 4;
  } else if (sSources.some((s) => ["HDTV", "PDTV"].includes(s))) {
    fallbackSourceWeight = 2;
  }

  const fuzzyScore = fuzz.token_set_ratio(
    videoFilename.toLowerCase(),
    subtitleFilename.toLowerCase(),
  );
  const baseFuzzy = Math.round(fuzzyScore * 0.14); // 0-14 points
  return Math.max(1, Math.min(20, baseFuzzy + fallbackSourceWeight));
}

// Static patterns for episode matching
const SEASON_INDICATOR_REGEX =
  /s\d+e\d+|\d+x\d+|(?:season|sezon|stagione|saison|staffel|évad|κύκλος|temporada)\s*\d+/i;
const SEASON_KEYWORDS =
  "(?:season|sezon|stagione|saison|staffel|évad|κύκλος|temporada)";
const EPISODE_KEYWORDS =
  "(?:episode|episod|episodio|épisode|folge|epizód|επεισόδιο|episódio)";

/**
 * Check if a text contains a specific season/episode pattern.
 */
function matchesEpisode(text, season, episode) {
  if (!text || episode === undefined || episode === null) return false;

  const normalizedText = text.toLowerCase();

  if (!SEASON_INDICATOR_REGEX.test(normalizedText) && !/\d/.test(text)) {
    return false;
  }

  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");
  const sShort = String(season);
  const eShort = String(episode);

  const hasSeasonInText = SEASON_INDICATOR_REGEX.test(normalizedText);

  if (hasSeasonInText) {
    const standardPatterns = [
      `s${s}e${e}\\b`,
      `s${sShort}e${eShort}\\b`,
      `s${s}e${eShort}\\b`,
      `s${sShort}e${e}\\b`,
      `\\b${sShort}x${e}\\b`,
      `\\b${sShort}x${eShort}\\b`,
      `\\b${s}x${e}\\b`,
    ];

    for (const pat of standardPatterns) {
      if (new RegExp(pat, "i").test(normalizedText)) return true;
    }

    const verbose1 = `${SEASON_KEYWORDS}\\s*${sShort}.*?${EPISODE_KEYWORDS}\\s*${eShort}`;
    const verbose2 = `${SEASON_KEYWORDS}\\s*${s}.*?${EPISODE_KEYWORDS}\\s*${e}`;

    return (
      new RegExp(verbose1, "i").test(normalizedText) ||
      new RegExp(verbose2, "i").test(normalizedText)
    );
  } else {
    const epPatterns = [
      `\\be${e}\\b`,
      `\\be${eShort}\\b`,
      `\\bep\\.?\\s*${eShort}\\b`,
      `\\bep\\.?\\s*${e}\\b`,
      `\\b${EPISODE_KEYWORDS}\\s*${eShort}\\b`,
      `\\b${EPISODE_KEYWORDS}\\s*${e}\\b`,
      `[\\-\\._\\s]${e}[\\-\\._\\s\\[]`,
    ];

    for (const pat of epPatterns) {
      if (new RegExp(pat, "i").test(normalizedText)) return true;
    }

    return false;
  }
}

module.exports = {
  parseStremioId,
  isExcludedSubtitle,
  getEditionTags,
  getNetworkTags,
  getQualityTags,
  getReleaseGroup,
  getResolution,
  calculateMatchScore,
  matchesEpisode,
};
