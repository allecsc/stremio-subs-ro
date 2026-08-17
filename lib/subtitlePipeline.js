const SubsRoClient = require("./subsro");
const AdmZip = require("adm-zip");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { srtToVtt } = require("./subtitleExtractor");
const { createExtractorFromFile } = require("node-unrar-js");
const { isExcludedSubtitle, explicitSeason, matchesEpisode, hasRecognizableEpisode } = require("./matcher");

const MAX_USABLE_CONTENT_BYTES = 256 * 1024 * 1024;
const MAX_DECLARED_TRACKS = 1000;
const MAX_ACTIVE_DOWNLOADS = 8;
const DEFAULT_MAX_DISK_BYTES = 1024 * 1024 * 1024;
const DEFAULT_READY_DISK_BYTES = 512 * 1024 * 1024;
const DEFAULT_PACKAGE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_FREE_RATIO = 0.25;

class DiskCapacityError extends Error {
  constructor(message = "Insufficient managed disk capacity") {
    super(message);
    this.name = "DiskCapacityError";
    this.code = "DISK_CAPACITY";
  }
}

class CacheStateError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "CacheStateError";
    this.code = "CACHE_STATE_INVALID";
  }
}

class TaskGate {
  constructor({ limit, name, emit, observe, yieldBetween = false }) {
    this.limit = limit;
    this.name = name;
    this.emit = emit;
    this.observe = observe;
    this.yieldBetween = yieldBetween;
    this.yieldPending = false;
    this.active = 0;
    this.queue = [];
  }

  run(task, context = {}) {
    return new Promise((resolve, reject) => {
      const depth = this.queue.length + 1;
      this.queue.push({ task, context, resolve, reject, queuedAt: Date.now(), depth });
      this.emit({ type: `${this.name}-queued`, ...context, active: this.active, queued: this.queue.length });
      if (!this.yieldPending) this.drain();
    });
  }

  drain() {
    while (this.active < this.limit && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active += 1;
      this.emit({ type: `${this.name}-started`, ...job.context, active: this.active, queued: this.queue.length });
      this.observe({
        type: "queue",
        queue: this.name,
        waitMs: Math.max(0, Date.now() - job.queuedAt),
        depth: job.depth,
      });
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this.emit({ type: `${this.name}-finished`, ...job.context, active: this.active, queued: this.queue.length });
          if (this.yieldBetween) {
            this.yieldPending = true;
            setImmediate(() => {
              this.yieldPending = false;
              this.drain();
            });
          } else {
            this.drain();
          }
        });
    }
  }
}

class SimpleLRU {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    this.cache.delete(key);
    this.cache.set(key, item);
    return item;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, value);
  }
}

/**
 * The one boundary shared by subtitle discovery and subtitle delivery.
 * Tickets 02-07 own package preparation, reuse, scheduling, disk safety,
 * delivery recovery, and revision invalidation.
 */
