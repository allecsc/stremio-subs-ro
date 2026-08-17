const assert = require("assert");
const AdmZip = require("adm-zip");
const express = require("express");
const fs = require("fs/promises");
const http = require("http");
const path = require("path");
const { subtitlesHandler } = require("../addon");
const proxyRouter = require("../lib/proxy");
const { createPipelineAcceptanceHarness, closeServer } = require("./helpers/pipelineAcceptanceHarness");

function zipWithTrack(trackPath, text = "private subtitle text") {
  const zip = new AdmZip();
  zip.addFile(trackPath, Buffer.from(`1\n00:00:01,000 --> 00:00:02,000\n${text}\n`));
  return zip.toBuffer();
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

function allKeys(value, keys = []) {
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    allKeys(child, keys);
  }
  return keys;
}

async function runTests() {
  console.log("=== Running Ticket I-08 Operational Signal Tests ===");
  const signals = [];
  let currentTime = Date.UTC(2026, 0, 1);
  let harness;
  let server;
  try {
    harness = await createPipelineAcceptanceHarness({
      diskLimits: { maxBytes: 4096, readyBytes: 2048, cleanupBytes: 3500, ttlMs: 1000 },
      now: () => new Date(currentTime),
      beforeConfigure: async ({ cacheRoot }) => {
        await fs.mkdir(path.join(cacheRoot, "ready", "stale-package"), { recursive: true });
        await fs.mkdir(path.join(cacheRoot, "staging"), { recursive: true });
        await fs.writeFile(path.join(cacheRoot, "ready", "stale-package", "track.srt"), "stale");
        await fs.writeFile(path.join(cacheRoot, "staging", "stale.zip"), "stale");
      },
      onOperationalSignal: (signal) => {
        signals.push(signal);
        if (signal.type === "cache-size") throw new Error("injected observer failure");
      },
    });
    const app = express();
    app.use(proxyRouter);
    server = http.createServer(app);
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    harness.setDeliveryBaseUrl(baseUrl);
    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "ready")), []);
    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), []);

    const apiKey = "privacy-secret-key";
    const title = "Private Movie Title";
    const filename = "Private.Movie.File.mkv";
    const trackPath = "Private.Movie.Release.srt";
    harness.setSearchResults([{ id: 808001, language: "ro", title }]);
    harness.setArchive(808001, zipWithTrack(trackPath));

    const cold = await subtitlesHandler({
      type: "movie",
      id: "tt8080001",
      extra: { filename },
      config: { apiKey, baseUrl },
    });
    assert.strictEqual(cold.subtitles.length, 1);

    const warm = await subtitlesHandler({
      type: "movie",
      id: "tt8080001",
      extra: { filename },
      config: { apiKey: "different-private-key", baseUrl },
    });
    assert.strictEqual(warm.subtitles.length, 1);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/808001/download"), 1);

    const delivery = await fetch(cold.subtitles[0].url);
    assert.strictEqual(delivery.status, 200);
    assert((await delivery.text()).startsWith("WEBVTT\n\n"));

    harness.setSearchResults([{ id: 808002, language: "ro", title: "Simultaneous private title" }]);
    harness.setArchive(808002, zipWithTrack("Simultaneous.Private.Release.srt"));
    harness.setArchiveDelay(808002, 20);
    const simultaneous = await Promise.all([
      subtitlesHandler({ type: "movie", id: "tt8080002", extra: { filename }, config: { apiKey: "simultaneous-key-a", baseUrl } }),
      subtitlesHandler({ type: "movie", id: "tt8080003", extra: { filename }, config: { apiKey: "simultaneous-key-b", baseUrl } }),
    ]);
    assert(simultaneous.every((result) => result.subtitles.length === 1));
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/808002/download"), 1);

    currentTime += 2000;
    harness.setSearchResults([{ id: 808003, language: "ro", title: "Replacement private title" }]);
    harness.setArchive(808003, zipWithTrack("Replacement.Private.Release.srt"));
    const replacement = await subtitlesHandler({ type: "movie", id: "tt8080004", extra: { filename }, config: { apiKey, baseUrl } });
    assert.strictEqual(replacement.subtitles.length, 1);

    harness.setSearchResults([{ id: 808004, language: "ro", title: "Corrupt private title" }]);
    harness.setArchive(808004, Buffer.from("not a zip"));
    const corrupt = await subtitlesHandler({ type: "movie", id: "tt8080005", extra: { filename }, config: { apiKey, baseUrl } });
    assert.deepStrictEqual(corrupt.subtitles, []);

    const signalTypes = new Set(signals.map((signal) => signal.type));
    for (const required of ["package-outcome", "download", "extraction", "queue", "conversion", "cache-reuse", "cache-size", "eviction"]) {
      assert(signalTypes.has(required), `missing ${required} operational signal`);
    }
    assert(signals.some((signal) => signal.type === "package-outcome" && signal.outcome === "ready"));
    assert(signals.some((signal) => signal.type === "package-outcome" && signal.outcome === "failed"));
    assert(signals.some((signal) => signal.type === "cache-reuse" && signal.result === "hit"));
    assert(signals.some((signal) => signal.type === "cache-reuse" && signal.result === "shared"));
    assert(signals.some((signal) => signal.type === "queue" && Number.isFinite(signal.waitMs) && Number.isInteger(signal.depth)));
    assert(signals.some((signal) => signal.type === "eviction" && signal.reason === "expired"));

    const serialized = JSON.stringify(signals);
    for (const secret of [apiKey, "different-private-key", title, filename, trackPath, "808001", "tt8080001", "127.0.0.1"]) {
      assert(!serialized.includes(secret), `operational signals leaked ${secret}`);
    }
    const forbiddenKeys = new Set(["apiKey", "title", "filename", "fileName", "originalPath", "ip", "requestId", "packageId", "subId", "trackId", "userId"]);
    assert.deepStrictEqual([...new Set(allKeys(signals).filter((key) => forbiddenKeys.has(key)))], []);
    console.log("✓ Cold, warm, shared, failed, conversion, size, and eviction signals are complete, isolated, and privacy-safe");
  } finally {
    const cleanup = await Promise.allSettled([
      closeServer(server),
      harness ? harness.close() : Promise.resolve(),
    ]);
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  await testAsyncObserverIsolation();
}

