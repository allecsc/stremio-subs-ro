# 04 — Parallel Archive Traversal, 50MB Limit, and Dynamic Ranking

**What to build:** Remove the 10MB `maxContentLength` download ceiling, allowing archives up to 50MB to download without triggering `ERR_BAD_RESPONSE` failures. When a search returns multiple candidate subtitle archives, fetch and inspect them concurrently (capped at 4 parallel downloads via `Promise.allSettled`) to reduce manifest response times below 1.5 seconds. Eliminate the 15-minute static response cache so every video stream filename is dynamically ranked in real-time.

**Blocked by:** 02 — Concurrent Subs.ro Gateway & API v1.0 Endpoint Migration

**Status:** resolved

- [x] Archive downloads support archives up to 50MB.
- [x] Multiple archives from a search result are downloaded and unpacked in parallel with a concurrency cap of 4.
- [x] If one archive fails to download/unpack, other valid archives in the same search result still succeed.
- [x] Total manifest generation time remains fast (<1.5s).
- [x] Static 15-minute subtitle response cache is removed, enabling real-time per-stream dynamic ranking.
- [x] Automated tests verify parallel downloading, failure resilience, and dynamic ranking.

## Answer

Configured `maxContentLength: 50MB` and `maxBodyLength: 50MB` in `lib/subsro.js`. Implemented `mapConcurrent` in `addon.js` to process up to 4 archives simultaneously. Removed the 15-minute static response cache so every stream receives real-time 9-tier ranking. Verified with `test/parallel_traversal.test.js`.
