const assert = require("assert");
const {
  MetricsEngine,
  hashApiKey,
} = require("../lib/metrics");

async function runTests() {
  console.log("=== Running Metrics Engine & Anonymization Tests ===");

  const metrics = new MetricsEngine();

  // Test 1: SHA-256 Anonymization
  console.log("Test 1: API keys are irreversibly hashed with SHA-256");
  const rawKey1 = "my-secret-key-123";
  const rawKey2 = "my-secret-key-123";
  const rawKey3 = "different-user-key-456";

  const hash1 = hashApiKey(rawKey1);
  const hash2 = hashApiKey(rawKey2);
  const hash3 = hashApiKey(rawKey3);

  assert.strictEqual(typeof hash1, "string");
  assert.strictEqual(hash1.length, 64); // SHA-256 hex string
  assert.strictEqual(hash1, hash2, "Identical keys must produce identical hashes");
  assert.notStrictEqual(hash1, hash3, "Different keys must produce different hashes");
  assert(!hash1.includes("secret"), "Raw key must not be exposed in hash");
  assert.strictEqual(hashApiKey(""), null);
  assert.strictEqual(hashApiKey(null), null);
  console.log("✓ Passed: SHA-256 hash anonymization verified");

  // Test 2: Search Request Ingestion & Match Tier Classification
  console.log("Test 2: Ingest search events and classify match tier distributions");
  metrics.recordSearch({ apiKey: rawKey1, durationMs: 120, topScore: 100 }); // Exact
  metrics.recordSearch({ apiKey: rawKey2, durationMs: 80, topScore: 92 });  // HighSync (90-99)
  metrics.recordSearch({ apiKey: rawKey3, durationMs: 250, topScore: 15 }); // Fallback (<45)

  const liveStats1 = metrics.getLiveStats();
  assert.strictEqual(liveStats1.today.uniqueActiveUsers, 2, "rawKey1 and rawKey2 share the same key");
  assert.strictEqual(liveStats1.today.searchRequests, 3);
  assert.strictEqual(liveStats1.today.matchTiers.exact, 1);
  assert.strictEqual(liveStats1.today.matchTiers.highSync, 1);
  assert.strictEqual(liveStats1.today.matchTiers.fallback, 1);
  assert.strictEqual(liveStats1.activeNow15m, 2);
  console.log("✓ Passed: Search requests and tier scoring accurately recorded");

  // Test 3: Proxy Stream Ingestion & Cache Hit Rate
  console.log("Test 3: Ingest stream proxy events, cache hit rates, and archive formats");
  metrics.recordProxy({ apiKey: rawKey1, durationMs: 5, cacheHit: true, archiveType: "zip" });
  metrics.recordProxy({ apiKey: rawKey3, durationMs: 450, cacheHit: false, archiveType: "rar" });

  const liveStats2 = metrics.getLiveStats();
  assert.strictEqual(liveStats2.today.proxyRequests, 2);
  assert.strictEqual(liveStats2.today.cacheHits, 1);
  assert.strictEqual(liveStats2.today.cacheMisses, 1);
  assert.strictEqual(liveStats2.today.cacheHitRate, 50); // 1 / 2 = 50%
  assert.strictEqual(liveStats2.today.archiveFormats.zip, 1);
  assert.strictEqual(liveStats2.today.archiveFormats.rar, 1);
  console.log("✓ Passed: Proxy streaming and cache hit rates accurately recorded");

  // Test 4: Live 15-minute active window pruning
  console.log("Test 4: Prune users who have been inactive for >15 minutes");
  // Artificially age rawKey1's timestamp
  metrics.liveActiveUsers.set(hash1, Date.now() - 20 * 60 * 1000); // 20m ago
  metrics.pruneLiveActive(Date.now());
  const liveStats3 = metrics.getLiveStats();
  assert.strictEqual(liveStats3.activeNow15m, 1, "Only rawKey3 should be active in the last 15m");
  assert.strictEqual(liveStats3.today.uniqueActiveUsers, 2, "Daily unique active count must still retain both");
  console.log("✓ Passed: Live active window pruned correctly");

  // Test 5: Daily midnight rollover & 30-day history retention
  console.log("Test 5: Daily rollover flushes completed day into 30-day rolling history");
  const rolledDate = "2026-08-15";
  metrics.rolloverDay("2026-08-16", rolledDate);

  const statsAfterRollover = metrics.getLiveStats();
  assert.strictEqual(statsAfterRollover.history.length, 1);
  assert.strictEqual(statsAfterRollover.history[0].date, rolledDate);
  assert.strictEqual(statsAfterRollover.history[0].uniqueActiveUsers, 2);
  assert.strictEqual(statsAfterRollover.history[0].totalRequests, 5); // 3 search + 2 proxy
  assert.strictEqual(statsAfterRollover.today.searchRequests, 0, "New day bucket must start at 0");
  assert.strictEqual(statsAfterRollover.today.uniqueActiveUsers, 0);

  // Test capacity bound: push 35 days and ensure history max is 30
  for (let i = 1; i <= 35; i++) {
    const dayStr = `2026-07-${String(i).padStart(2, "0")}`;
    metrics.history.push({ date: dayStr, uniqueActiveUsers: i, totalRequests: i * 10 });
  }
  // Test 6: 7-Day Error Diagnostics & Signature Grouping
  console.log("Test 6: Error diagnostics group identical signatures and track frequencies");
  metrics.recordError({
    type: "UPSTREAM_SERVER_ERROR",
    message: "Subs.ro returned 502 Bad Gateway",
    stack: "Error: 502\n    at SubsRoClient.get",
    context: "tt0898266",
  });
  metrics.recordError({
    type: "UPSTREAM_SERVER_ERROR",
    message: "Subs.ro returned 502 Bad Gateway",
    stack: "Error: 502\n    at SubsRoClient.get",
    context: "tt0898266",
  });
  metrics.recordError({
    type: "SYNTAX_ERROR",
    message: "Invalid regular expression: Nothing to repeat",
    stack: "SyntaxError\n    at matcher",
    context: "Who.Framed.Roger.Rabbit?",
  });

  const liveStatsWithErrors = metrics.getLiveStats();
  assert.strictEqual(liveStatsWithErrors.recentErrors.length, 2, "Should have 2 distinct signatures");
  const upstreamErr = liveStatsWithErrors.recentErrors.find((e) => e.type === "UPSTREAM_SERVER_ERROR");
  assert.strictEqual(upstreamErr.count, 2, "Repeated 502 errors must increment count to 2");
  assert.strictEqual(upstreamErr.context, "tt0898266");

  // Test error pruning
  metrics.errorLog[0].lastSeenMs = Date.now() - (8 * 24 * 60 * 60 * 1000); // 8 days ago
  metrics.pruneErrors(7);
  assert.strictEqual(metrics.errorLog.length, 1, "Errors older than 7 days must be pruned");
  console.log("✓ Passed: 7-day error diagnostics grouping and pruning verified");

  console.log("\nALL METRICS TESTS PASSED ✓");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
