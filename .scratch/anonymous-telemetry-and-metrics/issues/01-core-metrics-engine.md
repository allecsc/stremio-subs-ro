# 01 — Core In-Memory Metrics Engine & Anonymized Ingestion

**What to build:** Build an in-memory operational metrics engine that anonymously tracks daily active users (DAU) by computing one-way cryptographic `SHA-256(apiKey)` hashes without storing raw keys, IP addresses, or watch history. Maintain a rolling 30-day array of daily summary buckets recording unique active hashes, search counts, proxy stream counts, cache hit/miss counts, search and proxy latencies, match tier tallies, and archive format ratios (ZIP vs RAR), plus a 15-minute rolling window for live active user reporting.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] API keys are hashed with `SHA-256` before storage; raw keys and IP addresses are never retained.
- [x] Tracks distinct unique user hashes per 24-hour UTC calendar day.
- [x] Tracks live active unique user count within a rolling 15-minute window.
- [x] Maintains an in-memory rolling history of the last 30 days of metrics buckets.
- [x] Records search count, proxy stream count, cache hits/misses, search/proxy duration, match tier distribution, and archive format ratio.
- [x] Automated tests verify hash anonymization, daily bucket rollover, live active counting, and data serialization.

## Answer

Created `lib/metrics.js` with `MetricsEngine` and `hashApiKey`. Implemented SHA-256 one-way hashing for zero-PII user identification, 30-day bounded in-memory rolling history, 15-minute live active user window, and comprehensive telemetry ingestion for searches, proxy streams, cache hit rates, and match tier classification. Verified with 5 unit tests in `test/metrics.test.js`.
