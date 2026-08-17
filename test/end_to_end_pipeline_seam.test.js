const assert = require("assert");
const AdmZip = require("adm-zip");
const express = require("express");
const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { subtitlesHandler } = require("../addon");
const proxyRouter = require("../lib/proxy");
const { getSubtitlePipeline } = require("../lib/subtitlePipeline");
const { createPipelineAcceptanceHarness, closeServer } = require("./helpers/pipelineAcceptanceHarness");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function runTests() {
  console.log("=== Running End-to-End Pipeline Seam Tests ===");
  let harness;
  let server;
  let clockTick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clockTick++));

  try {
    harness = await createPipelineAcceptanceHarness({
      diskLimits: { maxBytes: 1024 * 1024, readyBytes: 512 * 1024 },
      now,
    });
    const app = express();
    app.use(proxyRouter);
    server = http.createServer(app);
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    harness.setDeliveryBaseUrl(baseUrl);

    const srtPath = "Show.S01E02.1080p.BluRay.srt";
    const secondSrtPath = "Show.S01E02.720p.WEB-DL.srt";
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nAşteaptă puțin.\n";
    const zip = new AdmZip();
    zip.addFile(secondSrtPath, Buffer.from(srt));
    zip.addFile(srtPath, Buffer.from(srt));
    zip.addFile("Show.S01E03.1080p.BluRay.srt", Buffer.from(srt));
    zip.addFile("Show.S01E02.Forced.srt", Buffer.from(srt));
    zip.addFile("Show.S01E02.CD1.srt", Buffer.from(srt));
    harness.setSearchResults([{ id: 424242, language: "ro", title: "Show" }]);
    harness.setArchive(424242, zip.toBuffer());

    console.log("Test 1: Real list handler reaches the controlled Subs.ro service through the shared pipeline");
    const list = await subtitlesHandler({
      type: "series",
      id: "tt1234567:1:2",
      extra: { filename: "Show.S01E02.1080p.BluRay.mkv" },
      config: { apiKey: "test-key", baseUrl },
    });
    assert.strictEqual(list.subtitles.length, 2);
    const manifest = JSON.parse(await fs.readFile(path.join(harness.cacheRoot, "ready", "424242", "manifest.json"), "utf8"));
    const listedTrackIds = list.subtitles.map((subtitle) => new URL(subtitle.url).pathname.split("/")[4]);
    const listedNames = listedTrackIds.map((id) => manifest.tracks.find((track) => track.id === id).originalPath);
    assert.deepStrictEqual(listedNames, [srtPath, secondSrtPath]);
    assert.strictEqual(list.subtitles[0].lang, "ron");
    assert.strictEqual(list.cacheMaxAge, 3600);
    assert.strictEqual(harness.countRequests("/v1.0/search/imdbid/tt1234567"), 1);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/424242/download"), 1);
    assert.strictEqual(getSubtitlePipeline().options.cacheRoot, harness.cacheRoot);
    assert.deepStrictEqual(getSubtitlePipeline().options.diskLimits, harness.diskLimits);
    assert.strictEqual(getSubtitlePipeline().options.deliveryBaseUrl, baseUrl);
    const readyDirectory = path.join(harness.cacheRoot, "ready", "424242");
    const stagingEntries = await fs.readdir(path.join(harness.cacheRoot, "staging"));
    assert.deepStrictEqual(stagingEntries, []);
    assert.deepStrictEqual((await fs.readdir(readyDirectory)).sort(), ["manifest.json", "track-0.srt", "track-1.srt", "track-2.srt"]);
    console.log("✓ Passed: exact list response contract and controlled pipeline configuration are preserved");

    console.log("Test 2: Delivery without a prepared package attempts one complete rebuild and returns a controlled error");
    const missesBefore = harness.countRequests("/v1.0/subtitle/999998/download");
    const absent = await fetch(`${baseUrl}/test-key/proxy/999998/not-a-track/sub.vtt`);
    assert.strictEqual(absent.status, 404);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/999998/download"), missesBefore + 1);
    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), []);
    console.log("✓ Passed: absent delivery performs one complete rebuild attempt and fails without partial state");

    console.log("Test 3: Real delivery router reuses the same prepared archive and returns WebVTT");
    const delivery = await fetch(list.subtitles[0].url);
    const body = await delivery.text();
    assert.strictEqual(delivery.status, 200);
    assert.strictEqual(delivery.headers.get("content-type"), "text/vtt; charset=utf-8");
    assert.strictEqual(delivery.headers.get("access-control-allow-origin"), "*");
    assert.strictEqual(delivery.headers.get("cache-control"), "public, max-age=43200");
    assert(body.startsWith("WEBVTT\n\n"));
    assert(body.includes("Așteaptă puțin."));
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/424242/download"), 1);
    assert.deepStrictEqual((await fs.readdir(readyDirectory)).sort(), ["manifest.json", "track-0.vtt", "track-1.srt", "track-2.srt"]);
    assert(!list.subtitles[0].url.includes(Buffer.from(srtPath).toString("base64url")));
    console.log("✓ Passed: delivery used the shared pipeline without a second archive download");

    console.log("Test 4: Ready packages are global, retain later episodes, and rank per request");
    const accessAfterFirstDelivery = JSON.parse(await fs.readFile(path.join(readyDirectory, "manifest.json"), "utf8")).lastAccessedAt;
    const otherUserEpisodeThree = await subtitlesHandler({
      type: "series",
      id: "tt1234567:1:3",
      extra: { filename: "Show.S01E03.1080p.BluRay.mkv" },
      config: { apiKey: "other-user-key", baseUrl },
    });
    assert.strictEqual(otherUserEpisodeThree.subtitles.length, 1);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/424242/download"), 1);
    const afterListAccess = JSON.parse(await fs.readFile(path.join(readyDirectory, "manifest.json"), "utf8"));
    assert(afterListAccess.lastAccessedAt > accessAfterFirstDelivery);
    const webRequest = await subtitlesHandler({
      type: "series",
      id: "tt1234567:1:2",
      extra: { filename: "Show.S01E02.720p.WEB-DL.mkv" },
      config: { apiKey: "third-user-key", baseUrl },
    });
    const webTrackId = new URL(webRequest.subtitles[0].url).pathname.split("/")[4];
    assert.strictEqual(afterListAccess.tracks.find((track) => track.id === webTrackId).originalPath, secondSrtPath);
    const beforeLaterDelivery = JSON.parse(await fs.readFile(path.join(readyDirectory, "manifest.json"), "utf8")).lastAccessedAt;
    const laterDelivery = await fetch(otherUserEpisodeThree.subtitles[0].url);
    assert.strictEqual(laterDelivery.status, 200);
    const afterDeliveryAccess = JSON.parse(await fs.readFile(path.join(readyDirectory, "manifest.json"), "utf8"));
    assert(afterDeliveryAccess.lastAccessedAt > beforeLaterDelivery);
    console.log("✓ Passed: cross-key reuse, episode selection, per-request ranking, and whole-package access refresh");

    console.log("Test 5: Ready-list access cannot overwrite a completed delivery manifest");
    let delayManifestRename = false;
    let releaseManifestRename;
    let manifestRenameStarted;
    let waitForDeliveryRead = false;
    let deliveryReadStarted;
    const racingFileOps = new Proxy(fs, {
      get(target, property) {
        const original = target[property];
        if (typeof original !== "function") return original;
        return async (...args) => {
          if (waitForDeliveryRead && property === "readFile" && String(args[0]).endsWith("track-0.srt")) {
            waitForDeliveryRead = false;
            deliveryReadStarted();
          }
          if (delayManifestRename && property === "rename" && String(args[1]).endsWith("manifest.json")) {
            delayManifestRename = false;
            manifestRenameStarted();
            await new Promise((resolve) => { releaseManifestRename = resolve; });
          }
          return original.apply(target, args);
        };
      },
    });
    harness.setFileOps(racingFileOps);
    harness.setSearchResults([{ id: 424248, language: "ro", title: "Manifest race" }]);
    harness.setArchive(424248, zip.toBuffer());
    const raceInitialList = await subtitlesHandler({ type: "series", id: "tt1234574:1:2", extra: { filename: "Show.S01E02.1080p.BluRay.mkv" }, config: { apiKey: "race-warm-key", baseUrl } });
    const raceDirectory = path.join(harness.cacheRoot, "ready", "424248");
    const raceTrackUrl = raceInitialList.subtitles[0].url;
    const raceTrackId = new URL(raceTrackUrl).pathname.split("/")[4];
    const beforeRace = JSON.parse(await fs.readFile(path.join(raceDirectory, "manifest.json"), "utf8")).lastAccessedAt;
    const renameBlocked = new Promise((resolve) => { manifestRenameStarted = resolve; });
    delayManifestRename = true;
    const readyListAccess = subtitlesHandler({ type: "series", id: "tt1234574:1:2", extra: { filename: "Show.S01E02.1080p.BluRay.mkv" }, config: { apiKey: "race-list-key", baseUrl } });
    await renameBlocked;
    const deliveryReading = new Promise((resolve) => { deliveryReadStarted = resolve; });
    waitForDeliveryRead = true;
    const racingDelivery = fetch(raceTrackUrl);
    await deliveryReading;
    releaseManifestRename();
    await readyListAccess;
    assert.strictEqual((await racingDelivery).status, 200);
    const afterRace = JSON.parse(await fs.readFile(path.join(raceDirectory, "manifest.json"), "utf8"));
    assert.strictEqual(afterRace.tracks.find((track) => track.id === raceTrackId).state, "vtt");
    assert((await fs.readdir(raceDirectory)).includes("track-0.vtt"));
    assert(!(await fs.readdir(raceDirectory)).includes("track-0.srt"));
    assert(afterRace.lastAccessedAt > beforeRace);
    const beforeUnknownTrack = afterRace.lastAccessedAt;
    const unknownTrack = await fetch(`${baseUrl}/race-key/proxy/424248/not-a-track/sub.vtt`);
    assert.strictEqual(unknownTrack.status, 404);
    assert.strictEqual(JSON.parse(await fs.readFile(path.join(raceDirectory, "manifest.json"), "utf8")).lastAccessedAt, beforeUnknownTrack);
    harness.setFileOps(undefined);
    console.log("✓ Passed: serialized manifest mutations retain VTT state and failed delivery access does not refresh it");

    console.log("Test 6: Simultaneous absent-package requests share exactly one preparation");
    harness.setSearchResults([{ id: 424246, language: "ro", title: "Shared" }]);
    harness.setArchive(424246, zip.toBuffer());
    harness.setDelay(25);
    const [firstMiss, secondMiss] = await Promise.all([
      subtitlesHandler({ type: "series", id: "tt1234572:1:2", extra: { filename: "Show.S01E02.1080p.BluRay.mkv" }, config: { apiKey: "first-miss-key", baseUrl } }),
      subtitlesHandler({ type: "series", id: "tt1234572:1:2", extra: { filename: "Show.S01E02.1080p.BluRay.mkv" }, config: { apiKey: "second-miss-key", baseUrl } }),
    ]);
    harness.setDelay(0);
    assert.strictEqual(firstMiss.subtitles.length, 2);
    assert.strictEqual(secondMiss.subtitles.length, 2);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/424246/download"), 1);
    console.log("✓ Passed: both users received one complete shared package after one upstream download");

    console.log("Test 6: Valid-empty packages are retained and never downloaded twice");
    const emptyZip = new AdmZip();
    emptyZip.addFile("Show.S01E02.Forced.srt", Buffer.from(srt));
    harness.setSearchResults([{ id: 424247, language: "ro", title: "Empty" }]);
    harness.setArchive(424247, emptyZip.toBuffer());
    const firstEmpty = await subtitlesHandler({ type: "movie", id: "tt1234573", extra: { filename: "Empty.mkv" }, config: { apiKey: "empty-first-key", baseUrl } });
    const secondEmpty = await subtitlesHandler({ type: "movie", id: "tt1234573", extra: { filename: "Empty.mkv" }, config: { apiKey: "empty-second-key", baseUrl } });
    assert.deepStrictEqual(firstEmpty.subtitles, []);
    assert.deepStrictEqual(secondEmpty.subtitles, []);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/424247/download"), 1);
    assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(harness.cacheRoot, "ready", "424247", "manifest.json"), "utf8")).tracks, []);
    console.log("✓ Passed: a valid empty package is a reusable ready result");

    console.log("Test 7: Explicitly wrong package seasons skip download, while ambiguous metadata and episode metadata remain eligible");
    harness.setSearchResults([{ id: 424260, language: "ro", title: "Show.S02E03" }]);
    harness.setArchive(424260, zip.toBuffer());
    const rejectedSeason = await subtitlesHandler({ type: "series", id: "tt1234580:1:2", extra: { filename: "Show.S01E02.mkv" }, config: { apiKey: "season-key", baseUrl } });
    assert.deepStrictEqual(rejectedSeason.subtitles, []);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/424260/download"), 0);
    const metadataZip = new AdmZip();
    metadataZip.addFile("Show.1080p.srt", Buffer.from(srt));
    harness.setSearchResults([{ id: 424261, language: "ro", title: "Show Season 1 Episode 2" }]);
    harness.setArchive(424261, metadataZip.toBuffer());
    const metadataEpisode = await subtitlesHandler({ type: "series", id: "tt1234581:1:2", extra: { filename: "Show.S01E02.mkv" }, config: { apiKey: "metadata-key", baseUrl } });
    assert.strictEqual(metadataEpisode.subtitles.length, 1);
    harness.setSearchResults([{ id: 424269, language: "ro", title: "Show collection" }]);
    harness.setArchive(424269, zip.toBuffer());
    const ambiguousSeason = await subtitlesHandler({ type: "series", id: "tt1234589:1:2", extra: { filename: "Show.S01E02.mkv" }, config: { apiKey: "ambiguous-key", baseUrl } });
    assert.strictEqual(ambiguousSeason.subtitles.length, 2);
    console.log("✓ Passed: only explicit other-season metadata is rejected before download");

    console.log("Test 8: RAR-shaped fixtures use the same filtering, limits, and delivery contract");
    harness.setArchiveAdapter(async ({ archiveType }) => {
      assert.strictEqual(archiveType, "rar");
      return [
        { originalPath: "Show.S01E02.srt", size: Buffer.byteLength(srt), directory: false, read: async () => Buffer.from(srt) },
        { originalPath: "Show.S01E03.srt", size: Buffer.byteLength(srt), directory: false, read: async () => Buffer.from(srt) },
        { originalPath: "Show.S02E03.srt", size: Buffer.byteLength(srt), directory: false, read: async () => Buffer.from(srt) },
        { originalPath: "Show.2x03.srt", size: Buffer.byteLength(srt), directory: false, read: async () => Buffer.from(srt) },
        { originalPath: "Show.S01E02.Forced.srt", size: Buffer.byteLength(srt), directory: false, read: async () => Buffer.from(srt) },
      ];
    });
    harness.setSearchResults([{ id: 424262, language: "ro", title: "RAR Show" }]);
    harness.setArchive(424262, Buffer.from("Rar!\x1A\x07\x00fixture"));
    const rarList = await subtitlesHandler({ type: "series", id: "tt1234582:1:2", extra: { filename: "Show.S01E02.mkv" }, config: { apiKey: "rar-key", baseUrl } });
    assert.strictEqual(rarList.subtitles.length, 1);
    assert.strictEqual((await fetch(rarList.subtitles[0].url)).status, 200);
    const rarManifest = JSON.parse(await fs.readFile(path.join(harness.cacheRoot, "ready", "424262", "manifest.json"), "utf8"));
    assert.deepStrictEqual(rarManifest.tracks.map((track) => track.originalPath).sort(), ["Show.S01E02.srt", "Show.S01E03.srt"]);
    harness.setArchiveAdapter(async () => [{ originalPath: "../outside.srt", size: 1, directory: false, read: async () => Buffer.from(srt) }]);
    harness.setSearchResults([{ id: 424263, language: "ro", title: "Unsafe RAR" }]);
    harness.setArchive(424263, Buffer.from("Rar!\x1A\x07\x00fixture"));
    const unsafeRar = await subtitlesHandler({ type: "movie", id: "tt1234583", extra: { filename: "Unsafe.mkv" }, config: { apiKey: "unsafe-rar-key", baseUrl } });
    assert.deepStrictEqual(unsafeRar.subtitles, []);
    await assert.rejects(fs.access(path.join(harness.cacheRoot, "ready", "424263")));
    harness.setArchiveAdapter(async () => [{ originalPath: "Show.S01E02.srt", size: 256 * 1024 * 1024 + 1, directory: false, read: async () => Buffer.from(srt) }]);
    harness.setSearchResults([{ id: 424266, language: "ro", title: "Oversized RAR" }]);
    harness.setArchive(424266, Buffer.from("Rar!\x1A\x07\x00fixture"));
    assert.deepStrictEqual(await subtitlesHandler({ type: "series", id: "tt1234586:1:2", extra: { filename: "Show.S01E02.mkv" }, config: { apiKey: "limit-key", baseUrl } }), { subtitles: [], cacheMaxAge: 3600 });
    harness.setArchiveAdapter(async () => Array.from({ length: 1001 }, (_, index) => ({ originalPath: `Show.S01E02.${index}.srt`, size: 1, directory: false, read: async () => Buffer.from(srt) })));
    harness.setSearchResults([{ id: 424267, language: "ro", title: "Many RAR tracks" }]);
    harness.setArchive(424267, Buffer.from("Rar!\x1A\x07\x00fixture"));
    assert.deepStrictEqual(await subtitlesHandler({ type: "series", id: "tt1234587:1:2", extra: { filename: "Show.S01E02.mkv" }, config: { apiKey: "count-key", baseUrl } }), { subtitles: [], cacheMaxAge: 3600 });
    harness.setArchiveAdapter(async () => [
      { originalPath: "Show.S01E02.First.srt", size: Buffer.byteLength(srt), directory: false, read: async () => Buffer.from(srt) },
      { originalPath: "Show.S01E02.Corrupt.srt", size: Buffer.byteLength(srt), directory: false, read: async () => { throw new Error("injected corrupt RAR member"); } },
      { originalPath: "Show.S01E02.Last.srt", size: Buffer.byteLength(srt), directory: false, read: async () => Buffer.from(srt) },
    ]);
    harness.setSearchResults([{ id: 424276, language: "ro", title: "RAR member isolation" }]);
    harness.setArchive(424276, Buffer.from("Rar!\x1A\x07\x00fixture"));
    const isolatedRar = await subtitlesHandler({ type: "series", id: "tt1234592:1:2", extra: { filename: "Show.S01E02.mkv" }, config: { apiKey: "rar-isolation-key", baseUrl } });
    assert.strictEqual(isolatedRar.subtitles.length, 2);
    const isolatedDirectory = path.join(harness.cacheRoot, "ready", "424276");
    assert.deepStrictEqual((await fs.readdir(isolatedDirectory)).sort(), ["manifest.json", "track-0.srt", "track-1.srt"]);
    assert.strictEqual((await fetch(isolatedRar.subtitles[0].url)).status, 200);
    assert.strictEqual((await fetch(isolatedRar.subtitles[1].url)).status, 200);
    assert.deepStrictEqual((await fs.readdir(isolatedDirectory)).sort(), ["manifest.json", "track-0.vtt", "track-1.vtt"]);
    harness.setArchiveAdapter(undefined);
    console.log("✓ Passed: RAR filtering, member isolation, unsafe paths, and declared archive limits follow the ZIP package contract");

    console.log("Test 9: A genuine RAR fixture reaches the real decoder and publishes only managed tracks");
    const genuineRar = await fs.readFile(path.join(__dirname, "fixtures", "node-unrar-srt-test.rar"));
    harness.setSearchResults([{ id: 424268, language: "ro", season: 1, episode: 2, title: "RAR fixture" }]);
    harness.setArchive(424268, genuineRar);
    const genuineRarList = await subtitlesHandler({ type: "series", id: "tt1234588:1:2", extra: { filename: "RAR.Fixture.S01E02.mkv" }, config: { apiKey: "genuine-rar-key", baseUrl } });
    assert.strictEqual(genuineRarList.subtitles.length, 2);
    const genuineRarDirectory = path.join(harness.cacheRoot, "ready", "424268");
    const genuineManifest = JSON.parse(await fs.readFile(path.join(genuineRarDirectory, "manifest.json"), "utf8"));
    assert.strictEqual(genuineManifest.archiveType, "rar");
    const genuineDelivery = await fetch(genuineRarList.subtitles[0].url);
    assert.strictEqual(genuineDelivery.status, 200);
    assert((await genuineDelivery.text()).startsWith("WEBVTT\n\n"));
    assert.deepStrictEqual((await fs.readdir(genuineRarDirectory)).sort(), ["manifest.json", "track-0.vtt", "track-1.srt"]);
    console.log("✓ Passed: createExtractorFromFile listed and extracted the genuine RAR without publishing decoder scratch files");

    console.log("Test 10: RAR scratch cleanup failure prevents atomic publication");
    let scratchCleanupFailed = false;
    harness.setFileOps(new Proxy(fs, {
      get(target, property) {
        const original = target[property];
        if (typeof original !== "function") return original;
        return async (...args) => {
          if (!scratchCleanupFailed && property === "rm" && String(args[0]).endsWith("rar-scratch")) {
            scratchCleanupFailed = true;
            throw new Error("injected RAR scratch cleanup failure");
          }
          return original.apply(target, args);
        };
      },
    }));
    harness.setSearchResults([{ id: 424275, language: "ro", season: 1, episode: 2, title: "RAR cleanup" }]);
    harness.setArchive(424275, genuineRar);
    const scratchFailure = await subtitlesHandler({ type: "series", id: "tt1234591:1:2", extra: { filename: "RAR.Cleanup.S01E02.mkv" }, config: { apiKey: "rar-cleanup-key", baseUrl } });
    assert.deepStrictEqual(scratchFailure.subtitles, []);
    await assert.rejects(fs.access(path.join(harness.cacheRoot, "ready", "424275")));
    harness.setFileOps(undefined);
    console.log("✓ Passed: scratch cleanup failure leaves no published RAR package");

    console.log("Test 11: A failed package is retryable and does not hide successful packages from one list response");
    harness.setSearchResults([{ id: 424264, language: "ro", title: "Good" }, { id: 424265, language: "ro", title: "Broken" }]);
    harness.setArchive(424264, zip.toBuffer());
    harness.setArchive(424265, Buffer.from("not an archive"));
    const partial = await subtitlesHandler({ type: "series", id: "tt1234584:1:2", extra: { filename: "Show.S01E02.mkv" }, config: { apiKey: "partial-key", baseUrl } });
    assert.strictEqual(partial.subtitles.length, 2);
    const retryDownloads = harness.countRequests("/v1.0/subtitle/424265/download");
    const retry = await subtitlesHandler({ type: "series", id: "tt1234585:1:2", extra: { filename: "Show.S01E02.mkv" }, config: { apiKey: "retry-key", baseUrl } });
    assert.strictEqual(retry.subtitles.length, 2);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/424265/download"), retryDownloads + 1);
    console.log("✓ Passed: successful packages remain listed and failed packages cleanly retry");

    console.log("Test 12: Five packages survive a fastest failure and retain every successful package");
    const fiveIds = [424270, 424271, 424272, 424273, 424274];
    harness.setSearchResults(fiveIds.map((id) => ({ id, language: "ro", title: `Package ${id}` })));
    for (const id of fiveIds) {
      harness.setArchive(id, id === 424270 ? Buffer.from("not an archive") : zip.toBuffer());
      harness.setArchiveDelay(id, id === 424270 ? 0 : 30);
    }
    const fivePackageList = await subtitlesHandler({ type: "series", id: "tt1234589:1:2", extra: { filename: "Show.S01E02.mkv" }, config: { apiKey: "five-package-key", baseUrl } });
    assert.strictEqual(fivePackageList.subtitles.length, 8);
    const failedBeforeRetry = harness.countRequests("/v1.0/subtitle/424270/download");
    const fivePackageRetry = await subtitlesHandler({ type: "series", id: "tt1234590:1:2", extra: { filename: "Show.S01E02.mkv" }, config: { apiKey: "five-package-retry-key", baseUrl } });
    assert.strictEqual(fivePackageRetry.subtitles.length, 8);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/424270/download"), failedBeforeRetry + 1);
    console.log("✓ Passed: the fastest failure settled without aborting successful package preparation or retryability");

    console.log("Test 7: A corrupt cold ZIP publishes no partial Cached Package");
    harness.setSearchResults([{ id: 424243, language: "ro", title: "Broken Movie" }]);
    harness.setArchive(424243, Buffer.from("not a ZIP"));
    const brokenList = await subtitlesHandler({
      type: "movie",
      id: "tt1234568",
      extra: { filename: "Broken.Movie.2024.mkv" },
      config: { apiKey: "test-key", baseUrl },
    });
    assert.deepStrictEqual(brokenList.subtitles, []);
    await assert.rejects(fs.access(path.join(harness.cacheRoot, "ready", "424243")));
    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), []);
    console.log("✓ Passed: failed preparation left no ready or temporary package behind");

    console.log("Test 5: A malformed upstream package ID cannot escape the cache roots");
    const sentinelDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "subsro-sentinel-"));
    const sentinel = path.join(sentinelDirectory, "sentinel.txt");
    try {
      await fs.writeFile(sentinel, "untouched");
      harness.setSearchResults([{ id: "../../subsro-sentinel", language: "ro", title: "Unsafe" }]);
      const unsafeList = await subtitlesHandler({
        type: "movie", id: "tt1234569", extra: { filename: "Unsafe.mkv" }, config: { apiKey: "test-key", baseUrl },
      });
      assert.deepStrictEqual(unsafeList.subtitles, []);
      assert.strictEqual(await fs.readFile(sentinel, "utf8"), "untouched");
      assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), []);
    } finally {
      await fs.rm(sentinelDirectory, { recursive: true, force: true });
    }
    console.log("✓ Passed: malformed package ID made no filesystem changes outside the isolated cache");

    console.log("Test 6: Injected archive-cleanup failure prevents publication and is retried during cleanup");
    let failureMode = "archive";
    let failed = false;
    const faultingFileOps = new Proxy(fs, {
      get(target, property) {
        const original = target[property];
        if (typeof original !== "function") return original;
        return async (...args) => {
          const [source, destination] = args;
          const shouldFail = !failed && (
            (failureMode === "archive" && property === "rm" && String(source).endsWith(".zip")) ||
            (failureMode === "track-write" && property === "writeFile" && String(source).endsWith("track-0.srt")) ||
            (failureMode === "vtt" && property === "rename" && String(destination).endsWith(".vtt")) ||
            (failureMode === "srt" && property === "rm" && String(source).endsWith(".srt") && args[1]?.force === false) ||
            (failureMode === "manifest" && property === "rename" && String(destination).endsWith("manifest.json"))
          );
          if (shouldFail) {
            failed = true;
            throw new Error(`injected ${failureMode} failure`);
          }
          return original.apply(target, args);
        };
      },
    });
    harness.setFileOps(faultingFileOps);
    harness.setSearchResults([{ id: 424244, language: "ro", title: "Cleanup" }]);
    harness.setArchive(424244, zip.toBuffer());
    const cleanupList = await subtitlesHandler({ type: "movie", id: "tt1234570", extra: { filename: "Cleanup.mkv" }, config: { apiKey: "test-key", baseUrl } });
    assert.deepStrictEqual(cleanupList.subtitles, []);
    await assert.rejects(fs.access(path.join(harness.cacheRoot, "ready", "424244")));
    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), []);

    console.log("Test 7: Injected extracted-track write failure aborts the complete package");
    failureMode = "track-write";
    failed = false;
    harness.setSearchResults([{ id: 424245, language: "ro", title: "Track write" }]);
    harness.setArchive(424245, zip.toBuffer());
    const trackWriteList = await subtitlesHandler({ type: "movie", id: "tt1234571", extra: { filename: "Track.Write.mkv" }, config: { apiKey: "test-key", baseUrl } });
    assert.deepStrictEqual(trackWriteList.subtitles, []);
    await assert.rejects(fs.access(path.join(harness.cacheRoot, "ready", "424245")));
    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), []);

    console.log("Test 8: Injected VTT, SRT, and manifest failures preserve SRT and permit a retry");
    for (const [offset, mode] of ["vtt", "srt", "manifest"].entries()) {
      const subId = 424250 + offset;
      failureMode = mode;
      failed = false;
      harness.setSearchResults([{ id: subId, language: "ro", title: `Retry ${mode}` }]);
      harness.setArchive(subId, zip.toBuffer());
      const retryList = await subtitlesHandler({ type: "movie", id: `tt12345${offset}1`, extra: { filename: "Show.S01E02.1080p.BluRay.mkv" }, config: { apiKey: "test-key", baseUrl } });
      const retryUrl = retryList.subtitles[0].url;
      const retryDirectory = path.join(harness.cacheRoot, "ready", String(subId));
      const beforeFailedDelivery = JSON.parse(await fs.readFile(path.join(retryDirectory, "manifest.json"), "utf8")).lastAccessedAt;
      const failedDelivery = await fetch(retryUrl);
      assert.strictEqual(failedDelivery.status, 500);
      const retryTrackId = new URL(retryUrl).pathname.split("/")[4];
      const failedManifest = JSON.parse(await fs.readFile(path.join(retryDirectory, "manifest.json"), "utf8"));
      assert.strictEqual(failedManifest.lastAccessedAt, beforeFailedDelivery);
      assert.strictEqual(failedManifest.tracks.find((track) => track.id === retryTrackId).state, "srt");
      assert((await fs.readdir(retryDirectory)).includes("track-0.srt"));
      assert(!(await fs.readdir(retryDirectory)).includes("track-0.vtt"));
      failureMode = null;
      const retriedDelivery = await fetch(retryUrl);
      assert.strictEqual(retriedDelivery.status, 200);
      const retriedManifest = JSON.parse(await fs.readFile(path.join(retryDirectory, "manifest.json"), "utf8"));
      assert.strictEqual(retriedManifest.tracks.find((track) => track.id === retryTrackId).state, "vtt");
      assert((await fs.readdir(retryDirectory)).includes("track-0.vtt"));
    }
    harness.setFileOps(undefined);
    console.log("✓ Passed: conversion failures preserve raw SRT and retries publish WebVTT safely");
  } finally {
    const cleanup = await Promise.allSettled([
      closeServer(server),
      harness ? harness.close() : Promise.resolve(),
    ]);
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  console.log("\nALL END-TO-END PIPELINE SEAM TESTS PASSED ✓");
}

runTests().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