async function testAsyncObserverIsolation() {
  const unhandledRejections = [];
  const onUnhandled = (reason) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  let harness;
  let server;
  try {
    harness = await createPipelineAcceptanceHarness({
      onOperationalSignal: async (signal) => {
        throw new Error(`async observer rejected on ${signal.type}`);
      },
      onSchedulingEvent: async (event) => {
        throw new Error(`async scheduling observer rejected on ${event.type}`);
      },
    });
    const app = express();
    app.use(proxyRouter);
    server = http.createServer(app);
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    harness.setDeliveryBaseUrl(baseUrl);

    const zip = new AdmZip();
    zip.addFile("Async.Test.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nasync test\n"));
    harness.setSearchResults([{ id: 808099, language: "ro", title: "Async Observer Test" }]);
    harness.setArchive(808099, zip.toBuffer());

    const list = await subtitlesHandler({
      type: "movie",
      id: "tt8080099",
      extra: { filename: "Async.Test.mkv" },
      config: { apiKey: "async-key", baseUrl },
    });
    assert.strictEqual(list.subtitles.length, 1);

    const delivery = await fetch(list.subtitles[0].url);
    assert.strictEqual(delivery.status, 200);
    assert((await delivery.text()).includes("async test"));

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.strictEqual(unhandledRejections.length, 0, `Unhandled promise rejections occurred: ${unhandledRejections.map((r) => r?.message || String(r)).join(", ")}`);
    console.log("✓ Async observer rejections are isolated and do not trigger unhandled promise rejections");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    const cleanup = await Promise.allSettled([
      closeServer(server),
      harness ? harness.close() : Promise.resolve(),
    ]);
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}

if (require.main === module) {
  runTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runTests };
