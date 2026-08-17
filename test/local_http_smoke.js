const assert = require("assert");
const AdmZip = require("adm-zip");
const http = require("http");
const { createApp } = require("../server");
const { createPipelineAcceptanceHarness, closeServer } = require("./helpers/pipelineAcceptanceHarness");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function runSmoke() {
  const capturedLogs = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  const capture = (...args) => {
    capturedLogs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
  };

  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;

  let harness;
  let addonServer;

  const SMOKE_API_KEY = "smoke-secret-key-8888";
  const SMOKE_CONFIG_OBJ = { apiKey: SMOKE_API_KEY };
  const SMOKE_CONFIG_STR = Buffer.from(JSON.stringify(SMOKE_CONFIG_OBJ)).toString("base64url");
  const SMOKE_FILENAME = "Smoke.Movie.2026.1080p.WEB-DL.mkv";
  const SMOKE_TRACK_NAME = "Smoke.Movie.2026.1080p.WEB-DL.srt";

  try {
    harness = await createPipelineAcceptanceHarness();
    const app = createApp();
    addonServer = http.createServer(app);
    await listen(addonServer);
    const baseUrl = `http://127.0.0.1:${addonServer.address().port}`;
    harness.setDeliveryBaseUrl(baseUrl);

    const zip = new AdmZip();
    zip.addFile(
      SMOKE_TRACK_NAME,
      Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nTest local controlat.\n"),
    );
    harness.setSearchResults([{ id: 880001, language: "ro", title: "Controlled smoke package" }]);
    harness.setArchive(880001, zip.toBuffer());

    // 1. Perform actual public Subtitle List request
    const extraEncoded = encodeURIComponent(JSON.stringify({ filename: SMOKE_FILENAME }));
    const listUrl = `${baseUrl}/${SMOKE_CONFIG_STR}/subtitles/movie/tt8800001/${extraEncoded}.json`;
    const listResponse = await fetch(listUrl);
    assert.strictEqual(listResponse.status, 200);
    const list = await listResponse.json();
    assert.strictEqual(list.subtitles.length, 1);

    // 2. Take the proxy URL returned by that real list response and fetch it
    const deliveryResponse = await fetch(list.subtitles[0].url);
    assert.strictEqual(deliveryResponse.status, 200);
    assert.strictEqual(deliveryResponse.headers.get("content-type"), "text/vtt; charset=utf-8");
    const body = await deliveryResponse.text();
    assert(body.startsWith("WEBVTT\n\n"));
    assert(body.includes("Test local controlat."));

    // 3. Assert exactly one controlled search and one controlled download
    assert.strictEqual(harness.countRequests("/v1.0/search/imdbid/tt8800001"), 1);
    assert.strictEqual(harness.countRequests("/v1.0/subtitle/880001/download"), 1);

  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;

    const cleanup = await Promise.allSettled([
      closeServer(addonServer),
      harness ? harness.close() : Promise.resolve(),
    ]);
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  // 4. Assert request logs are sanitized and contain none of the sentinel secrets/filenames
  const combinedLogs = capturedLogs.join("\n");
  for (const secret of [SMOKE_API_KEY, SMOKE_CONFIG_STR, SMOKE_FILENAME, SMOKE_TRACK_NAME, "880001", "tt8800001"]) {
    assert(!combinedLogs.includes(secret), `Smoke test logs leaked secret "${secret}"!\nLogs:\n${combinedLogs}`);
  }
  assert(combinedLogs.includes("GET /subtitles -> 200"), "Expected categorized /subtitles request log");
  assert(combinedLogs.includes("GET /proxy -> 200"), "Expected categorized /proxy request log");

  console.log("LOCAL HTTP SMOKE PASSED: list=200 tracks=1 delivery=200 upstream-searches=1 upstream-downloads=1 sanitized-logs=verified");
}

if (require.main === module) {
  runSmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runSmoke };
