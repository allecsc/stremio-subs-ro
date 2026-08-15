# 01 — Direct API Key Validation & Granular UI Feedback

**What to build:** Decouple key validation from internal search queues so validation calls `/quota` directly on `https://api.subs.ro/v1.0/quota` with a 5s timeout. The endpoint returns detailed status information (`valid`, `invalid_key`, `quota_exceeded`, `network_error`) and remaining quota, and the configuration page (`configure.html`) displays clear visual feedback for each scenario instead of a generic "Invalid" error.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] Validation endpoint `GET /api/validate/:apiKey` calls `/quota` directly without entering rate-limiter queues.
- [x] Returns `{ valid: true, quota: { remaining_quota, total_quota } }` for valid keys.
- [x] Returns `{ valid: false, status: 403, reason: "invalid_key" }` when Subs.ro returns 403.
- [x] Returns `{ valid: false, status: 429, reason: "quota_exceeded" }` when Subs.ro returns 429.
- [x] `configure.html` displays distinct messages for Valid, Invalid Key, and Quota Exceeded states.
- [x] Automated tests verify all 4 validation states.

## Answer

Decoupled `SubsRoClient.prototype.validate` from `globalLimiter`, making direct HTTP requests with a 5s timeout to `https://api.subs.ro/v1.0/quota`. Updated `server.js` to return the granular status payload, and updated `configure.html` with explicit messages for `Cotă Depășită ✕` / `Quota Exceeded ✕` and `Eroare Conexiune ✕` / `Connection Error ✕`. All 5 test cases in `test/validate.test.js` verified.
