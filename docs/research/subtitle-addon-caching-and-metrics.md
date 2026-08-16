# Research: Subtitle Addon Architecture, Caching Standards & Operational Telemetry

## 1. Executive Summary & Problem Context

* **Domain:** Stremio Subtitle Addon Architecture (`stremio-addon-sdk`, BeamUp / Dokku container hosting).
* **Observed Load:** 400+ DAU, 70+ concurrent requests, momentary 100% CPU spikes during concurrent `.rar`/`.zip` decompression bursts.
* **Goal:** Establish industry standards for archive caching TTLs, client-side cache control, failure resilience, and persistent long-term metrics without adding external infrastructure costs.

---

## 2. Stremio Subtitle Caching Standards (Primary Sources)

### 2.1. Client-Side Protocol Caching (`cacheMaxAge`)
* **Reference:** `stremio-addon-sdk` specification (`docs/api/responses/subtitles.md`).
* **Behavior:** Stremio's subtitle resolution is pull-based. When playback initializes, the client queries all installed subtitle addons concurrently.
* **Standard Practice:**
  * By default, without `cacheMaxAge`, Stremio clients may re-query the addon on stream changes, audio track toggles, or pause/resume events.
  * Adding `cacheMaxAge: 3600` (1 hour) or `7200` (2 hours) to the handler response instructs the Stremio desktop, Android, and TV clients to cache subtitle search results locally.
  * **Result:** Eliminates redundant upstream queries for users pausing or seeking videos.

### 2.2. Addon-Side Caching (OpenSubtitles v3, SubDL, SubSense)
* **Reference:** OpenSubtitles v3 / SubDL community addon implementations.
* **Two-Layer Caching Hierarchy:**
  1. **Layer 1: Query Metadata Cache (Search TTL: 1 to 4 hours):**
     * Maps `imdbId` / `tmdbId` + language to the ranked list of subtitle tracks.
     * Stored in an in-memory LRU cache.
     * When 50 users watch the same trending movie on Friday evening, only the **first** request queries Subs.ro; the subsequent 49 requests are served in **<2ms with 0 upstream API calls and 0 CPU decompression**.
  2. **Layer 2: Unpacked WebVTT Stream Cache (Stream TTL: 15 to 30 minutes):**
     * Stores pre-extracted, normalized WebVTT subtitle text by `archiveId:fileIndex`.
     * Memory footprint: Average WebVTT file is ~80 KB. An LRU store of 300 active subtitle tracks consumes **~24 MB of RAM** (well below BeamUp's 512 MB threshold).
     * **Result:** Solves the 100% CPU spike issue by ensuring archives are decompressed at most once per release window.

---

## 3. Persistent Long-Term Metrics on Ephemeral Containers

### 3.1. The BeamUp/Dokku Ephemeral Container Constraint
* Dokku rebuilds and deploys new containers on git pushes or server restarts. Local in-container files are wiped upon recreation unless backed up out-of-band.

### 3.2. Recommended Zero-Dependency Persistence Architecture
* **Daily In-Memory Rollups (7-Day Error Log & 30-Day Daily Traffic):**
  * Stored in RAM during runtime.
* **Automated Daily Discord Snapshot Beacon (00:00 UTC):**
  * Every midnight, the server posts a structured JSON/embed snapshot of the 30-day history and all-time user counts to the Discord webhook channel.
* **On-Boot Hydration / Long-Term Tracking:**
  * Cumulative all-time install hashes stored in a bounded in-memory Set (`Set<SHA-256>` taking ~320 KB per 10,000 users).
  * 7-day error diagnostic log retaining distinct error taxonomy, sanitized query context, occurrence frequency, and first/last seen timestamps.

---

## 4. Metrics Feasibility Matrix (What Platforms Track vs Stateless Addons)

| Metric | Feasibility in Stremio Addon | Value | Rationale |
| :--- | :--- | :--- | :--- |
| **Live Active (15m)** | ✅ **100% Feasible** | High | Shows real-time concurrent viewership. |
| **Today's DAU (24h)** | ✅ **100% Feasible** | High | Daily unique audience count. |
| **30-Day MAU** | ✅ **100% Feasible** | Critical | Industry standard user base benchmark. |
| **All-Time Installs** | ✅ **100% Feasible** | Critical | Cumulative unique hashed configs seen. |
| **Search-to-Stream Ratio** | ✅ **100% Feasible** | High | Conversion rate of subtitle searches to active video playback. |
| **Hourly Peak Distribution** | ✅ **100% Feasible** | Medium | Identifies server rush hours (e.g. 20:00–23:00 UTC+3). |
| **7-Day Error Diagnostics** | ✅ **100% Feasible** | Critical | Verifies if bug fixes eliminate error classes over time. |
| **Watch Duration / Time Online** | ❌ **Not Feasible** | None | Stremio does not emit playback heartbeats; requests are stateless HTTP pulls. |
