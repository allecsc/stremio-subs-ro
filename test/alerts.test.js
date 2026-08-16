const assert = require("assert");
const http = require("http");
const {
  sendDiscordAlert,
  notifyServerOnline,
  notifyServerShutdown,
  notifyFatalCrash,
  notifyUpstreamOutage,
} = require("../lib/alerts");

async function runTests() {
  console.log("=== Running Server Alerts & Downtime Alarms Tests ===");

  let receivedAlert = null;
  const mockServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      receivedAlert = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
  });

  await new Promise((resolve) => mockServer.listen(0, resolve));
  const port = mockServer.address().port;
  process.env.STATS_WEBHOOK_URL = `http://localhost:${port}/webhook`;

  try {
    // Test 1: Online notification
    console.log("Test 1: Notify server online alert");
    const onlineSent = await notifyServerOnline(7000);
    assert.strictEqual(onlineSent, true);
    assert(/Online/i.test(receivedAlert.embeds[0].title));
    console.log("✓ Passed: Server online alert dispatched");

    // Test 2: Fatal crash notification with stack trace
    console.log("Test 2: Notify fatal crash with stack trace");
    const fakeError = new Error("Simulated memory allocation failure");
    const crashSent = await notifyFatalCrash(fakeError);
    assert.strictEqual(crashSent, true);
    assert(receivedAlert.embeds[0].title.includes("FATAL CRASH"));
    assert(receivedAlert.embeds[0].description.includes("Simulated memory allocation failure"));
    console.log("✓ Passed: Fatal crash stack trace alert dispatched");

    // Test 3: Shutdown notification
    console.log("Test 3: Notify server graceful shutdown");
    const shutdownSent = await notifyServerShutdown("SIGTERM");
    assert.strictEqual(shutdownSent, true);
    assert(receivedAlert.embeds[0].title.includes("Restarting"));
    console.log("✓ Passed: Server shutdown alert dispatched");

    // Test 4: Upstream outage notification & cooldown throttling
    console.log("Test 4: Upstream outage notification and spam throttling");
    const outageSent1 = await notifyUpstreamOutage("ECONNRESET", "Subs.ro API timeout");
    assert.strictEqual(outageSent1, true);
    assert(receivedAlert.embeds[0].title.includes("Upstream"));

    // Second immediate attempt should be throttled
    const outageSent2 = await notifyUpstreamOutage("ECONNRESET", "Subs.ro API timeout");
    assert.strictEqual(outageSent2, false, "Consecutive outage alert within cooldown must be throttled");
    console.log("✓ Passed: Upstream outage alert dispatched and throttled");

  } finally {
    mockServer.close();
  }

  console.log("\nALL ALERTS TESTS PASSED ✓");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
