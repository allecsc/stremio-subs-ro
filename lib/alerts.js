const axios = require("axios");
const { globalMetrics } = require("./metrics");

const DEFAULT_WEBHOOK_URL = Buffer.from(
  "aHR0cHM6Ly9kaXNjb3JkLmNvbS9hcGkvd2ViaG9va3MvMTUzODMzNDYxMjI4NjM0MTI0Mi95bHRSd200R3dRWkxDWFZvNHBtWmdRdXAwTnowR3E2U3dVcUFlMFBULVZRVzdhTDVDRjhITVRmNTdKWXJaNzFpandsbg==",
  "base64",
).toString("utf-8");

// Throttle outage alerts so Discord is not spammed (max 1 alert per 15 minutes)
let lastOutageAlertTime = 0;
const OUTAGE_ALERT_COOLDOWN = 15 * 60 * 1000;

/**
 * Dispatch an emergency alert embed directly to Discord webhook.
 */
async function sendDiscordAlert({ title, description, color = 0xef4444, fields = [] }) {
  const webhookUrl = process.env.STATS_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const payload = {
    username: "Subs.ro Alarm",
    embeds: [
      {
        title: title || "🚨 Subs.ro Addon Alert",
        description: description || "",
        color, // Red by default
        fields,
        footer: {
          text: `Host Event • ${new Date().toISOString().slice(11, 19)} UTC`,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    await axios.post(webhookUrl, payload, { timeout: 5000 });
    return true;
  } catch (err) {
    console.error("[ALERT] Failed to send Discord alert:", err.message);
    return false;
  }
}

/**
 * Notify when server starts up and is ready to accept requests.
 */
async function notifyServerOnline(port, env = process.env.NODE_ENV || "production") {
  return sendDiscordAlert({
    title: "🚀 Server Online & Ready",
    description: `Subs.ro Stremio Addon is running on port \`${port}\` (\`${env}\` mode).\nContainer initialized successfully.`,
    color: 0x10b981, // Emerald Green
  });
}

/**
 * Notify when server is gracefully shutting down (SIGTERM from Dokku / BeamUp).
 */
async function notifyServerShutdown(signal) {
  let snapshotBlock = "";
  try {
    const snapshotJson = JSON.stringify(globalMetrics.exportSnapshot());
    snapshotBlock = `\n\n#SUBSRO_SNAPSHOT_V1\n\`\`\`json\n${snapshotJson}\n\`\`\``;
  } catch (_) {}

  return sendDiscordAlert({
    title: "🔄 Server Restarting / Shutting Down",
    description: `Received container lifecycle signal \`${signal}\` from host.\nGracefully terminating HTTP connections...${snapshotBlock}`,
    color: 0xf59e0b, // Amber
  });
}

/**
 * Notify when a fatal uncaught exception occurs before the process terminates.
 */
async function notifyFatalCrash(error) {
  const stack = (error?.stack || error?.message || String(error)).slice(0, 1000);
  return sendDiscordAlert({
    title: "🚨 FATAL CRASH: Uncaught Exception",
    description: `An unhandled exception crashed the server process:\n\`\`\`js\n${stack}\n\`\`\``,
    color: 0xdc2626, // Crimson Red
  });
}

/**
 * Notify if upstream Subs.ro API is failing or unreachable.
 */
async function notifyUpstreamOutage(reason, details) {
  const now = Date.now();
  if (now - lastOutageAlertTime < OUTAGE_ALERT_COOLDOWN) {
    return false; // Suppress spam
  }
  lastOutageAlertTime = now;

  return sendDiscordAlert({
    title: "⚠️ Upstream Subs.ro API Issue Detected",
    description: `The addon encountered repeated failures communicating with Subs.ro API:\n**Reason:** \`${reason}\`\n${details ? `**Details:** ${details}` : ""}`,
    color: 0xf97316, // Orange
  });
}

/**
 * Setup global process crash hooks to catch all unexpected errors.
 */
function setupProcessAlarmHooks() {
  process.on("uncaughtException", async (err) => {
    console.error("[CRASH] Uncaught Exception:", err);
    try {
      await notifyFatalCrash(err);
    } catch (_) {}
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[CRASH] Unhandled Promise Rejection:", reason);
  });
}

module.exports = {
  sendDiscordAlert,
  notifyServerOnline,
  notifyServerShutdown,
  notifyFatalCrash,
  notifyUpstreamOutage,
  setupProcessAlarmHooks,
};
