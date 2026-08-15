# 04 — Automated Daily Summary Beacon (Webhook Scheduler)

**What to build:** Implement a background scheduler that triggers once daily at 00:00 UTC to serialize the completed day's operational statistics and POST a formatted summary message to an optional `STATS_WEBHOOK_URL` (Discord / Telegram / Generic HTTP). If no webhook is configured, the scheduler silently archives the completed day into the in-memory 30-day history without logging errors or interrupting server execution.

**Blocked by:** 02 — Pipeline Hooks & Live Request Instrumentation

**Status:** resolved

- [x] Daily rollover triggers automatically at 00:00 UTC (or configured interval).
- [x] Formats a clear, human-readable summary (e.g. *"Subs.ro Addon: 412 active users, 5,830 requests, 94% cache hit rate, 88% exact sync"*).
- [x] Dispatches an HTTP POST payload to `process.env.STATS_WEBHOOK_URL` when configured.
- [x] Supports Discord webhook format, Telegram bot format, or generic JSON payload.
- [x] If `STATS_WEBHOOK_URL` is empty, scheduler runs in silent in-memory mode without errors.
- [x] Webhook timeouts and network errors are caught and logged without crashing the process.
- [x] Automated tests verify daily rollover triggering, payload formatting, and failure resilience.

## Answer

Created `lib/beacon.js` and wired `startBeaconScheduler()` to `server.js`. Implemented automatic 00:00 UTC midnight rollover calculation, formatted markdown daily summaries (DAU, requests, cache hit rate, sync accuracy, latencies, archive types), and dispatched async HTTP POST payloads to Discord, Telegram, or generic webhooks with complete exception isolation. Verified with 5 unit tests in `test/beacon.test.js`.