function createSubtitlePipeline(options = {}) {
  const clientCache = new SimpleLRU(options.clientCacheSize || 500);
  const cacheRoot = options.cacheRoot || path.join(os.tmpdir(), "stremio-subs-ro-track-cache");
  const readyRoot = path.join(cacheRoot, "ready");
  const stagingRoot = path.join(cacheRoot, "staging");
  const packages = new Map();
  const protectedPackages = new Map();
  const activePackageUsers = new Map();
  const packageUserWaiters = new Map();
  const fileOps = options.fileOps || fs;
  const archiveAdapter = options.archiveAdapter;
  const createRarExtractor = options.createRarExtractor || createExtractorFromFile;
  const convertTrack = options.convertTrack || srtToVtt;
  const now = options.now || (() => new Date());
  const diskLimits = {
    maxBytes: options.diskLimits?.maxBytes ?? DEFAULT_MAX_DISK_BYTES,
    readyBytes: options.diskLimits?.readyBytes ?? DEFAULT_READY_DISK_BYTES,
    ttlMs: options.diskLimits?.ttlMs ?? DEFAULT_PACKAGE_TTL_MS,
    minFreeRatio: options.diskLimits?.minFreeRatio ?? DEFAULT_MIN_FREE_RATIO,
  };
  diskLimits.cleanupBytes = options.diskLimits?.cleanupBytes ?? Math.floor(diskLimits.maxBytes * 0.9);
  for (const [name, value] of Object.entries(diskLimits)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid disk limit: ${name}`);
  }
  if (diskLimits.readyBytes > diskLimits.maxBytes || diskLimits.cleanupBytes > diskLimits.maxBytes) {
    throw new Error("Invalid disk limits: trim and cleanup thresholds must not exceed the hard limit");
  }
  const emitSchedulingEvent = (event) => {
    if (typeof options.onSchedulingEvent !== "function") return;
    try {
      const result = options.onSchedulingEvent(event);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {
          // Diagnostics must never affect package preparation or delivery.
        });
      }
    } catch (_) {
      // Diagnostics must never affect package preparation or delivery.
    }
  };
  const emitOperationalSignal = (signal) => {
    try {
      if (typeof options.onOperationalSignal === "function") {
        const result = options.onOperationalSignal(Object.freeze({ ...signal }));
        if (result && typeof result.then === "function") {
          Promise.resolve(result).catch(() => {
            // Operational observation must never affect package preparation or delivery.
          });
        }
      } else {
        console.info(`[PIPELINE] ${JSON.stringify(signal)}`);
      }
    } catch (_) {
      // Operational observation must never affect package preparation or delivery.
    }
  };
  const downloadGate = new TaskGate({
    limit: MAX_ACTIVE_DOWNLOADS,
    name: "download",
    emit: emitSchedulingEvent,
    observe: emitOperationalSignal,
  });
  const extractionGate = new TaskGate({
    limit: 1,
    name: "extraction",
    emit: emitSchedulingEvent,
    observe: emitOperationalSignal,
    yieldBetween: true,
  });
  const conversions = new Map();
  let maintenanceTail = Promise.resolve();
  let reservedWriteBytes = 0;
  const createClient = options.createClient || ((apiKey) => {
    const client = new SubsRoClient(apiKey);
    if (options.subsRoBaseUrl) client.baseUrl = options.subsRoBaseUrl;
    return client;
  });

  const getClient = (apiKey) => {
    let client = clientCache.get(apiKey);
    if (!client) {
      client = createClient(apiKey);
      clientCache.set(apiKey, client);
    }
    return client;
  };

  const packageId = (subId) => {
    const id = String(subId);
    if (!/^\d+$/.test(id)) throw new Error("Invalid Subs.ro package ID");
    return id;
  };
  const normalizeUpdatedAt = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  };
  const hasLaterRevision = (prepared, context) => {
    const observed = normalizeUpdatedAt(context?.updatedAt);
    return Boolean(observed && prepared.updatedAt && Date.parse(observed) > Date.parse(prepared.updatedAt));
  };
  const stableTrackId = (originalPath) => crypto.createHash("sha256").update(originalPath).digest("base64url");
  const decodeLegacyTrackPath = (token) => {
    if (typeof token !== "string" || token.length === 0 || token.length > 2048) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
    if (token.length % 4 === 1) return null;
    try {
      const buffer = Buffer.from(token, "base64url");
      if (buffer.toString("base64url") !== token) return null;
      const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
      const decoded = utf8Decoder.decode(buffer);
      if (decoded.includes("\0") || decoded.includes("\uFFFD")) return null;
      return decoded;
    } catch {
      return null;
    }
  };
  const contentIntegrity = (content) => {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    return {
      contentBytes: buffer.length,
      contentHash: crypto.createHash("sha256").update(buffer).digest("hex"),
    };
  };
  const contentMatchesTrack = (content, track) => {
    const integrity = contentIntegrity(content);
    return integrity.contentBytes === track.contentBytes && integrity.contentHash === track.contentHash;
  };
  const isInside = (root, target, allowRoot = false) => {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return (allowRoot && relative === "") || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const ensureInside = (root, target, allowRoot = false) => {
    if (!isInside(root, target, allowRoot)) {
      throw new Error("Unsafe cache filesystem target");
    }
    return path.resolve(target);
  };
  const pathExists = async (target) => {
    try {
      await fileOps.lstat(target);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  };
  const validateResolvedTarget = async (root, target, allowRoot = false) => {
    ensureInside(root, target, allowRoot);
    const [rootInfo, targetInfo] = await Promise.all([fileOps.lstat(root), fileOps.lstat(target)]);
    if (rootInfo.isSymbolicLink() || targetInfo.isSymbolicLink()) {
      throw new Error("Unsafe cache filesystem target");
    }
    const [resolvedRoot, resolvedTarget] = await Promise.all([fileOps.realpath(root), fileOps.realpath(target)]);
    ensureInside(resolvedRoot, resolvedTarget, allowRoot);
  };
  const removeRecursively = async (root, target, { allowRoot = false } = {}) => {
    ensureInside(root, target, allowRoot);
    if (!await pathExists(target)) return;
    await validateResolvedTarget(root, target, allowRoot);
    await fileOps.rm(target, { recursive: true, force: true });
  };
  const removeTemporary = async (target) => {
    await removeRecursively(stagingRoot, target);
  };
  const removeArchive = async (target) => {
    ensureInside(stagingRoot, target);
    await fileOps.rm(target, { force: true });
  };
  const cleanupFailure = async (originalError, targets) => {
    const cleanupErrors = [];
    for (const [remove, target] of targets) {
      try {
        await remove(target);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length === 0) throw originalError;
    throw new AggregateError([originalError, ...cleanupErrors], "Package preparation failed and cleanup was incomplete", { cause: originalError });
  };
  const initializeOwnedStorage = async () => {
    await fileOps.mkdir(cacheRoot, { recursive: true });
    const cacheInfo = await fileOps.lstat(cacheRoot);
    if (cacheInfo.isSymbolicLink()) throw new Error("Unsafe cache filesystem target");
    const resolvedCacheRoot = await fileOps.realpath(cacheRoot);
    for (const root of [readyRoot, stagingRoot]) {
      ensureInside(cacheRoot, root);
      if (await pathExists(root)) {
        const rootInfo = await fileOps.lstat(root);
        if (rootInfo.isSymbolicLink()) throw new Error("Unsafe cache filesystem target");
        const resolvedRoot = await fileOps.realpath(root);
        ensureInside(resolvedCacheRoot, resolvedRoot);
        await removeRecursively(cacheRoot, root);
      }
      await fileOps.mkdir(root);
      await validateResolvedTarget(cacheRoot, root);
    }
  };
  const ready = initializeOwnedStorage();
  const scanBytes = async (target) => {
    let info;
    try {
      info = await fileOps.lstat(target);
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error("Unsafe cache filesystem target");
    if (!info.isDirectory()) return info.size;
    let bytes = 0;
    let names;
    try {
      names = await fileOps.readdir(target);
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
    for (const name of names) {
      bytes += await scanBytes(path.join(target, name));
    }
    return bytes;
  };
  const measureManagedBytes = async () => {
    const [readyBytes, stagingBytes] = await Promise.all([scanBytes(readyRoot), scanBytes(stagingRoot)]);
    return { readyBytes, stagingBytes, totalBytes: readyBytes + stagingBytes };
  };
  const emitCacheSize = async () => {
    try {
      const usage = await measureManagedBytes();
      emitOperationalSignal({ type: "cache-size", ...usage });
      return usage;
    } catch (_) {
      // Cache-size observation is isolated from the cache lifecycle.
      return null;
    }
  };
  const freeSpaceRatio = async () => {
    if (typeof options.getFreeSpaceRatio === "function") return Number(await options.getFreeSpaceRatio(cacheRoot));
    const stats = await fileOps.statfs(cacheRoot);
    const blocks = Number(stats.blocks);
    return blocks > 0 ? Number(stats.bavail) / blocks : 0;
  };
  const withMaintenance = (task) => {
    const operation = maintenanceTail.then(task, task);
    maintenanceTail = operation.catch(() => {});
    return operation;
  };
  const protectPackage = (id) => protectedPackages.set(id, (protectedPackages.get(id) || 0) + 1);
  const unprotectPackage = (id) => {
    const remaining = (protectedPackages.get(id) || 0) - 1;
    if (remaining > 0) protectedPackages.set(id, remaining);
    else protectedPackages.delete(id);
  };
  const beginPackageUse = (id) => activePackageUsers.set(id, (activePackageUsers.get(id) || 0) + 1);
  const endPackageUse = (id) => {
    const remaining = (activePackageUsers.get(id) || 0) - 1;
    if (remaining > 0) {
      activePackageUsers.set(id, remaining);
      return;
    }
    activePackageUsers.delete(id);
    const waiters = packageUserWaiters.get(id) || [];
    packageUserWaiters.delete(id);
    for (const resolve of waiters) resolve();
  };
  const waitForNoPackageUsers = (id) => {
    if (!activePackageUsers.has(id)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = packageUserWaiters.get(id) || [];
      waiters.push(resolve);
      packageUserWaiters.set(id, waiters);
    });
  };
  const isExpired = (prepared) => now().getTime() - Date.parse(prepared.lastAccessedAt) >= diskLimits.ttlMs;
  const beginEviction = async (id, prepared, reason, { allowProtectedWaiters = false } = {}) => {
    const current = packages.get(id);
    if (
      current?.state !== "ready" ||
      current.prepared !== prepared ||
      activePackageUsers.has(id) ||
      (!allowProtectedWaiters && protectedPackages.has(id))
    ) return false;
    let eviction;
    eviction = (async () => {
      try {
        await removeRecursively(readyRoot, prepared.directory);
        if (packages.get(id)?.eviction === eviction) packages.delete(id);
        emitSchedulingEvent({ type: "cache-evicted", packageId: id, reason });
        emitOperationalSignal({ type: "eviction", reason });
        await emitCacheSize();
        return true;
      } catch (error) {
        if (packages.get(id)?.eviction === eviction) packages.set(id, { state: "ready", prepared });
        throw error;
      }
    })();
    packages.set(id, { state: "evicting", prepared, eviction });
    return eviction;
  };
  const evictCandidates = () => [...packages.entries()]
    .filter(([id, entry]) => entry.state === "ready" && !protectedPackages.has(id))
    .sort(([, left], [, right]) => Date.parse(left.prepared.lastAccessedAt) - Date.parse(right.prepared.lastAccessedAt));
  const reclaimStorage = async ({ requiredBytes = 0, cold = false } = {}) => {
    let usage = await measureManagedBytes();
    for (const [id, entry] of evictCandidates().filter(([, candidate]) => isExpired(candidate.prepared))) {
      await beginEviction(id, entry.prepared, "expired");
      usage = await measureManagedBytes();
    }
    const freeRatio = await freeSpaceRatio();
    const shouldTrim = cold && (usage.totalBytes + reservedWriteBytes + requiredBytes >= diskLimits.cleanupBytes || freeRatio < diskLimits.minFreeRatio);
    if (shouldTrim || usage.totalBytes + reservedWriteBytes + requiredBytes > diskLimits.maxBytes) {
      for (const [id, entry] of evictCandidates()) {
        if (usage.readyBytes <= diskLimits.readyBytes && usage.totalBytes + reservedWriteBytes + requiredBytes <= diskLimits.maxBytes) break;
        await beginEviction(id, entry.prepared, "lru");
        usage = await measureManagedBytes();
      }
    }
    return { usage, freeRatio, shouldTrim };
  };
  const acceptColdWork = (id) => withMaintenance(async () => {
    await ready;
    const { usage, shouldTrim } = await reclaimStorage({ cold: true });
    if ((shouldTrim && usage.readyBytes > diskLimits.readyBytes) || usage.totalBytes + reservedWriteBytes >= diskLimits.maxBytes) {
      throw new DiskCapacityError(`Package ${id} cannot fit within the managed disk limit`);
    }
  });
  const reserveManagedWrite = (bytes, id) => withMaintenance(async () => {
    await ready;
    const requiredBytes = Number(bytes);
    if (!Number.isFinite(requiredBytes) || requiredBytes < 0) throw new DiskCapacityError("Invalid managed write size");
    const { usage } = await reclaimStorage({ requiredBytes, cold: true });
    if (usage.totalBytes + reservedWriteBytes + requiredBytes > diskLimits.maxBytes) {
      throw new DiskCapacityError(`Package ${id} cannot fit within the managed disk limit`);
    }
    reservedWriteBytes += requiredBytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      reservedWriteBytes -= requiredBytes;
    };
  });
  const writeManagedFile = async (root, target, content, writeOptions, id) => {
    ensureInside(root, target);
    const bytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content));
    const release = await reserveManagedWrite(bytes, id);
    try {
      await fileOps.writeFile(target, content, writeOptions);
    } finally {
      release();
    }
  };
  const writeManifestAtomically = async (directory, manifest) => {
    const destination = manifestPath(directory);
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    const content = JSON.stringify(manifest);
    ensureInside(readyRoot, destination);
    ensureInside(readyRoot, temporary);
    try {
      await writeManagedFile(readyRoot, temporary, content, { flag: "wx" }, path.basename(directory));
      await fileOps.rename(temporary, destination);
      return;
    } catch (originalError) {
      try {
        await fileOps.rm(temporary, { force: true });
      } catch (cleanupError) {
        throw new AggregateError([originalError, cleanupError], "Manifest publication failed and cleanup was incomplete", { cause: originalError });
      }
      throw originalError;
    }
  };
  const packageDirectory = (subId) => path.join(readyRoot, packageId(subId));
  const manifestPath = (directory) => path.join(directory, "manifest.json");
  const manifestState = (prepared, overrides = {}) => ({
    archiveType: prepared.archiveType,
    tracks: prepared.tracks,
    lastAccessedAt: prepared.lastAccessedAt,
    updatedAt: prepared.updatedAt,
    ...overrides,
  });
  const isSafeArchivePath = (candidate) => {
    if (typeof candidate !== "string" || !candidate || candidate.includes("\0")) return false;
    const normalized = candidate.replace(/\\/g, "/");
    return !normalized.startsWith("/") && !/^[a-z]:\//i.test(normalized) && !normalized.split("/").some((part) => part === ".." || part === "");
  };
  const isUsableEntry = (entry, context) => {
    if (!isSafeArchivePath(entry.originalPath)) throw new Error("Unsafe archive entry path");
    if (entry.directory || entry.originalPath.includes("__MACOSX") || !entry.originalPath.toLowerCase().endsWith(".srt") || isExcludedSubtitle(entry.originalPath)) return false;
    const entrySeason = explicitSeason(entry.originalPath);
    if (context?.season && entrySeason !== null && entrySeason !== context.season) return false;
    if (!context?.episode) return true;
    return hasRecognizableEpisode(entry.originalPath) || metadataIdentifiesEpisode(context.metadata, context.season, context.episode);
  };
  const metadataIdentifiesEpisode = (metadata, season, episode) => {
    if (!metadata) return false;
    return (metadata.season === season && metadata.episode === episode) || matchesEpisode(metadata.text, season, episode);
  };
  const validateHeaders = (entries, context) => {
    let usableBytes = 0;
    let usableTracks = 0;
    for (const entry of entries) {
      if (!isSafeArchivePath(entry.originalPath)) throw new Error("Unsafe archive entry path");
      if (!isUsableEntry(entry, context)) continue;
      usableTracks += 1;
      usableBytes += Number(entry.size) || 0;
      if (usableTracks > MAX_DECLARED_TRACKS || usableBytes > MAX_USABLE_CONTENT_BYTES) {
        throw new Error("Archive exceeds usable subtitle safety limits");
      }
    }
  };
  const readZipEntries = (archivePath) => {
    const zip = new AdmZip(archivePath);
    return zip.getEntries().map((entry) => ({
      originalPath: entry.entryName,
      size: entry.header.size,
      directory: entry.isDirectory,
      read: () => entry.getData(),
    }));
  };
  const readRarEntries = async (archivePath, scratchDirectory, id) => {
    const createExtractor = (outputName = "unselected.raw") => createRarExtractor({
      filepath: archivePath,
      targetPath: scratchDirectory,
      filenameTransform: () => outputName,
    });
    const lister = await createExtractor();
    const headers = [...lister.getFileList().fileHeaders];
    return headers.map((header, index) => ({
      originalPath: header.name,
      size: header.unpSize,
      directory: header.flags.directory,
      index,
      header,
      read: async () => {
        const outputName = `entry-${index}.raw`;
        const outputPath = path.join(scratchDirectory, outputName);
        ensureInside(stagingRoot, outputPath);
        const declaredSize = Number(header.unpSize);
        if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
          const error = new Error("RAR member has an invalid declared size");
          error.code = "RAR_SCRATCH_SAFETY";
          throw error;
        }
        let releaseReservation = await reserveManagedWrite(declaredSize, id);
        try {
          emitSchedulingEvent({ type: "rar-decoder-started", packageId: id, trackPath: header.name });
          const extractor = await createExtractor(outputName);
          const extracted = [...extractor.extract({ files: [header.name] }).files];
          if (extracted.length !== 1) throw new Error("RAR member was not extracted");
          const outputInfo = await fileOps.lstat(outputPath);
          if (outputInfo.isSymbolicLink() || outputInfo.size !== declaredSize) {
            const error = new Error("RAR member size did not match its declared size");
            error.code = "RAR_SCRATCH_SAFETY";
            throw error;
          }
          releaseReservation();
          releaseReservation = null;
          return await fileOps.readFile(outputPath);
        } catch (error) {
          const cleanupErrors = [];
          try {
            await removeArchive(outputPath);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          } finally {
            if (releaseReservation) releaseReservation();
          }
          if (cleanupErrors.length) {
            throw new AggregateError([error, ...cleanupErrors], "RAR extraction failed and scratch cleanup was incomplete", { cause: error });
          }
          throw error;
        }
      },
    }));
  };

  const queueManifestMutation = (prepared, mutation) => {
    prepared.manifestMutationsPending = (prepared.manifestMutationsPending || 0) + 1;
    const queued = prepared.manifestMutation.then(mutation).finally(() => {
      prepared.manifestMutationsPending -= 1;
    });
    prepared.manifestMutation = queued.catch(() => {});
    return queued;
  };
  const touchPackage = (prepared) => queueManifestMutation(prepared, async () => {
    const lastAccessedAt = now().toISOString();
    await writeManifestAtomically(prepared.directory, manifestState(prepared, { lastAccessedAt }));
    prepared.lastAccessedAt = lastAccessedAt;
  });
  const validateCachedPackage = async (prepared) => {
    try {
      const manifest = JSON.parse(await fileOps.readFile(manifestPath(prepared.directory), "utf8"));
      const expectedUpdatedAt = prepared.updatedAt ?? null;
      const mutationPending = () => (prepared.manifestMutationsPending || 0) > 0;
      if (
        !manifest ||
        manifest.archiveType !== prepared.archiveType ||
        manifest.updatedAt !== expectedUpdatedAt ||
        (!mutationPending() && manifest.lastAccessedAt !== prepared.lastAccessedAt) ||
        !Number.isFinite(Date.parse(manifest.lastAccessedAt)) ||
        !Array.isArray(manifest.tracks)
      ) {
        throw new Error("Cached package manifest does not match package state");
      }
      for (const actual of manifest.tracks) {
        if (
          !actual ||
          typeof actual.id !== "string" ||
          typeof actual.originalPath !== "string" ||
          typeof actual.fileName !== "string" ||
          !Number.isSafeInteger(actual.contentBytes) ||
          actual.contentBytes < 0 ||
          !/^[a-f0-9]{64}$/.test(actual.contentHash) ||
          !["srt", "vtt"].includes(actual.state)
        ) {
          throw new Error("Cached package track manifest is corrupt");
        }
        const storedName = actual.state === "vtt" ? actual.fileName.replace(/\.srt$/i, ".vtt") : actual.fileName;
        const storedPath = path.join(prepared.directory, storedName);
        ensureInside(readyRoot, storedPath);
        const info = await fileOps.lstat(storedPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== actual.contentBytes) {
          throw new Error("Cached package track size is missing or corrupt");
        }
        if (actual.state === "vtt") {
          const content = await fileOps.readFile(storedPath, "utf8");
          if (!content.startsWith("WEBVTT") || !contentMatchesTrack(content, actual)) {
            throw new Error("Cached WebVTT track is corrupt");
          }
        }
      }
      if ((prepared.manifestMutationsPending || 0) === 0) {
        if (manifest.tracks.length !== prepared.tracks.length) throw new Error("Cached package track count is corrupt");
        for (let index = 0; index < prepared.tracks.length; index += 1) {
          const expected = prepared.tracks[index];
          const actual = manifest.tracks[index];
          if (
            actual.id !== expected.id ||
            actual.originalPath !== expected.originalPath ||
            actual.fileName !== expected.fileName ||
            actual.state !== expected.state ||
            actual.contentBytes !== expected.contentBytes ||
            actual.contentHash !== expected.contentHash
          ) {
            throw new Error("Cached package track manifest does not match package state");
          }
        }
      }
    } catch (error) {
      if (error.code === "CACHE_STATE_INVALID") throw error;
      throw new CacheStateError("Cached package state is missing or corrupt", error);
    }
  };

  const prepareColdPackage = async (apiKey, subId, context) => {
    const id = packageId(subId);
    const token = crypto.randomUUID();
    const archivePath = path.join(stagingRoot, `${id}-${token}.zip`);
    const temporaryDirectory = path.join(stagingRoot, `${id}-${token}.package`);
    const publishedDirectory = packageDirectory(id);
    await acceptColdWork(id);
    const client = getClient(apiKey);
    ensureInside(stagingRoot, archivePath);
    ensureInside(stagingRoot, temporaryDirectory);
    ensureInside(readyRoot, publishedDirectory);
    try {
      await downloadGate.run(
        async () => {
          const startedAt = Date.now();
          let outcome = "success";
          try {
            await client.downloadArchiveToFile(id, archivePath, {
              beforeWrite: (bytes) => reserveManagedWrite(bytes, id),
            });
          } catch (error) {
            outcome = "failed";
            throw error;
          } finally {
            emitOperationalSignal({ type: "download", outcome, durationMs: Math.max(0, Date.now() - startedAt) });
          }
        },
        { packageId: id },
      );
      await withMaintenance(async () => {
        const { usage } = await reclaimStorage({ cold: true });
        if (usage.totalBytes + reservedWriteBytes > diskLimits.maxBytes) {
          throw new DiskCapacityError(`Package ${id} cannot fit within the managed disk limit`);
        }
      });
    } catch (error) {
      await cleanupFailure(error, [[removeArchive, archivePath], [removeTemporary, temporaryDirectory]]);
    }

    return extractionGate.run(async () => {
      const startedAt = Date.now();
      let outcome = "success";
      try {
        await fileOps.mkdir(temporaryDirectory);
        const archiveHandle = await fileOps.open(archivePath, "r");
        const signature = Buffer.alloc(8);
        try {
          await archiveHandle.read(signature, 0, signature.length, 0);
        } finally {
          await archiveHandle.close();
        }
        const archiveType = signature && signature.subarray(0, 4).toString("ascii") === "Rar!" ? "rar" : "zip";
        let entries;
        if (archiveAdapter) {
          entries = await archiveAdapter({ archivePath, archiveType, temporaryDirectory });
        } else if (archiveType === "rar") {
          const rarScratchDirectory = path.join(temporaryDirectory, "rar-scratch");
          ensureInside(stagingRoot, rarScratchDirectory);
          await fileOps.mkdir(rarScratchDirectory);
          entries = await readRarEntries(archivePath, rarScratchDirectory, id);
        } else {
          entries = readZipEntries(archivePath);
        }
        validateHeaders(entries, context);
        const tracks = [];
        const usableEntries = entries.filter((entry) => isUsableEntry(entry, context));
        for (const entry of usableEntries) {
          const originalPath = entry.originalPath;
          let content;
          try {
            content = await entry.read();
          } catch (error) {
            if (error.code === "DISK_CAPACITY" || error.code === "RAR_SCRATCH_SAFETY") throw error;
            console.warn(`[SUBS] Skipped unreadable ${archiveType.toUpperCase()} track: ${error.message}`);
            continue;
          }
          const fileName = `track-${tracks.length}.srt`;
          const trackPath = path.join(temporaryDirectory, fileName);
          ensureInside(stagingRoot, trackPath);
          await writeManagedFile(stagingRoot, trackPath, content, { flag: "wx" }, id);
          tracks.push({
            id: stableTrackId(originalPath),
            originalPath,
            fileName,
            state: "srt",
            ...contentIntegrity(content),
          });
        }
        if (archiveType === "rar" && !archiveAdapter) {
          const rarScratchDirectory = path.join(temporaryDirectory, "rar-scratch");
          await removeTemporary(rarScratchDirectory);
        }
        const temporaryManifest = manifestPath(temporaryDirectory);
        ensureInside(stagingRoot, temporaryManifest);
        const lastAccessedAt = now().toISOString();
        const updatedAt = normalizeUpdatedAt(context?.updatedAt);
        await writeManagedFile(
          stagingRoot,
          temporaryManifest,
          JSON.stringify({ archiveType, tracks, lastAccessedAt, updatedAt }),
          { flag: "wx" },
          id,
        );
        await removeArchive(archivePath);
        ensureInside(stagingRoot, temporaryDirectory);
        ensureInside(readyRoot, publishedDirectory);
        await fileOps.rename(temporaryDirectory, publishedDirectory);
        return {
          directory: publishedDirectory,
          archiveType,
          tracks,
          lastAccessedAt,
          updatedAt,
          manifestMutation: Promise.resolve(),
          manifestMutationsPending: 0,
        };
      } catch (error) {
        outcome = "failed";
        await cleanupFailure(error, [[removeArchive, archivePath], [removeTemporary, temporaryDirectory]]);
      } finally {
        emitOperationalSignal({ type: "extraction", outcome, durationMs: Math.max(0, Date.now() - startedAt) });
      }
    }, { packageId: id });
  };

  // The index is authoritative: only an absent ID starts cold work, a pending
  // ID exposes its one shared promise, and ready access is pinned before I/O.
  const startColdPreparation = (apiKey, subId, context) => {
    const id = packageId(subId);
    const existing = packages.get(id);
    if (existing?.state === "pending") return existing.preparation;
    if (existing?.state === "ready") return Promise.resolve(existing.prepared);
    if (existing?.state === "evicting") return existing.eviction.then(() => startColdPreparation(apiKey, id, context));

    const preparation = prepareColdPackage(apiKey, id, context)
      .then(async (prepared) => {
        const current = packages.get(id);
        let becameReady = false;
        if (current?.state === "pending" && current.preparation === preparation) {
          packages.set(id, { state: "ready", prepared });
          becameReady = true;
        }
        if (becameReady && typeof options.onReadyHandoff === "function") {
          try {
            await options.onReadyHandoff({ packageId: id, directory: prepared.directory });
          } catch (_) {
            // Deterministic test/diagnostic hooks must not alter package readiness.
          }
        }
        if (becameReady) {
          emitOperationalSignal({
            type: "package-outcome",
            outcome: prepared.tracks.length === 0 ? "empty" : "ready",
            trackCount: prepared.tracks.length,
          });
          await emitCacheSize();
        }
        return prepared;
      })
      .catch((error) => {
        const current = packages.get(id);
        if (current?.state === "pending" && current.preparation === preparation) {
          packages.delete(id);
        }
        if (error.code === "DISK_CAPACITY") {
          console.warn(`[SUBS] Package ${id} omitted: ${error.message}`);
          emitSchedulingEvent({ type: "cold-work-refused", packageId: id });
        }
        emitOperationalSignal({
          type: "package-outcome",
          outcome: error.code === "DISK_CAPACITY" ? "refused" : "failed",
        });
        throw error;
      });
    packages.set(id, { state: "pending", preparation });
    return preparation;
  };

  const invalidateReadyEntry = async (id, entry, reason) => {
    await waitForNoPackageUsers(id);
    return withMaintenance(() => beginEviction(
      id,
      entry.prepared,
      reason,
      { allowProtectedWaiters: true },
    ));
  };

  const withListedPackage = async (apiKey, subId, context, operation) => {
    const id = packageId(subId);
    protectPackage(id);
    try {
      await ready;
      let freshlyPrepared = null;
      let recoveryAttempted = false;
      let reuseReported = false;
      while (true) {
        const entry = packages.get(id);
        if (!entry) {
          if (!reuseReported) {
            emitOperationalSignal({ type: "cache-reuse", result: "miss" });
            reuseReported = true;
          }
          freshlyPrepared = await startColdPreparation(apiKey, id, context);
          continue;
        }
        if (entry.state === "pending") {
          if (!reuseReported) {
            emitOperationalSignal({ type: "cache-reuse", result: "shared" });
            reuseReported = true;
          }
          freshlyPrepared = await entry.preparation;
          continue;
        }
        if (entry.state === "evicting") {
          await entry.eviction;
          continue;
        }
        if (isExpired(entry.prepared)) {
          await waitForNoPackageUsers(id);
          const evicted = await withMaintenance(() => beginEviction(
            id,
            entry.prepared,
            "expired",
            { allowProtectedWaiters: true },
          ));
          if (evicted) freshlyPrepared = null;
          continue;
        }
        let invalidationReason = null;
        if (hasLaterRevision(entry.prepared, context)) {
          invalidationReason = "revision";
        } else {
          try {
            await validateCachedPackage(entry.prepared);
          } catch (error) {
            if (error.code !== "CACHE_STATE_INVALID") throw error;
            invalidationReason = "corrupt";
          }
        }
        if (invalidationReason) {
          if (recoveryAttempted) throw new CacheStateError(`Package ${id} remained invalid after one rebuild`);
          recoveryAttempted = true;
          const invalidated = await invalidateReadyEntry(id, entry, invalidationReason);
          if (invalidated) freshlyPrepared = null;
          continue;
        }
        beginPackageUse(id);
        if (packages.get(id) !== entry) {
          endPackageUse(id);
          continue;
        }
        try {
          if (!reuseReported) {
            emitOperationalSignal({ type: "cache-reuse", result: "hit" });
            reuseReported = true;
          }
          if (freshlyPrepared !== entry.prepared) await touchPackage(entry.prepared);
          return await operation(entry.prepared);
        } finally {
          endPackageUse(id);
        }
      }
    } finally {
      unprotectPackage(id);
    }
  };

  const getArchiveSrtList = async (apiKey, subId) => {
    try {
      return await withListedPackage(apiKey, subId, undefined, async (prepared) => {
        const ts = new Date().toISOString().slice(11, 23);
        console.log(`[${ts}] [SUBS] Prepared ${prepared.tracks.length} usable SRT tracks on disk`);
        return prepared.tracks.map((track) => track.originalPath);
      });
    } catch (error) {
      console.error(`[SUBS] Archive download failed:`, error.message);
      return [];
    }
  };

  const getArchiveTracks = async (apiKey, subId, context) => {
    return withListedPackage(apiKey, subId, context, async (prepared) => (
      prepared.tracks.map(({ id, originalPath }) => ({ id, originalPath }))
    ));
  };

  const deliverVtt = async ({ apiKey, subId, encodedSrtPath }) => {
    const id = packageId(subId);
    await ready;
    protectPackage(id);
    let rebuildAttempts = 0;
    let reuseReported = false;
    const rebuildOnce = async () => {
      if (rebuildAttempts >= 1) throw new CacheStateError(`Package ${id} could not be recovered after one rebuild`);
      rebuildAttempts += 1;
      await startColdPreparation(apiKey, id, undefined);
    };
    try {
      while (true) {
        const entry = packages.get(id);
        if (entry?.state === "pending") {
          if (!reuseReported) {
            emitOperationalSignal({ type: "cache-reuse", result: "shared" });
            reuseReported = true;
          }
          await entry.preparation;
          continue;
        }
        if (entry?.state === "evicting") {
          await entry.eviction;
          continue;
        }
        if (entry?.state !== "ready") {
          if (!reuseReported) {
            emitOperationalSignal({ type: "cache-reuse", result: "miss" });
            reuseReported = true;
          }
          await rebuildOnce();
          continue;
        }
        if (isExpired(entry.prepared)) {
          await invalidateReadyEntry(id, entry, "expired");
          await rebuildOnce();
          continue;
        }
        try {
          await validateCachedPackage(entry.prepared);
        } catch (error) {
          if (error.code !== "CACHE_STATE_INVALID") throw error;
          await invalidateReadyEntry(id, entry, "corrupt");
          await rebuildOnce();
          continue;
        }
        beginPackageUse(id);
        if (packages.get(id) !== entry) {
          endPackageUse(id);
          continue;
        }
        let packageUseActive = true;
        try {
          if (!reuseReported) {
            emitOperationalSignal({ type: "cache-reuse", result: "hit" });
            reuseReported = true;
          }
          const prepared = entry.prepared;
          let track = prepared.tracks.find((candidate) => candidate.id === encodedSrtPath);
          if (!track) {
            const legacyPath = decodeLegacyTrackPath(encodedSrtPath);
            if (legacyPath !== null) {
              track = prepared.tracks.find((candidate) => candidate.originalPath === legacyPath);
            }
          }
          if (!track) return { vttContent: null, archiveType: prepared.archiveType, cacheHit: rebuildAttempts === 0 };
          emitSchedulingEvent({ type: "delivery-track-requested", packageId: id, trackId: track.id });

          const srtFile = path.join(prepared.directory, track.fileName);
          const vttFile = srtFile.replace(/\.srt$/i, ".vtt");
          ensureInside(readyRoot, srtFile);
          ensureInside(readyRoot, vttFile);
          if (track.state === "vtt") {
            let vttContent;
            try {
              vttContent = await fileOps.readFile(vttFile, "utf8");
            } catch (error) {
              throw new CacheStateError("Prepared WebVTT track is missing or unreadable", error);
            }
            if (!vttContent.startsWith("WEBVTT")) throw new CacheStateError("Prepared WebVTT track is corrupt");
            await touchPackage(prepared);
            return { vttContent, archiveType: prepared.archiveType, cacheHit: rebuildAttempts === 0 };
          }
          const conversionKey = `${id}:${track.id}`;
          const existingConversion = conversions.get(conversionKey);
          if (existingConversion) return await existingConversion;

          const conversion = (async () => {
            emitSchedulingEvent({ type: "conversion-started", packageId: id, trackId: track.id });
            const startedAt = Date.now();
            let outcome = "success";
            try {
              let srt;
              try {
                srt = await fileOps.readFile(srtFile);
              } catch (error) {
                throw new CacheStateError("Cached SRT track is missing or unreadable", error);
              }
              if (!contentMatchesTrack(srt, track)) throw new CacheStateError("Cached SRT track is corrupt");
              const vttContent = await convertTrack(srt);
              await queueManifestMutation(prepared, async () => {
                const temporaryVtt = `${vttFile}.${crypto.randomUUID()}.tmp`;
                ensureInside(readyRoot, temporaryVtt);
                const previousTracks = prepared.tracks;
                const previousLastAccessedAt = prepared.lastAccessedAt;
                let publishedManifest = false;
                try {
                  await fileOps.rm(vttFile, { force: true });
                  await writeManagedFile(readyRoot, temporaryVtt, vttContent, { flag: "wx" }, id);
                  await fileOps.rename(temporaryVtt, vttFile);
                  const nextTrack = { ...track, state: "vtt", ...contentIntegrity(vttContent) };
                  const nextTracks = prepared.tracks.map((candidate) => candidate.id === track.id ? nextTrack : candidate);
                  const lastAccessedAt = now().toISOString();
                  await writeManifestAtomically(prepared.directory, manifestState(prepared, { tracks: nextTracks, lastAccessedAt }));
                  publishedManifest = true;
                  await fileOps.rm(srtFile, { force: false });
                  prepared.tracks = nextTracks;
                  prepared.lastAccessedAt = lastAccessedAt;
                } catch (error) {
                  const cleanupErrors = [];
                  if (publishedManifest) {
                    try {
                      await writeManifestAtomically(prepared.directory, manifestState(prepared, { tracks: previousTracks, lastAccessedAt: previousLastAccessedAt }));
                    } catch (rollbackError) {
                      cleanupErrors.push(rollbackError);
                    }
                  }
                  for (const target of [temporaryVtt, vttFile]) {
                    try { await fileOps.rm(target, { force: true }); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
                  }
                  if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Track conversion failed and cleanup was incomplete", { cause: error });
                  throw error;
                }
              });
              return { vttContent, archiveType: prepared.archiveType, cacheHit: rebuildAttempts === 0 };
            } catch (error) {
              outcome = "failed";
              throw error;
            } finally {
              emitSchedulingEvent({ type: "conversion-finished", packageId: id, trackId: track.id });
              emitOperationalSignal({ type: "conversion", outcome, durationMs: Math.max(0, Date.now() - startedAt) });
            }
          })();
          conversions.set(conversionKey, conversion);
          try {
            return await conversion;
          } finally {
            if (conversions.get(conversionKey) === conversion) conversions.delete(conversionKey);
          }
        } catch (error) {
          if (error.code !== "CACHE_STATE_INVALID") throw error;
          endPackageUse(id);
          packageUseActive = false;
          await invalidateReadyEntry(id, entry, "corrupt");
          await rebuildOnce();
          continue;
        } finally {
          if (packageUseActive) endPackageUse(id);
        }
      }
    } finally {
      unprotectPackage(id);
    }
  };

  return {
    ready,
    options: {
      cacheRoot,
      diskLimits: options.diskLimits,
      deliveryBaseUrl: options.deliveryBaseUrl,
    },
    getClient,
    getArchiveSrtList,
    getArchiveTracks,
    deliverVtt,
  };
}

let activePipeline = createSubtitlePipeline();

function getSubtitlePipeline() {
  return activePipeline;
}

function configureSubtitlePipeline(options = {}) {
  activePipeline = createSubtitlePipeline(options);
  return activePipeline;
}

function resetSubtitlePipeline() {
  activePipeline = createSubtitlePipeline();
  return activePipeline;
}

module.exports = {
  createSubtitlePipeline,
  getSubtitlePipeline,
  configureSubtitlePipeline,
  resetSubtitlePipeline,
};
