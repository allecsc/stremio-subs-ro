const assert = require("assert");
const AdmZip = require("adm-zip");
const { subtitlesHandler } = require("../addon");
const { globalMetrics } = require("../lib/metrics");
const { ARCHIVE_CACHE } = require("../lib/archiveCache");
const SubsRoClient = require("../lib/subsro");
const express = require("express");
const http = require("http");
const proxyRouter = require("../lib/proxy");

async function runTests() {
  console.log("=== Running Telemetry Pipeline Hooks Tests ===");

  globalMetrics.reset();

  // Test 1: Subtitle search event recording
  console.log("Test 1: subtitlesHandler records search metrics, latencies, and match scores");
  const testApiKey = "telemetry-user-key-1";

  // Mock searchByImdb and downloadArchive
  const mockSub = {
    id: 88881,
    title: "Test Movie 2024",
    language: "ro",
    translator: "Official Retail",
  };

  const originalSearch = SubsRoClient.prototype.searchByImdb;
  const originalDownload = SubsRoClient.prototype.downloadArchive;

  try {
    SubsRoClient.prototype.searchByImdb = async () => [mockSub];
    
    const srtPath = "Test.Movie.2024.1080p.AMZN.WEB-DL.srt";
    const zip = new AdmZip();
    zip.addFile(srtPath, Buffer.from("1\n00:00:01,000 --> 00:00:03,000\nTest\n", "utf8"));
    const archiveBuffer = zip.toBuffer();
    SubsRoClient.prototype.downloadArchive = async () => archiveBuffer;

    const res = await subtitlesHandler({
      type: "movie",
      id: "tt9999999",
      extra: { filename: "Test.Movie.2024.1080p.AMZN.WEB-DL-GROUP.mkv" },
      config: { apiKey: testApiKey },
    });

    assert(res.subtitles.length > 0);
    const cachedArchive = ARCHIVE_CACHE.get(`archive_${mockSub.id}`);
    assert.deepStrictEqual(cachedArchive.srtFiles, [srtPath]);
    assert.strictEqual(cachedArchive.vttMap, undefined);

    const stats = globalMetrics.getLiveStats();
    assert.strictEqual(stats.today.searchRequests, 1);
    assert.strictEqual(stats.today.uniqueActiveUsers, 1);
    assert.strictEqual(stats.activeNow15m, 1);
    assert(stats.today.matchTiers.medSync >= 1);
    console.log("✓ Passed: Search request and match score recorded in global metrics");

    // Test 2: Stream proxy event recording
    console.log("Test 2: Proxy router records fallback stream events when search retained only archive metadata");
    const app = express();
    app.use(proxyRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const encodedSrtPath = Buffer.from(srtPath).toString("base64url");
      const proxyRes = await fetch(`http://localhost:${port}/${testApiKey}/proxy/${mockSub.id}/${encodedSrtPath}/sub.vtt`);
      assert.strictEqual(proxyRes.status, 200);

      const statsAfterProxy = globalMetrics.getLiveStats();
      assert.strictEqual(statsAfterProxy.today.proxyRequests, 1);
      assert.strictEqual(statsAfterProxy.today.cacheHits, 0);
      assert.strictEqual(statsAfterProxy.today.cacheHitRate, 0);
      assert.strictEqual(statsAfterProxy.today.archiveFormats.zip, 1);
      console.log("✓ Passed: Proxy stream cache hit and format recorded in global metrics");
    } finally {
      server.close();
    }

  } finally {
    SubsRoClient.prototype.searchByImdb = originalSearch;
    SubsRoClient.prototype.downloadArchive = originalDownload;
  }

  console.log("\nALL TELEMETRY HOOKS TESTS PASSED ✓");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
