const express = require("express");
const cors = require("cors");
const path = require("path");
const querystring = require("querystring");
const dotenv = require("dotenv");

const helmet = require("helmet");
const { addonInterface, subtitlesHandler } = require("./addon");
const SubsRoClient = require("./lib/subsro");
const proxyRouter = require("./lib/proxy");
const adminRouter = require("./lib/adminStats");
const { startBeaconScheduler } = require("./lib/beacon");
const { startDiscordBot } = require("./lib/discordBot");
const {
  setupProcessAlarmHooks,
  notifyServerOnline,
  notifyServerShutdown,
} = require("./lib/alerts");

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

function categorizeRoute(urlPath) {
  if (!urlPath || typeof urlPath !== "string") return "/other";
  const normalized = urlPath.split("?")[0].replace(/\/+/g, "/");
  if (normalized === "/" || normalized === "/configure" || normalized.endsWith("/configure")) return "/configure";
  if (normalized === "/manifest" || normalized === "/manifest.json" || normalized.endsWith("/manifest") || normalized.endsWith("/manifest.json")) return "/manifest";
  if (normalized.includes("/subtitles/")) return "/subtitles";
  if (normalized.includes("/proxy/")) return "/proxy";
  if (normalized.startsWith("/api/validate")) return "/validate";
  if (normalized.startsWith("/admin")) return "/admin";
  if (normalized.startsWith("/public") || normalized.endsWith(".html") || normalized.endsWith(".css") || normalized.endsWith(".js") || normalized.endsWith(".png") || normalized.endsWith(".ico")) return "/static";
  return "/other";
}

// Manifest handler (shared by all manifest routes)
const manifestHandler = (req, res) => {
  const { config } = req.params;
  const userConfig = decodeConfig(config);
  const hasConfig = config && Object.keys(userConfig).length > 0;

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

function createApp() {
  const app = express();
  app.enable("trust proxy");

  app.use(
    helmet({
      contentSecurityPolicy: false, // Disable CSP to allow custom configuration page scripts/styles
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(cors());
  app.use(express.static(path.join(__dirname, "public")));

  // Request logger middleware: category-only route logging without sensitive query strings or path parameters
  app.use((req, res, next) => {
    const start = Date.now();
    const ts = new Date().toISOString().slice(11, 23);
    res.on("finish", () => {
      const duration = Date.now() - start;
      const category = categorizeRoute(req.originalUrl || req.url || req.path);
      console.log(`[${ts}] ${req.method} ${category} -> ${res.statusCode} (${duration}ms)`);
    });
    next();
  });

  app.use(proxyRouter);
  app.use(adminRouter);

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

  // Manifest routes (both /manifest and /manifest.json work)
  app.get("/manifest", manifestHandler);
  app.get("/manifest.json", manifestHandler);
  app.get("/:config/manifest", manifestHandler);
  app.get("/:config/manifest.json", manifestHandler);

  // API Validation Endpoint
  app.get("/api/validate/:apiKey", async (req, res) => {
    const { apiKey } = req.params;
    const client = new SubsRoClient(apiKey);
    const result = await client.validate();
    const ts = new Date().toISOString().slice(11, 23);
    if (result.valid) {
      console.log(`[${ts}] [AUTH] Key validated successfully (Quota: ${result.quota.remaining_quota}/${result.quota.total_quota})`);
    } else {
      console.log(`[${ts}] [AUTH] Key validation failed (Status: ${result.status}, Reason: ${result.reason})`);
    }
    res.json(result);
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

  return app;
}

function startServer(port = process.env.PORT || 7000) {
  dotenv.config();
  setupProcessAlarmHooks();

  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`🚀 Addon live on port ${port}`);
    console.log(`[INFO] Logs silenced for production.`);
    startBeaconScheduler();
    startDiscordBot();
    if (process.env.NODE_ENV) {
      notifyServerOnline(port).catch(() => {});
    }
  });

  // Graceful shutdown handling for BeamUp/Dokku container lifecycle
  const shutdown = async (signal) => {
    console.log(`[SYSTEM] Received ${signal}. Shutting down gracefully...`);
    try {
      await notifyServerShutdown(signal);
    } catch (_) {}
    server.close(() => {
      console.log("[SYSTEM] HTTP server closed cleanly.");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("[SYSTEM] Forcing shutdown after 5s timeout.");
      process.exit(1);
    }, 5000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { app, server };
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer,
  categorizeRoute,
  decodeConfig,
};
