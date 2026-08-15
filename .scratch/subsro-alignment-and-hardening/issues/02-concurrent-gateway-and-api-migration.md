# 02 — Concurrent Subs.ro Gateway & API v1.0 Endpoint Migration

**What to build:** Update the Subs.ro client to target the official OpenAPI endpoint (`https://api.subs.ro/v1.0`), ensuring all URL paths are sanitized with no double slashes. Eliminate the global 1-request-per-second bottleneck queue and the destructive `globalLimiter.clearQueues()` call, allowing concurrent pass-through requests per user with exponential backoff on transient network glitches.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] All API URLs point to `https://api.subs.ro/v1.0` with no trailing/double slashes.
- [x] `clearQueues()` is completely removed from the request lifecycle.
- [x] Multiple users can execute searches and downloads concurrently without waiting in a single global 1-second line.
- [x] Retries with exponential backoff handle transient network errors (ECONNRESET, ETIMEDOUT).
- [x] Automated tests verify concurrent request dispatch and URL formatting.

## Answer

Migrated `SubsRoClient` and proxy endpoints to `https://api.subs.ro/v1.0` with sanitized path parameters. Completely eliminated `globalLimiter.clearQueues()` and global request serialization. Implemented non-blocking concurrent request execution with exponential backoff retry on transient socket errors. Verified 5 concurrent requests execute in 8ms (down from 5017ms) via `test/gateway.test.js`.
