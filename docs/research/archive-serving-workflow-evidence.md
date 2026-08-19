# Archive-serving workflows: evidence before Ticket 01 design

## Scope

This note answers a narrow question for Ticket 01: what archive and cache
workflow does the current add-on actually run, what do the named comparable
add-ons demonstrably do, and which parts are recommendations rather than
established facts. It deliberately does **not** choose new archive-size,
concurrency, TTL, or cache-capacity limits. Those require the measurement work
described at the end of this note.

## Confirmed current Subs.ro workflow

The current manifest request performs the following work for every matching
Subs.ro package, with a per-request archive concurrency of four:

1. Download the whole ZIP or RAR package into a Node.js `Buffer`.
2. Enumerate and extract every subtitle track in that package.
3. Convert every extracted subtitle to a WebVTT string and store the resulting
   `Map<path, WebVTT>` in `ARCHIVE_CACHE`.
4. Return only the track names/URLs to Stremio. On playback, serve the WebVTT
   from the archive map if it is still present; otherwise download the package
   again and extract the selected track.
5. Store the selected WebVTT in a separate playback cache.

Source: [`addon.js`](../../addon.js),
[`subtitleExtractor.js`](../../lib/subtitleExtractor.js),
[`archiveCache.js`](../../lib/archiveCache.js), and
[`proxy.js`](../../lib/proxy.js).

The source comments still describe a 60-second/30-entry bridge, but the active
values differ: the archive cache permits 250 archive maps for 30 minutes; the
playback cache permits 100 WebVTT strings for 12 hours. Both use a
recency-updating `Map` order, but neither records retained text bytes. Therefore
the current implementation **does** discard the compressed archive buffer after
the manifest path finishes, but it eagerly creates and retains all converted
tracks from every inspected package. “The archive buffer is discarded” is not
equivalent to “the request has a bounded memory cost.”

## Comparable add-ons: confirmed behaviour

| Project | Confirmed workflow | What it does not prove |
| --- | --- | --- |
| [`dexter21767/stremio-opensubtitles`](https://github.com/dexter21767/stremio-opensubtitles/blob/main/opensubtitles.js) | Caches provider result lists and returns a generated proxy URL. The proxy/converter is selected when the subtitle is fetched; this resolver does not eagerly unpack a package into every track. It has three `node-cache` instances, all with a 30-minute TTL and no configured entry/byte maximum. | Its source does not establish a safe cache size, archive policy, or production traffic profile. |
| [`NepiRaw/Stremio-SubSense`](https://github.com/NepiRaw/Stremio-SubSense) | Documents SQL/SQLite/LibSQL caching of subtitle results, a mounted `/app/data` directory for self-hosting, 30-day retention, a maximum-output option per language, and fast-first provider results. | The README does not demonstrate an archive-decompression workflow or prove that an SQL cache is suitable on BeamUp's multi-node disposable runtime. |
| [`xtremexq/StremioSubMaker`](https://github.com/xtremexq/StremioSubMaker/tree/main/src/storage) | Has a storage abstraction with filesystem and Redis backends; it treats the translation cache as a separate value store. Its test tree includes a Redis timeout regression. | It does not establish which backend its public deployment uses, or provide a transfer-ready archive-cache budget. |
| [`skoruppa/stremio-community-subtitles`](https://github.com/skoruppa/stremio-community-subtitles/blob/main/docker-compose.yml) | Uses a durable MariaDB volume by default, app/data/log/subtitle mounts, a memory limit, and a healthcheck. Its in-process `AsyncCache` is TTL-only and has no capacity limit. | Its community-upload product and 2 GB Compose deployment are not comparable capacity evidence for this 512 MB failure. |

Two important conclusions follow from the comparable source:

- The named projects predominantly cache search/result metadata or a selected
  artifact. None is evidence that “eagerly convert every track from every
  archive and retain it” is required for a Stremio subtitle add-on.
- None supplies a universal industry number for cache size. The comparable
  in-memory caches also lack byte limits, so copying their TTLs or item counts
  would repeat the same unmeasured-risk pattern.

## Is download -> unpack -> convert -> discard archive -> cache WebVTT a good practice?

It is a **valid cache-aside pattern**, with a clear user benefit: when a player
requests an already converted track, the server can return it without another
upstream download or conversion. The current add-on implements that pattern.

It is not automatically good or bad. Its safety depends on three independent
quantities:

1. compressed package bytes held while downloading;
2. uncompressed bytes and CPU held while enumerating/extracting; and
3. converted WebVTT bytes retained across all live cache entries.

ZIP/RAR compression means item count and compressed size cannot predict the
second or third quantity. A package with a small compressed download can expand
to many large subtitle files. Concurrent requests multiply the temporary
buffers. A cache with LRU eviction is useful only when it also has a measured
byte budget and correct accounting for replacement/eviction.

For this add-on, eager conversion is a **hypothesis to test**, not a decision to
keep or remove. The alternative is a two-stage path: read only the package
index/filenames during manifest generation, then extract/convert the selected
track on playback and cache that selected value. That trades first-playback
latency for much lower expansion and retention. A hybrid can pre-convert only a
small, explicitly selected subset. Neither alternative should be selected until
we measure actual packages and player timing.

## Recommendation for the next diagnostic step (not an implementation decision)

Build a temporary, zero-PII measurement harness against representative API
responses. For each package, record only bucketed/aggregate operational data:

- compressed byte size;
- archive type;
- track count;
- total and largest extracted subtitle byte size;
- total converted WebVTT byte size;
- download, enumeration, extraction, conversion, and proxy timing;
- peak process heap/RSS around one package and around four concurrent packages;
- cache entry count and retained bytes after each operation.

Do not record raw API keys, URLs, titles, filenames, subtitle text, IP
addresses, or watch history. Run both the current eager path and a
selected-track-only prototype against the same representative samples. The
decision can then be based on observed latency, memory expansion, and cache
reuse rather than arbitrary limits.

## Sources and limits

The project source files cited above are the authority for current behaviour.
The four linked repositories are primary source code/configuration for the
comparative claims. They describe different products, versions, deployment
models, and traffic levels; they are evidence for architectural patterns, not
capacity specifications for this service.
