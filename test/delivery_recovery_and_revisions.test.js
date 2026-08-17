const assert = require("assert");
const AdmZip = require("adm-zip");
const express = require("express");
const fs = require("fs/promises");
const http = require("http");
const path = require("path");
const { subtitlesHandler } = require("../addon");
const proxyRouter = require("../lib/proxy");
const { createPipelineAcceptanceHarness, closeServer } = require("./helpers/pipelineAcceptanceHarness");

function makeZip(entries) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function createEnvironment(options = {}) {
  const harness = await createPipelineAcceptanceHarness(options);
  const app = express();
  app.use(proxyRouter);
  const server = http.createServer(app);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const pipeline = harness.setDeliveryBaseUrl(baseUrl);
  await pipeline.ready;
  return { harness, server, baseUrl };
}

async function closeEnvironment(environment, primaryError) {
  const results = await Promise.allSettled([
    closeServer(environment?.server),
    environment?.harness ? environment.harness.close() : Promise.resolve(),
  ]);
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (primaryError && errors.length) {
    throw new AggregateError([primaryError, ...errors], "I-07 acceptance failed and cleanup was incomplete", { cause: primaryError });
  }
  if (primaryError) throw primaryError;
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "I-07 acceptance cleanup was incomplete");
}

function listRequest({ baseUrl, apiKey, imdbId, packageId, updatedAt, filename = "Movie.1080p.mkv" }, harness) {
  harness.setSearchResults([{
    id: packageId,
    language: "ro",
    title: "Movie",
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }]);
  return subtitlesHandler({
    type: "movie",
    id: imdbId,
    extra: { filename },
    config: { apiKey, baseUrl },
  });
}

function trackIdFromUrl(url) {
  return new URL(url).pathname.split("/")[4];
}

async function manifestFor(harness, packageId) {
  return JSON.parse(await fs.readFile(path.join(harness.cacheRoot, "ready", String(packageId), "manifest.json"), "utf8"));
}

async function testRevisionInvalidation() {
  const environment = await createEnvironment();
  const { harness, baseUrl } = environment;
  let primaryError;
  try {
    const packageId = 710001;
    const trackName = "Movie.1080p.srt";
    const firstRevision = "2026-01-01T00:00:00.000Z";
    const laterRevision = "2026-02-01T00:00:00.000Z";
    harness.setArchive(packageId, makeZip({ [trackName]: "1\n00:00:01,000 --> 00:00:02,000\nfirst revision\n" }));
    const first = await listRequest({ baseUrl, apiKey: "revision-one", imdbId: "tt7100001", packageId, updatedAt: firstRevision }, harness);
    assert.strictEqual(first.subtitles.length, 1);
    const firstTrackId = trackIdFromUrl(first.subtitles[0].url);
    let manifest = await manifestFor(harness, packageId);
    assert.strictEqual(manifest.updatedAt, firstRevision);
    assert.strictEqual(manifest.tracks[0].id, firstTrackId);
    assert.strictEqual(Object.hasOwn(manifest, "matchScore"), false);
    assert.strictEqual(Object.hasOwn(manifest.tracks[0], "matchScore"), false);

    harness.setArchive(packageId, makeZip({ [trackName]: "1\n00:00:01,000 --> 00:00:02,000\nmissing timestamp must reuse\n" }));
    const withoutRevision = await listRequest({ baseUrl, apiKey: "revision-missing", imdbId: "tt7100001", packageId }, harness);
    assert.strictEqual(trackIdFromUrl(withoutRevision.subtitles[0].url), firstTrackId);
    assert.strictEqual(harness.countRequests(`/v1.0/subtitle/${packageId}/download`), 1);

    harness.setArchive(packageId, makeZip({ [trackName]: "1\n00:00:01,000 --> 00:00:02,000\nlater revision\n" }));
    const revised = await listRequest({ baseUrl, apiKey: "revision-two", imdbId: "tt7100001", packageId, updatedAt: laterRevision }, harness);
    assert.strictEqual(revised.subtitles.length, 1);
    assert.strictEqual(trackIdFromUrl(revised.subtitles[0].url), firstTrackId);
    assert.strictEqual(harness.countRequests(`/v1.0/subtitle/${packageId}/download`), 2);
    manifest = await manifestFor(harness, packageId);
    assert.strictEqual(manifest.updatedAt, laterRevision);
    const delivered = await fetch(first.subtitles[0].url);
    const deliveredBody = await delivered.text();
    assert.strictEqual(delivered.status, 200, deliveredBody);
    assert(deliveredBody.includes("later revision"));
  } catch (error) {
    primaryError = error;
  }
  await closeEnvironment(environment, primaryError);
}

