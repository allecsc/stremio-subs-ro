const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

const {
  globalMetrics,
  hashApiKey,
  MetricsEngine,
  APP_VERSION,
  INSTANCE_ID,
} = require("../lib/metrics");
const { categorizeRoute, createApp } = require("../server");
const {
  subtitlesHandler,
  CACHE,
  PENDING_PACKAGES,
  PENDING_REQUESTS,
} = require("../addon");
const { ARCHIVE_CACHE } = require("../lib/archiveCache");
const { limiterManager } = require("../lib/rateLimiter");

async function runTelemetryTestSuite() {
  console.log("================================================================================");
  console.log("RUNNING PRODUCTION RC TELEMETRY VALIDATION SUITE");
  console.log("================================================================================");

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error(`    Error: ${err.message}`);
      failed++;
    }
  }

  // 1. Unique API-key counting uses SHA-256 hashes and never exposes raw keys
  test("Unique API-key hashing & privacy", () => {
    const rawKey1 = "secret-user-key-12345";
    const rawKey2 = "another-secret-user-key-67890";
    const hash1 = hashApiKey(rawKey1);
    const hash2 = hashApiKey(rawKey2);

    assert.strictEqual(typeof hash1, "string");
    assert.strictEqual(hash1.length, 64);
    assert.notStrictEqual(hash1, rawKey1);
    assert.strictEqual(hash1, hashApiKey(rawKey1)); // Deterministic
    assert.notStrictEqual(hash1, hash2);

    // Test with fresh engine
    const engine = new MetricsEngine();
    engine.recordActiveUser(rawKey1);
    engine.recordActiveUser(rawKey2);
    engine.recordActiveUser(rawKey1); // Duplicate

    const snapshot = engine.exportSnapshot();
    assert.strictEqual(snapshot.users.uniqueToday, 2);
    assert.strictEqual(snapshot.users.uniqueRcInstalls, 2);
    assert.strictEqual(snapshot.users.activeNow15m, 2);

    // Ensure raw keys are not exposed in exportSnapshot
    const snapshotStr = JSON.stringify(snapshot);
    assert.strictEqual(snapshotStr.includes(rawKey1), false);
    assert.strictEqual(snapshotStr.includes(rawKey2), false);
  });

  // 2. Route logging contains no raw URL/config/key/filename
  test("Safe Route Categorization (no sensitive data in logs)", () => {
    const sensitiveUrl1 = "/eyJhcGlLZXkiOiJteS1zZWNyZXQta2V5In0/subtitles/movie/tt1234567:Breaking.Bad.S01E01.mkv.json";
    const sensitiveUrl2 = "/my-secret-api-key/proxy/9999/c29tZXN1YnBhdGg/sub.vtt";
    const manifestUrl = "/eyJhcGlLZXkiOiJzZWNyZXQifQ/manifest.json";
    const configUrl = "/configure";
    const adminUrl = "/admin/stats?key=my-admin-secret";

    assert.strictEqual(categorizeRoute(sensitiveUrl1), "/subtitles");
    assert.strictEqual(categorizeRoute(sensitiveUrl2), "/proxy");
    assert.strictEqual(categorizeRoute(manifestUrl), "/manifest");
    assert.strictEqual(categorizeRoute(configUrl), "/configure");
    assert.strictEqual(categorizeRoute(adminUrl), "/admin");
    assert.strictEqual(categorizeRoute("/public/style.css"), "/static");
  });

  // 3. List metrics & latency buckets increment correctly
  test("List metrics and latency distributions", () => {
    const engine = new MetricsEngine();
    engine.recordSubtitleRequest({ durationMs: 250, searchDurationMs: 120, resultCount: 5, success: true });
    engine.recordSubtitleRequest({ durationMs: 1500, searchDurationMs: 800, resultCount: 0, success: true });
    engine.recordSubtitleRequest({ durationMs: 7000, searchDurationMs: 6500, success: false, error: "Timeout" });

    const snap = engine.exportSnapshot();
    assert.strictEqual(snap.traffic.subtitleRequests, 3);
    assert.strictEqual(snap.traffic.successfulRequests, 2);
    assert.strictEqual(snap.traffic.emptySubtitleResponses, 1);
    assert.strictEqual(snap.traffic.failedRequests, 1);

    assert.strictEqual(snap.latency.subtitle.buckets["<500ms"], 1);
    assert.strictEqual(snap.latency.subtitle.buckets["1-2s"], 1);
    assert.strictEqual(snap.latency.subtitle.buckets["5-10s"], 1);
    assert.strictEqual(snap.latency.subtitle.maxMs, 7000);
  });

  // 4. Proxy metrics increment correctly
  test("Proxy metrics and extraction latency", () => {
    const engine = new MetricsEngine();
    engine.recordProxyRequest({ durationMs: 45, extractionDurationMs: 20, statusCode: 200 });
    engine.recordProxyRequest({ durationMs: 10, extractionDurationMs: 0, statusCode: 404 });
    engine.recordProxyRequest({ durationMs: 500, statusCode: 500, error: "Corrupt stream" });

    const snap = engine.exportSnapshot();
    assert.strictEqual(snap.traffic.proxyRequests, 3);
    assert.strictEqual(snap.latency.proxyStatus["200"], 1);
    assert.strictEqual(snap.latency.proxyStatus["404"], 1);
    assert.strictEqual(snap.latency.proxyStatus["5xx"], 1);
    assert.strictEqual(snap.latency.proxy.buckets["<500ms"], 2);
    assert.strictEqual(snap.latency.proxy.buckets["500ms-1s"], 1);
  });

  // 5. Cache hit/miss counters are strictly separated
  test("Separated Cache Hit/Miss counters", () => {
    const engine = new MetricsEngine();
    engine.recordCacheHit("responseCache");
    engine.recordCacheMiss("responseCache");
    engine.recordCacheHit("archiveCache");
    engine.recordCacheMiss("archiveCache");
    engine.recordCacheMiss("archiveCache");
    engine.recordCacheHit("vttCache");

    const snap = engine.exportSnapshot();
    assert.strictEqual(snap.cache.responseCache.hit, 1);
    assert.strictEqual(snap.cache.responseCache.miss, 1);
    assert.strictEqual(snap.cache.responseCache.hitRate, 50);

    assert.strictEqual(snap.cache.archiveCache.hit, 1);
    assert.strictEqual(snap.cache.archiveCache.miss, 2);
    assert.strictEqual(snap.cache.archiveCache.hitRate, 33);

    assert.strictEqual(snap.cache.vttCache.hit, 1);
    assert.strictEqual(snap.cache.vttCache.miss, 0);
    assert.strictEqual(snap.cache.vttCache.hitRate, 100);
  });

  // 6. Package singleflight joins are counted
  test("Singleflight Leaders and Joins", () => {
    const engine = new MetricsEngine();
    engine.recordSingleflight("leaders");
    engine.recordSingleflight("joined");
    engine.recordSingleflight("joined");

    const snap = engine.exportSnapshot();
    assert.strictEqual(snap.cache.singleflight.leaders, 1);
    assert.strictEqual(snap.cache.singleflight.joined, 2);
  });

  // 6b. Corrupt archive vs download failure classification
  test("Corrupt archive vs download failure classification", () => {
    const engine = new MetricsEngine();
    // Network/download failure
    engine.recordArchiveDownload({ success: false, error: new Error("Network timeout") });
    // Successful download + parse failure (corrupt)
    engine.recordArchiveDownload({ bytes: 5000, success: true });
    engine.recordCorruptArchive("zip", new Error("Bad CRC"));

    const snap = engine.exportSnapshot();
    assert.strictEqual(snap.upstream.downloadFailures, 1);
    assert.strictEqual(snap.upstream.corruptFailures, 1);
    assert.strictEqual(snap.upstream.downloads, 1);
  });

  // 7. Resource sampler records RSS/heap
  test("Resource Sampler & Concurrency Tracking", () => {
    const engine = new MetricsEngine();
    const sample = engine.sampleResources({
      archiveCacheEntries: 5,
      stagedFileCount: 2,
      stagedTotalBytes: 1048576,
      pendingPackages: 0,
      pendingRequests: 0,
      activeLimiters: 3,
      globalActiveDownloads: 2,
      queuedDownloads: 1,
      eventLoopLagMs: 1.5,
    });

    assert.ok(sample);
    assert.strictEqual(sample.archiveCacheEntries, 5);
    assert.strictEqual(sample.stagedFileCount, 2);
    assert.strictEqual(sample.stagedTotalMb, 1);
    assert.ok(sample.rssMb > 0);
    assert.ok(sample.heapUsedMb > 0);
    assert.strictEqual(sample.globalActiveDownloads, 2);
    assert.strictEqual(sample.queuedDownloads, 1);

    const snap = engine.exportSnapshot();
    assert.strictEqual(snap.limiter.peakGlobalActive, 2);
    assert.strictEqual(snap.limiter.peakQueued, 1);
    assert.strictEqual(snap.recentSamples.length, 1);
  });

  // 8. Snapshot serialization works & contains machine-readable marker
  test("Snapshot serialization & format marker", () => {
    const engine = new MetricsEngine();
    const snap = engine.exportSnapshot();
    assert.strictEqual(snap.header, "#SUBSRO_TELEMETRY_V2");
    assert.strictEqual(snap.appVersion, APP_VERSION);
    assert.strictEqual(snap.instanceId.startsWith("inst_"), true);
    assert.strictEqual(typeof snap.uptimeSeconds, "number");
  });

  // 9. Telemetry exception cannot break request
  test("Telemetry failure isolation", () => {
    const engine = new MetricsEngine();
    // Pass corrupted/unexpected types
    assert.doesNotThrow(() => engine.recordActiveUser(null));
    assert.doesNotThrow(() => engine.recordActiveUser({ invalid: true }));
    assert.doesNotThrow(() => engine.recordSubtitleRequest({ durationMs: "invalid", resultCount: null }));
    assert.doesNotThrow(() => engine.recordProxyRequest({ durationMs: -50, statusCode: "bad" }));
    assert.doesNotThrow(() => engine.recordCacheHit("nonExistent"));
    assert.doesNotThrow(() => engine.sampleResources(null));
  });

  // 10. Admin stats security (requires ADMIN_SECRET)
  test("Admin Stats Endpoint Security", async () => {
    process.env.ADMIN_SECRET = "test-secret-key-xyz";
    const app = createApp();
    const server = app.listen(0);
    const port = server.address().port;

    const get = (url, headers = {}) => new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}${url}`, { headers }, (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
    });

    try {
      // Missing secret -> 401
      const resUnauth = await get("/admin/stats");
      assert.strictEqual(resUnauth.status, 401);

      // Wrong secret -> 401
      const resBad = await get("/admin/stats?key=wrong-secret");
      assert.strictEqual(resBad.status, 401);

      // Correct secret via query -> 200 HTML
      const resAuthHtml = await get("/admin/stats?key=test-secret-key-xyz");
      assert.strictEqual(resAuthHtml.status, 200);
      assert.ok(resAuthHtml.body.includes("Subs.ro Addon"));
      assert.ok(resAuthHtml.body.includes(APP_VERSION));

      // Correct secret via header -> 200 JSON
      const resAuthJson = await get("/admin/stats?format=json", { "x-admin-secret": "test-secret-key-xyz" });
      assert.strictEqual(resAuthJson.status, 200);
      const json = JSON.parse(resAuthJson.body);
      assert.strictEqual(json.header, "#SUBSRO_TELEMETRY_V2");
      assert.strictEqual(json.appVersion, APP_VERSION);
    } finally {
      server.close();
    }
  });

  console.log("================================================================================");
  console.log(`TELEMETRY VALIDATION RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTelemetryTestSuite().catch((err) => {
  console.error("FATAL ERROR IN TEST SUITE:", err);
  process.exit(1);
});
