# 07 — Host Compliance & Container Lifecycle Hardening

**What to build:** Configure `maxBodyLength: 50MB` alongside `maxContentLength` in Axios to prevent body stream buffer exceptions on multi-season archives. Enable Express `trust proxy` for correct protocol/host resolution behind BeamUp/Dokku reverse proxies. Replace the arbitrary 24-hour self-kill timeout with standard `SIGTERM`/`SIGINT` graceful shutdown handlers. Add defensive error handling in archive unpackers and clean proxy error messages.

**Blocked by:** 05 — Extracted WebVTT Memory Bridge & Romanian Diacritics Normalization

**Status:** resolved

- [x] Axios `maxBodyLength` set to 50MB alongside `maxContentLength`.
- [x] Express `trust proxy` enabled in `server.js`.
- [x] 24-hour `setTimeout(process.exit(0))` removed.
- [x] `SIGTERM` and `SIGINT` listeners close HTTP server with 5s hard cutoff.
- [x] Archive unpackers in `subtitleExtractor.js` wrapped in defensive `try/catch`.
- [x] Automated tests verified across all suites.

## Answer

Configured `maxBodyLength: 50MB` in `lib/subsro.js`. Updated `server.js` to enable `trust proxy`, removed the legacy 24h `process.exit(0)` self-kill, and implemented graceful `SIGTERM`/`SIGINT` shutdown listeners. Added defensive exception handling in `lib/subtitleExtractor.js` and `lib/proxy.js`. All 6 automated test suites pass cleanly.
