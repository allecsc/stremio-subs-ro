const assert = require("assert");
const AdmZip = require("adm-zip");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { subtitlesHandler } = require("../addon");
const { globalMetrics } = require("../lib/metrics");
const SubsRoClient = require("../lib/subsro");
const { configureSubtitlePipeline, resetSubtitlePipeline } = require("../lib/subtitlePipeline");
const express = require("express");
const http = require("http");
const proxyRouter = require("../lib/proxy");

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

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
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subsro-telemetry-test-"));

  try {
    SubsRoClient.prototype.searchByImdb = async () => [mockSub];
    
    const srtPath = "Test.Movie.2024.1080p.AMZN.WEB-DL.srt";
    const zip = new AdmZip();
    zip.addFile(srtPath, Buffer.from("1\n00:00:01,000 --> 00:00:03,000\nTest\n"));
    configureSubtitlePipeline({
      cacheRoot,
      createClient: (apiKey) => {
        const client = new SubsRoClient(apiKey);
        client.downloadArchiveToFile = async (_subId, destination) => fs.writeFile(destination, zip.toBuffer(), { flag: "wx" });
        return client;
      },
    });

    const res = await subtitlesHandler({
      type: "movie",
      id: "tt9999999",
      extra: { filename: "Test.Movie.2024.1080p.AMZN.WEB-DL-GROUP.mkv" },
      config: { apiKey: testApiKey },
    });

    assert(res.subtitles.length > 0);

    const stats = globalMetrics.getLiveStats();
    assert.strictEqual(stats.today.searchRequests, 1);
    assert.strictEqual(stats.today.uniqueActiveUsers, 1);
    assert.strictEqual(stats.activeNow15m, 1);
    assert(stats.today.matchTiers.medSync >= 1);
    console.log("✓ Passed: Search request and match score recorded in global metrics");

    // Test 2: Stream proxy event recording
    console.log("Test 2: Proxy router records stream events and cache hit rates");
    const app = express();
    app.use(proxyRouter);
    const server = http.createServer(app);
    try {
      await listen(server);
      const port = server.address().port;
      const proxyUrl = new URL(res.subtitles[0].url);
      const proxyRes = await fetch(`http://localhost:${port}${proxyUrl.pathname}`);
      assert.strictEqual(proxyRes.status, 200);

      const statsAfterProxy = globalMetrics.getLiveStats();
      assert.strictEqual(statsAfterProxy.today.proxyRequests, 1);
      assert.strictEqual(statsAfterProxy.today.cacheHits, 1);
      assert.strictEqual(statsAfterProxy.today.cacheHitRate, 100);
      assert.strictEqual(statsAfterProxy.today.archiveFormats.zip, 1);
      console.log("✓ Passed: Proxy stream cache hit and format recorded in global metrics");
    } finally {
      await closeServer(server);
    }

  } finally {
    SubsRoClient.prototype.searchByImdb = originalSearch;
    resetSubtitlePipeline();
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }

  console.log("\nALL TELEMETRY HOOKS TESTS PASSED ✓");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
