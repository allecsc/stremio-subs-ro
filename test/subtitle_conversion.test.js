const assert = require("assert");
const iconv = require("iconv-lite");
const {
  normalizeRomanianDiacritics,
  srtToVtt,
  decodeSubtitleBuffer,
} = require("../lib/subtitleExtractor");

function runTests() {
  console.log("=== Running Diacritics Normalization & WebVTT Conversion Tests ===");

  // 1. Diacritics Normalization
  console.log("Test 1: Normalize legacy Romanian cedillas (ş, ţ) to comma-below (ș, ț)");
  const legacyText = "Aşteaptă şi tu puţin, băieţel! ŞTIINŢA ŞI VIAŢA.";
  const normalizedText = normalizeRomanianDiacritics(legacyText);
  const expectedText = "Așteaptă și tu puțin, băiețel! ȘTIINȚA ȘI VIAȚA.";

  assert.strictEqual(normalizedText, expectedText);
  assert(!normalizedText.includes("ş"));
  assert(!normalizedText.includes("ţ"));
  assert(!normalizedText.includes("Ş"));
  assert(!normalizedText.includes("Ţ"));
  console.log("✓ Passed: Romanian diacritics normalized accurately");

  // 2. Charset Detection & Decoding
  console.log("Test 2: Decode Windows-1250 and UTF-8 subtitle buffers");
  const roText = "Subtitrare în limba română cu diacritice: ș, ț, ă, î, â.";
  const win1250Buffer = iconv.encode(roText, "windows-1250");
  const utf8Buffer = Buffer.from(roText, "utf-8");

  const decodedWin1250 = decodeSubtitleBuffer(win1250Buffer);
  const decodedUtf8 = decodeSubtitleBuffer(utf8Buffer);

  assert(decodedWin1250.includes("română"));
  assert(decodedUtf8.includes("română"));
  console.log("✓ Passed: Windows-1250 and UTF-8 buffers decoded without mojibake");

  // 3. SRT to WebVTT Conversion
  console.log("Test 3: Convert SRT syntax to WebVTT syntax");
  const sampleSrt = `1
00:01:23,456 --> 00:01:25,789
{\\an8}Aşteaptă puţin!

2
00:01:26,000 --> 00:01:28,500
Şi ce mai faci?`;

  const vttOutput = srtToVtt(sampleSrt);
  console.log("VTT Output:\n" + vttOutput);

  assert(vttOutput.startsWith("WEBVTT\n\n"));
  assert(vttOutput.includes("00:01:23.456 --> 00:01:25.789"));
  assert(vttOutput.includes("00:01:26.000 --> 00:01:28.500"));
  assert(!vttOutput.includes("{\\an8}"), "ASS positioning tags must be stripped");
  assert(vttOutput.includes("Așteaptă puțin!"));
  assert(vttOutput.includes("Și ce mai faci?"));
  console.log("✓ Passed: SRT converted cleanly to WebVTT");

  console.log("\nALL DIACRITICS AND WEBVTT CONVERSION TESTS PASSED ✓");
}

runTests();