async function testAbsentAndObsoleteDeliveryRecovery() {
  const environment = await createEnvironment();
  const { harness, baseUrl } = environment;
  let primaryError;
  try {
    const packageId = 710002;
    const requestedTrack = "Movie.Exact.1080p.srt";
    harness.setArchive(packageId, makeZip({
      [requestedTrack]: "1\n00:00:01,000 --> 00:00:02,000\nexact recovered track\n",
      "Movie.Other.720p.srt": "1\n00:00:01,000 --> 00:00:02,000\nother track\n",
    }));
    const listed = await listRequest({ baseUrl, apiKey: "absent-list", imdbId: "tt7100002", packageId }, harness);
    const requestedUrl = listed.subtitles.find((subtitle) => subtitle.id.includes(String(packageId))).url;
    const requestedTrackId = trackIdFromUrl(requestedUrl);

    const restarted = harness.setDeliveryBaseUrl(baseUrl);
    await restarted.ready;
    const recovered = await fetch(requestedUrl);
    assert.strictEqual(recovered.status, 200);
    assert((await recovered.text()).includes("exact recovered track"));
    assert.strictEqual(harness.countRequests(`/v1.0/subtitle/${packageId}/download`), 2);
    assert((await manifestFor(harness, packageId)).tracks.some((track) => track.id === requestedTrackId));

    const obsoleteUrl = requestedUrl;
    const restartedAgain = harness.setDeliveryBaseUrl(baseUrl);
    await restartedAgain.ready;
    harness.setArchive(packageId, makeZip({
      "Movie.Replacement.1080p.srt": "1\n00:00:01,000 --> 00:00:02,000\nreplacement must not be served\n",
    }));
    const obsolete = await fetch(obsoleteUrl);
    assert.strictEqual(obsolete.status, 404);
    assert(!(await obsolete.text()).includes("replacement must not be served"));
    assert.strictEqual(harness.countRequests(`/v1.0/subtitle/${packageId}/download`), 3);
  } catch (error) {
    primaryError = error;
  }
  await closeEnvironment(environment, primaryError);
}

async function testMissingAndCorruptCacheRecovery() {
  const environment = await createEnvironment();
  const { harness, baseUrl } = environment;
  let primaryError;
  try {
    for (const [offset, damage] of ["missing-track", "corrupt-track", "corrupt-manifest"].entries()) {
      const packageId = 710010 + offset;
      harness.setArchive(packageId, makeZip({
        "Movie.Primary.1080p.srt": `1\n00:00:01,000 --> 00:00:02,000\n${damage}\n`,
        "Movie.Secondary.720p.srt": "1\n00:00:01,000 --> 00:00:02,000\ncomplete package member\n",
      }));
      const listed = await listRequest({ baseUrl, apiKey: `damage-${offset}`, imdbId: `tt710001${offset}`, packageId }, harness);
      const url = listed.subtitles[0].url;
      const directory = path.join(harness.cacheRoot, "ready", String(packageId));
      const manifest = await manifestFor(harness, packageId);
      if (damage === "missing-track") {
        const track = manifest.tracks.find((candidate) => candidate.id === trackIdFromUrl(url));
        await fs.rm(path.join(directory, track.fileName));
      } else if (damage === "corrupt-track") {
        const track = manifest.tracks.find((candidate) => candidate.id === trackIdFromUrl(url));
        await fs.writeFile(path.join(directory, track.fileName), "truncated");
      } else {
        await fs.writeFile(path.join(directory, "manifest.json"), "{corrupt", "utf8");
      }

      const recovered = await fetch(url);
      assert.strictEqual(recovered.status, 200);
      assert.strictEqual(harness.countRequests(`/v1.0/subtitle/${packageId}/download`), 2);
      assert.strictEqual((await manifestFor(harness, packageId)).tracks.length, 2);
      assert.deepStrictEqual((await fs.readdir(path.join(harness.cacheRoot, "staging"))), []);
    }
  } catch (error) {
    primaryError = error;
  }
  await closeEnvironment(environment, primaryError);
}

