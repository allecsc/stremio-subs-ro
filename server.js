const express = require("express");
const cors = require("cors");
const path = require("path");
const querystring = require("querystring");
const dotenv = require("dotenv");

const helmet = require("helmet");
const { addonInterface, subtitlesHandler } = require("./addon");
const SubsRoClient = require("./lib/subsro");
const proxyRouter = require("./lib/proxy");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 7000;

app.use(
  helmet({
    contentSecurityPolicy: false, // Disable CSP to allow custom configuration page scripts/styles
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
app.use(proxyRouter);

const decodeConfig = (configStr) => {
  if (!configStr) return {};
  try {
    const base64 = configStr
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(configStr.length + ((4 - (configStr.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
  } catch (e) {
    return {};
  }
};

// Serve configure page directly (no redirect - required by addon catalog)
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "configure.html")),
);
app.get("/configure", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "configure.html")),
);
app.get("/:config/configure", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "configure.html")),
);

// Manifest handler (shared by all manifest routes)
const manifestHandler = (req, res) => {
  const { config } = req.params;
  const userConfig = decodeConfig(config);
  const hasConfig = config && Object.keys(userConfig).length > 0;

  // Shallow clone with spread (40× faster than JSON.parse/stringify)
  const manifest = {
    ...addonInterface.manifest,
    behaviorHints: {
      ...addonInterface.manifest.behaviorHints,
      configurationRequired: !hasConfig,
    },
  };

  res.set("Cache-Control", "public, max-age=86400"); // 1 day
  res.json(manifest);
};

// Manifest routes (both /manifest and /manifest.json work)
app.get("/manifest", manifestHandler);
app.get("/manifest.json", manifestHandler);
app.get("/:config/manifest", manifestHandler);
app.get("/:config/manifest.json", manifestHandler);

// API Validation Endpoint
app.get("/api/validate/:apiKey", async (req, res) => {
  const { apiKey } = req.params;
  const client = new SubsRoClient(apiKey);
  const isValid = await client.validate();
  res.json({ valid: isValid });
});

// Subtitles
app.get("/:config?/subtitles/:type/:id/:extra?.json", async (req, res) => {
  const { config, type, id, extra } = req.params;
  const userConfig = decodeConfig(config);

  // Prefer HTTPS (BeamUp uses HTTPS)
  const protocol =
    req.headers["x-forwarded-proto"] || (req.secure ? "https" : req.protocol);
  const host = req.headers["x-forwarded-host"] || req.get("host");
  userConfig.baseUrl = `${protocol}://${host}`;

  try {
    let extraObj = {};
    if (extra) {
      try {
        extraObj = JSON.parse(extra);
      } catch (e) {
        extraObj = querystring.parse(extra);
      }
    }
    const response = await subtitlesHandler({
      type,
      id,
      extra: extraObj,
      config: userConfig,
    });
    res.set("Cache-Control", "public, max-age=900"); // 15 minutes
    res.json(response);
  } catch (e) {
    res.status(500).json({ subtitles: [] });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Addon live on port ${PORT}`);
  console.log(`[INFO] Logs silenced for production.`);

  // Scheduled restart every 24 hours to prevent memory leaks/hangs
  const RESTART_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
  setTimeout(() => {
    console.error("[SYSTEM] Planned 24h restart triggered. Exiting...");
    process.exit(0);
  }, RESTART_INTERVAL);

  console.log(`[SYSTEM] Scheduled restart in 24 hours.`);
});
