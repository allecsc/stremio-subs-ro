# 01 — Safe Memory Budget and Immediate Containment

**Type:** task

**Status:** claimed

**Blocked by:** None

## Question

What is the smallest safe cache and archive-processing policy that prevents the confirmed Node heap exhaustion on BeamUp while preserving the v1.6 subtitle service behavior? Establish a red-capable, deterministic memory-budget feedback loop before selecting a corrective implementation.

## Known evidence

- Live BeamUp logs show repeated fatal Node heap exhaustion near a roughly 516–518 MB heap limit, followed by `Aborted (core dumped)`.
- The current process retains up to 250 archive WebVTT maps for 30 minutes and 100 played-track VTT entries for 12 hours, while real archives can contain hundreds of tracks.
- The prior cache-size estimate was not validated against production archive contents.

## Answer

The crash regression came from expanding the archive bridge from the documented 30 entries/60 seconds to 250 entries/30 minutes. The containment policy restores that bridge and adds deterministic bounds on retained converted text:

- Archive bridge: 30 entries, 60 seconds, at most 1 MiB of converted VTT text per archive and 8 MiB across the bridge. An oversized archive retains only its subtitle file list; the proxy downloads and extracts the requested track on demand.
- Proxy replay cache: 20 entries, 60 seconds, at most 512 KiB per track and 4 MiB across the cache. An oversized track is served but not retained.
- Both caches expose an idempotent expiry-prune operation and prune before writes and cache-stat reads.
- Search no longer expands every archive into a WebVTT map. It lists archive paths only, downloads are capped at 10 MiB, and at most two archive listings run concurrently. The proxy extracts only the selected track on demand.

The deterministic regression suite proves oversize omission, aggregate VTT-text eviction, refresh accounting, expiry cleanup, normal cached playback, bounded proxy caching, on-demand fallback playback, metadata-only search, and archive-download rejection above the ceiling. Final review identified three remaining host-level limits before resolution: shared process-wide archive-work concurrency, an uncompressed selected-track limit, and a bounded archive filename-list policy. Choosing their thresholds changes which exceptional archives are accepted, so this ticket remains open. It also does not prove a live BeamUp container cannot fail for another cause; production deployment and observation remain a separate approval step.
