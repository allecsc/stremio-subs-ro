const assert = require("assert");
const AdmZip = require("adm-zip");
const express = require("express");
const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const proxyRouter = require("../lib/proxy");
const { configureSubtitlePipeline, getSubtitlePipeline, resetSubtitlePipeline } = require("../lib/subtitlePipeline");

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function runTests() {
  console.log("=== Running Proxy End-to-End Integration Tests ===");

  let server;
  let cacheRoot;
  let primaryError;

  try {
    const app = express();
    app.use(proxyRouter);
    server = http.createServer(app);
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subsro-proxy-test-"));
    await listen(server);
    const port = server.address().port;
    const baseUrl = `http://localhost:${port}`;
    console.log("Test 1: Proxy prepares one ZIP on disk and serves WebVTT");
    const subId = "99999";
    const srtPath = "Movie.2024.Extended.1080p.srt";
    const sampleSrt = "1\n00:00:10,000 --> 00:00:12,000\nSalut, prietene! Aşteaptă puțin.\n";
    const zip = new AdmZip();
    zip.addFile(srtPath, Buffer.from(sampleSrt));
    let downloads = 0;
    configureSubtitlePipeline({
      cacheRoot,
      createClient: () => ({
        downloadArchiveToFile: async (_subId, destination) => {
          downloads += 1;
          await fs.writeFile(destination, zip.toBuffer(), { flag: "wx" });
        },
      }),
    });
    const [{ id: encodedSrtPath }] = await getSubtitlePipeline().getArchiveTracks("testApiKey", subId);

    const start = Date.now();
    const res = await fetch(`${baseUrl}/testApiKey/proxy/${subId}/${encodedSrtPath}/sub.vtt`);
    const duration = Date.now() - start;
    const body = await res.text();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "text/vtt; charset=utf-8");
    assert(body.startsWith("WEBVTT\n\n"));
    assert.strictEqual(downloads, 1);
    console.log(`✓ Passed: disk-backed WebVTT served in ${duration}ms with correct headers`);

    // 2. Diacritics verified in payload
    console.log("Test 2: Subtitle contains modern comma-below Romanian characters and is reused");
    assert(body.includes("Așteaptă"));
    assert(!body.includes("Aşteaptă"));
    const second = await fetch(`${baseUrl}/testApiKey/proxy/${subId}/${encodedSrtPath}/sub.vtt`);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(downloads, 1);
    console.log("✓ Passed: Comma-below characters present in stream output");

  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    resetSubtitlePipeline();
    const cleanup = await Promise.allSettled([
      cacheRoot ? fs.rm(cacheRoot, { recursive: true, force: true }) : Promise.resolve(),
      closeServer(server),
    ]);
    const cleanupErrors = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (cleanupErrors.length) {
      if (primaryError) throw new AggregateError([primaryError, ...cleanupErrors], "Proxy test failed and cleanup was incomplete", { cause: primaryError });
      throw new AggregateError(cleanupErrors, "Proxy test cleanup failed");
    }
  }

  console.log("\nALL PROXY INTEGRATION TESTS PASSED ✓");
}

runTests();