async function testConversionAndFailedRebuildContainment() {
  let failConversion = true;
  const environment = await createEnvironment({
    convertTrack: async (srt) => {
      if (failConversion) throw new Error("controlled conversion failure");
      return `WEBVTT\n\n${Buffer.from(srt).toString("utf8").replace(/,/g, ".")}`;
    },
  });
  const { harness, baseUrl } = environment;
  let primaryError;
  try {
    const conversionPackage = 710020;
    harness.setArchive(conversionPackage, makeZip({ "Movie.1080p.srt": "1\n00:00:01,000 --> 00:00:02,000\nconversion\n" }));
    const listed = await listRequest({ baseUrl, apiKey: "conversion", imdbId: "tt7100020", packageId: conversionPackage }, harness);
    const conversionUrl = listed.subtitles[0].url;
    const failedConversion = await fetch(conversionUrl);
    assert.strictEqual(failedConversion.status, 500);
    const conversionManifest = await manifestFor(harness, conversionPackage);
    const conversionTrack = conversionManifest.tracks.find((track) => track.id === trackIdFromUrl(conversionUrl));
    assert.strictEqual(conversionTrack.state, "srt");
    assert((await fs.readdir(path.join(harness.cacheRoot, "ready", String(conversionPackage)))).includes(conversionTrack.fileName));
    assert.strictEqual(harness.countRequests(`/v1.0/subtitle/${conversionPackage}/download`), 1);
    failConversion = false;
    assert.strictEqual((await fetch(conversionUrl)).status, 200);

    const rebuildPackage = 710021;
    const validArchive = makeZip({ "Movie.1080p.srt": "1\n00:00:01,000 --> 00:00:02,000\nrebuild\n" });
    harness.setArchive(rebuildPackage, validArchive);
    const rebuildList = await listRequest({ baseUrl, apiKey: "rebuild", imdbId: "tt7100021", packageId: rebuildPackage }, harness);
    const rebuildUrl = rebuildList.subtitles[0].url;
    const rebuildManifest = await manifestFor(harness, rebuildPackage);
    const rebuildTrack = rebuildManifest.tracks.find((track) => track.id === trackIdFromUrl(rebuildUrl));
    await fs.rm(path.join(harness.cacheRoot, "ready", String(rebuildPackage), rebuildTrack.fileName));
    harness.setArchive(rebuildPackage, Buffer.from("not an archive"));
    const failedRebuild = await fetch(rebuildUrl);
    assert.strictEqual(failedRebuild.status, 500);
    assert.strictEqual(harness.countRequests(`/v1.0/subtitle/${rebuildPackage}/download`), 2);
    await assert.rejects(fs.access(path.join(harness.cacheRoot, "ready", String(rebuildPackage))));
    assert.deepStrictEqual(await fs.readdir(path.join(harness.cacheRoot, "staging")), []);

    harness.setArchive(rebuildPackage, validArchive);
    const nextRequest = await fetch(rebuildUrl);
    assert.strictEqual(nextRequest.status, 200);
    assert.strictEqual(harness.countRequests(`/v1.0/subtitle/${rebuildPackage}/download`), 3);
  } catch (error) {
    primaryError = error;
  }
  await closeEnvironment(environment, primaryError);
}

