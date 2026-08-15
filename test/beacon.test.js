const assert = require("assert");
const http = require("http");
const {
  formatBeaconSummary,
  sendDailyBeacon,
  calculateMsUntilMidnightUtc,
} = require("../lib/beacon");

async function runTests() {
  console.log("=== Running Daily Summary Beacon Tests ===");

  const sampleSnapshot = {
    date: "2026-08-16",
    uniqueActiveUsers: 342,
    totalRequests: 4810,
    searchRequests: 3200,
    proxyRequests: 1610,
    cacheHitRate: 94,
    avgSearchLatencyMs: 245,
    avgProxyLatencyMs: 6,
    matchTiers: { exact: 2100, highSync: 850, medSync: 200, lowSync: 40, fallback: 10 },
    archiveFormats: { zip: 1400, rar: 210 },
    upstreamErrors: { quota429: 2, invalid403: 0, networkErrors: 1 },
  };

  // Test 1: Message Formatting
  console.log("Test 1: Format human-readable beacon summary message");
  const message = formatBeaconSummary(sampleSnapshot);
  assert(message.includes("Subs.ro Addon"));
  assert(message.includes("2026-08-16"));
  assert(message.includes("342 active users"));
  assert(message.includes("4,810 total requests"));
  assert(message.includes("94% cache hit rate"));
  console.log("✓ Passed: Human-readable beacon summary formatted accurately");

  // Test 2: Successful Webhook POST delivery
  console.log("Test 2: Dispatch webhook payload to mock server");
  let receivedPayload = null;
  const mockServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      receivedPayload = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
  });

  await new Promise((resolve) => mockServer.listen(0, resolve));
  const port = mockServer.address().port;
  const webhookUrl = `http://localhost:${port}/webhook`;

  try {
    const success = await sendDailyBeacon(sampleSnapshot, webhookUrl);
    assert.strictEqual(success, true);
    assert(receivedPayload !== null);
    assert(receivedPayload.content || receivedPayload.text || receivedPayload.summary);
    console.log("✓ Passed: Webhook payload successfully received and acknowledged");

    // Test 3: Silent graceful handling when URL is empty
    console.log("Test 3: Gracefully skip when webhook URL is empty");
    const skipped = await sendDailyBeacon(sampleSnapshot, "");
    assert.strictEqual(skipped, false);
    console.log("✓ Passed: Empty webhook URL skipped silently");

    // Test 4: Graceful handling of unreachable webhook
    console.log("Test 4: Gracefully handle network failure on unreachable host");
    const failed = await sendDailyBeacon(sampleSnapshot, "http://localhost:99999/dead");
    assert.strictEqual(failed, false);
    console.log("✓ Passed: Network errors caught gracefully without throwing");

    // Test 5: Calculate ms until UTC midnight
    console.log("Test 5: Calculate positive milliseconds until next UTC midnight");
    const ms = calculateMsUntilMidnightUtc();
    assert(typeof ms === "number");
    assert(ms > 0);
    assert(ms <= 24 * 60 * 60 * 1000);
    console.log(`✓ Passed: Time until midnight UTC calculated: ${Math.round(ms / 60000)} minutes`);

  } finally {
    mockServer.close();
  }

  console.log("\nALL BEACON TESTS PASSED ✓");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
