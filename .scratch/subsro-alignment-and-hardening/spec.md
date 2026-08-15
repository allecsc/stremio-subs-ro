# Specification: Subs.ro Stremio Addon Alignment & Hardening

**Status:** ready-for-agent

## Problem Statement

Users of the Subs.ro Stremio Addon experience intermittent API key validation failures ("Invalid Key" errors even for valid keys), subtitle loading timeouts, and playback failures on large multi-release subtitle archives. This is caused by a global serialized rate-limiting queue that cancels in-flight requests across concurrent users, an artificial 10MB download limit, legacy API endpoints, lack of support for non-IMDb (e.g. TMDB) identifiers, out-of-sync or partial subtitle matches (e.g. `FORCED` or `CD1/CD2` tracks), memory retention of multi-megabyte binary archive buffers, and a 15-minute static response cache that pollutes rankings when switching between different video cuts (e.g. Extended vs Theatrical).

## Solution

Transform the addon into a high-performance, concurrent pass-through proxy aligned with the official Subs.ro OpenAPI specification (`https://api.subs.ro/v1.0`). Remove destructive global request cancellations, validate API keys directly against the quota endpoint with granular status reporting, support both IMDb and TMDB searches in parallel, increase the archive download ceiling to 50MB, immediately unpack archives into lightweight WebVTT memory buffers (~50KB each) with a 60-second transient bridge, normalize Romanian diacritics to modern UTF-8 WebVTT, implement a 9-tier scene matching hierarchy (with Edition, Network, Source, and Group extraction), automatically filter out partial/forced subtitles, evaluate 9-tier ranking dynamically per stream without static cache pollution, and format subtitle track labels cleanly for Stremio UI.

## User Stories

1. As a Stremio user, I want to validate my Subs.ro API key in the configuration page, so that I receive instant and accurate feedback on whether my key is valid, exhausted, or rejected.
2. As a Stremio user whose daily quota has reached 0, I want to see a clear "Daily Quota Exceeded" message instead of a generic "Invalid Key" error, so that I understand why validation failed.
3. As a Stremio user, I want my subtitle search and download requests to succeed regardless of other users' activity on the server, so that other people's browsing does not cancel or delay my subtitles.
4. As a Stremio user watching a movie with a 25MB complete subtitle archive pack, I want the subtitle to download and extract successfully, so that playback does not fail with size errors.
5. As a Stremio user, I want Romanian subtitles with legacy Windows-1250 or cedilla encodings to be displayed with clean comma-below diacritics (`ș`, `ț`, `ă`, `î`, `â`), so that no broken glyphs or question marks appear on screen.
6. As a Stremio user watching content indexed by TMDB ID (`tmdb:...`), I want the addon to search Subs.ro by TMDB ID, so that subtitles are found even without an IMDb ID.
7. As a Stremio user browsing non-movie/series streams (e.g. IPTV), I want the addon to immediately ignore unsupported streams, so that no wasted requests or 400 errors are sent upstream.
8. As a Stremio user, I want my preferred languages to be filtered upstream via query parameters, so that only relevant subtitle archives are downloaded and parsed.
9. As a Stremio user watching an Extended edition of a film on a streaming rip (`EXTENDED AMZN WEB-DL`), I want the addon to prioritize subtitles with matching edition, source, and streaming platform over generic release group matches, so that my subtitles remain in perfect sync throughout the movie.
10. As a Stremio user, I want the addon to automatically filter out `FORCED` and `CD1`–`CD9` / `D1`–`D9` subtitle tracks, so that I am not served empty or cut-off subtitles.
11. As a Stremio user switching between different cuts of a film (e.g. Extended cut vs Theatrical cut), I want subtitle rankings to be dynamically calculated for my active video filename in real-time, so that cached results from a prior cut do not appear at the top.
12. As a Stremio user streaming a subtitle, I want the addon to hold lightweight extracted WebVTT text in memory rather than large multi-megabyte binary archives, so that the server remains fast and memory-efficient.
13. As a Stremio user selecting subtitles in Stremio's player menu, I want to see descriptive release details on subtitle items when supported, so that I can easily select the track corresponding to my release.