async function testLegacyDeliveryUrlCompatibility() {
  const environment = await createEnvironment();
  const { harness, baseUrl } = environment;
  let primaryError;
  try {
    const packageId = 710030;
    const trackOne = "Movie.Exact.1080p.srt";
    const trackTwo = "Movie.Other.720p.srt";
    harness.setArchive(packageId, makeZip({
      [trackOne]: "1\n00:00:01,000 --> 00:00:02,000\nlegacy exact track\n",
      [trackTwo]: "1\n00:00:01,000 --> 00:00:02,000\nother track\n",
    }));

    // 1. Prepare package on disk via list request
    await listRequest({ baseUrl, apiKey: "legacy-key", imdbId: "tt7100030", packageId }, harness);
    assert.strictEqual(harness.countRequests(`/v1.0/subtitle/${packageId}/download`), 1);

    // 2. Ready state: Request using legacy base64url(originalPath) URL
    const legacyToken = Buffer.from(trackOne, "utf8").toString("base64url");
    const legacyUrl = `${baseUrl}/legacy-key/proxy/${packageId}/${legacyToken}/sub.vtt`;
    const responseReady = await fetch(legacyUrl);
    assert.strictEqual(responseReady.status, 200);
    assert.strictEqual(responseReady.headers.get("content-type"), "text/vtt; charset=utf-8");
    const bodyReady = await responseReady.text();
    assert(bodyReady.startsWith("WEBVTT\n\n"));
    assert(bodyReady.includes("legacy exact track"));
    assert.strictEqual(harness.countRequests(`/v1.0/subtitle/${packageId}/download`), 1);

    // 3. Absent state: Clear cache and restart pipeline, then request legacy URL directly
    const restarted = harness.setDeliveryBaseUrl(baseUrl);
    await restarted.ready;
    const responseAbsent = await fetch(legacyUrl);
    assert.strictEqual(responseAbsent.status, 200);
    const bodyAbsent = await responseAbsent.text();
    assert(bodyAbsent.startsWith("WEBVTT\n\n"));
    assert(bodyAbsent.includes("legacy exact track"));
    assert.strictEqual(harness.countRequests(`/v1.0/subtitle/${packageId}/download`), 2);

    // 4. Malformed / Noncanonical token returns 404
    const malformedToken = "invalid@@token!!";
    const malformedUrl = `${baseUrl}/legacy-key/proxy/${packageId}/${malformedToken}/sub.vtt`;
    const responseMalformed = await fetch(malformedUrl);
    assert.strictEqual(responseMalformed.status, 404);

    // 5. Unknown decoded path returns 404
    const unknownToken = Buffer.from("NonExistent.Track.1080p.srt", "utf8").toString("base64url");
    const unknownUrl = `${baseUrl}/legacy-key/proxy/${packageId}/${unknownToken}/sub.vtt`;
    const responseUnknown = await fetch(unknownUrl);
    assert.strictEqual(responseUnknown.status, 404);

    // 6. Token containing NUL byte returns 404
    const nulToken = Buffer.from(`${trackOne}\0evil`, "utf8").toString("base64url");
    const nulUrl = `${baseUrl}/legacy-key/proxy/${packageId}/${nulToken}/sub.vtt`;
    const responseNul = await fetch(nulUrl);
    assert.strictEqual(responseNul.status, 404);

    // 7. Token with invalid UTF-8 returns 404
    const invalidUtf8Token = Buffer.from([0xFF, 0xFE, 0xFD]).toString("base64url");
    const invalidUtf8Url = `${baseUrl}/legacy-key/proxy/${packageId}/${invalidUtf8Token}/sub.vtt`;
    const responseInvalidUtf8 = await fetch(invalidUtf8Url);
    assert.strictEqual(responseInvalidUtf8.status, 404);

    // 8. Obsolete track after rebuild returns 404 without substitution
    const obsoleteTrackName = "Movie.Obsolete.1080p.srt";
    const obsoleteToken = Buffer.from(obsoleteTrackName, "utf8").toString("base64url");
    const obsoleteUrl = `${baseUrl}/legacy-key/proxy/${packageId}/${obsoleteToken}/sub.vtt`;
    const responseObsolete = await fetch(obsoleteUrl);
    assert.strictEqual(responseObsolete.status, 404);

    // Ensure downloads didn't loop on missing/malformed tokens
    assert.strictEqual(harness.countRequests(`/v1.0/subtitle/${packageId}/download`), 2);
  } catch (error) {
    primaryError = error;
  }
  await closeEnvironment(environment, primaryError);
}

async function runTests() {
  console.log("=== Running Ticket I-07 Delivery Recovery and Revision Tests ===");
  await testRevisionInvalidation();
  console.log("✓ Later updatedAt rebuilds once; a missing revision reuses the package; manifests retain no ranking");
  await testAbsentAndObsoleteDeliveryRecovery();
  console.log("✓ Absent delivery state rebuilds the complete package and obsolete URLs return 404 without substitution");
  await testMissingAndCorruptCacheRecovery();
  console.log("✓ Missing tracks, corrupt track content, and corrupt manifests invalidate and rebuild the complete package once");
  await testConversionAndFailedRebuildContainment();
  console.log("✓ Conversion preserves SRT; failed rebuilds clean up, stop, release resources, and permit a later retry");
  await testLegacyDeliveryUrlCompatibility();
  console.log("✓ Legacy base64url delivery URLs decode safely, match exact tracks, recover once on absent state, and reject malformed/obsolete tokens");
  console.log("ALL TICKET I-07 DELIVERY RECOVERY AND REVISION TESTS PASSED ✓");
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
