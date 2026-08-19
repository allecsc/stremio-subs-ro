const AdmZip = require("adm-zip");
const unrar = require("node-unrar-js");
const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Validate that an archive entry path is safe (no path traversal, valid SRT extension).
 */
function isSafeArchiveEntry(entryName) {
  if (!entryName || typeof entryName !== "string") return false;
  if (
    entryName.includes("..") ||
    entryName.startsWith("/") ||
    entryName.startsWith("\\") ||
    entryName.includes("\0")
  ) {
    return false;
  }
  return entryName.toLowerCase().endsWith(".srt");
}

/**
 * Detect archive type by reading first 4 magic bytes directly from file descriptor.
 * Never reads the whole archive into RAM.
 */
function getArchiveTypeFromFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(4);
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    fd = null;

    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return "zip";
    if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72)
      return "rar";
    return "zip";
  } catch (e) {
    if (fd !== null && fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (err) {}
    }
    return "zip";
  }
}

/**
 * List all SRT files in a RAR archive using file-backed extractor.
 * Operates directly on disk without pre-reading archive into Node.js Buffer.
 * Throws if archive is corrupt or unparsable.
 */
async function listSrtsFromRarFile(filePath) {
  const extractor = await unrar.createExtractorFromFile({ filepath: filePath });
  const list = extractor.getFileList();
  const fileHeaders = [...list.fileHeaders];

  return fileHeaders
    .filter(
      (h) =>
        !h.flags.directory &&
        !h.name.includes("__MACOSX") &&
        isSafeArchiveEntry(h.name),
    )
    .map((h) => h.name);
}

/**
 * List all SRT files in a ZIP archive directly from file path.
 * Throws if archive is corrupt or unparsable.
 */
function listSrtsFromZipFile(filePath) {
  const zip = new AdmZip(filePath);
  return zip
    .getEntries()
    .filter(
      (e) =>
        !e.isDirectory &&
        !e.entryName.includes("__MACOSX") &&
        isSafeArchiveEntry(e.entryName),
    )
    .map((e) => e.entryName);
}

/**
 * List all SRT file names in an archive (ZIP or RAR) directly from file path.
 * Propagates parser exceptions if the archive is corrupt/unparsable.
 */
async function listSrtFilesFromFile(filePath) {
  const archiveType = getArchiveTypeFromFile(filePath);
  if (archiveType === "rar") {
    return await listSrtsFromRarFile(filePath);
  } else {
    return listSrtsFromZipFile(filePath);
  }
}

const MAX_UNCOMPRESSED_SRT_BYTES = 10 * 1024 * 1024; // 10 MiB limit per extracted subtitle

/**
 * Extract a single specific SRT file from a RAR archive using file-backed extractor.
 * Extracts directly to a temporary directory without reading the full compressed archive into RAM.
 */
async function extractSrtFromRarFile(filePath, srtPath) {
  if (!isSafeArchiveEntry(srtPath)) return null;
  const tmpDir = path.join(
    os.tmpdir(),
    `unrar_track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    const extractor = await unrar.createExtractorFromFile({
      filepath: filePath,
      targetPath: tmpDir,
    });

    const list = extractor.getFileList();
    const header = [...list.fileHeaders].find((h) => h.name === srtPath);
    if (!header || header.flags?.directory) {
      return null;
    }

    if (
      !Number.isSafeInteger(header.unpSize) ||
      header.unpSize < 0 ||
      header.unpSize > MAX_UNCOMPRESSED_SRT_BYTES
    ) {
      return null;
    }

    fs.mkdirSync(tmpDir, { recursive: true });
    const extracted = extractor.extract({ files: [srtPath] });
    for (const _ of extracted.files) {} // exhaust generator

    const extractedFilePath = path.join(tmpDir, srtPath);
    if (!fs.existsSync(extractedFilePath)) {
      return null;
    }

    const stat = fs.statSync(extractedFilePath);
    if (!stat.isFile() || stat.size > MAX_UNCOMPRESSED_SRT_BYTES) {
      return null;
    }

    const buffer = fs.readFileSync(extractedFilePath);
    return buffer;
  } catch (err) {
    return null;
  } finally {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (e) {}
  }
}

/**
 * Extract a single specific SRT file from a ZIP archive directly from file path.
 */
function extractSrtFromZipFile(filePath, srtPath) {
  if (!isSafeArchiveEntry(srtPath)) return null;
  try {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry(srtPath);
    if (!entry || entry.isDirectory) return null;

    const declaredSize = entry.header?.size;
    if (
      !Number.isSafeInteger(declaredSize) ||
      declaredSize < 0 ||
      declaredSize > MAX_UNCOMPRESSED_SRT_BYTES
    ) {
      return null;
    }

    const buffer = entry.getData();
    if (!buffer || buffer.length > MAX_UNCOMPRESSED_SRT_BYTES) {
      return null;
    }

    return buffer;
  } catch (err) {
    return null;
  }
}

/**
 * Extract a single specific SRT file from an archive (ZIP or RAR) directly from file path.
 */
async function extractSrtFileFromFile(filePath, srtPath) {
  const archiveType = getArchiveTypeFromFile(filePath);
  if (archiveType === "rar") {
    return await extractSrtFromRarFile(filePath, srtPath);
  } else {
    return extractSrtFromZipFile(filePath, srtPath);
  }
}

module.exports = {
  isSafeArchiveEntry,
  getArchiveTypeFromFile,
  listSrtFilesFromFile,
  extractSrtFileFromFile,
  listSrtsFromRarFile,
  extractSrtFromRarFile,
  listSrtsFromZipFile,
  extractSrtFromZipFile,
  MAX_UNCOMPRESSED_SRT_BYTES,
};
