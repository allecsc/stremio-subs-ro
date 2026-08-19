const axios = require("axios");
const { globalMetrics, APP_VERSION, INSTANCE_ID } = require("./metrics");

/**
 * Format a human-readable summary of metrics for Discord.
 */
function formatTelemetrySummary(snapshot) {
  const u = snapshot.users || {};
  const tr = snapshot.traffic || {};
  const lat = snapshot.latency || {};
  const c = snapshot.cache || {};
  const up = snapshot.upstream || {};
  const lim = snapshot.limiter || {};
  const res = snapshot.resources || {};

  return [
    `📊 **Subs.ro Addon Operational Telemetry — v${APP_VERSION}**`,
    `• **Instance:** \`${INSTANCE_ID}\` (Uptime: \`${Math.round((snapshot.uptimeSeconds || 0) / 60)}m\`)`,
    `• **Users:** \`${u.activeNow15m || 0}\` active (15m) · \`${u.uniqueToday || 0}\` unique today · \`${u.uniqueRcInstalls || 0}\` RC total`,
    `• **Traffic:** \`${tr.subtitleRequests || 0}\` list requests · \`${tr.proxyRequests || 0}\` stream requests · \`${tr.failedRequests || 0}\` errors`,
    `• **Latency (avg/max):** List \`${lat.subtitle?.avgMs || 0}/${lat.subtitle?.maxMs || 0}ms\` · Stream \`${lat.proxy?.avgMs || 0}/${lat.proxy?.maxMs || 0}ms\``,
    `• **Cache Hit Rates:** Ranked List: \`${c.responseCache?.hitRate || 0}%\` · Archive: \`${c.archiveCache?.hitRate || 0}%\` · WebVTT: \`${c.vttCache?.hitRate || 0}%\``,
    `• **Singleflight:** \`${c.singleflight?.leaders || 0}\` leaders · \`${c.singleflight?.joined || 0}\` joined waiters`,
    `• **Upstream:** \`${up.searches || 0}\` searches · \`${up.downloads || 0}\` downloads (\`${up.downloadFailures || 0}\` failed · \`${up.totalCompressedMb || 0} MB\`) · \`${up.corruptFailures || 0}\` corrupt rejects`,
    `• **Safety Filters:** \`${up.wrongSeasonSkipped || 0}\` wrong season · \`${up.forcedSplitFiltered || 0}\` forced/split · \`${up.oversizedSelectedSrtRejects || 0}\` oversized SRTs`,
    `• **Limiter & Resources:** Peak Global Active: \`${lim.peakGlobalActive || 0}\` · Peak User: \`${lim.maxObservedPerUserActive || 0}/3\` · RSS: \`${res.currentRssMb || 0} MB\` (Peak: \`${res.peakRssMb || 0} MB\`)`,
  ].join("\n");
}

/**
 * Dispatch periodic telemetry snapshot to configured external webhook.
 */
async function sendTelemetrySnapshot(metricsInstance = globalMetrics, isShutdown = false) {
  const enabled = process.env.TELEMETRY_EXTERNAL_ENABLED === "true";
  const webhookUrl = process.env.STATS_WEBHOOK_URL;

  if (!enabled || !webhookUrl || typeof webhookUrl !== "string" || !webhookUrl.trim()) {
    return false;
  }

  try {
    const snapshot = metricsInstance.exportSnapshot();
    const summaryText = formatTelemetrySummary(snapshot);
    const prefix = isShutdown ? "⚠️ **SHUTDOWN SNAPSHOT**\n" : "";

    const payload = {
      content: `${prefix}${summaryText}\n\n#SUBSRO_TELEMETRY_V2`,
      username: "Subs.ro Telemetry",
    };

    await axios.post(webhookUrl.trim(), payload, {
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
    });
    return true;
  } catch (error) {
    console.error("[TELEMETRY] Failed to dispatch snapshot webhook:", error.message);
    return false;
  }
}

/**
 * Start the 15-minute snapshot scheduler.
 */
function startTelemetryScheduler(metricsInstance = globalMetrics) {
  const enabled = process.env.TELEMETRY_EXTERNAL_ENABLED === "true";
  const webhookUrl = process.env.STATS_WEBHOOK_URL;

  if (!enabled || !webhookUrl) {
    // In local mode or unconfigured, scheduler is dormant
    return null;
  }

  const intervalMs = 15 * 60 * 1000; // 15 minutes
  console.log(`[TELEMETRY] Periodic external snapshot enabled (every 15m to webhook).`);

  const timerId = setInterval(async () => {
    try {
      await sendTelemetrySnapshot(metricsInstance, false);
    } catch (e) {}
  }, intervalMs);

  // Send initial startup heartbeat
  sendTelemetrySnapshot(metricsInstance, false).catch(() => {});

  return timerId;
}

module.exports = {
  formatTelemetrySummary,
  sendTelemetrySnapshot,
  startTelemetryScheduler,
};
