# Primary-Source Study: Similar Stremio Subtitle Addons

## Scope and method

This note examines the repositories named in the recovery request, using their
tracked source, configuration, and README files as primary sources. It reports
what the repositories demonstrate, not claims about their live production
deployments where the source does not establish one. In particular, a
repository's cache implementation is evidence of a design choice, **not** a
memory-safe limit or a recommendation to copy it.

This supplements, and corrects where necessary, the older comparative notes in
this directory. Several of their asserted implementation details could not be
confirmed in the actual repositories inspected here.

## Findings at a glance

| Repository | Durable state | Runtime cache | Operational lesson |
| --- | --- | --- | --- |
| [Stremio Community Subtitles](https://github.com/skoruppa/stremio-community-subtitles) | MariaDB volume by default; optional SQLite file or external database | A five-minute in-process dictionary with no capacity bound | Persist user/community data separately from a disposable application container, but do not copy its unbounded process cache. |
| [stremio-opensubtitles](https://github.com/dexter21767/stremio-opensubtitles) | None shown | Three 30-minute `node-cache` caches, with no max-key/byte limit | Split cache domains (result, metadata, provider list), but give every memory cache an explicit capacity as well as a TTL. |
| [Stremio-SubSense](https://github.com/NepiRaw/Stremio-SubSense) | SQLite/LibSQL cache mounted under `/app/data` in self-hosted Docker | 30-day configured persistent cache, plus configurable result caps | A durable cache must live on mounted/shared storage; cap result cardinality before retaining it. |
| [StremioSubMaker](https://github.com/xtremexq/StremioSubMaker) | Pluggable filesystem/Redis storage adapters | Value-bearing shared translation cache | Put storage behind an interface and test backend timeouts; do not presume a container filesystem is the interface. |

## 1. `skoruppa/stremio-community-subtitles`

### Storage, deployment, and lifecycle

The self-hosted Compose file starts an application and MariaDB service. MariaDB
uses a named `db_data` volume; the application has separate bind mounts for
data, logs, and subtitles, applies an application memory limit of 2 GB, and
defines a 30-second healthcheck. This is a conventional answer for a product
that stores accounts, uploads, selections, and votes: application containers
may be replaced, while the database storage survives.

Sources: [Compose deployment](https://github.com/skoruppa/stremio-community-subtitles/blob/main/docker-compose.yml), [self-hosting README](https://github.com/skoruppa/stremio-community-subtitles/blob/main/README.md#-self-hosting-with-docker).

The configuration supports either a SQLite file under the application
`instance` directory or a database URL (PostgreSQL is named in a comment), but
the provided Compose default points to MariaDB. SQLite is therefore only
durable when its containing directory is mounted or otherwise survives
replacement; the configuration alone does not make it persistent.

Source: [database configuration](https://github.com/skoruppa/stremio-community-subtitles/blob/main/config.py).

### Cache and matching

The application has a custom asynchronous in-memory cache. Its entries expire
on lookup and it supports memoization, but it has no maximum entry count,
maximum bytes, eviction policy, or background expiry sweep. The configured
default timeout is 300 seconds. This is useful evidence that a TTL alone does
not bound a cache's memory consumption.

Sources: [async cache](https://github.com/skoruppa/stremio-community-subtitles/blob/main/app/extensions.py), [cache configuration](https://github.com/skoruppa/stremio-community-subtitles/blob/main/config.py).

Selection is a hierarchy rather than a single release-name score: saved user
selection, locally uploaded subtitle by video hash, provider hash match,
filename scoring, then a fallback. The code uses video hashes, season/episode,
language, provider metadata, and forced status; it sorts candidate scores and
can prioritise forced tracks. That hierarchy is relevant to Subs.ro matching,
but the associated persistent user/community model is far broader than this
addon needs.

Sources: [selection hierarchy](https://github.com/skoruppa/stremio-community-subtitles/blob/main/app/routes/utils.py), [project feature description](https://github.com/skoruppa/stremio-community-subtitles/blob/main/README.md#-features).

### Secrets, errors, and telemetry

Secrets are configured through environment variables, including the session
secret, database URL, provider keys, and Better Stack token. Better Stack
logging is optional and only enabled when both its flag and token are present.

Sources: [environment template](https://github.com/skoruppa/stremio-community-subtitles/blob/main/.env.docker.example), [logging setup](https://github.com/skoruppa/stremio-community-subtitles/blob/main/app/__init__.py).

This is not a privacy-safe logging model to copy wholesale: several provider
error paths log filenames, IDs, usernames, URLs, and request parameters. For
Subs.ro, operational logging must instead use a deliberately sanitised event
schema and never record configuration URLs or API-key material.

Sources: [Napisy24 provider client](https://github.com/skoruppa/stremio-community-subtitles/blob/main/app/providers/napisy24/client.py), [OpenSubtitles provider client](https://github.com/skoruppa/stremio-community-subtitles/blob/main/app/providers/opensubtitles/client.py).

## 2. `dexter21767/stremio-opensubtitles`

### Cache, hosting, and delivery

The subtitle resolver creates three independent `node-cache` instances for
final subtitle responses, IMDb metadata, and provider subtitle lists. Each is
configured with a 30-minute TTL and a one-hour check period. The code does not
specify a maximum number of keys or memory size, so it is not an LRU and cannot
be used as evidence for a safe capacity at sustained load.

Source: [resolver cache implementation](https://github.com/dexter21767/stremio-opensubtitles/blob/main/opensubtitles.js).

Its BeamUp/Dokku process definition wraps `npm start` with `beamup-logger`; the
configuration detects BeamUp using `NODE_ENV` and embeds a public BeamUp URL.
This is historical evidence of a simple BeamUp deployment, not evidence of
durable storage or monitoring.

Sources: [Procfile](https://github.com/dexter21767/stremio-opensubtitles/blob/main/Procfile), [runtime configuration](https://github.com/dexter21767/stremio-opensubtitles/blob/main/config.js).

The HTTP endpoints set a one-day public cache header for manifests, subtitle
catalog responses, and generated WebVTT streams. Client/proxy caching can cut
repeated work, but must only be used for responses that are safe to share at
that cache key; it does not make server memory durable.

Source: [Express routes and response headers](https://github.com/dexter21767/stremio-opensubtitles/blob/main/index.js).

### Error handling and privacy

The resolver catches errors, logs them to the console, and returns no
subtitles; the proxy handler catches errors and ends the response. There is no
durable incident record, external alert integration, health endpoint, or
restart supervision shown in this repository.

Sources: [resolver](https://github.com/dexter21767/stremio-opensubtitles/blob/main/opensubtitles.js), [HTTP proxy route](https://github.com/dexter21767/stremio-opensubtitles/blob/main/index.js).

It also logs route parameters, generated proxy data, provider URLs, and
subtitle results. That demonstrates why logs must be treated as a sensitive
data boundary; it is explicitly not a model for Subs.ro's zero-PII telemetry.

Sources: [HTTP route logging](https://github.com/dexter21767/stremio-opensubtitles/blob/main/index.js), [provider API logging](https://github.com/dexter21767/stremio-opensubtitles/blob/main/opensubtitlesAPI.js).

## 3. `NepiRaw/Stremio-SubSense`

The project documents a SQLite/LibSQL database cache path (`DB_PATH`, default
`./data/subsense.db`), caching enabled by default, and 30-day cache retention.
Its self-hosting Docker pattern mounts `./data` at `/app/data`, while the
Dockerfile creates that directory. This makes the cache survive *that Docker
deployment's* container replacement; it does not make SQLite durable on a
multi-node host without a confirmed shared mount.

Sources: [environment variables and self-hosting](https://github.com/NepiRaw/Stremio-SubSense#environment-variables), [Dockerfile](https://github.com/NepiRaw/Stremio-SubSense/blob/main/Dockerfile).

The documented telemetry has explicit modes: `minimal` refreshes user counts
on a five-minute cadence, `0` disables statistics, and a numeric setting turns
on fuller periodic statistics. The dashboard includes request/cache-hit,
provider-performance, language, and active-session statistics. This supports
separating cheap aggregate metrics from optional, potentially expensive
per-provider detail; it does not eliminate the need for a durable metrics
writer when the application host is ephemeral.

Source: [statistics and monitoring](https://github.com/NepiRaw/Stremio-SubSense#stats--monitoring).

The project documents a fast-first multi-provider response, a maximum of five
configured languages, and a configurable maximum subtitles per language
(three to 100 or unlimited). Those are workload controls that transfer well:
the caller can bound output before it expands memory, rendering, and network
work.

Source: [features and configuration](https://github.com/NepiRaw/Stremio-SubSense#features).

It also documents manifest-provider key encryption using
`SUBSENSE_ENCRYPTION_KEY`, and declares a `/health` Docker healthcheck at a
30-second interval with timeout/retry limits. Encryption of one application's
configuration format does not make URL logging safe in another application;
Subs.ro still must not log manifest/configuration URLs.

Sources: [features and environment configuration](https://github.com/NepiRaw/Stremio-SubSense#features), [Dockerfile healthcheck](https://github.com/NepiRaw/Stremio-SubSense/blob/main/Dockerfile).

## 4. `xtremexq/StremioSubMaker`

The README states that the public deployment is at `submaker.elfhosted.com`,
thanks ElfHosted for community hosting, and offers both local and Docker
self-hosting. It also describes a shared translation database: after one user
translates a subtitle, later retrievals can use the cached translation. This
is a value-bearing content cache, not a model for operational telemetry.

Sources: [public deployment](https://github.com/xtremexq/StremioSubMaker#try-it-now), [features and operation](https://github.com/xtremexq/StremioSubMaker#features).

Its storage layer contains filesystem and Redis adapters, a storage interface,
and a factory; the test tree includes a Redis command-timeout regression test.
The transferable architecture is the boundary: storage is an explicit
dependency with failure behaviour to test, instead of an implicit assumption
about the current container's filesystem. The source alone does not establish
which backend runs in its public deployment.

Sources: [storage layer](https://github.com/xtremexq/StremioSubMaker/tree/main/src/storage), [test tree](https://github.com/xtremexq/StremioSubMaker/tree/main/src).

The service tree contains source-specific clients (including Subs.ro) and an
OpenSubtitles no-backoff regression test. This is evidence for isolating
provider behaviour and retaining narrow regressions around a past outage,
rather than implementing provider failure policy as undifferentiated handler
logic.

Source: [services tree](https://github.com/xtremexq/StremioSubMaker/tree/main/src/services).

The README supports BYOK provider API keys and server-side credentials. It does
not by itself establish a secret-encryption or log-redaction implementation,
so no security claim beyond its documented configuration model is drawn here.

Source: [configuration](https://github.com/xtremexq/StremioSubMaker#configuration).

## Practical recommendations for the Subs.ro recovery plan

1. **Do not use a container-local SQLite file on BeamUp.** SQLite is a good
   small database only when the database path is on confirmed durable storage
   and there is a single-writer design. BeamUp replacement and overlap make
   that an unsuitable assumption.
2. **Use Oracle-hosted PostgreSQL for durable metrics and incidents.** This
   keeps the durable writer outside BeamUp, supports concurrent/additive
   updates, and avoids treating Discord or a Gist as a database.
3. **Make cache capacity a first-class contract.** Use separate bounded caches
   for search/result metadata and extracted WebVTT. Each needs a TTL, a
   maximum entry count, a maximum retained byte budget, and tests that prove
   eviction releases references.
4. **Constrain work before caching it.** Reject oversized archives before
   decompression, cap extracted candidate files and text bytes, deduplicate
   in-flight work by a non-secret content key, and use timeouts/abort signals
   for upstream requests.
5. **Keep durable operational telemetry aggregate and sanitised.** Persist
   counters and append-only incident records; exclude API keys, configuration
   paths, titles/filenames, raw URLs, and payloads. Record enough structured
   fields to diagnose a failure class, timestamp, and count.
6. **Use a two-layer alert model.** The application reports caught upstream and
   graceful lifecycle events to Discord; an external monitor reports hard
   outage/recovery because V8 OOM or a forced kill cannot reliably execute
   JavaScript shutdown handlers.

## Limits of this study

These projects serve different products and traffic profiles. None proves a
safe cache limit for the current 512 MB BeamUp runtime, and none substitutes
for measuring Subs.ro archive sizes, extraction cost, cache retained bytes,
and restart behaviour under representative load. The recovery implementation
must be based on those measurements and a bounded memory budget, not copied
constants.
