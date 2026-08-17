const assert = require("assert");
const express = require("express");
const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { createExtractorFromFile } = require("node-unrar-js");
const { subtitlesHandler } = require("../addon");
const proxyRouter = require("../lib/proxy");
const { createSubtitlePipeline, getSubtitlePipeline } = require("../lib/subtitlePipeline");
const { createPipelineAcceptanceHarness, closeServer } = require("./helpers/pipelineAcceptanceHarness");

const HOUR = 60 * 60 * 1000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout(promise, message, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function requestList(apiKey, imdbId, baseUrl = "http://delivery.test") {
  return subtitlesHandler({
    type: "movie",
    id: imdbId,
    extra: { filename: "Movie.1080p.mkv" },
    config: { apiKey, baseUrl },
  });
}

function packageAdapter(trackBytes = 96) {
  return async ({ archivePath }) => {
    const id = path.basename(archivePath).split("-")[0];
    return [{
      originalPath: `Movie.${id}.1080p.srt`,
      size: trackBytes,
      directory: false,
      read: async () => Buffer.from(`1\n00:00:01,000 --> 00:00:02,000\n${"x".repeat(trackBytes)}\n`),
    }];
  };
}

async function prepare(harness, id, apiKey = `key-${id}`, baseUrl) {
  harness.setSearchResults([{ id, language: "ro", title: "Movie" }]);
  harness.setArchive(id, Buffer.from("PK\u0003\u0004tiny"));
  const list = await requestList(apiKey, `tt${String(id).padStart(7, "0")}`, baseUrl);
  return list;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (_) {
    return false;
  }
}

function throwCleanupErrors(primaryError, cleanupErrors, message) {
  if (cleanupErrors.length) {
    if (primaryError) throw new AggregateError([primaryError, ...cleanupErrors], message, { cause: primaryError });
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    throw new AggregateError(cleanupErrors, message);
  }
  if (primaryError) throw primaryError;
}

async function finishCleanup(primaryError, cleanupPromises, message) {
  const results = await Promise.allSettled(cleanupPromises);
  const cleanupErrors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  throwCleanupErrors(primaryError, cleanupErrors, message);
}

async function testStartupCleanupAndContainment() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "subsro-i06-startup-"));
  const cacheRoot = path.join(parent, "owned");
  const readyRoot = path.join(cacheRoot, "ready");
  const stagingRoot = path.join(cacheRoot, "staging");
  const sentinel = path.join(parent, "sentinel.txt");
  await fs.mkdir(path.join(readyRoot, "stale"), { recursive: true });
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.writeFile(path.join(readyRoot, "stale", "track.srt"), "stale");
  await fs.writeFile(path.join(stagingRoot, "archive.zip"), "stale");
  await fs.writeFile(sentinel, "keep");

  try {
    const pipeline = createSubtitlePipeline({ cacheRoot });
    await pipeline.ready;
    assert.deepStrictEqual(await fs.readdir(readyRoot), []);
    assert.deepStrictEqual(await fs.readdir(stagingRoot), []);
    assert.strictEqual(await fs.readFile(sentinel, "utf8"), "keep");

    const restartedPipeline = createSubtitlePipeline({ cacheRoot });
    await restartedPipeline.ready;
    assert.deepStrictEqual(await fs.readdir(readyRoot), []);
    assert.deepStrictEqual(await fs.readdir(stagingRoot), []);

    await fs.writeFile(path.join(readyRoot, "must-remain.txt"), "owned but unsafe root resolution");
    const realpath = fs.realpath.bind(fs);
    const guardedFileOps = new Proxy(fs, {
      get(target, property) {
        if (property === "realpath") {
          return async (candidate) => path.resolve(candidate) === path.resolve(readyRoot)
            ? parent
            : realpath(candidate);
        }
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const rejected = createSubtitlePipeline({ cacheRoot, fileOps: guardedFileOps });
    await assert.rejects(rejected.ready, /Unsafe cache filesystem target/);
    assert.strictEqual(await fs.readFile(path.join(readyRoot, "must-remain.txt"), "utf8"), "owned but unsafe root resolution");
    assert.strictEqual(await fs.readFile(sentinel, "utf8"), "keep");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function testCleanupFailurePropagation() {
  const primaryError = new assert.AssertionError({ message: "primary assertion" });
  const cleanupError = new Error("cleanup failed");
  await assert.rejects(
    finishCleanup(primaryError, [Promise.reject(cleanupError)], "combined cleanup failure"),
    (error) => error instanceof AggregateError && error.cause === primaryError && error.errors.includes(cleanupError),
  );
  await assert.rejects(
    finishCleanup(null, [Promise.reject(cleanupError)], "cleanup failure"),
    (error) => error === cleanupError,
  );
}

async function testSlidingExpiration() {
  let currentTime = Date.UTC(2026, 0, 1);
  const harness = await createPipelineAcceptanceHarness({
    now: () => new Date(currentTime),
    archiveAdapter: packageAdapter(),
  });
  try {
    await prepare(harness, 610001, "first");
    currentTime += 23 * HOUR;
    await prepare(harness, 610001, "refresh-one");
    currentTime += 23 * HOUR;
    await prepare(harness, 610001, "refresh-two");
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/610001/download"), 1);

    currentTime += 25 * HOUR;
    await prepare(harness, 610001, "expired");
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/610001/download"), 2);
    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), []);
  } finally {
    await harness.close();
  }
}

async function testCombinedAccountingAndEvictionOrder() {
  let currentTime = Date.UTC(2026, 0, 1);
  let freeRatio = 0.8;
  const evictions = [];
  const harness = await createPipelineAcceptanceHarness({
    diskLimits: { maxBytes: 1800, readyBytes: 650 },
    now: () => new Date(currentTime),
    getFreeSpaceRatio: async () => freeRatio,
    archiveAdapter: packageAdapter(120),
    onSchedulingEvent: (event) => {
      if (event.type === "cache-evicted") evictions.push(event);
    },
  });
  try {
    await prepare(harness, 620001);
    currentTime += 2 * HOUR;
    await prepare(harness, 620002);
    currentTime += 2 * HOUR;
    await prepare(harness, 620003);

    currentTime = Date.UTC(2026, 0, 2, 1);
    await prepare(harness, 620003, "refresh-c");
    const stagingPressure = path.join(harness.cacheRoot, "staging", "other-active-download.bin");
    await fs.writeFile(stagingPressure, Buffer.alloc(700));
    freeRatio = 0.2;
    await prepare(harness, 620004);

    assert.deepStrictEqual(evictions.slice(0, 2).map((event) => [event.packageId, event.reason]), [
      ["620001", "expired"],
      ["620002", "lru"],
    ]);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "620001")), false);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "620002")), false);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "620003")), true);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "620004")), true);
    assert.strictEqual(await fs.readFile(stagingPressure).then((buffer) => buffer.length), 700);
  } finally {
    await harness.close();
  }
}

