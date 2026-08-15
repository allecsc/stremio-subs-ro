# 01 — Core In-Memory Metrics Engine & Anonymized Ingestion

**What to build:** Build an in-memory operational metrics engine that anonymously tracks daily active users (DAU) by computing one-way cryptographic `SHA-256(apiKey)` hashes without storing raw keys, IP addresses, or watch history. Maintain a rolling 30-day array of daily summary buckets recording unique active hashes, search counts, proxy stream counts, cache hit/miss counts, search and proxy latencies, match tier tallies, and archive format ratios (ZIP vs RAR), plus a 15-minute rolling window for live active user reporting.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] API keys are hashed with `SHA-256` before storage; raw keys and IP addresses are never retained.
- [ ] Tracks distinct unique user hashes per 24-hour UTC calendar day.
- [ ] Tracks live active unique user count within a rolling 15-minute window.
- [ ] Maintains an in-memory rolling history of the last 30 days of metrics buckets.
- [ ] Records search count, proxy stream count, cache hits/misses, search/proxy duration, match tier distribution, and archive format ratio.
- [ ] Automated tests verify hash anonymization, daily bucket rollover, live active counting, and data serialization.
