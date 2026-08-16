const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const axios = require("axios");
const AdmZip = require("adm-zip");
const { createExtractorFromData } = require("node-unrar-js");
const { extractSingleVtt, getArchiveType, unpackArchiveToVttMap } = require("../lib/subtitleExtractor");

const DATA_DIR = path.join(os.tmpdir(), "subsro-archive-benchmark");
const ARCHIVE_DIR = path.join(DATA_DIR, "archives");
const MANIFEST_PATH = path.join(DATA_DIR, "manifest.json");
const REPORT_PATH = path.join(DATA_DIR, "report.json");
// The original benchmark used 18 logical API operations, but its retrying
// client did not capture the underlying attempt count. Further downloads stay
// locked until the user grants a fresh HTTP-attempt budget. This harness never
// retries.
const REMAINING_AUTHORIZED_HTTP_ATTEMPTS = 0;
const TITLES = [
  { label: "Breaking Bad", imdbId: "tt0903747", downloads: 4 },
  { label: "Game of Thrones", imdbId: "tt0944947", downloads: 4 },
  { label: "The Matrix", imdbId: "tt0133093", downloads: 3 },
  { label: "Dune Part Two", imdbId: "tt15239678", downloads: 2 },
  { label: "Oppenheimer", imdbId: "tt15398776", downloads: 1 },
];

function ensureDataDirectories() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

function bytesToMiB(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(3));
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    heapMiB: bytesToMiB(usage.heapUsed),
    rssMiB: bytesToMiB(usage.rss),
    externalMiB: bytesToMiB(usage.external),
    maxRssMiB: bytesToMiB(process.resourceUsage().maxRSS * 1024),
  };
}

function forceGc() {
  if (typeof global.gc === "function") global.gc();
}

async function timed(fn) {
  const started = performance.now();
  const value = await fn();
  return { value, elapsedMs: Math.round(performance.now() - started) };
}

function getVttBytes(vttMap) {
  let bytes = 0;
  for (const [trackPath, vtt] of vttMap) {
    bytes += Buffer.byteLength(trackPath, "utf8") + Buffer.byteLength(vtt, "utf8");
  }
  return bytes;
}

function chooseRepresentativeTrack(trackPaths) {
  const patterns = [/[Ss]0?1[Ee]0?1/, /\b0?1x0?1\b/i, /\b[Ee]0?1\b/];
  return trackPaths.find((trackPath) => patterns.some((pattern) => pattern.test(trackPath))) || trackPaths[0] || null;
}

function listZip(buffer) {
  const entries = new AdmZip(buffer).getEntries().filter(
    (entry) => !entry.isDirectory && !entry.entryName.includes("__MACOSX") && entry.entryName.toLowerCase().endsWith(".srt"),
  );
  return {
    trackPaths: entries.map((entry) => entry.entryName),
    originalSrtBytes: entries.reduce((total, entry) => total + entry.header.size, 0),
  };
}

async function listRar(buffer) {
  const extractor = await createExtractorFromData({ data: buffer });
  const headers = [...extractor.getFileList().fileHeaders].filter(
    (header) => !header.flags.directory && !header.name.includes("__MACOSX") && header.name.toLowerCase().endsWith(".srt"),
  );
  return {
    trackPaths: headers.map((header) => header.name),
    originalSrtBytes: headers.reduce((total, header) => total + Number(header.unpSize || header.unpackedSize || 0), 0),
  };
}

async function listArchive(buffer, archiveType) {
  return archiveType === "rar" ? listRar(buffer) : listZip(buffer);
}

async function measureArchive(entry) {
  forceGc();
  const baseline = memorySnapshot();
  const read = await timed(() => fs.readFileSync(entry.filePath));
  const archiveBuffer = read.value;
  const afterRead = memorySnapshot();
  const archiveType = getArchiveType(archiveBuffer);
  const listed = await timed(() => listArchive(archiveBuffer, archiveType));
  const selectedTrack = chooseRepresentativeTrack(listed.value.trackPaths);
  const afterList = memorySnapshot();
  const eager = await timed(() => unpackArchiveToVttMap(archiveBuffer));
  const eagerVttBytes = getVttBytes(eager.value);
  const afterEager = memorySnapshot();
  const expectedSelected = selectedTrack ? eager.value.get(selectedTrack) : null;
  eager.value = null;
  forceGc();
  const beforeSelected = memorySnapshot();
  const selected = selectedTrack
    ? await timed(() => extractSingleVtt(archiveBuffer, selectedTrack))
    : { value: null, elapsedMs: 0 };
  const afterSelected = memorySnapshot();
  const diskReuse = selectedTrack
    ? await timed(async () => extractSingleVtt(fs.readFileSync(entry.filePath), selectedTrack))
    : { value: null, elapsedMs: 0 };

  assert.strictEqual(selected.value, expectedSelected);
  assert.strictEqual(diskReuse.value, selected.value);

  return {
    label: entry.label,
    sourceTitle: entry.sourceTitle,
    archiveType,
    compressedMiB: bytesToMiB(archiveBuffer.byteLength),
    tracks: listed.value.trackPaths.length,
    originalSrtMiB: bytesToMiB(listed.value.originalSrtBytes),
    eagerVttMiB: bytesToMiB(eagerVttBytes),
    selectedVttMiB: bytesToMiB(Buffer.byteLength(selected.value || "", "utf8")),
    expansionRatio: archiveBuffer.byteLength ? Number((eagerVttBytes / archiveBuffer.byteLength).toFixed(2)) : 0,
    timingsMs: {
      diskRead: read.elapsedMs,
      listOnly: listed.elapsedMs,
      eagerAllTracks: eager.elapsedMs,
      selectedFromRam: selected.elapsedMs,
      selectedFromDisk: diskReuse.elapsedMs,
    },
    memory: { baseline, afterRead, afterList, afterEager, beforeSelected, afterSelected },
  };
}

