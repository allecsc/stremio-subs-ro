const assert = require("assert");
const AdmZip = require("adm-zip");
const express = require("express");
const http = require("http");
const { ARCHIVE_CACHE } = require("../lib/archiveCache");
const proxyRouter = require("../lib/proxy");

async function runTests() {
  console.log("=== Running Proxy End-to-End Integration Tests ===");

  const app = express();
  app.use(proxyRouter);
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. Populate ARCHIVE_CACHE with pre-converted VTT Map (simulating search step)
    console.log("Test 1: Proxy serves pre-converted WebVTT from 60s memory bridge in 0ms");
    const subId = "99999";
    const srtPath = "Movie.2024.Extended.1080p.srt";
    const encodedSrtPath = Buffer.from(srtPath).toString("base64url");
    const sampleVtt = "WEBVTT\n\n1\n00:00:10.000 --> 00:00:12.000\nSalut, prietene! Așteaptă puțin.\n";

    const vttMap = new Map();
    vttMap.set(srtPath, sampleVtt);

    ARCHIVE_CACHE.set(`archive_${subId}`, {
      vttMap,
      srtFiles: [srtPath],
      archiveType: "zip",
      timestamp: Date.now(),
    });

    const start = Date.now();
    const res = await fetch(`${baseUrl}/testApiKey/proxy/${subId}/${encodedSrtPath}/sub.vtt`);
    const duration = Date.now() - start;
    const body = await res.text();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "text/vtt; charset=utf-8");
    assert.strictEqual(body, sampleVtt);
    assert(duration < 50, `Proxy served cached VTT in ${duration}ms, must be < 50ms`);
    console.log(`✓ Passed: Pre-converted VTT served in ${duration}ms with correct headers`);

    // 2. Diacritics verified in payload
    console.log("Test 2: Subtitle contains modern comma-below Romanian characters");
    assert(body.includes("Așteaptă"));
    assert(!body.includes("Aşteaptă"));
    console.log("✓ Passed: Comma-below characters present in stream output");

  } finally {
    server.close();
  }

  console.log("\nALL PROXY INTEGRATION TESTS PASSED ✓");
}

runTests();
