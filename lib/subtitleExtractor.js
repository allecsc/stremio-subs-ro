const iconv = require("iconv-lite");
const jschardet = require("jschardet");

/**
 * Detect archive type from magic bytes
 */
function getArchiveType(buffer) {
  if (!buffer || buffer.length < 3) return "zip";
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return "zip";
  if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72) return "rar";
  return "zip";
}

/**
 * Normalize legacy Romanian cedilla characters to standard comma-below diacritics.
 * ş (U+015F) -> ș (U+0219)
 * Ş (U+015E) -> Ș (U+0218)
 * ţ (U+0163) -> ț (U+021B)
 * Ţ (U+0162) -> Ț (U+021A)
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeRomanianDiacritics(text) {
  if (!text || typeof text !== "string") return "";

  return text
    .replace(/\u015F/g, "\u0219") // ş -> ș
    .replace(/\u015E/g, "\u0218") // Ş -> Ș
    .replace(/\u0163/g, "\u021B") // ţ -> ț
    .replace(/\u0162/g, "\u021A"); // Ţ -> Ț
}

/**
 * Decode a subtitle buffer with automatic charset detection (Windows-1250, UTF-8, ISO-8859-2).
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeSubtitleBuffer(buffer) {
  if (!buffer || buffer.length === 0) return "";

  const detected = jschardet.detect(buffer);
  let encoding = detected?.encoding ? detected.encoding.toLowerCase() : "utf-8";

  // For Romanian subtitles, low confidence or Windows-1252 usually indicates Windows-1250
  if (
    encoding.includes("windows-1252") ||
    encoding.includes("ascii") ||
    !detected ||
    detected.confidence < 0.8
  ) {
    // Check if valid UTF-8
    try {
      const utf8Str = buffer.toString("utf-8");
      // If no replacement characters and contains Romanian diacritics, it's valid UTF-8
      if (!utf8Str.includes("\uFFFD") && /[șțăîâşţ]/i.test(utf8Str)) {
        return utf8Str;
      }
    } catch (_) {}

    encoding = "windows-1250";
  }

  try {
    return iconv.decode(buffer, encoding);
  } catch (_) {
    return buffer.toString("utf-8");
  }
}

/**
 * Convert SRT content to standard WebVTT format with normalized diacritics.
 * @param {string|Buffer} srtInput
 * @returns {string}
 */
function srtToVtt(srtInput) {
  let text = typeof srtInput === "string" ? srtInput : decodeSubtitleBuffer(srtInput);

  // 1. Normalize diacritics
  text = normalizeRomanianDiacritics(text);

  // 2. Normalize line endings and strip BOM
  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 3. Convert timestamps (00:01:23,456 -> 00:01:23.456)
  text = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");

  // 4. Strip ASS/SSA positioning and formatting tags (e.g. {\an8}, {\\pos(x,y)})
  text = text.replace(/\{\\[^}]+\}/gi, "");

  // 5. Ensure valid WEBVTT header
  if (!text.startsWith("WEBVTT")) {
    text = "WEBVTT\n\n" + text;
  }

  return text;
}

module.exports = {
  getArchiveType,
  normalizeRomanianDiacritics,
  decodeSubtitleBuffer,
  srtToVtt,
};
