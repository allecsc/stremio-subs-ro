const assert = require("assert");
const AdmZip = require("adm-zip");
const http = require("http");
const { createApp } = require("../server");
const { subtitlesHandler } = require("../addon");
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

function createZipWithUnreadableEntry(validTrackName, unreadableTrackName) {
  const zip = new AdmZip();
  zip.addFile(validTrackName, Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nValid track content.\n"));
  zip.addFile(unreadableTrackName, Buffer.from("invalid-compressed-payload-bytes"));
  const buffer = zip.toBuffer();

  const corruptZip = new AdmZip(buffer);
  const badEntry = corruptZip.getEntry(unreadableTrackName);
  if (badEntry) {
    badEntry.header.method = 8;
    badEntry.header.compressedSize = 10;
    badEntry.header.size = 100;
  }
  return corruptZip.toBuffer();
}

async function runLoggingPrivacyTests() {
  console.log("=== Running Logging Privacy & Sanitization Tests ===");

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
  let server;

  const SENTINEL_API_KEY = "SENTINEL_SECRET_API_KEY_7777";
  const SENTINEL_CONFIG_OBJ = { apiKey: SENTINEL_API_KEY, customSetting: "SENTINEL_SECRET_CONFIG" };
  const SENTINEL_CONFIG_STR = Buffer.from(JSON.stringify(SENTINEL_CONFIG_OBJ)).toString("base64url");
  const SENTINEL_TITLE = "SENTINEL_SECRET_MOVIE_TITLE_2026";
  const SENTINEL_VIDEO_FILENAME = "SENTINEL_SECRET_VIDEO_FILENAME_1080p.mkv";
  const SENTINEL_ARCHIVE_TRACK = "SENTINEL_SECRET_ARCHIVE_TRACK_RELEASE.srt";
  const SENTINEL_UNREADABLE_TRACK = "SENTINEL_SECRET_UNREADABLE_CORRUPT_TRACK.srt";
  const SENTINEL_IP = "198.51.100.42";
  const SENTINEL_QUERY = "secret_query_param=SENTINEL_SECRET_VALUE";

  const SENTINEL_NESTED_CONFIG_KEY = "SENTINEL_NESTED_CONFIG_KEY_1234";
  const SENTINEL_NESTED_HEADER_KEY = "SENTINEL_NESTED_HEADER_KEY_5678";
  const SENTINEL_NESTED_RESPONSE_KEY = "SENTINEL_NESTED_RESPONSE_KEY_9012";

  try {
    harness = await createPipelineAcceptanceHarness();
    const app = createApp();
    server = http.createServer(app);
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    harness.setDeliveryBaseUrl(baseUrl);

    // 1. Prepare valid zip archive with sensitive track name
    const zip = new AdmZip();
    zip.addFile(SENTINEL_ARCHIVE_TRACK, Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nPrivacy verified.\n"));
    harness.setSearchResults([{ id: 990001, language: "ro", title: SENTINEL_TITLE }]);
    harness.setArchive(990001, zip.toBuffer());

    // 2. Perform Subtitle List request on public route
    const listUrl = `${baseUrl}/${SENTINEL_CONFIG_STR}/subtitles/movie/tt9900001/${encodeURIComponent(JSON.stringify({ filename: SENTINEL_VIDEO_FILENAME }))}.json?${SENTINEL_QUERY}`;
    const listRes = await fetch(listUrl, {
      headers: { "x-forwarded-for": SENTINEL_IP },
    });
    assert.strictEqual(listRes.status, 200);
    const listBody = await listRes.json();
    assert.strictEqual(listBody.subtitles.length, 1);

    // 3. Perform Subtitle Delivery request on real proxy route
    const deliveryUrl = `${listBody.subtitles[0].url}?${SENTINEL_QUERY}`;
    const deliveryRes = await fetch(deliveryUrl, {
      headers: { "x-forwarded-for": SENTINEL_IP },
    });
    assert.strictEqual(deliveryRes.status, 200);
    const deliveryBody = await deliveryRes.text();
    assert(deliveryBody.startsWith("WEBVTT\n\n"));

    // 4. Perform Validate request
    const validateRes = await fetch(`${baseUrl}/api/validate/${SENTINEL_API_KEY}`);
    assert.strictEqual(validateRes.status, 200);

    // 5. Genuinely exercise the unreadable archive-member warning path
    const unreadableZipBuffer = createZipWithUnreadableEntry("Readable.Track.1080p.srt", SENTINEL_UNREADABLE_TRACK);
    harness.setSearchResults([{ id: 990002, language: "ro", title: "Partial Unreadable Archive Package" }]);
    harness.setArchive(990002, unreadableZipBuffer);
    const unreadableListUrl = `${baseUrl}/${SENTINEL_CONFIG_STR}/subtitles/movie/tt9900002/${encodeURIComponent(JSON.stringify({ filename: SENTINEL_VIDEO_FILENAME }))}.json`;
    const unreadableListRes = await fetch(unreadableListUrl);
    assert.strictEqual(unreadableListRes.status, 200);
    const unreadableListBody = await unreadableListRes.json();
    assert.strictEqual(unreadableListBody.subtitles.length, 1);

    // 6. Force outer subtitlesHandler catch block to receive an Error with nested enumerable secret properties
    const errorWithNestedSecrets = new Error("Simulated upstream failure with nested secrets");
    errorWithNestedSecrets.config = {
      url: `https://api.subs.ro/v1.0/search?secret=${SENTINEL_NESTED_CONFIG_KEY}`,
      headers: { Authorization: `Bearer ${SENTINEL_NESTED_HEADER_KEY}` },
    };
    errorWithNestedSecrets.response = {
      status: 502,
      data: { secretPayload: SENTINEL_NESTED_RESPONSE_KEY },
    };

    const { getSubtitlePipeline } = require("../lib/subtitlePipeline");
    const originalClient = getSubtitlePipeline().getClient(SENTINEL_API_KEY);
    const originalSearch = originalClient.searchByImdb;
    originalClient.searchByImdb = async () => { throw errorWithNestedSecrets; };

    try {
      const errorListRes = await subtitlesHandler({
        type: "movie",
        id: "tt9900003",
        extra: { filename: SENTINEL_VIDEO_FILENAME },
        config: { apiKey: SENTINEL_API_KEY, baseUrl },
      });
      assert.deepStrictEqual(errorListRes.subtitles, []);
    } finally {
      originalClient.searchByImdb = originalSearch;
    }

  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;

    const cleanup = await Promise.allSettled([
      closeServer(server),
      harness ? harness.close() : Promise.resolve(),
    ]);
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  assert(capturedLogs.length > 0, "Expected production logs to be captured");

  const combinedLogs = capturedLogs.join("\n");

  const sentinels = [
    SENTINEL_API_KEY,
    SENTINEL_CONFIG_STR,
    SENTINEL_TITLE,
    SENTINEL_VIDEO_FILENAME,
    SENTINEL_ARCHIVE_TRACK,
    SENTINEL_UNREADABLE_TRACK,
    SENTINEL_IP,
    "SENTINEL_SECRET_VALUE",
    SENTINEL_NESTED_CONFIG_KEY,
    SENTINEL_NESTED_HEADER_KEY,
    SENTINEL_NESTED_RESPONSE_KEY,
  ];

  for (const sentinel of sentinels) {
    assert(
      !combinedLogs.includes(sentinel),
      `Privacy violation: Sentinel "${sentinel}" was leaked in production logs!\nCaptured logs:\n${combinedLogs}`,
    );
  }

  assert(combinedLogs.includes("GET /subtitles -> 200"), "Expected categorized /subtitles log");
  assert(combinedLogs.includes("GET /proxy -> 200"), "Expected categorized /proxy log");
  assert(combinedLogs.includes("GET /validate -> 200"), "Expected categorized /validate log");
  assert(combinedLogs.includes("[MATCH] Evaluated"), "Expected safe match count log");
  assert(combinedLogs.includes("[SUBS] Skipped unreadable ZIP track:"), "Expected unreadable track warning without member path");
  assert(combinedLogs.includes("[SUBS] Error processing request (UPSTREAM_SERVER_ERROR):"), "Expected safe error classification log without serialized error object");

  console.log("✓ All sensitive sentinels (API keys, config, filenames, track names, IPs, query data, nested error properties) are absent from logs");
  console.log("✓ Unreadable archive member warning path was genuinely exercised without leaking the track filename");
  console.log("✓ Outer catch block handled complex error object without leaking nested config/headers/response properties");
  console.log("ALL LOGGING PRIVACY TESTS PASSED ✓");
}

if (require.main === module) {
  runLoggingPrivacyTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runLoggingPrivacyTests };
