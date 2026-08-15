# 03 — Multi-Identifier Search, Guarding, and 9-Tier Scene Matching

**What to build:** Support both IMDb (`tt...`) and TMDB (`tmdb:...`) ID lookups against the Subs.ro API (`/search/imdbid/...` vs `/search/tmdbid/...`), passing language query parameters upstream (`?language=`). Fast-fail with an empty subtitle list immediately when a stream ID does not match supported video identifier patterns (e.g. IPTV streams). Implement the 9-tier matching algorithm that parses Movie Edition (`EXTENDED`, `UNRATED`, etc.), Streaming Network (`AMZN`, `NF`, etc.), Source (`BluRay`, `WEB-DL`, etc.), and Group tags, while automatically excluding `FORCED` and `CD1/CD2` split tracks.

**Blocked by:** 02 — Concurrent Subs.ro Gateway & API v1.0 Endpoint Migration

**Status:** resolved

- [x] IMDb IDs (`tt\d+`) query `/search/imdbid/{id}`.
- [x] TMDB IDs (`tmdb:\d+`) query `/search/tmdbid/{id}`.
- [x] Non-supported stream IDs (e.g. `vavoo_...`, IPTV) return `{ subtitles: [] }` immediately without calling Subs.ro.
- [x] Language query parameter `?language=ro` is passed upstream when specified.
- [x] Subtitle tracks containing `FORCED`, `CD1`, `CD2`, `DISC1`, `DISC2`, `PART1`, `PART2` are automatically discarded.
- [x] Movie Edition (`EXTENDED`, `UNRATED`, `DIRECTORS CUT`, `REMASTERED`, `IMAX`, `THEATRICAL`) and Streaming Network (`AMZN`, `NF`, `DSNP`, `ATVP`, `HMAX`, `HULU`, `MAX`, `CR`, `BBC`) tags are parsed from filenames.
- [x] Subtitles are sorted according to the 9-tier priority scoring hierarchy.
- [x] Automated tests verify ID routing, fast-failing behavior, exclusion filtering, and 9-tier ranking.

## Answer

Implemented `parseStremioId` with fast-fail guarding against non-video / IPTV IDs, routing IMDb (`tt...`) to `/search/imdbid/...` and TMDB (`tmdb:...`) to `/search/tmdbid/...` with `?language=` upstream query parameters. Added `isExcludedSubtitle` to reject `FORCED` and multi-part (`CD1/CD2`) subtitles. Implemented the 9-tier scene matching hierarchy extracting Edition, Streaming Network, Source, and Release Group tags. Verified across all cases with `test/matcher_and_routing.test.js`.
