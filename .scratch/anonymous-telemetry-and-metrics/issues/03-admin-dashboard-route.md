# 03 — Protected Admin Dashboard Route (`/admin/stats`)

**What to build:** Expose a dedicated Express route at `/admin/stats` protected by an `ADMIN_SECRET` environment variable or query token (`/admin/stats?key=...`). When authorized, the route renders an editorial, standalone HTML/CSS dashboard visualizing daily active users, total search and stream volume, cache hit rates, average latencies, archive format ratios (ZIP vs RAR), and scene match tier distributions over the last 30 days, alongside live 15-minute active counters. When unauthorized or if `ADMIN_SECRET` is unset, the endpoint returns 404 Not Found.

**Blocked by:** 02 — Pipeline Hooks & Live Request Instrumentation

**Status:** resolved

- [x] Route `GET /admin/stats` requires a valid query token matching `process.env.ADMIN_SECRET`.
- [x] Returns HTTP 404 / 401 when `ADMIN_SECRET` is unconfigured or token is invalid.
- [x] Returns JSON data when requested via `Accept: application/json` or `?format=json`.
- [x] Renders a standalone, responsive HTML/CSS dashboard with 30-day historical trend graphs and live 15m active counters.
- [x] Dashboard displays match tier distribution (% exact vs platform tags vs fallback) and cache hit rate.
- [x] Automated tests verify route authorization, JSON serialization, and 404 protection.

## Answer

Created `lib/adminStats.js` and mounted on `server.js`. Implemented `ADMIN_SECRET` query/bearer protection returning 404 on unauthenticated access. Added `?format=json` JSON API format and a responsive standalone HTML dashboard displaying live 15m active users, 24h DAU, request volume, cache hit rates, sync tier distributions, and 30-day daily historical tables with 30s auto-refresh. Verified with 5 tests in `test/admin_stats.test.js`.