## Implementation Decisions

- **Direct Key Validation**: The API key validation endpoint calls `/quota` directly using standard HTTP requests with a 5s timeout, bypassing any search queues. It returns explicit status codes and reasons (`valid`, `invalid_key`, `quota_exceeded`, `network_error`).
- **Concurrent Pass-Through Proxy**: Remove `globalLimiter.clearQueues()` and global request serialization. Requests run concurrently per user, letting the upstream Subs.ro API handle individual user quotas.
- **Official API Base URL**: Migrate all API calls to `https://api.subs.ro/v1.0`, ensuring proper path formatting with no double slashes and utilizing the `?language=` query parameter.
- **Archive Size & Memory Strategy**: Increase `maxContentLength` and `maxBodyLength` to 50MB. Download and unpack archives immediately into lightweight WebVTT strings (~50KB per sub), storing them in a 60-second transient cache and discarding large binary ZIP/RAR buffers immediately.
- **Parallel Archive Listing**: Download and inspect up to 4 archives concurrently during subtitle search to keep manifest response time under 1.5 seconds.
- **Dynamic Real-Time Ranking**: Eliminate long-term static subtitle response caches in `addon.js`. Only keep transient in-flight promise debouncing so parallel identical stream requests do not duplicate work, and evaluate 9-tier ranking in real-time per video filename.
- **Diacritics & Charset Normalization**: All extracted subtitles are decoded from legacy charsets (Windows-1250 / ISO-8859-2 / UTF-8) and normalized to standard Romanian comma-below characters (`ș`, `ț`) in UTF-8 WebVTT format.
- **Identifier Support**: Support both IMDb (`tt\d+`) and TMDB (`tmdb:\d+`) ID lookups, fast-failing with `{ subtitles: [] }` on invalid or unsupported stream formats.
- **9-Tier Matching Engine**: Extract Movie Edition tags (`EXTENDED`, `UNRATED`, `DIRECTORS CUT`, `REMASTERED`, `IMAX`, `THEATRICAL`), Streaming Network tags (`AMZN`, `NF`, `DSNP`, `ATVP`, `HMAX`, `HULU`, `MAX`, `CR`, `BBC`), Source tags (`BluRay`, `WEB-DL`, `WEBRip`, `HDTV`), Release Groups, and 4K UHD / Remux master tiebreakers.
- **Exclusion Filters**: Automatically discard tracks containing `FORCED`, `CD1`–`CD9`, `DISC1`–`DISC9`, `D1`–`D9`, `PART1`–`PART9`, and `\d+ CD-uri` from search results.
- **Subtitle Label Formatting**: Maintain standard ISO 639-2 language codes (`ron`) for compatibility with Stremio core, and design isolated release labeling.

## Testing Decisions

- **External Behavior Testing**: Test only public endpoints and observable outputs (HTTP status codes, WebVTT payload text, manifest JSON structure).
- **Seam Placement**:
  - Validation endpoint seam: `GET /api/validate/:apiKey` asserted with valid, invalid (403), quota-exceeded (429), and timeout states.
  - Subtitles resolver seam: `subtitlesHandler` tested with mock Subs.ro responses for IMDb, TMDB, parallel downloading, and dynamic ranking.
  - Subtitle proxy seam: `GET /:apiKey/proxy/:subId/:path/sub.vtt` tested for ZIP and RAR extraction, diacritic normalization, and WebVTT conversion.
  - Matcher module seam: `calculateMatchScore` tested across edition, network, source, group combinations, UHD remux tiebreakers, and exclusion filters.
- **Prior Art**: Leverage existing unit test harnesses and pure mock inputs without external network dependencies.

## Out of Scope

- Multi-provider subtitle aggregation (OpenSubtitles, SubDL).
- User account creation or automatic key generation.
- Persistent database or long-term disk caching.

## Further Notes

All architectural decisions are documented in:
- `docs/adr/0001-concurrent-pass-through-architecture.md`
- `docs/adr/0002-transient-in-memory-archive-bridge.md`
- `docs/adr/0003-scene-matching-hierarchy.md`
