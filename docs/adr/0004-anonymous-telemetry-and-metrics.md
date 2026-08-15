# 0004: Privacy-Preserving Anonymous Telemetry & Operational Metrics

## Context

To monitor addon adoption, traffic volume, and matching algorithm efficiency on BeamUp/Dokku without persistent database overhead or user privacy violations, the maintainer requires operational visibility into active users, request throughput, and matching tier distributions.

## Decision

1. **Zero-PII User Identification:** A user is anonymously identified by the one-way cryptographic hash of their Subs.ro API key (`SHA-256(apiKey)`). No IP addresses, user names, video titles, or IMDb/TMDB IDs are ever retained, stored, or transmitted.
2. **Ephemeral In-Memory Rolling History:** The server maintains a 30-day rolling daily history in RAM, tracking daily active users (DAU), total requests, cache hit rates, average latencies, archive format ratios (ZIP vs RAR), and scene matching tier distributions.
3. **Out-of-Band Daily Summary Push:** At 00:00 UTC, a background job dispatches a daily summary payload to an optional webhook (Discord / Telegram / Generic HTTP). If no webhook is configured, it operates silently in memory.
4. **Protected Administration View:** A lightweight visual dashboard is exposed at `/admin/stats?key=ADMIN_SECRET` to display historical 30-day trends and live 15-minute active counters.

## Consequences

* **Pros:** Complete operational visibility, zero third-party client trackers, zero outbound search latency, zero external database requirement, GDPR compliant by design.
* **Cons:** If the container restarts without an external webhook configured, historical in-memory metrics reset to the current day.
