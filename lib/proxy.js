const express = require("express");
const axios = require("axios");
const AdmZip = require("adm-zip");
const iconv = require("iconv-lite");
const jschardet = require("jschardet");
const router = express.Router();

const VTT_CACHE = new Map(); // subId -> { vtt, timestamp }
const VTT_TTL = 12 * 60 * 60 * 1000; // 12 hours

router.get("/:apiKey/proxy/:subId/:filename", async (req, res) => {
  const { apiKey, subId } = req.params;

  // 1. Validation & Hardening
  if (!/^\d+$/.test(subId)) return res.status(400).send("Invalid subtitle ID");

  // 2. Check Cache
  const cached = VTT_CACHE.get(subId);
  if (cached && Date.now() - cached.timestamp < VTT_TTL) {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Type", "text/vtt; charset=utf-8");
    res.set("Cache-Control", "public, max-age=43200"); // 12 hours
    return res.send(cached.vtt);
  }

  try {
    const downloadUrl = `https://subs.ro/api/v1.0/subtitle/${subId}/download`;
    const response = await axios.get(downloadUrl, {
      headers: { "X-Subs-Api-Key": apiKey },
      responseType: "arraybuffer",
      maxContentLength: 5 * 1024 * 1024, // 5MB limit to prevent Zip Bombs
    });

    const zip = new AdmZip(response.data);
    const validEntries = zip
      .getEntries()
      .filter(
        (e) =>
          !e.isDirectory &&
          !e.entryName.includes("__MACOSX") &&
          e.entryName.endsWith(".srt")
      );

    const entry = validEntries[0];
    if (!entry) return res.status(404).send("SRT not found in zip");

    const contentBuffer = entry.getData();
    const detected = jschardet.detect(contentBuffer);
    let encoding = detected.encoding || "utf-8";

    // Romanian Encoding Fix (Windows-1250 vs Windows-1252)
    const isWindows1252 = encoding.toLowerCase().includes("windows-1252");
    if (isWindows1252 || detected.confidence < 0.8) {
      encoding = "windows-1250";
    }

    let contentStr = iconv.decode(contentBuffer, encoding);

    // Convert SRT to WebVTT
    contentStr =
      "WEBVTT\n\n" +
      contentStr
        .replace(/\r\n/g, "\n")
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");

    // Cache results
    VTT_CACHE.set(subId, { vtt: contentStr, timestamp: Date.now() });

    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Type", "text/vtt; charset=utf-8");
    res.set("Content-Disposition", `inline; filename="${subId}.vtt"`);
    res.set("Cache-Control", "public, max-age=43200"); // 12 hours
    res.send(contentStr);
  } catch (error) {
    const status = error.response?.status;

    if (status === 401) {
      console.error(`[PROXY] Invalid API key for subtitle ${subId}`);
      res.status(401).send("Invalid API key");
    } else if (status === 404) {
      console.error(`[PROXY] Subtitle ${subId} not found`);
      res.status(404).send("Subtitle not found");
    } else if (status === 429) {
      console.error(`[PROXY] Quota exceeded for subtitle ${subId}`);
      res.status(429).send("API quota exceeded");
    } else {
      console.error(`[PROXY] Error for subtitle ${subId}:`, error.message);
      res.status(500).send("Proxy error");
    }
  }
});

module.exports = router;