async function testLowFreeSpaceOnlyCleanup() {
  let freeRatio = 0.8;
  const evictions = [];
  const harness = await createPipelineAcceptanceHarness({
    diskLimits: { maxBytes: 3000, readyBytes: 600, cleanupBytes: 2500 },
    getFreeSpaceRatio: async () => freeRatio,
    archiveAdapter: packageAdapter(120),
    onSchedulingEvent: (event) => {
      if (event.type === "cache-evicted") evictions.push(event);
    },
  });
  try {
    await prepare(harness, 625001);
    await prepare(harness, 625002);
    assert.deepStrictEqual(evictions, []);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "625001")), true);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "625002")), true);

    freeRatio = 0.24;
    await prepare(harness, 625003);
    assert.deepStrictEqual(evictions.map((event) => [event.packageId, event.reason]), [["625001", "lru"]]);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "625001")), false);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "625002")), true);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "625003")), true);
  } finally {
    await harness.close();
  }
}

async function testRarScratchReservation() {
  const fixture = await fs.readFile(path.join(__dirname, "fixtures", "node-unrar-srt-test.rar"));
  let extractorCalls = 0;
  const createRarExtractor = async (options) => {
    extractorCalls += 1;
    const extractor = await createExtractorFromFile(options);
    if (extractorCalls === 1) {
      // The repository's genuine 288-byte fixture contains two zero-byte members.
      // Inflate only the listed declaration so capacity fails before the same real
      // decoder can be created for member output.
      const getFileList = extractor.getFileList.bind(extractor);
      extractor.getFileList = () => {
        const listed = getFileList();
        return {
          ...listed,
          fileHeaders: [...listed.fileHeaders].map((header) => ({ ...header, unpSize: 64 })),
        };
      };
    }
    return extractor;
  };
  const events = [];
  const harness = await createPipelineAcceptanceHarness({
    diskLimits: { maxBytes: 400, readyBytes: 200, cleanupBytes: 390 },
    createRarExtractor,
    onSchedulingEvent: (event) => events.push(event),
  });
  try {
    const pressure = path.join(harness.cacheRoot, "staging", "pressure.bin");
    await fs.writeFile(pressure, Buffer.alloc(60));
    harness.setSearchResults([{ id: 626001, language: "ro", title: "RAR pressure" }]);
    harness.setArchive(626001, fixture);
    const result = await requestList("rar-pressure", "tt6260001");

    assert.deepStrictEqual(result.subtitles, []);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/626001/download"), 1);
    assert.strictEqual(extractorCalls, 1, "only header listing may run when the declared member cannot fit");
    assert.strictEqual(events.some((event) => event.type === "rar-decoder-started"), false);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "626001")), false);
    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), ["pressure.bin"]);
  } finally {
    await harness.close();
  }
}

