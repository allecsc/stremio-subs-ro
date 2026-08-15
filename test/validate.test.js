const assert = require("assert");
const http = require("http");
const SubsRoClient = require("../lib/subsro");

// Create a local mock Subs.ro server
function createMockSubsRoServer() {
  return http.createServer((req, res) => {
    const apiKey = req.headers["x-subs-api-key"];

    if (req.url === "/v1.0/quota") {
      if (apiKey === "valid-key-123") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: 200,
            meta: { requestId: "req-123" },
            quota: {
              total_quota: 200,
              used_quota: 5,
              remaining_quota: 195,
              quota_type: "api_key",
            },
          })
        );
      } else if (apiKey === "quota-exceeded-key") {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: 429,
            meta: { requestId: "req-429" },
            message: "Daily quota exceeded",
          })
        );
      } else if (apiKey === "invalid-key") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: 403,
            meta: { requestId: "req-403" },
            message: "Invalid API key",
          })
        );
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Server error" }));
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

async function runTests() {
  console.log("=== Running Validation Tests ===");
  const server = createMockSubsRoServer();

  await new Promise((resolve) => server.listen(9876, resolve));
  const mockBaseUrl = "http://127.0.0.1:9876/v1.0";

  try {
    // Test 1: Valid Key
    console.log("Test 1: Valid API key returns valid: true and quota info");
    const validClient = new SubsRoClient("valid-key-123");
    validClient.baseUrl = mockBaseUrl;
    const validResult = await validClient.validate();
    assert.strictEqual(validResult.valid, true, "Expected valid to be true");
    assert.strictEqual(validResult.quota.remaining_quota, 195);
    assert.strictEqual(validResult.quota.total_quota, 200);
    console.log("✓ Passed: Valid key handled correctly");

    // Test 2: Invalid Key (403)
    console.log("Test 2: Invalid API key (403) returns valid: false and reason: invalid_key");
    const invalidClient = new SubsRoClient("invalid-key");
    invalidClient.baseUrl = mockBaseUrl;
    const invalidResult = await invalidClient.validate();
    assert.strictEqual(invalidResult.valid, false);
    assert.strictEqual(invalidResult.status, 403);
    assert.strictEqual(invalidResult.reason, "invalid_key");
    console.log("✓ Passed: Invalid key (403) identified accurately");

    // Test 3: Quota Exceeded (429)
    console.log("Test 3: Quota exceeded (429) returns valid: false and reason: quota_exceeded");
    const quotaClient = new SubsRoClient("quota-exceeded-key");
    quotaClient.baseUrl = mockBaseUrl;
    const quotaResult = await quotaClient.validate();
    assert.strictEqual(quotaResult.valid, false);
    assert.strictEqual(quotaResult.status, 429);
    assert.strictEqual(quotaResult.reason, "quota_exceeded");
    console.log("✓ Passed: Quota exceeded (429) distinguished from invalid key");

    // Test 4: Network Timeout / Error
    console.log("Test 4: Unreachable host returns reason: network_error");
    const deadClient = new SubsRoClient("valid-key-123");
    deadClient.baseUrl = "http://127.0.0.1:9999/v1.0"; // non-existent port
    const deadResult = await deadClient.validate();
    assert.strictEqual(deadResult.valid, false);
    assert.strictEqual(deadResult.reason, "network_error");
    console.log("✓ Passed: Network errors caught gracefully");

    // Test 5: Concurrency - Multiple parallel validations do not block each other
    console.log("Test 5: Concurrent validations run in parallel");
    const promises = [
      validClient.validate(),
      invalidClient.validate(),
      quotaClient.validate(),
    ];
    const results = await Promise.all(promises);
    assert.strictEqual(results[0].valid, true);
    assert.strictEqual(results[1].reason, "invalid_key");
    assert.strictEqual(results[2].reason, "quota_exceeded");
    console.log("✓ Passed: Concurrent validations handled properly");

    console.log("\nALL VALIDATION TESTS PASSED ✓");
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
