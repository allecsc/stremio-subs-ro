# 04 — Automated Daily Summary Beacon (Webhook Scheduler)

**What to build:** Implement a background scheduler that triggers once daily at 00:00 UTC to serialize the completed day's operational statistics and POST a formatted summary message to an optional `STATS_WEBHOOK_URL` (Discord / Telegram / Generic HTTP). If no webhook is configured, the scheduler silently archives the completed day into the in-memory 30-day history without logging errors or interrupting server execution.

**Blocked by:** 02 — Pipeline Hooks & Live Request Instrumentation

**Status:** ready-for-agent

- [ ] Daily rollover triggers automatically at 00:00 UTC (or configured interval).
- [ ] Formats a clear, human-readable summary (e.g. *"Subs.ro Addon: 412 active users, 5,830 requests, 94% cache hit rate, 88% exact sync"*).
- [ ] Dispatches an HTTP POST payload to `process.env.STATS_WEBHOOK_URL` when configured.
- [ ] Supports Discord webhook format, Telegram bot format, or generic JSON payload.
- [ ] If `STATS_WEBHOOK_URL` is empty, scheduler runs in silent in-memory mode without errors.
- [ ] Webhook timeouts and network errors are caught and logged without crashing the process.
- [ ] Automated tests verify daily rollover triggering, payload formatting, and failure resilience.
