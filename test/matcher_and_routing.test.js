const assert = require("assert");
const {
  isExcludedSubtitle,
  getEditionTags,
  getNetworkTags,
  getQualityTags,
  getReleaseGroup,
  calculateMatchScore,
  parseStremioId,
} = require("../lib/matcher");

function runTests() {
  console.log("=== Running Multi-Identifier & 9-Tier Matcher Tests ===");

  // 1. Guarding & ID Parsing Tests
  console.log("Test 1: parseStremioId parses IMDb and TMDB, rejecting non-video IDs");
  assert.deepStrictEqual(parseStremioId("tt0898266"), {
    type: "imdb",
    id: "tt0898266",
    season: null,
    episode: null,
    isValid: true,
  });

  assert.deepStrictEqual(parseStremioId("tt0898266:2:5"), {
    type: "imdb",
    id: "tt0898266",
    season: 2,
    episode: 5,
    isValid: true,
  });

  assert.deepStrictEqual(parseStremioId("tmdb:94605"), {
    type: "tmdb",
    id: "94605",
    season: null,
    episode: null,
    isValid: true,
  });

  assert.deepStrictEqual(parseStremioId("tmdb:94605:1:3"), {
    type: "tmdb",
    id: "94605",
    season: 1,
    episode: 3,
    isValid: true,
  });

  assert.strictEqual(parseStremioId("vavoo_channel_123").isValid, false);
  assert.strictEqual(parseStremioId("iptv:custom_stream").isValid, false);
  assert.strictEqual(parseStremioId("").isValid, false);
  console.log("✓ Passed: ID parsing and guarding verified");

  // 2. Exclusion Filters
  console.log("Test 2: Exclusion filters reject FORCED and Multi-CD partial subtitles");
  assert.strictEqual(isExcludedSubtitle("Movie.2024.1080p.BluRay.Ro.Forced.srt"), true);
  assert.strictEqual(isExcludedSubtitle("Avatar.2009.Ro.FORCED.srt"), true);
  assert.strictEqual(isExcludedSubtitle("Gladiator.2000.CD1.Ro.srt"), true);
  assert.strictEqual(isExcludedSubtitle("Gladiator.2000.CD2.Ro.srt"), true);
  assert.strictEqual(isExcludedSubtitle("Titanic.1997.Disc1.srt"), true);
  assert.strictEqual(isExcludedSubtitle("Titanic.1997.Part.2.srt"), true);
  assert.strictEqual(isExcludedSubtitle("Movie.2024.1080p.BluRay.x264-FLUX.srt"), false);
  assert.strictEqual(isExcludedSubtitle("Show.S01E03.AMZN.WEB-DL.srt"), false);
  console.log("✓ Passed: Exclusion filtering verified");

  // 3. Tag Extractions
  console.log("Test 3: Extract Edition, Network, and Source tags");
  assert(getEditionTags("Movie.2024.EXTENDED.1080p.mkv").includes("EXTENDED"));
  assert(getEditionTags("Movie.UNRATED.Directors.Cut.mkv").includes("UNRATED"));
  assert(getEditionTags("Movie.UNRATED.Directors.Cut.mkv").includes("DIRECTORS CUT"));
  assert(getNetworkTags("Show.S01E01.AMZN.WEB-DL.mkv").includes("AMZN"));
  assert(getNetworkTags("Show.S01E01.DSNP.WEB-DL.mkv").includes("DSNP"));
  assert(getNetworkTags("Show.S01E01.NF.WEB-DL.mkv").includes("NF"));
  assert(getQualityTags("Movie.1080p.BluRay.mkv").includes("BLURAY"));
  assert(getQualityTags("Movie.1080p.WEB-DL.mkv").includes("WEB-DL"));
  console.log("✓ Passed: Tag extraction verified");

  // 4. 9-Tier Scoring Hierarchy
  console.log("Test 4: 9-Tier Scoring Hierarchy Ordering");
  const videoFile = "Movie.Title.2024.EXTENDED.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX.mkv";

  // Tier 1: Exact Match (sans extension)
  const tier1Sub = "Movie.Title.2024.EXTENDED.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX.srt";
  // Tier 2: Edition + Source + Network + Group
  const tier2Sub = "OtherName.EXTENDED.AMZN.WEB-DL-FLUX.srt";
  // Tier 3: Edition + Source + Network
  const tier3Sub = "OtherName.EXTENDED.AMZN.WEB-DL-OTHERGROUP.srt";
  // Tier 4: Edition + Source + Group
  const tier4Sub = "OtherName.EXTENDED.WEB-DL-FLUX.srt";
  // Tier 5: Edition + Source
  const tier5Sub = "OtherName.EXTENDED.WEB-DL-OTHERGROUP.srt";
  // Tier 6: Source + Network
  const tier6Sub = "OtherName.AMZN.WEB-DL-OTHERGROUP.srt";
  // Tier 7: Source + Group
  const tier7Sub = "OtherName.WEB-DL-FLUX.srt";
  // Tier 8: Source Only
  const tier8Sub = "OtherName.WEB-DL.srt";
  // Tier 9: Fuzzy Fallback
  const tier9Sub = "Movie.Title.2024.720p.HDTV.srt";

  const score1 = calculateMatchScore(videoFile, tier1Sub);
  const score2 = calculateMatchScore(videoFile, tier2Sub);
  const score3 = calculateMatchScore(videoFile, tier3Sub);
  const score4 = calculateMatchScore(videoFile, tier4Sub);
  const score5 = calculateMatchScore(videoFile, tier5Sub);
  const score6 = calculateMatchScore(videoFile, tier6Sub);
  const score7 = calculateMatchScore(videoFile, tier7Sub);
  const score8 = calculateMatchScore(videoFile, tier8Sub);
  const score9 = calculateMatchScore(videoFile, tier9Sub);

  console.log(`Scores:
  Tier 1 (Exact): ${score1}
  Tier 2 (Edition + Source + Network + Group): ${score2}
  Tier 3 (Edition + Source + Network): ${score3}
  Tier 4 (Edition + Source + Group): ${score4}
  Tier 5 (Edition + Source): ${score5}
  Tier 6 (Source + Network): ${score6}
  Tier 7 (Source + Group): ${score7}
  Tier 8 (Source Only): ${score8}
  Tier 9 (Fuzzy Fallback): ${score9}`);

  assert(score1 > score2, `Tier 1 (${score1}) must > Tier 2 (${score2})`);
  assert(score2 > score3, `Tier 2 (${score2}) must > Tier 3 (${score3})`);
  assert(score3 > score4, `Tier 3 (${score3}) must > Tier 4 (${score4})`);
  assert(score4 > score5, `Tier 4 (${score4}) must > Tier 5 (${score5})`);
  assert(score5 > score6, `Tier 5 (${score5}) must > Tier 6 (${score6})`);
  assert(score6 > score7, `Tier 6 (${score6}) must > Tier 7 (${score7})`);
  assert(score7 > score8, `Tier 7 (${score7}) must > Tier 8 (${score8})`);
  assert(score8 > score9, `Tier 8 (${score8}) must > Tier 9 (${score9})`);

  // 5. 4K UHD / REMUX Tiebreaker Test
  console.log("Test 5: 4K UHD / REMUX tiebreakers prioritize remaster releases over older disc masters");
  const lotrVideo = "The.Lord.of.the.Rings-.The.Two.Towers.2002.Extended.Edition.2160p.UHD.BluRay.TrueHD.7.1.DoVi.x265-DON.mkv";
  const uhdRemuxSub = "BluRay/The.Lord.of.the.Rings.The.Two.Towers.2002.Extended.2160p.UHD.Remux.HEVC.HDR.TrueHD.Atmos.7.1-playBD.srt";
  const hdSub = "BluRay/The.Lord.of.the.Rings.The.Two.Towers.2002.EXTENDED.1080p.BluRay.x265-RARBG.srt";

  const uhdScore = calculateMatchScore(lotrVideo, uhdRemuxSub);
  const hdScore = calculateMatchScore(lotrVideo, hdSub);
  console.log(`LOTR UHD Score: ${uhdScore} vs 1080p Score: ${hdScore}`);
  assert(uhdScore > hdScore, `UHD Remaster (${uhdScore}) must score higher than 1080p (${hdScore})`);
  // 6. Fuzzy Fallback Source Quality Weighting Test
  console.log("Test 6: Fuzzy fallback prioritizes modern sync sources (BluRay > WEB-DL > HDTV > DVDRip)");
  const genericVideo = "Some.Show.S01E01.Unknown.Stream.mkv";
  const blurayFallback = "Some.Show.S01E01.720p.BluRay.x264.srt";
  const webFallback = "Some.Show.S01E01.1080p.WEB-DL.srt";
  const hdtvFallback = "Some.Show.S01E01.HDTV.XviD.srt";
  const dvdFallback = "Some.Show.S01E01.DVDRip.XviD.srt";

  const sBluRay = calculateMatchScore(genericVideo, blurayFallback);
  const sWeb = calculateMatchScore(genericVideo, webFallback);
  const sHdtv = calculateMatchScore(genericVideo, hdtvFallback);
  const sDvd = calculateMatchScore(genericVideo, dvdFallback);

  console.log(`Fallback Scores: BluRay: ${sBluRay}, WEB-DL: ${sWeb}, HDTV: ${sHdtv}, DVDRip: ${sDvd}`);
  assert(sBluRay > sWeb, `BluRay (${sBluRay}) must > WEB-DL (${sWeb})`);
  assert(sWeb > sHdtv, `WEB-DL (${sWeb}) must > HDTV (${sHdtv})`);
  assert(sHdtv > sDvd, `HDTV (${sHdtv}) must > DVDRip (${sDvd})`);
  console.log("✓ Passed: Fallback source quality weighting verified");

  console.log("\nALL MATCHER AND ROUTING TESTS PASSED ✓");
}

runTests();
