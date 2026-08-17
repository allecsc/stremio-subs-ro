const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { configureSubtitlePipeline, resetSubtitlePipeline } = require("../../lib/subtitlePipeline");

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function createPipelineAcceptanceHarness({
  diskLimits = { maxBytes: 1024 * 1024, readyBytes: 512 * 1024 },
  now,
  getFreeSpaceRatio = async () => 0.8,
  createClient,
  archiveAdapter,
  convertTrack,
  onSchedulingEvent,
  onOperationalSignal,
  fileOps,
  createRarExtractor,
  onReadyHandoff,
  beforeConfigure,
} = {}) {
  const state = {
    searchResults: [],
    archives: new Map(),
    archiveDelays: new Map(),
    delayMs: 0,
    failure: null,
    requests: [],
  };
  let cacheRoot;
  let upstream;
  let configuredDeliveryBaseUrl;
  let configuredNow = now;
  let configuredArchiveAdapter = archiveAdapter;
  let configuredFileOps = fileOps;
  const configuredPipelines = [];

  try {
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subsro-pipeline-"));
    upstream = http.createServer(async (req, res) => {
      state.requests.push(req.url);
      const archiveMatch = req.url.match(/^\/v1\.0\/subtitle\/(\d+)\/download$/);
      const delayMs = archiveMatch ? (state.archiveDelays.get(archiveMatch[1]) || state.delayMs) : state.delayMs;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (state.failure) {
        res.writeHead(state.failure.status || 500);
        return res.end(state.failure.body || "controlled upstream failure");
      }
      if (req.url.startsWith("/v1.0/search/imdbid/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ items: state.searchResults }));
      }
      const downloadMatch = req.url.match(/^\/v1\.0\/subtitle\/(\d+)\/download$/);
      if (downloadMatch && state.archives.has(downloadMatch[1])) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(state.archives.get(downloadMatch[1]));
      }
      res.writeHead(404);
      res.end();
    });

    if (typeof beforeConfigure === "function") {
      await beforeConfigure({ cacheRoot });
    }

    await new Promise((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, () => {
        upstream.off("error", reject);
        resolve();
      });
    });
    const upstreamBaseUrl = `http://127.0.0.1:${upstream.address().port}/v1.0`;
    const configure = (deliveryBaseUrl) => {
      const configured = configureSubtitlePipeline({
        cacheRoot,
        diskLimits,
        subsRoBaseUrl: upstreamBaseUrl,
        deliveryBaseUrl: configuredDeliveryBaseUrl = deliveryBaseUrl || configuredDeliveryBaseUrl,
        fileOps: configuredFileOps,
        archiveAdapter: configuredArchiveAdapter,
        createClient,
        convertTrack,
        onSchedulingEvent,
        onOperationalSignal,
        now: configuredNow,
        getFreeSpaceRatio,
        createRarExtractor,
        onReadyHandoff,
      });
      configuredPipelines.push(configured);
      return configured;
    };
    const pipeline = configure();
    await pipeline.ready;

    return {
      cacheRoot,
      diskLimits,
      state,
      setDeliveryBaseUrl: configure,
      setFileOps: (nextFileOps) => {
        configuredFileOps = nextFileOps;
        return configure(configuredDeliveryBaseUrl);
      },
      setArchiveAdapter: (archiveAdapter) => {
        configuredArchiveAdapter = archiveAdapter;
        return configure(configuredDeliveryBaseUrl);
      },
      setNow: (nextNow) => {
        configuredNow = nextNow;
        return configure(configuredDeliveryBaseUrl);
      },
      setSearchResults: (results) => { state.searchResults = results; },
      setArchive: (subId, archive) => state.archives.set(String(subId), archive),
      setArchiveDelay: (subId, delayMs) => state.archiveDelays.set(String(subId), delayMs),
      setDelay: (delayMs) => { state.delayMs = delayMs; },
      failUpstream: (failure) => { state.failure = failure; },
      clearFailure: () => { state.failure = null; },
      countRequests: (prefix) => state.requests.filter((url) => url.startsWith(prefix)).length,
      close: async () => {
        const readiness = await Promise.allSettled(configuredPipelines.map((configured) => configured.ready));
        resetSubtitlePipeline();
        const results = await Promise.allSettled([
          closeServer(upstream),
          fs.rm(cacheRoot, { recursive: true, force: true }),
        ]);
        const errors = [...readiness, ...results]
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Acceptance harness cleanup was incomplete");
      },
    };
  } catch (error) {
    const readiness = await Promise.allSettled(configuredPipelines.map((configured) => configured.ready));
    resetSubtitlePipeline();
    const cleanup = await Promise.allSettled([
      closeServer(upstream),
      cacheRoot ? fs.rm(cacheRoot, { recursive: true, force: true }) : Promise.resolve(),
    ]);
    const cleanupErrors = [...readiness, ...cleanup]
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], "Acceptance harness setup failed and cleanup was incomplete", { cause: error });
    }
    throw error;
  }
}

module.exports = { createPipelineAcceptanceHarness, closeServer };