async function measureFourArchiveBatch(entries) {
  const zipEntries = entries.filter((entry) => path.extname(entry.filePath).toLowerCase() === ".zip");
  const batchSource = zipEntries.length >= 4 ? zipEntries : entries;
  const batch = batchSource.slice(0, Math.min(4, batchSource.length));
  if (!batch.length) return null;
  forceGc();
  const before = memorySnapshot();
  const measured = await timed(() => Promise.all(batch.map(async (entry) => {
    return unpackArchiveToVttMap(fs.readFileSync(entry.filePath));
  })));
  const after = memorySnapshot();
  const retainedVttBytes = measured.value.reduce((sum, map) => sum + getVttBytes(map), 0);
  return {
    archiveCount: batch.length,
    elapsedMs: measured.elapsedMs,
    retainedVttMiB: bytesToMiB(retainedVttBytes),
    before,
    after,
  };
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function summarize(results) {
  const average = (values) => values.length
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3))
    : 0;
  const compressed = results.map((result) => result.compressedMiB);
  const tracks = results.map((result) => result.tracks);
  const eager = results.map((result) => result.eagerVttMiB);
  const typical = average(eager);
  const high = percentile(eager, 0.9);
  return {
    archiveCount: results.length,
    compressedMiB: { average: average(compressed), high: percentile(compressed, 0.9) },
    tracks: { average: average(tracks), high: percentile(tracks, 0.9), maximum: Math.max(0, ...tracks) },
    eagerVttMiB: { average: typical, high, maximum: Math.max(0, ...eager) },
    timingsMs: {
      eagerAverage: average(results.map((result) => result.timingsMs.eagerAllTracks)),
      selectedAverage: average(results.map((result) => result.timingsMs.selectedFromRam)),
    },
    estimatedRetainedVttMiB: {
      archives30Typical: Number((typical * 30).toFixed(1)),
      archives250Typical: Number((typical * 250).toFixed(1)),
      archives250High: Number((high * 250).toFixed(1)),
    },
    estimatedBurstVttMiB: {
      fourTypical: Number((typical * 4).toFixed(1)),
      eightTypical: Number((typical * 8).toFixed(1)),
      twelveTypical: Number((typical * 12).toFixed(1)),
      twelveHigh: Number((high * 12).toFixed(1)),
    },
  };
}

