const assert = require("assert");
const AdmZip = require("adm-zip");
const express = require("express");
const fs = require("fs/promises");
const http = require("http");
const path = require("path");
const { subtitlesHandler } = require("../addon");
const proxyRouter = require("../lib/proxy");
const { srtToVtt } = require("../lib/subtitleExtractor");
const { createPipelineAcceptanceHarness, closeServer } = require("./helpers/pipelineAcceptanceHarness");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
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

function makeZip() {
  const zip = new AdmZip();
  zip.addFile("Movie.1080p.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nSalut.\n"));
  return zip.toBuffer();
}

function listRequest(apiKey, imdbId, baseUrl = "http://delivery.test") {
  return subtitlesHandler({
    type: "movie",
    id: imdbId,
    extra: { filename: "Movie.1080p.mkv" },
    config: { apiKey, baseUrl },
  });
}

function createControlledClient({ archive = makeZip() } = {}) {
  const searchResults = new Map();
  const downloadGates = new Map();
  const downloadStartWaiters = [];
  const downloadStarts = [];
  const downloadCompletions = [];
  let activeDownloads = 0;
  let peakDownloads = 0;

  const notifyStarts = () => {
    for (let index = downloadStartWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = downloadStartWaiters[index];
      if (downloadStarts.length >= waiter.count) {
        downloadStartWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };
  const gateFor = (subId) => {
    const id = String(subId);
    if (!downloadGates.has(id)) downloadGates.set(id, deferred());
    return downloadGates.get(id);
  };

  return {
    searchResults,
    downloadStarts,
    downloadCompletions,
    get activeDownloads() { return activeDownloads; },
    get peakDownloads() { return peakDownloads; },
    createClient(apiKey) {
      return {
        searchByImdb: async () => searchResults.get(apiKey) || [],
        searchByTmdb: async () => searchResults.get(apiKey) || [],
        downloadArchiveToFile: async (subId, destination) => {
          const id = String(subId);
          activeDownloads += 1;
          peakDownloads = Math.max(peakDownloads, activeDownloads);
          downloadStarts.push(id);
          notifyStarts();
          try {
            await gateFor(id).promise;
            await fs.writeFile(destination, archive, { flag: "wx" });
            downloadCompletions.push(id);
          } finally {
            activeDownloads -= 1;
          }
        },
      };
    },
    waitForDownloadStarts(count) {
      if (downloadStarts.length >= count) return Promise.resolve();
      const waiter = deferred();
      downloadStartWaiters.push({ count, resolve: waiter.resolve });
      return waiter.promise;
    },
    releaseDownload(subId) {
      gateFor(subId).resolve();
    },
    failDownload(subId, error) {
      gateFor(subId).reject(error);
    },
  };
}

function createExtractionController() {
  const gates = new Map();
  const startWaiters = [];
  const starts = [];
  let active = 0;
  let peak = 0;

  const gateFor = (id) => {
    if (!gates.has(id)) gates.set(id, deferred());
    return gates.get(id);
  };
  const notifyStarts = () => {
    for (let index = startWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = startWaiters[index];
      if (starts.length >= waiter.count) {
        startWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };

  return {
    starts,
    get active() { return active; },
    get peak() { return peak; },
    async adapter({ archivePath }) {
      const id = path.basename(archivePath).split("-")[0];
      active += 1;
      peak = Math.max(peak, active);
      starts.push(id);
      notifyStarts();
      try {
        await gateFor(id).promise;
        return [{
          originalPath: `${id}.1080p.srt`,
          size: 44,
          directory: false,
          read: async () => Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nSalut.\n"),
        }];
      } finally {
        active -= 1;
      }
    },
    waitForStarts(count) {
      if (starts.length >= count) return Promise.resolve();
      const waiter = deferred();
      startWaiters.push({ count, resolve: waiter.resolve });
      return waiter.promise;
    },
    release(id) {
      gateFor(String(id)).resolve();
    },
    fail(id, error) {
      gateFor(String(id)).reject(error);
    },
  };
}

function createSchedulingObserver() {
  const events = [];
  const waiters = [];
  const notify = () => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (events.filter((event) => event.type === waiter.type).length >= waiter.count) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };
  return {
    events,
    observe(event) {
      events.push(event);
      notify();
    },
    ofType(type) {
      return events.filter((event) => event.type === type);
    },
    waitFor(type, count) {
      if (events.filter((event) => event.type === type).length >= count) return Promise.resolve();
      const waiter = deferred();
      waiters.push({ type, count, resolve: waiter.resolve });
      return waiter.promise;
    },
  };
}

async function testGlobalDownloadLimitAndQueuedSharing() {
  const downloads = createControlledClient();
  const scheduling = createSchedulingObserver();
  const harness = await createPipelineAcceptanceHarness({
    createClient: downloads.createClient,
    onSchedulingEvent: scheduling.observe,
  });
  try {
    const firstIds = [510001, 510002, 510003, 510004];
    const secondIds = [510005, 510006, 510007, 510008];
    const sharedId = 510009;
    downloads.searchResults.set("burst-a", firstIds.map((id) => ({ id, language: "ro" })));
    downloads.searchResults.set("burst-b", secondIds.map((id) => ({ id, language: "ro" })));
    downloads.searchResults.set("shared-a", [{ id: sharedId, language: "ro" }]);
    downloads.searchResults.set("shared-b", [{ id: sharedId, language: "ro" }]);

    const firstBurst = listRequest("burst-a", "tt5100001");
    const secondBurst = listRequest("burst-b", "tt5100002");
    await downloads.waitForDownloadStarts(8);

    const firstShared = listRequest("shared-a", "tt5100003");
    const secondShared = listRequest("shared-b", "tt5100004");
    await scheduling.waitFor("download-queued", 9);
    assert.strictEqual(downloads.downloadStarts.length, 8, "the ninth package must wait for a process-wide slot");
    assert.strictEqual(downloads.activeDownloads, 8);

    const timedOutId = downloads.downloadStarts[0];
    const timeout = Object.assign(new Error("controlled download timeout"), { code: "ETIMEDOUT" });
    downloads.failDownload(timedOutId, timeout);
    await scheduling.waitFor("download-started", 9);
    await downloads.waitForDownloadStarts(9);
    assert.strictEqual(downloads.downloadStarts.filter((id) => id === String(sharedId)).length, 1);
    assert.strictEqual(downloads.peakDownloads, 8);

    for (const id of downloads.downloadStarts) {
      if (id !== timedOutId) downloads.releaseDownload(id);
    }
    const [firstResult, secondResult, firstSharedResult, secondSharedResult] = await Promise.all([
      firstBurst,
      secondBurst,
      firstShared,
      secondShared,
    ]);
    assert.strictEqual(firstResult.subtitles.length + secondResult.subtitles.length, 7);
    assert.strictEqual(firstSharedResult.subtitles.length, 1);
    assert.strictEqual(secondSharedResult.subtitles.length, 1);
    assert.strictEqual(
      new URL(secondSharedResult.subtitles[0].url).pathname.split("/")[4],
      new URL(firstSharedResult.subtitles[0].url).pathname.split("/")[4],
    );
    assert.strictEqual(downloads.activeDownloads, 0);
    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), []);
  } finally {
    await harness.close();
  }
}

async function testExtractionFifoAndBypass() {
  const downloads = createControlledClient({ archive: Buffer.from("PK\x03\x04fixture") });
  const extractions = createExtractionController();
  const scheduling = createSchedulingObserver();
  const harness = await createPipelineAcceptanceHarness({
    createClient: downloads.createClient,
    archiveAdapter: extractions.adapter,
    onSchedulingEvent: scheduling.observe,
  });
  try {
    const warmId = 520000;
    downloads.searchResults.set("warm", [{ id: warmId, language: "ro" }]);
    const warmList = listRequest("warm", "tt5200000");
    await downloads.waitForDownloadStarts(1);
    downloads.releaseDownload(warmId);
    await extractions.waitForStarts(1);
    extractions.release(warmId);
    assert.strictEqual((await warmList).subtitles.length, 1);
    scheduling.events.splice(0);
    extractions.starts.splice(0);
    downloads.downloadStarts.splice(0);
    downloads.downloadCompletions.splice(0);

    const ids = [520001, 520002, 520003];
    downloads.searchResults.set("fifo-a", [ids[0], ids[2]].map((id) => ({ id, language: "ro" })));
    downloads.searchResults.set("fifo-b", [{ id: ids[1], language: "ro" }]);
    const firstFifoList = listRequest("fifo-a", "tt5200001");
    const secondFifoList = listRequest("fifo-b", "tt5200004");
    await downloads.waitForDownloadStarts(3);

    downloads.releaseDownload(ids[1]);
    while (downloads.downloadCompletions.length < 1) await nextTurn();
    await extractions.waitForStarts(1);
    downloads.releaseDownload(ids[0]);
    while (downloads.downloadCompletions.length < 2) await nextTurn();
    downloads.releaseDownload(ids[2]);
    while (downloads.downloadCompletions.length < 3) await nextTurn();
    assert.deepStrictEqual(downloads.downloadCompletions, [String(ids[1]), String(ids[0]), String(ids[2])]);
    await scheduling.waitFor("extraction-queued", 3);
    assert.deepStrictEqual(
      scheduling.ofType("extraction-started").map((event) => event.packageId),
      [String(ids[1])],
    );

    extractions.fail(ids[1], new Error("controlled extraction failure"));
    await extractions.waitForStarts(2);
    assert.deepStrictEqual(extractions.starts, [String(ids[1]), String(ids[0])]);

    downloads.searchResults.set("search-bypass", []);
    downloads.searchResults.set("cache-hit", [{ id: warmId, language: "ro" }]);
    const searchBypass = await listRequest("search-bypass", "tt5200002");
    const cacheHit = await listRequest("cache-hit", "tt5200003");
    assert.deepStrictEqual(searchBypass.subtitles, []);
    assert.strictEqual(cacheHit.subtitles.length, 1);
    assert.strictEqual(extractions.active, 1, "search must finish while extraction remains blocked");

    extractions.release(ids[0]);
    await extractions.waitForStarts(3);
    assert.deepStrictEqual(extractions.starts, [String(ids[1]), String(ids[0]), String(ids[2])]);
    extractions.release(ids[2]);
    const [firstFifoResult, secondFifoResult] = await Promise.all([firstFifoList, secondFifoList]);
    assert.strictEqual(firstFifoResult.subtitles.length + secondFifoResult.subtitles.length, 2);
    assert.strictEqual(extractions.peak, 1);

    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), []);
  } finally {
    await harness.close();
  }
}

