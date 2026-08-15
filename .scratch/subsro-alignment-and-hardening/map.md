# Wayfinder Map: Subs.ro Addon Alignment & Hardening

## Destination

A hardened, high-performance Stremio subtitle addon connecting to the official Subs.ro API v1.0 with direct key validation, concurrent pass-through proxying on BeamUp, 9-tier scene synchronization, lightweight extracted WebVTT memory bridge, and Romanian diacritic normalization.

## Notes

- Domain glossary: `CONTEXT.md`
- Architecture records: `docs/adr/`
- Target platform: Dokku/BeamUp Node.js container

## Decisions so far

- [ADR 0001: Concurrent Pass-Through Architecture](../../docs/adr/0001-concurrent-pass-through-architecture.md) — Eliminated global serialized queues and destructive cancellations in favor of concurrent pass-through proxying.
- [ADR 0002: Transient In-Memory Archive Bridge](../../docs/adr/0002-transient-in-memory-archive-bridge.md) — 60s transient buffer between search and playback to prevent double downloads without memory bloat.
- [ADR 0003: Video Release Matching Hierarchy & Exclusions](../../docs/adr/0003-scene-matching-hierarchy.md) — 9-tier scoring prioritizing Edition and Source+Network, with auto-exclusion of `FORCED` and `CD1/CD2`.
- [01 — Direct API Key Validation & Granular UI Feedback](issues/01-direct-key-validation.md) — Decoupled validation from rate-limiter queues; implemented direct 5s `/quota` validation with explicit UI feedback for valid, invalid, quota-exceeded, and network errors. (Status: `resolved`)
- [02 — Concurrent Subs.ro Gateway & API v1.0 Endpoint Migration](issues/02-concurrent-gateway-and-api-migration.md) — Migrated all endpoints to `https://api.subs.ro/v1.0`; removed global queue serialization and `clearQueues()`, enabling concurrent pass-through dispatch. (Status: `resolved`)
- [03 — Multi-Identifier Search, Guarding, and 9-Tier Scene Matching](issues/03-multi-identifier-search-and-guarding.md) — Added TMDB search, IPTV stream guarding, upstream language parameter passing, auto-exclusion of `FORCED` and `CD1/CD2`, and 9-tier scene matching engine. (Status: `resolved`)
- [04 — Parallel Archive Traversal, 50MB Limit, and Dynamic Ranking](issues/04-parallel-archive-traversal-and-limits.md) — 4-worker parallel archive downloads, 50MB ceiling, and dynamic per-stream ranking without static response cache pollution. (Status: `resolved`)
- [05 — Extracted WebVTT Memory Bridge & Romanian Diacritics Normalization](issues/05-diacritics-normalization-and-transient-bridge.md) — Extract into ~50KB WebVTT strings immediately, 60s transient bridge, Windows-1250/UTF-8 decoding, and Romanian cedilla `ş`/`ţ` normalization into `ș`/`ț`. (Status: `resolved`)
- [06 — Stremio Subtitle Release Labeling](issues/06-stremio-subtitle-release-labeling.md) — Closed as `wontfix` to preserve Stremio ISO 639-2 protocol compatibility and player auto-selection.
- [07 — Host Compliance & Container Lifecycle Hardening](issues/07-host-compliance-and-lifecycle.md) — Configured `maxBodyLength: 50MB` in Axios, enabled `trust proxy`, removed legacy 24h self-kill in favor of graceful `SIGTERM`/`SIGINT` container draining, and added defensive archive decompression. (Status: `resolved`)

## Work Status

All roadmap items and tickets are fully implemented, verified, and closed.
