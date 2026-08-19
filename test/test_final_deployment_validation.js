const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const AdmZip = require("adm-zip");
const unrar = require("node-unrar-js");

const { subtitlesHandler, PENDING_PACKAGES, PENDING_REQUESTS, CACHE } = require("../addon");
const proxyRouter = require("../lib/proxy");
const { ARCHIVE_CACHE, STAGING_DIR } = require("../lib/archiveCache");
const { limiterManager, getLimiter } = require("../lib/rateLimiter");

const CAPTURED_RAR_PATH = path.join(__dirname, "..", ".scratch", "local-runtime-probe", "final-deployment-validation", "captured-package.bin");
const CAPTURED_RAR = fs.readFileSync(CAPTURED_RAR_PATH);

process.setMaxListeners(50);

const logLines = [];
function log(msg = "") {
  console.log(msg);
  logLines.push(msg);
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

async function runTestA_100ColdUsers() {
  log("================================================================================");
  log("TEST A: 100 INDEPENDENT COLD USERS");
  log("================================================================================");

  CACHE.clear();
  ARCHIVE_CACHE.clear();
  PENDING_PACKAGES.clear();
  PENDING_REQUESTS.clear();

  let totalSearches = 0;
  let totalDownloads = 0;
  let peakGlobalDownloads = 0;
  let peakPerUserDownloads = 0;

  const fakeServer = http.createServer(async (req, res) => {
    if (req.url.includes("/search/")) {
      totalSearches++;
      const userMatch = req.headers["x-subs-api-key"] || "user_0";
      const uId = parseInt(userMatch.replace(/\D/g, "") || "0", 10);
      const pkg1 = 10000 + uId * 2;
      const pkg2 = 10000 + uId * 2 + 1;

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          items: [
            { id: pkg1, language: "ro", title: `Cold Show S01 Pkg ${pkg1}`, translator: "Retail" },
            { id: pkg2, language: "ro", title: `Cold Show S01 Pkg ${pkg2}`, translator: "Retail" },
          ],
        })
      );
    }

    if (req.url.includes("/download")) {
      totalDownloads++;
      const userKey = req.headers["x-subs-api-key"] || "anon";
      const limiter = getLimiter(userKey);
      const userActive = limiter.queues.download.activeCount;
      if (userActive > peakPerUserDownloads) peakPerUserDownloads = userActive;

      const gActive = limiterManager.globalActiveDownloads;
      if (gActive > peakGlobalDownloads) peakGlobalDownloads = gActive;

      res.writeHead(200, {
        "Content-Type": "application/x-rar-compressed",
        "Content-Length": CAPTURED_RAR.length,
      });

      // Stream with realistic chunks
      const chunkSize = 8192;
      let offset = 0;
      const interval = setInterval(() => {
        if (offset < CAPTURED_RAR.length) {
          const chunk = CAPTURED_RAR.slice(offset, offset + chunkSize);
          res.write(chunk);
          offset += chunkSize;
        } else {
          clearInterval(interval);
          res.end();
        }
      }, 5);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  const serverPort = await new Promise((res) => {
    fakeServer.listen(0, () => res(fakeServer.address().port));
  });

  const origAxiosGet = axios.get;
  axios.get = async function (url, config = {}) {
    const parsed = new URL(url);
    parsed.protocol = "http:";
    parsed.hostname = "127.0.0.1";
    parsed.port = serverPort;
    return origAxiosGet.call(this, parsed.toString(), config);
  };

  const initialCpu = process.cpuUsage();
  const initialMem = process.memoryUsage();
  const startTime = Date.now();

  const NUM_USERS = 100;
  const userLatencies = [];
  let successes = 0;
  let failures = 0;
  let timeouts = 0;

  const userPromises = Array.from({ length: NUM_USERS }, async (_, i) => {
    const userApiKey = `usr_${String(i).padStart(3, "0")}_${Math.random().toString(36).slice(2, 6)}`;
    const mediaId = `tt${String(9000000 + i)}:1:1`;
    const t0 = Date.now();

    try {
      const resp = await subtitlesHandler({
        type: "series",
        id: mediaId,
        extra: { filename: `Cold.Show.S01E01.1080p.mkv` },
        config: { apiKey: userApiKey, baseUrl: "http://127.0.0.1:7000" },
      });

      const lat = Date.now() - t0;
      userLatencies.push(lat);

      if (resp && resp.subtitles && resp.subtitles.length > 0) {
        successes++;
      } else {
        failures++;
      }
    } catch (err) {
      const lat = Date.now() - t0;
      userLatencies.push(lat);
      if (err.message && err.message.includes("timeout")) {
        timeouts++;
      } else {
        failures++;
      }
    }
  });

  await Promise.all(userPromises);

  const totalElapsed = Date.now() - startTime;
  const finalCpu = process.cpuUsage(initialCpu);
  const finalMem = process.memoryUsage();

  axios.get = origAxiosGet;
  await new Promise((res) => fakeServer.close(res));

  const p50 = percentile(userLatencies, 50);
  const p95 = percentile(userLatencies, 95);
  const slowest = Math.max(...userLatencies);

  log(`  Total Users:               ${NUM_USERS}`);
  log(`  Successes:                 ${successes} / ${NUM_USERS} (Expected: 100)`);
  log(`  Failures:                  ${failures} (Expected: 0)`);
  log(`  Timeouts:                  ${timeouts} (Expected: 0)`);
  log(`  Total Searches:            ${totalSearches}`);
  log(`  Total Package Downloads:   ${totalDownloads}`);
  log(`  Latency p50:               ${p50} ms`);
  log(`  Latency p95:               ${p95} ms`);
  log(`  Slowest / LAST:            ${slowest} ms (Total Elapsed: ${totalElapsed} ms)`);
  log(`  Peak Per-User Active:      ${peakPerUserDownloads} (Max Allowed: 3)`);
  log(`  Peak Global Active:        ${peakGlobalDownloads}`);
  log(`  CPU Usage (user/system):   ${(finalCpu.user / 1000).toFixed(1)} ms / ${(finalCpu.system / 1000).toFixed(1)} ms`);
  log(`  RAM Usage:                 Heap ${(finalMem.heapUsed / 1024 / 1024).toFixed(2)} MB (Delta: ${((finalMem.heapUsed - initialMem.heapUsed) / 1024 / 1024).toFixed(2)} MB)`);
  log(`  PENDING_PACKAGES end:      ${PENDING_PACKAGES.size} (Expected: 0)`);
  log(`  PENDING_REQUESTS end:      ${PENDING_REQUESTS.size} (Expected: 0)`);
  log(`  globalActiveDownloads end: ${limiterManager.globalActiveDownloads} (Expected: 0)`);
  log(`  Fully Drained:             ${PENDING_PACKAGES.size === 0 && PENDING_REQUESTS.size === 0 && limiterManager.globalActiveDownloads === 0 ? "YES" : "NO"}`);

  if (
    successes === 100 &&
    failures === 0 &&
    timeouts === 0 &&
    peakPerUserDownloads <= 3 &&
    PENDING_PACKAGES.size === 0 &&
    PENDING_REQUESTS.size === 0 &&
    limiterManager.globalActiveDownloads === 0
  ) {
    log(">>> TEST A PASSED!\n");
    return true;
  } else {
    log(">>> TEST A FAILED!\n");
    return false;
  }
}

async function runTestB_100UsersSharedContent() {
  log("================================================================================");
  log("TEST B: 100 USERS, SHARED POPULAR CONTENT (11 SHARED PACKAGES)");
  log("================================================================================");

  CACHE.clear();
  ARCHIVE_CACHE.clear();
  PENDING_PACKAGES.clear();
  PENDING_REQUESTS.clear();

  let totalSearches = 0;
  let totalDownloads = 0;

  const sharedPackages = Array.from({ length: 11 }, (_, i) => ({
    id: 50000 + i,
    language: "ro",
    title: `Popular Movie S01 Pkg ${50000 + i}`,
    translator: "Retail",
  }));

  const fakeServer = http.createServer(async (req, res) => {
    if (req.url.includes("/search/")) {
      totalSearches++;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ items: sharedPackages }));
    }

    if (req.url.includes("/download")) {
      totalDownloads++;
      res.writeHead(200, {
        "Content-Type": "application/x-rar-compressed",
        "Content-Length": CAPTURED_RAR.length,
      });

      const chunkSize = 8192;
      let offset = 0;
      const interval = setInterval(() => {
        if (offset < CAPTURED_RAR.length) {
          const chunk = CAPTURED_RAR.slice(offset, offset + chunkSize);
          res.write(chunk);
          offset += chunkSize;
        } else {
          clearInterval(interval);
          res.end();
        }
      }, 5);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  const serverPort = await new Promise((res) => {
    fakeServer.listen(0, () => res(fakeServer.address().port));
  });

  const origAxiosGet = axios.get;
  axios.get = async function (url, config = {}) {
    const parsed = new URL(url);
    parsed.protocol = "http:";
    parsed.hostname = "127.0.0.1";
    parsed.port = serverPort;
    return origAxiosGet.call(this, parsed.toString(), config);
  };

  const initialCpu = process.cpuUsage();
  const startTime = Date.now();

  const NUM_USERS = 100;
  const userLatencies = [];
  let successes = 0;
  let failures = 0;
  let wrongUserUrls = 0;

  const userPromises = Array.from({ length: NUM_USERS }, async (_, i) => {
    const userApiKey = `shared_usr_${String(i).padStart(3, "0")}`;
    const mediaId = `tt0903747:1:1`; // Breaking Bad S01E01
    const t0 = Date.now();

    try {
      const resp = await subtitlesHandler({
        type: "series",
        id: mediaId,
        extra: { filename: `Breaking.Bad.S01E01.720p.BluRay.x264-DEMAND.mkv` },
        config: { apiKey: userApiKey, baseUrl: "http://127.0.0.1:7000" },
      });

      const lat = Date.now() - t0;
      userLatencies.push(lat);

      if (resp && resp.subtitles && resp.subtitles.length > 0) {
        successes++;
        for (const sub of resp.subtitles) {
          if (!sub.url.includes(`/${userApiKey}/proxy/`)) {
            wrongUserUrls++;
          }
        }
      } else {
        failures++;
      }
    } catch (err) {
      const lat = Date.now() - t0;
      userLatencies.push(lat);
      failures++;
    }
  });

  await Promise.all(userPromises);

  const totalElapsed = Date.now() - startTime;
  const finalCpu = process.cpuUsage(initialCpu);
  const finalMem = process.memoryUsage();

  axios.get = origAxiosGet;
  await new Promise((res) => fakeServer.close(res));

  const p50 = percentile(userLatencies, 50);
  const p95 = percentile(userLatencies, 95);
  const slowest = Math.max(...userLatencies);

  log(`  Total Users:               ${NUM_USERS}`);
  log(`  Successes:                 ${successes} / ${NUM_USERS} (Expected: 100)`);
  log(`  Failures:                  ${failures} (Expected: 0)`);
  log(`  Total Searches:            ${totalSearches} (Expected: 100)`);
  log(`  Package Downloads:         ${totalDownloads} (Expected: exactly 11)`);
  log(`  Wrong-User Proxy URLs:     ${wrongUserUrls} (Expected: 0)`);
  log(`  Latency p50:               ${p50} ms`);
  log(`  Latency p95:               ${p95} ms`);
  log(`  Slowest / LAST:            ${slowest} ms (Total Elapsed: ${totalElapsed} ms)`);
  log(`  CPU Usage (user/system):   ${(finalCpu.user / 1000).toFixed(1)} ms / ${(finalCpu.system / 1000).toFixed(1)} ms`);
  log(`  RAM Usage:                 Heap ${(finalMem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  log(`  PENDING_PACKAGES end:      ${PENDING_PACKAGES.size} (Expected: 0)`);
  log(`  PENDING_REQUESTS end:      ${PENDING_REQUESTS.size} (Expected: 0)`);
  log(`  globalActiveDownloads end: ${limiterManager.globalActiveDownloads} (Expected: 0)`);
  log(`  Fully Drained:             ${PENDING_PACKAGES.size === 0 && PENDING_REQUESTS.size === 0 && limiterManager.globalActiveDownloads === 0 ? "YES" : "NO"}`);

  if (
    successes === 100 &&
    failures === 0 &&
    totalSearches === 100 &&
    totalDownloads === 11 &&
    wrongUserUrls === 0 &&
    PENDING_PACKAGES.size === 0 &&
    PENDING_REQUESTS.size === 0 &&
    limiterManager.globalActiveDownloads === 0
  ) {
    log(">>> TEST B PASSED!\n");
    return true;
  } else {
    log(">>> TEST B FAILED!\n");
    return false;
  }
}

async function runTestC_DeliveryRegression() {
  log("================================================================================");
  log("TEST C: DELIVERY REGRESSION (ZIP AND RAR WEBVTT PROXY DELIVERY)");
  log("================================================================================");

  const app = express();
  app.use(cors());
  app.use(proxyRouter);

  const server = app.listen(0);
  const port = server.address().port;

  const testZip = new AdmZip();
  const sampleSrt = "1\n00:00:01,000 --> 00:00:04,000\nSalutare tuturor!";
  testZip.addFile("Show.S01E01.720p.srt", Buffer.from(sampleSrt, "utf-8"));
  const zipBuffer = testZip.toBuffer();

  const fakeApi = http.createServer((req, res) => {
    if (req.url.includes("/1111/download")) {
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": zipBuffer.length });
      return res.end(zipBuffer);
    }
    if (req.url.includes("/2222/download")) {
      res.writeHead(200, { "Content-Type": "application/x-rar-compressed", "Content-Length": CAPTURED_RAR.length });
      return res.end(CAPTURED_RAR);
    }
    res.writeHead(404);
    res.end();
  });

  const apiPort = await new Promise((res) => fakeApi.listen(0, () => res(fakeApi.address().port)));

  const origAxiosGet = axios.get;
  axios.get = async function (url, config = {}) {
    const parsed = new URL(url);
    parsed.protocol = "http:";
    parsed.hostname = "127.0.0.1";
    parsed.port = apiPort;
    return origAxiosGet.call(this, parsed.toString(), config);
  };

  const get = (urlPath) =>
    new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
    });

  let zipPass = false;
  let rarPass = false;

  try {
    const zipSrtEncoded = Buffer.from("Show.S01E01.720p.srt").toString("base64url");
    const zipResp = await get(`/usr_zip/proxy/1111/${zipSrtEncoded}/sub.vtt?apiKey=usr_zip`);

    log(`  ZIP Delivery HTTP Status:   ${zipResp.status} (Expected: 200)`);
    log(`  ZIP Content-Type:           ${zipResp.headers["content-type"]} (Expected: text/vtt; charset=utf-8)`);
    log(`  ZIP WebVTT valid:           ${zipResp.body.startsWith("WEBVTT") && zipResp.body.includes("Salutare tuturor!")}`);

    if (
      zipResp.status === 200 &&
      zipResp.headers["content-type"] === "text/vtt; charset=utf-8" &&
      zipResp.body.startsWith("WEBVTT") &&
      zipResp.body.includes("Salutare tuturor!")
    ) {
      zipPass = true;
    }

    const rarSrtName = "Breaking.Bad.S01E01.720p.BluRay.x264.DTS-SYLER.srt";
    const rarSrtEncoded = Buffer.from(rarSrtName).toString("base64url");
    const rarResp = await get(`/usr_rar/proxy/2222/${rarSrtEncoded}/sub.vtt?apiKey=usr_rar`);

    log(`  RAR Delivery HTTP Status:   ${rarResp.status} (Expected: 200)`);
    log(`  RAR Content-Type:           ${rarResp.headers["content-type"]} (Expected: text/vtt; charset=utf-8)`);
    log(`  RAR WebVTT valid:           ${rarResp.body.startsWith("WEBVTT")}`);

    if (
      rarResp.status === 200 &&
      rarResp.headers["content-type"] === "text/vtt; charset=utf-8" &&
      rarResp.body.startsWith("WEBVTT")
    ) {
      rarPass = true;
    }
  } finally {
    axios.get = origAxiosGet;
    server.close();
    fakeApi.close();
  }

  if (zipPass && rarPass) {
    log(">>> TEST C PASSED!\n");
    return true;
  } else {
    log(">>> TEST C FAILED!\n");
    return false;
  }
}

async function runFinalDeploymentValidation() {
  log("================================================================================");
  log("FINAL DEPLOYMENT READINESS VALIDATION SUITE (PRODUCTION ROOT)");
  log("================================================================================\n");

  const passA = await runTestA_100ColdUsers();
  const passB = await runTestB_100UsersSharedContent();
  const passC = await runTestC_DeliveryRegression();

  log("================================================================================");
  log("FINAL VALIDATION SUMMARY:");
  log(`  TEST A (100 Cold Users):       ${passA ? "PASS" : "FAIL"}`);
  log(`  TEST B (100 Shared Content):   ${passB ? "PASS" : "FAIL"}`);
  log(`  TEST C (Delivery Regression):   ${passC ? "PASS" : "FAIL"}`);
  log("================================================================================");

  if (passA && passB && passC) {
    log("ALL TESTS COMPLETED SUCCESSFULLY!");
    log("================================================================================");
    process.exit(0);
  } else {
    log("SOME TESTS FAILED!");
    log("================================================================================");
    process.exit(1);
  }
}

runFinalDeploymentValidation().catch((err) => {
  console.error("FATAL ERROR IN VALIDATION SUITE:", err);
  process.exit(1);
});
