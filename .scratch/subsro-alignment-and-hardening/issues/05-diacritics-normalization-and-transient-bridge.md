# 05 — Extracted WebVTT Memory Bridge & Romanian Diacritics Normalization

**What to build:** When archives are downloaded during search, immediately unpack them, decode their charsets, and store only the lightweight `.vtt` strings (~50KB per sub) in a 60-second transient cache, discarding the heavy multi-megabyte binary ZIP/RAR buffers immediately. In the subtitle proxy, decode legacy charsets (Windows-1250, ISO-8859-2, UTF-8) and normalize legacy cedillas (`ş`, `ţ`) into standard Romanian comma-below characters (`ș`, `ț`) in clean WebVTT format for 0ms instant streaming.

**Blocked by:** 04 — Parallel Archive Traversal, 50MB Limit, and Dynamic Ranking

**Status:** resolved

- [x] Downloaded archives are immediately unpacked into lightweight `.vtt` string entries (~50KB each).
- [x] Binary ZIP/RAR archive buffers are discarded immediately after extraction to keep RAM usage minimal.
- [x] Extracted WebVTT buffers are retained in a transient cache for 60 seconds (max 30 items) to serve player stream requests.
- [x] If a subtitle is missing from the transient cache when `/proxy/.../sub.vtt` is requested, it downloads on-demand and extracts cleanly.
- [x] Windows-1250, ISO-8859-2, and UTF-8 charsets are detected and decoded accurately.
- [x] Legacy Romanian cedilla characters (`ş`, `Ş`, `ţ`, `Ţ`) are converted to standard comma-below diacritics (`ș`, `Ș`, `ț`, `Ț`).
- [x] WebVTT timestamps and headers (`WEBVTT\n\n`) are formatted correctly for Stremio player playback.
- [x] Automated tests verify charset decoding, diacritic conversion, WebVTT memory bridge, and on-demand fallback.

## Answer

Created `lib/subtitleExtractor.js` implementing automatic charset detection (`windows-1250`, `utf-8`), Romanian cedilla normalization (`ş`/`ţ` ➔ `ș`/`ț`), SRT-to-WebVTT parsing, and direct archive unpacking to `Map<srtPath, vttString>`. Updated `addon.js` to unpack archives immediately during search and store only lightweight VTT maps in `ARCHIVE_CACHE` (with 60-second TTL), discarding multi-megabyte binary ZIP/RAR buffers immediately. Updated `lib/proxy.js` to serve pre-converted VTTs in 0ms with on-demand fallback. Verified with `test/diacritics_and_bridge.test.js` and `test/proxy_integration.test.js`.
