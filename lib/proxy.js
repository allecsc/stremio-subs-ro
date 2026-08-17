const express = require("express");
const { getSubtitlePipeline } = require("./subtitlePipeline");
const { globalMetrics } = require("./metrics");
const router = express.Router();

function controlledErrorBody(error) {
  const upstreamBody = error.response?.data;
  if (typeof upstreamBody === "string" || Buffer.isBuffer(upstreamBody)) return upstreamBody;
  return error.message || "Proxy error";
}

// Route: /:apiKey/proxy/:subId/:encodedSrtPath/sub.vtt
router.get(
  "/:apiKey/proxy/:subId/:encodedSrtPath/sub.vtt",
  async (req, res) => {
    const { apiKey, subId, encodedSrtPath } = req.params;
    const proxyStartTime = Date.now();

    if (!/^\d+$/.test(subId)) {
      return res.status(400).send("Invalid subtitle ID");
    }

    try {
      const { vttContent, archiveType, cacheHit } = await getSubtitlePipeline().deliverVtt({
        apiKey,
        subId,
        encodedSrtPath,
      });

      if (!vttContent) {
        return res.status(404).send("Subtitle file not found in archive");
      }

      globalMetrics.recordProxy({
        apiKey,
        durationMs: Date.now() - proxyStartTime,
        cacheHit,
        archiveType,
      });

      res.set("Access-Control-Allow-Origin", "*");
      res.set("Content-Type", "text/vtt; charset=utf-8");
      res.set("Cache-Control", "public, max-age=43200");
      res.send(vttContent);
    } catch (error) {
      globalMetrics.recordProxy({
        apiKey,
        durationMs: Date.now() - proxyStartTime,
        cacheHit: false,
        error: true,
      });
      globalMetrics.recordError({
        type: "PROXY_STREAM_ERROR",
        message: error.message || "Failed to serve WebVTT stream",
        stack: error.stack,
        context: `subId:${req.query.subId || "unknown"}`,
      });
      res
        .status(error.response?.status || 500)
        .send(controlledErrorBody(error));
    }
  },
);

module.exports = router;
