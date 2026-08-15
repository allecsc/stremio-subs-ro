# Specification: Privacy-Preserving Anonymous Telemetry & Operational Metrics

**Status:** ready-for-agent

## Problem Statement

As the maintainer of the unofficial Subs.ro Stremio Addon on BeamUp/Dokku, I have zero operational visibility into how many active users rely on the addon daily, the volume of subtitle searches and stream proxy requests being handled, or whether the 9-tier scene matching algorithm accurately syncs video releases without falling back to fuzzy matches. Because the addon operates without a persistent database or user accounts, there is currently no way to track user adoption trends, measure memory/cache efficiency, or receive automated daily traffic summaries without compromising user privacy.

## Solution

Implement an in-process, privacy-preserving operational metrics engine that tracks daily active users (via irreversible one-way SHA-256 hashes of API keys), request throughput, cache hit rates, average search and proxy latencies, archive format distributions (ZIP vs RAR), and scene match tier distributions. The system maintains a 30-day rolling history in memory, exposes a password-protected visual dashboard (`/admin/stats`), and automatically dispatches an optional daily summary beacon at 00:00 UTC to a configured Discord/Telegram webhook.

## User Stories

1. As an addon maintainer, I want to know the count of unique daily active users (DAU) over 24-hour windows, so that I can monitor addon adoption without storing any personal user data.
2. As an addon maintainer, I want user requests to be counted using a one-way `SHA-256(apiKey)` hash, so that no raw API keys, IP addresses, or user identities are ever logged or retained.
3. As an addon maintainer, I want to see the daily volume of subtitle searches and stream proxy requests, so that I can understand overall traffic throughput.
4. As an addon maintainer, I want to measure the 60-second transient memory bridge cache hit rate, so that I can verify whether the 2-step Stremio manifest-to-stream bridge avoids redundant archive downloads.
5. As an addon maintainer, I want to track the statistical distribution of scene matching tiers (Tier 1 Exact, Tiers 2–5 Edition/Network/Source, vs Tier 10 Fuzzy Fallback), so that I know when new streaming platform tags or release patterns need to be added to the regex engine.
6. As an addon maintainer, I want to measure the ratio of ZIP vs RAR archive downloads, so that I can evaluate decompression overhead.
7. As an addon maintainer, I want to receive an optional daily summary message at 00:00 UTC via Discord/Telegram webhook, so that I stay informed of daily traffic spikes without having to manually log into a dashboard.
8. As an addon maintainer, I want to access a private, password-protected web dashboard at `/admin/stats?key=ADMIN_SECRET`, so that I can visually inspect 30-day historical trends and live 15-minute active counters.
9. As an addon maintainer running in an environment without a webhook configured, I want the telemetry module to function seamlessly in in-memory mode without throwing errors or halting server execution.
10. As a privacy-conscious Stremio user, I want the addon to never transmit my IP address, viewing history, or video title queries to any third-party analytics trackers, so that my privacy is strictly maintained.
11. As a Stremio player client, I want telemetry tracking to be completely non-blocking in memory (0ms network overhead), so that subtitle search and playback latency remain unaffected.

## Implementation Decisions

- **Cryptographic Anonymization**: Active users are uniquely distinguished per 24-hour window by computing `crypto.createHash('sha256').update(apiKey).digest('hex')`. The raw key is discarded immediately.
- **In-Memory Rolling Store**: The metrics engine maintains a 30-day rolling array of daily summary buckets in RAM. Each bucket records unique active hash count, total search requests, total proxy stream requests, cache hits/misses, archive format breakdown, upstream error counts, and match tier tallies.
- **Live Activity Window**: Tracks active unique user hashes within a 15-minute rolling window for live "Active Now" reporting on the dashboard.
- **Zero-Latency Ingestion**: Metrics recording occurs synchronously in-process with sub-millisecond execution time, introducing zero external network calls during subtitle search or streaming.
- **Daily Summary Beacon**: A scheduled cron/timer triggers daily at 00:00 UTC to serialize the completed day's snapshot and POST a formatted message to an optional `STATS_WEBHOOK_URL` (Discord / Telegram / Generic HTTP).
- **Administration Endpoint**: A dedicated Express route at `/admin/stats` protected by an `ADMIN_SECRET` environment variable renders an editorial, standalone HTML/CSS dashboard with 30-day historical trend charts. If `ADMIN_SECRET` is unset, the endpoint returns 404 Not Found.
- **Graceful Error Isolation**: Any exception in metrics ingestion or beacon dispatch is caught and isolated, guaranteeing that user subtitle requests and player playback never fail due to telemetry operations.

## Testing Decisions

- **Testing External Behavior**: Tests evaluate observable metrics aggregation, hash anonymization, rollover behavior, and dashboard authentication rather than internal variables.
- **Seam Placement**:
  - Metrics Engine Seam: Unit tests verify `recordSearch()`, `recordProxy()`, `recordMatchTier()`, live 15-minute active counting, and 24-hour midnight bucket rotation.
  - Anonymization Seam: Assert that `SHA-256` hashing produces consistent unique counts while completely excluding raw API keys and IP addresses.
  - Admin Route Seam: Assert that `GET /admin/stats` rejects unauthorized requests with 401/404 when `key` is missing or invalid, and returns HTTP 200 with HTML/JSON when authorized.
  - Beacon Seam: Assert that daily webhook dispatch produces valid markdown/JSON payloads when configured and fails gracefully when unconfigured or unreachable.
- **Prior Art**: Follow the established zero-dependency test runner patterns in `test/*.test.js`.

## Out of Scope

- External relational databases (PostgreSQL, MySQL, SQLite) or persistent file storage dependencies.
- Tracking individual video filenames, search queries, or user watch histories.
- Third-party client-side JavaScript tracking tags (Google Analytics, PostHog, Mixpanel).
- User authentication accounts or multi-tenant permission levels.

## Further Notes

Documented in:
- `docs/adr/0004-anonymous-telemetry-and-metrics.md`
- `CONTEXT.md`