async function downloadDataset() {
  const apiKey = process.env.SUBSRO_BENCH_API_KEY;
  if (!apiKey) throw new Error("SUBSRO_BENCH_API_KEY must be set outside this script.");
  const requestedBudget = Number.parseInt(process.env.SUBSRO_BENCH_HTTP_BUDGET || "0", 10);
  if (!Number.isInteger(requestedBudget) || requestedBudget < 1) {
    throw new Error("Set SUBSRO_BENCH_HTTP_BUDGET only after receiving explicit authorization for more HTTP attempts.");
  }
  if (requestedBudget > REMAINING_AUTHORIZED_HTTP_ATTEMPTS) {
    throw new Error(`HTTP attempt budget exceeds the ${REMAINING_AUTHORIZED_HTTP_ATTEMPTS} attempts still authorized.`);
  }
  ensureDataDirectories();
  let requestsUsed = 0;
  const candidates = [];

  async function getOnce(url, options = {}) {
    if (requestsUsed >= requestedBudget) throw new Error("HTTP attempt budget exhausted.");
    requestsUsed += 1;
    return axios.get(url, {
      timeout: 10000,
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024,
      headers: { "X-Subs-Api-Key": apiKey },
      ...options,
    });
  }

  for (const title of TITLES) {
    if (requestsUsed >= requestedBudget) break;
    const response = await getOnce(`https://api.subs.ro/v1.0/search/imdbid/${title.imdbId}?language=ro`);
    const results = Array.isArray(response.data?.items) ? response.data.items : [];
    const seen = new Set();
    for (const result of results) {
      if (seen.has(result.id) || seen.size >= title.downloads) continue;
      seen.add(result.id);
      candidates.push({ sourceTitle: title.label, subId: result.id });
    }
  }

  const manifestEntries = [];
  let next = 0;
  async function worker() {
    while (next < candidates.length && requestsUsed < requestedBudget) {
      const candidate = candidates[next++];
      try {
        const response = await getOnce(`https://api.subs.ro/v1.0/subtitle/${candidate.subId}/download`, {
          responseType: "arraybuffer",
        });
        const buffer = Buffer.from(response.data);
        const archiveType = getArchiveType(buffer);
        const safeTitle = candidate.sourceTitle.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
        const filePath = path.join(ARCHIVE_DIR, `${safeTitle}-${candidate.subId}.${archiveType}`);
        fs.writeFileSync(filePath, buffer);
        manifestEntries.push({
          label: `${candidate.sourceTitle} #${candidate.subId}`,
          sourceTitle: candidate.sourceTitle,
          subId: candidate.subId,
          filePath,
        });
      } catch (error) {
        manifestEntries.push({
          label: `${candidate.sourceTitle} #${candidate.subId}`,
          sourceTitle: candidate.sourceTitle,
          subId: candidate.subId,
          error: error.message,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  const manifest = {
    createdAt: new Date().toISOString(),
    requestBudget: requestedBudget,
    logicalOperationsUsed: requestsUsed,
    httpAttemptsUsed: requestsUsed,
    entries: manifestEntries,
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`Downloaded dataset: ${manifestEntries.filter((entry) => entry.filePath).length} archives`);
  console.log(`HTTP attempts used: ${requestsUsed}/${requestedBudget}`);
  console.log(`Manifest: ${MANIFEST_PATH}`);
}

async function measureDataset() {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Dataset manifest not found: ${MANIFEST_PATH}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const entries = manifest.entries.filter((entry) => entry.filePath && fs.existsSync(entry.filePath));
  const results = [];
  for (const entry of entries) results.push(await measureArchive(entry));
  const report = {
    measuredAt: new Date().toISOString(),
    host: { platform: os.platform(), cpuCount: os.cpus().length, totalRamMiB: bytesToMiB(os.totalmem()) },
    dataset: {
      logicalOperationsUsed: manifest.logicalOperationsUsed ?? manifest.requestsUsed ?? null,
      httpAttemptsUsed: manifest.httpAttemptsUsed ?? null,
      archiveCount: entries.length,
    },
    summary: summarize(results),
    fourArchiveCurrentWorkflow: await measureFourArchiveBatch(entries),
    archives: results,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report: ${REPORT_PATH}`);
}

async function selfTest() {
  ensureDataDirectories();
  const fixturePath = path.join(ARCHIVE_DIR, "synthetic-season.zip");
  const zip = new AdmZip();
  for (let episode = 1; episode <= 12; episode += 1) {
    const number = String(episode).padStart(2, "0");
    const srt = `1\n00:00:01,000 --> 00:00:03,000\nEpisodul ${episode}\n`;
    zip.addFile(`Synthetic.Show.S01E${number}.ro.srt`, Buffer.from(srt, "utf8"));
  }
  fs.writeFileSync(fixturePath, zip.toBuffer());
  const measured = await measureArchive({ label: "Synthetic season", sourceTitle: "Synthetic season", filePath: fixturePath });
  assert.strictEqual(measured.tracks, 12);
  assert(measured.eagerVttMiB >= measured.selectedVttMiB);
  console.log("Synthetic benchmark validation passed.");
  console.log(JSON.stringify(measured, null, 2));
}

function cleanDataset() {
  const expected = path.resolve(os.tmpdir(), "subsro-archive-benchmark");
  const target = path.resolve(DATA_DIR);
  if (target !== expected || path.dirname(target) !== path.resolve(os.tmpdir())) {
    throw new Error(`Refusing to remove unexpected path: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`Removed benchmark data: ${target}`);
}

async function main() {
  const command = process.argv[2] || "self-test";
  if (command === "download") return downloadDataset();
  if (command === "measure") return measureDataset();
  if (command === "all") {
    await downloadDataset();
    return measureDataset();
  }
  if (command === "self-test") return selfTest();
  if (command === "clean") return cleanDataset();
  throw new Error("Usage: benchmark-archive-workflow.js [self-test|download|measure|all|clean]");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
