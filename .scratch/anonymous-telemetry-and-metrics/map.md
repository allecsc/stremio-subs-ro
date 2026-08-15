# Wayfinder Map: Privacy-Preserving Anonymous Telemetry & Metrics

## Destination

An in-process, zero-PII operational metrics engine for the Subs.ro Stremio Addon tracking daily active users via SHA-256 API key hashing, request throughput, cache hit rate, latencies, archive format ratios, and scene match tier distributions over a rolling 30-day in-memory window, complete with an `/admin/stats` web dashboard and automated 00:00 UTC Discord/Telegram daily summary beacon.

## Notes

- Domain glossary: `CONTEXT.md`
- Architecture records: `docs/adr/0004-anonymous-telemetry-and-metrics.md`
- Specification: `.scratch/anonymous-telemetry-and-metrics/spec.md`
- Target platform: Dokku/BeamUp Node.js container

## Decisions so far

- [ADR 0004: Privacy-Preserving Anonymous Telemetry & Operational Metrics](../../docs/adr/0004-anonymous-telemetry-and-metrics.md) — Zero-PII user identification via `SHA-256(apiKey)`, 30-day in-memory rolling history, out-of-band daily summary beacon, and protected `/admin/stats` endpoint.

## Tickets

- [01 — Core In-Memory Metrics Engine & Anonymized Ingestion](issues/01-core-metrics-engine.md) (Status: `ready-for-agent`)
- [02 — Pipeline Hooks & Live Request Instrumentation](issues/02-pipeline-hooks-and-instrumentation.md) (Status: `ready-for-agent`, Blocked by: 01)
- [03 — Protected Admin Dashboard Route (`/admin/stats`)](issues/03-admin-dashboard-route.md) (Status: `ready-for-agent`, Blocked by: 02)
- [04 — Automated Daily Summary Beacon (Webhook Scheduler)](issues/04-daily-summary-beacon.md) (Status: `ready-for-agent`, Blocked by: 02)

## Work Status

Tickets published and ready for implementation.
