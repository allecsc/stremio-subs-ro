const assert = require("assert");
const express = require("express");
const http = require("http");
const { globalMetrics } = require("../lib/metrics");
const adminRouter = require("../lib/adminStats");

async function runTests() {
  console.log("=== Running Admin Dashboard Route Tests ===");

  process.env.ADMIN_SECRET = "super-secret-admin-key-999";
  globalMetrics.reset();

  // Populate some test metrics
  globalMetrics.recordSearch({ apiKey: "user-1", durationMs: 150, topScore: 100 });
  globalMetrics.recordProxy({ apiKey: "user-1", durationMs: 12, cacheHit: true, archiveType: "zip" });

  const app = express();
  app.use(adminRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // Test 1: Reject unauthorized requests (no key) with 404
    console.log("Test 1: Reject request with missing key (returns 404)");
    const resUnauthorized = await fetch(`${baseUrl}/admin/stats`);
    assert.strictEqual(resUnauthorized.status, 404);
    console.log("✓ Passed: Missing key returns 404");

    // Test 2: Reject invalid key with 404
    console.log("Test 2: Reject request with wrong key (returns 404)");
    const resWrongKey = await fetch(`${baseUrl}/admin/stats?key=wrong-key`);
    assert.strictEqual(resWrongKey.status, 404);
    console.log("✓ Passed: Invalid key returns 404");

    // Test 3: Authorized JSON request
    console.log("Test 3: Authorized request with ?format=json returns metrics JSON payload");
    const resJson = await fetch(`${baseUrl}/admin/stats?key=super-secret-admin-key-999&format=json`);
    assert.strictEqual(resJson.status, 200);
    assert.strictEqual(resJson.headers.get("content-type"), "application/json; charset=utf-8");
    const jsonData = await resJson.json();
    assert.strictEqual(jsonData.today.uniqueActiveUsers, 1);
    assert.strictEqual(jsonData.today.searchRequests, 1);
    assert.strictEqual(jsonData.today.proxyRequests, 1);
    assert.strictEqual(jsonData.today.cacheHitRate, 100);
    console.log("✓ Passed: Authorized JSON data returned correctly");

    // Test 4: Authorized HTML Dashboard
    console.log("Test 4: Authorized request returns rendered HTML dashboard");
    const resHtml = await fetch(`${baseUrl}/admin/stats?key=super-secret-admin-key-999`);
    assert.strictEqual(resHtml.status, 200);
    assert(resHtml.headers.get("content-type").includes("text/html"));
    const htmlBody = await resHtml.text();
    assert(htmlBody.includes("Subs.ro Addon — Operational Metrics"));
    assert(htmlBody.includes("Active Now (15m)"));
    assert(htmlBody.includes("Cache Hit Rate"));
    console.log("✓ Passed: Standalone HTML dashboard rendered with live metrics");

    // Test 5: Disabled when ADMIN_SECRET is not configured
    console.log("Test 5: Returns 404 when ADMIN_SECRET env var is completely unset");
    delete process.env.ADMIN_SECRET;
    const resNoSecret = await fetch(`${baseUrl}/admin/stats?key=anything`);
    assert.strictEqual(resNoSecret.status, 404);
    console.log("✓ Passed: Unconfigured ADMIN_SECRET returns 404");

  } finally {
    server.close();
  }

  console.log("\nALL ADMIN DASHBOARD TESTS PASSED ✓");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
