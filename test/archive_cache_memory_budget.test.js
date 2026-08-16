const assert = require("assert");
const {
  ARCHIVE_CACHE,
  ARCHIVE_CACHE_MAX_ENTRY_VTT_BYTES,
  ARCHIVE_CACHE_MAX_RETAINED_VTT_BYTES,
} = require("../lib/archiveCache");

const MAX_ENTRY_VTT_BYTES = 1 * 1024 * 1024;
const MAX_RETAINED_VTT_BYTES = 8 * 1024 * 1024;

function makeArchive(trackName, vttBytes) {
  return {
    vttMap: new Map([[trackName, "WEBVTT\n\n" + "x".repeat(vttBytes)]]),
    srtFiles: [trackName],
    archiveType: "zip",
  };
}

function runTests() {
  console.log("=== Running Archive Cache Memory Budget Tests ===");

  assert.strictEqual(ARCHIVE_CACHE_MAX_ENTRY_VTT_BYTES, MAX_ENTRY_VTT_BYTES);
  assert.strictEqual(ARCHIVE_CACHE_MAX_RETAINED_VTT_BYTES, MAX_RETAINED_VTT_BYTES);

  console.log("Test 1: an oversized archive keeps its track list but not its converted VTT text");
  const largeTrack = "Large.Release.2026.ro.srt";
  ARCHIVE_CACHE.set(
    "archive-large",
    makeArchive(largeTrack, MAX_ENTRY_VTT_BYTES),
  );
  const largeArchive = ARCHIVE_CACHE.get("archive-large");
  assert.deepStrictEqual(largeArchive.srtFiles, [largeTrack]);
  assert.strictEqual(largeArchive.vttMap, undefined);
  console.log("✓ Passed: proxy metadata survives without retaining an oversized VTT map");

  console.log("Test 2: many cacheable archives never retain more than the VTT-text budget");
  for (let index = 0; index < 20; index += 1) {
    ARCHIVE_CACHE.set(
      `archive-${index}`,
      makeArchive(`Release.${index}.ro.srt`, MAX_ENTRY_VTT_BYTES / 2),
    );
  }
  const stats = ARCHIVE_CACHE.stats();
  assert(
    stats.retainedVttBytes <= MAX_RETAINED_VTT_BYTES,
    `Expected <= ${MAX_RETAINED_VTT_BYTES} retained VTT bytes, got ${stats.retainedVttBytes}`,
  );
  assert.strictEqual(ARCHIVE_CACHE.get("archive-19").vttMap instanceof Map, true);
  assert.strictEqual(ARCHIVE_CACHE.get("archive-0"), null);
  console.log("✓ Passed: LRU eviction keeps recent archive bridges inside the memory budget");

  console.log("Test 3: refreshing an archive does not evict a different archive");
  const oldestRetainedKey = stats.keys[0];
  ARCHIVE_CACHE.set(
    "archive-19",
    makeArchive("Release.19.ro.srt", MAX_ENTRY_VTT_BYTES / 2),
  );
  assert.notStrictEqual(ARCHIVE_CACHE.get(oldestRetainedKey), null);
  console.log("✓ Passed: refreshing an archive preserves the other retained archives");

  console.log("Test 4: expired archive entries have an explicit cleanup path");
  const realDateNow = Date.now;
  try {
    Date.now = () => 1_000;
    ARCHIVE_CACHE.set("archive-expired", makeArchive("Expired.ro.srt", 1));
    Date.now = () => 1_000 + 60_001;
    ARCHIVE_CACHE.prune();
    assert.strictEqual(ARCHIVE_CACHE.get("archive-expired"), null);
  } finally {
    Date.now = realDateNow;
  }
  console.log("✓ Passed: expired archive cache entries are reclaimed deterministically");

  console.log("\nALL ARCHIVE CACHE MEMORY BUDGET TESTS PASSED ✓");
}

runTests();
