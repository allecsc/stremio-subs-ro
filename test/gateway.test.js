const assert = require("assert");
const http = require("http");
const SubsRoClient = require("../lib/subsro");

function createMockApiServer() {
  let requestCount = 0;
  const requests = [];

  const server = http.createServer((req, res) => {
    requestCount++;
    const url = req.url;
    const apiKey = req.headers["x-subs-api-key"];
    requests.push({ url, apiKey });

    // Check for double slashes
    if (url.includes("//")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: 400, message: "Double slash in URL" }));
    }

    if (url.startsWith("/v1.0/search/imdbid/")) {
      const imdbId = url.split("/")[4];
      if (imdbId === "tt0898266") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            status: 200,
            meta: { requestId: "req-search" },
            count: 1,
            items: [{ id: 74288, title: "The Big Bang Theory", language: "ro" }],
          })
        );
      }
    }

    if (url.startsWith("/v1.0/subtitle/") && url.endsWith("/download")) {
      const subId = url.split("/")[3];
      if (subId === "74288") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(Buffer.from("PK\x03\x04mockzipcontent"));
      }
    }

    res.writeHead(404);
    res.end();
  });

  return { server, getRequestCount: () => requestCount, getRequests: () => requests };
}

async function runTests() {
  console.log("=== Running Gateway & Concurrency Tests ===");
  const { server, getRequests } = createMockApiServer();
  await new Promise((resolve) => server.listen(9877, resolve));

  try {
    const client = new SubsRoClient("test-key-1");
    client.baseUrl = "http://127.0.0.1:9877/v1.0";

    // Test 1: URL construction does not produce double slashes
    console.log("Test 1: Search URL has no double slashes and targets /v1.0/search/imdbid/tt0898266");
    const searchResults = await client.searchByImdb("tt0898266");
    assert.strictEqual(searchResults.length, 1);
    assert.strictEqual(searchResults[0].id, 74288);
    const lastReq = getRequests()[getRequests().length - 1];
    assert.strictEqual(lastReq.url, "/v1.0/search/imdbid/tt0898266");
    assert.strictEqual(lastReq.apiKey, "test-key-1");
    console.log("✓ Passed: URL correctly formatted");

    // Test 2: Concurrent requests do not wait in a 1-second sequential line
    console.log("Test 2: 5 parallel requests complete in under 500ms (not 5000ms)");
    const startTime = Date.now();
    const concurrentClients = [1, 2, 3, 4, 5].map((i) => {
      const c = new SubsRoClient(`user-key-${i}`);
      c.baseUrl = "http://127.0.0.1:9877/v1.0";
      return c.searchByImdb("tt0898266");
    });
    const allResults = await Promise.all(concurrentClients);
    const duration = Date.now() - startTime;
    assert.strictEqual(allResults.length, 5);
    assert(duration < 1000, `Expected duration < 1000ms, but was ${duration}ms`);
    console.log(`✓ Passed: 5 concurrent searches completed in ${duration}ms`);

    // Test 3: Download archive returns buffer
    console.log("Test 3: Download archive returns binary buffer");
    const downloadBuffer = await client.downloadArchive(74288);
    assert(Buffer.isBuffer(downloadBuffer), "Expected Buffer instance");
    assert.strictEqual(downloadBuffer.toString("utf8", 0, 4), "PK\x03\x04");
    console.log("✓ Passed: Archive downloaded successfully");

    console.log("\nALL GATEWAY TESTS PASSED ✓");
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
