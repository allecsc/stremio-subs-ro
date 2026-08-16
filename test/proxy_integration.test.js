const assert = require("assert");
const AdmZip = require("adm-zip");
const express = require("express");
const http = require("http");
const { ARCHIVE_CACHE } = require("../lib/archiveCache");
const proxyRouter = require("../lib/proxy");
const SubsRoClient = require("../lib/subsro");

const MAX_PROXY_VTT_ENTRY_BYTES = 512 * 1024;

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

    console.log("Test 3: Proxy VTT cache retains a bounded amount of converted subtitle text");
    for (let index = 0; index < 20; index += 1) {
      proxyRouter.vttCache.set(`memory-track-${index}`, {
        vtt: "WEBVTT\n\n" + "x".repeat(MAX_PROXY_VTT_ENTRY_BYTES - 8),
      });
    }
    const vttStats = proxyRouter.vttCache.stats();
    assert(vttStats.retainedVttBytes <= vttStats.maxRetainedVttBytes);
    assert.notStrictEqual(proxyRouter.vttCache.get("memory-track-19"), null);
    assert.strictEqual(proxyRouter.vttCache.get("memory-track-0"), null);
    console.log("✓ Passed: Proxy VTT text stays within its independent memory budget");

    // 4. Oversized archive bridges retain only metadata; playback must still
    // download the selected track through the existing fallback path.
    console.log("Test 4: Proxy falls back to on-demand extraction when a cached archive has no VTT map");
    const fallbackSubId = "88888";
    const fallbackPath = "Large.Release.2026.ro.srt";
    const fallbackEncodedPath = Buffer.from(fallbackPath).toString("base64url");
    const fallbackSrt = "1\n00:00:01,000 --> 00:00:02,000\nFallback works\n";
    const zip = new AdmZip();
    zip.addFile(fallbackPath, Buffer.from(fallbackSrt, "utf8"));
    const archiveBuffer = zip.toBuffer();
    let downloadCount = 0;
    const originalDownloadArchive = SubsRoClient.prototype.downloadArchive;

    try {
      SubsRoClient.prototype.downloadArchive = async () => {
        downloadCount += 1;
        return archiveBuffer;
      };
      ARCHIVE_CACHE.set(`archive_${fallbackSubId}`, {
        srtFiles: [fallbackPath],
        archiveType: "zip",
      });

      const fallbackRes = await fetch(
        `${baseUrl}/testApiKey/proxy/${fallbackSubId}/${fallbackEncodedPath}/sub.vtt`,
      );
      assert.strictEqual(fallbackRes.status, 200);
      assert.strictEqual(await fallbackRes.text(), "WEBVTT\n\n" + fallbackSrt.replace(/,/g, "."));
      assert.strictEqual(downloadCount, 1);
      console.log("✓ Passed: Metadata-only cache falls back to a correct WebVTT stream");
    } finally {
      SubsRoClient.prototype.downloadArchive = originalDownloadArchive;
    }

  } finally {
    server.close();
  }

  console.log("\nALL PROXY INTEGRATION TESTS PASSED ✓");
}

runTests();
