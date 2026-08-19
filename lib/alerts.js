const axios = require("axios");
const { globalMetrics, APP_VERSION } = require("./metrics");
const { sendTelemetrySnapshot } = require("./beacon");

let lastOutageAlertTime = 0;
const OUTAGE_ALERT_COOLDOWN = 15 * 60 * 1000;

/**
 * Dispatch an alert embed to Discord webhook if configured.
 */
async function sendDiscordAlert({ title, description, color = 0xef4444, fields = [] }) {
  const enabled = process.env.TELEMETRY_EXTERNAL_ENABLED === "true";
  const webhookUrl = process.env.STATS_WEBHOOK_URL;
  if (!enabled || !webhookUrl) return false;

  const payload = {
    username: "Subs.ro Alert",
    embeds: [
      {
        title: title || `🚨 Subs.ro Addon v${APP_VERSION} Alert`,
        description: description || "",
        color,
        fields,
        footer: {
          text: `Host Event • ${new Date().toISOString().slice(11, 19)} UTC`,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    await axios.post(webhookUrl.trim(), payload, { timeout: 5000 });
    return true;
  } catch (err) {
    console.error("[ALERT] Failed to send Discord alert:", err.message);
    return false;
  }
}

/**
 * Notify when server starts up.
 */
async function notifyServerOnline(port, env = process.env.NODE_ENV || "production") {
  return sendDiscordAlert({
    title: `🚀 Server Online — v${APP_VERSION}`,
    description: `Subs.ro Stremio Addon is running on port \`${port}\` (\`${env}\` mode).\nRuntime initialized successfully.`,
    color: 0x10b981,
  });
}

let hooksInstalled = false;

/**
 * Setup process signal and error listeners.
 */
function setupProcessAlarmHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;

  const handleShutdown = async (signal) => {
    console.log(`[SHUTDOWN] Received ${signal}. Flushing final telemetry snapshot...`);
    try {
      await sendTelemetrySnapshot(globalMetrics, true);
    } catch (e) {}
    process.exit(0);
  };

  process.once("SIGTERM", () => handleShutdown("SIGTERM"));
  process.once("SIGINT", () => handleShutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    const msg = reason?.message || String(reason);
    console.error(`[UNHANDLED REJECTION] ${msg}`);
    globalMetrics.recordError("unhandledRejection", msg);
  });

  process.on("uncaughtException", async (err) => {
    console.error(`[UNCAUGHT EXCEPTION] ${err.message}\n${err.stack}`);
    globalMetrics.recordError("uncaughtException", err.message);
    try {
      await sendTelemetrySnapshot(globalMetrics, true);
    } catch (e) {}
    process.exit(1);
  });
}

module.exports = {
  sendDiscordAlert,
  notifyServerOnline,
  setupProcessAlarmHooks,
};