async function testRarScratchSizeMismatch() {
  const fixture = await fs.readFile(path.join(__dirname, "fixtures", "node-unrar-srt-test.rar"));
  let extractorCalls = 0;
  const createRarExtractor = async (options) => {
    extractorCalls += 1;
    const extractor = await createExtractorFromFile(options);
    if (extractorCalls === 1) {
      const getFileList = extractor.getFileList.bind(extractor);
      extractor.getFileList = () => {
        const listed = getFileList();
        return {
          ...listed,
          fileHeaders: [...listed.fileHeaders].map((header) => ({ ...header, unpSize: 1 })),
        };
      };
    }
    return extractor;
  };
  const events = [];
  const harness = await createPipelineAcceptanceHarness({
    diskLimits: { maxBytes: 2000, readyBytes: 1000 },
    createRarExtractor,
    onSchedulingEvent: (event) => events.push(event),
  });
  try {
    harness.setSearchResults([{ id: 626002, language: "ro", title: "RAR mismatch" }]);
    harness.setArchive(626002, fixture);
    const result = await requestList("rar-mismatch", "tt6260002");

    assert.deepStrictEqual(result.subtitles, []);
    assert.strictEqual(extractorCalls, 2, "one decoder attempt must detect the first impossible size mismatch");
    assert(events.some((event) => event.type === "rar-decoder-started"));
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "626002")), false);
    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), []);
  } finally {
    await harness.close();
  }
}

async function testPendingListHandoffProtection() {
  const handoffStarted = deferred();
  const releaseHandoff = deferred();
  const events = [];
  const harness = await createPipelineAcceptanceHarness({
    diskLimits: { maxBytes: 2000, readyBytes: 250, cleanupBytes: 1000 },
    getFreeSpaceRatio: async () => 0.2,
    archiveAdapter: packageAdapter(120),
    onSchedulingEvent: (event) => events.push(event),
    onReadyHandoff: async ({ packageId }) => {
      if (packageId !== "627001") return;
      handoffStarted.resolve();
      await releaseHandoff.promise;
    },
  });
  let activeList;
  let primaryError;
  try {
    harness.setSearchResults([{ id: 627001, language: "ro", title: "Pinned handoff" }]);
    harness.setArchive(627001, Buffer.from("PK\u0003\u0004tiny"));
    activeList = requestList("handoff-active", "tt6270001");
    await withTimeout(handoffStarted.promise, "ready-handoff hook was not reached");
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "627001")), true);

    const pressure = path.join(harness.cacheRoot, "staging", "handoff-pressure.bin");
    await fs.writeFile(pressure, Buffer.alloc(900));
    const refused = await prepare(harness, 627002, "handoff-maintenance");
    assert.deepStrictEqual(refused.subtitles, []);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "627001")), true);
    assert.strictEqual(events.some((event) => event.type === "cache-evicted" && event.packageId === "627001"), false);

    await fs.rm(pressure);
    releaseHandoff.resolve();
    assert.strictEqual((await activeList).subtitles.length, 1);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/627001/download"), 1);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "627001")), true);
  } catch (error) {
    primaryError = error;
  } finally {
    releaseHandoff.resolve();
    const cleanupErrors = [];
    if (activeList) {
      const [activeResult] = await Promise.allSettled([activeList]);
      if (activeResult.status === "rejected") cleanupErrors.push(activeResult.reason);
    }
    const [harnessResult] = await Promise.allSettled([harness.close()]);
    if (harnessResult.status === "rejected") cleanupErrors.push(harnessResult.reason);
    throwCleanupErrors(primaryError, cleanupErrors, "Pending-list handoff failed or cleanup was incomplete");
  }
}

