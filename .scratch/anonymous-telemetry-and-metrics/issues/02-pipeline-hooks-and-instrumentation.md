# 02 — Pipeline Hooks & Live Request Instrumentation

**What to build:** Wire the metrics engine into `addon.js`, `lib/proxy.js`, and `server.js` to record search requests, playback stream requests, 60s memory bridge cache hits vs on-demand downloads, match tier distribution (Tiers 1–10), and archive decompression types in real-time. Ingestion runs with 0ms external latency, and any unexpected error inside the metrics recorder is caught and isolated to guarantee that user playback never fails due to telemetry.

**Blocked by:** 01 — Core In-Memory Metrics Engine & Anonymized Ingestion

**Status:** ready-for-agent

- [ ] `addon.js` records subtitle search events with response latency and highest matched tier score.
- [ ] `lib/proxy.js` records subtitle stream proxy events with cache hit (0ms memory bridge) vs cache miss (on-demand download) status.
- [ ] Subtitle archive decompression records whether `.zip` or `.rar` was unpacked.
- [ ] Upstream HTTP errors (429 quota exceeded, 403 invalid key, socket retries) are recorded.
- [ ] Telemetry ingestion adds 0ms external network latency to the request lifecycle.
- [ ] All telemetry hook calls are wrapped in exception isolation so telemetry failures never crash or disrupt subtitle playback.
- [ ] Automated tests verify end-to-end event recording during search and stream requests.