async function testSharedConversion() {
  const conversionStarted = deferred();
  const releaseConversion = deferred();
  const scheduling = createSchedulingObserver();
  let conversionCalls = 0;
  const harness = await createPipelineAcceptanceHarness({
    onSchedulingEvent: scheduling.observe,
    convertTrack: async (srt) => {
      conversionCalls += 1;
      conversionStarted.resolve();
      await releaseConversion.promise;
      return srtToVtt(srt);
    },
  });
  let server;
  try {
    const app = express();
    app.use(proxyRouter);
    server = http.createServer(app);
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    harness.setDeliveryBaseUrl(baseUrl);
    harness.setSearchResults([{ id: 530001, language: "ro" }]);
    harness.setArchive(530001, makeZip());
    const list = await listRequest("conversion", "tt5300001", baseUrl);

    const first = fetch(list.subtitles[0].url);
    const second = fetch(list.subtitles[0].url);
    await conversionStarted.promise;
    await scheduling.waitFor("delivery-track-requested", 2);
    assert.strictEqual(conversionCalls, 1);
    releaseConversion.resolve();
    const responses = await Promise.all([first, second]);
    assert.deepStrictEqual(responses.map((response) => response.status), [200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    assert.strictEqual(bodies[0], bodies[1]);
    const readyFiles = await fs.readdir(path.join(harness.cacheRoot, "ready", "530001"));
    assert.deepStrictEqual(readyFiles.sort(), ["manifest.json", "track-0.vtt"]);
  } finally {
    await Promise.allSettled([closeServer(server), harness.close()]);
  }
}

async function testPreparationSurvivesDisconnect() {
  const downloads = createControlledClient();
  const harness = await createPipelineAcceptanceHarness({ createClient: downloads.createClient });
  let server;
  try {
    downloads.searchResults.set("disconnect-origin", [{ id: 540001, language: "ro" }]);
    downloads.searchResults.set("disconnect-retry", [{ id: 540001, language: "ro" }]);
    server = http.createServer(async (_req, res) => {
      const result = await listRequest("disconnect-origin", "tt5400001");
      if (!res.destroyed) res.end(JSON.stringify(result));
    });
    await listen(server);

    const request = http.get(`http://127.0.0.1:${server.address().port}/list`);
    request.on("error", () => {});
    await downloads.waitForDownloadStarts(1);
    request.destroy();
    downloads.releaseDownload(540001);

    const retry = await listRequest("disconnect-retry", "tt5400002");
    assert.strictEqual(retry.subtitles.length, 1);
    assert.strictEqual(downloads.downloadStarts.filter((id) => id === "540001").length, 1);
    await fs.access(path.join(harness.cacheRoot, "ready", "540001", "manifest.json"));
    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), []);
  } finally {
    await Promise.allSettled([closeServer(server), harness.close()]);
  }
}

async function runTests() {
  console.log("=== Running Ticket I-05 Process-Wide Scheduling Tests ===");
  await testGlobalDownloadLimitAndQueuedSharing();
  console.log("✓ Peak downloads: 8; a timed-out job released its slot; one queued shared package prepared once");
  await testExtractionFifoAndBypass();
  console.log("✓ Peak extractions: 1; extraction order followed download completion; searches and cache hits bypassed the gate");
  await testSharedConversion();
  console.log("✓ Two simultaneous deliveries shared one conversion and one published VTT");
  await testPreparationSurvivesDisconnect();
  console.log("✓ Accepted preparation survived the originating HTTP disconnect and served the retry");
  console.log("ALL TICKET I-05 PROCESS-WIDE SCHEDULING TESTS PASSED ✓");
}

runTests().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