async function testActiveProtectionAndSafeRefusal() {
  const conversionStarted = deferred();
  const releaseConversion = deferred();
  const events = [];
  const harness = await createPipelineAcceptanceHarness({
    diskLimits: { maxBytes: 1500, readyBytes: 600 },
    archiveAdapter: packageAdapter(120),
    convertTrack: async () => {
      conversionStarted.resolve();
      await releaseConversion.promise;
      return "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nconverted\n";
    },
    onSchedulingEvent: (event) => events.push(event),
  });
  let server;
  let primaryError;
  try {
    const app = express();
    app.use(proxyRouter);
    server = http.createServer(app);
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const warm = await prepare(harness, 630001, "warm", baseUrl);
    assert.strictEqual(warm.subtitles.length, 1);

    const delivery = fetch(warm.subtitles[0].url);
    await conversionStarted.promise;
    const blocker = path.join(harness.cacheRoot, "staging", "active-download.bin");
    await fs.writeFile(blocker, Buffer.alloc(1000));
    const refused = await prepare(harness, 630002, "cold-refused", baseUrl);
    assert.deepStrictEqual(refused.subtitles, []);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/630002/download"), 1);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "630001")), true);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "630002")), false);
    assert.deepStrictEqual((await fs.readdir(path.join(harness.cacheRoot, "staging"))).sort(), ["active-download.bin"]);
    assert(events.some((event) => event.type === "cold-work-refused" && event.packageId === "630002"));

    await fs.rm(blocker);
    releaseConversion.resolve();
    const response = await delivery;
    assert.strictEqual(response.status, 200);
    assert((await response.text()).startsWith("WEBVTT"));
  } catch (error) {
    primaryError = error;
  } finally {
    releaseConversion.resolve();
    await finishCleanup(
      primaryError,
      [closeServer(server), harness.close()],
      "Active-protection assertions failed and cleanup was incomplete",
    );
  }
}

async function testListedPackageProtection() {
  let blockManifestRename = false;
  const renameStarted = deferred();
  const releaseRename = deferred();
  const realRename = fs.rename.bind(fs);
  const guardedFileOps = new Proxy(fs, {
    get(target, property) {
      if (property === "rename") {
        return async (source, destination) => {
          if (blockManifestRename && path.basename(destination) === "manifest.json") {
            renameStarted.resolve();
            await releaseRename.promise;
          }
          return realRename(source, destination);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const events = [];
  const harness = await createPipelineAcceptanceHarness({
    diskLimits: { maxBytes: 1500, readyBytes: 800 },
    archiveAdapter: packageAdapter(120),
    fileOps: guardedFileOps,
    onSchedulingEvent: (event) => events.push(event),
  });
  try {
    await prepare(harness, 640001, "warm-list");
    blockManifestRename = true;
    const activeList = prepare(harness, 640001, "active-list");
    await renameStarted.promise;
    const blocker = path.join(harness.cacheRoot, "staging", "listing-pressure.bin");
    await fs.writeFile(blocker, Buffer.alloc(650));
    const refused = await prepare(harness, 640002, "cold-during-list");
    assert.deepStrictEqual(refused.subtitles, []);
    assert.strictEqual(
      harness.countRequests("/v1.0/subtitle/640002/download"),
      0,
      "the blocked atomic manifest counts toward managed bytes and must permit refusal before download",
    );
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "640001")), true);
    assert.strictEqual(await exists(path.join(harness.cacheRoot, "ready", "640002")), false);
    assert(events.some((event) => event.type === "cold-work-refused" && event.packageId === "640002"));

    await fs.rm(blocker);
    blockManifestRename = false;
    releaseRename.resolve();
    assert.strictEqual((await activeList).subtitles.length, 1);
  } finally {
    blockManifestRename = false;
    releaseRename.resolve();
    await harness.close();
  }
}

async function runTests() {
  console.log("=== Running Ticket I-06 LRU and Disk-Safety Tests ===");
  await testStartupCleanupAndContainment();
  console.log("✓ Startup cleanup is idempotent and rejects an owned root that resolves outside its boundary");
  await testCleanupFailurePropagation();
  console.log("✓ Cleanup failures propagate without discarding a primary assertion error");
  await testSlidingExpiration();
  console.log("✓ Package access refreshes the 24-hour sliding lifetime; expired access rebuilds once");
  await testCombinedAccountingAndEvictionOrder();
  console.log("✓ Staging bytes and low free space trigger expired-first, whole-package LRU eviction");
  await testLowFreeSpaceOnlyCleanup();
  console.log("✓ Filesystem free space below 25% independently triggers early LRU cleanup");
  await testRarScratchReservation();
  console.log("✓ Genuine RAR members reserve declared scratch bytes before decoder extraction");
  await testRarScratchSizeMismatch();
  console.log("✓ Impossible RAR scratch-size mismatches abort and clean the whole package");
  await testPendingListHandoffProtection();
  console.log("✓ Pending list work pins its package across publication and ready handoff");
  await testActiveProtectionAndSafeRefusal();
  console.log("✓ Active conversion/delivery pins its package; unsafe cold work is refused and cleaned completely");
  await testListedPackageProtection();
  console.log("✓ Active listing pins its complete package until manifest access finishes");
  console.log("ALL TICKET I-06 LRU AND DISK-SAFETY TESTS PASSED ✓");
}

if (require.main === module) {
  runTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runTests };
