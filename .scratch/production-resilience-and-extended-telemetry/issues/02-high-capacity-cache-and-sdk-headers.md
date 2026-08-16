# 02 — High-Capacity Subtitle Cache & SDK Cache Headers

**What to build:** Expand the in-memory subtitle archive bridge to retain up to 2,000 subtitle tracks (~140 MB RAM) with 30-minute LRU eviction, and inject `cacheMaxAge: 3600` into Stremio SDK subtitle discovery responses to prevent client-side search spam during timeline seeking.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] In-memory archive bridge cache capacity expanded to 2,000 subtitle tracks (~200 concurrent movies/episodes).
- [x] Subtitle cache TTL increased from 60 seconds to 30 minutes with automatic LRU eviction to prevent memory growth beyond ~140 MB.
- [x] `stremio-addon-sdk` discovery response includes `cacheMaxAge: 3600` (1 hour) so client apps cache subtitle availability.
- [x] Automated unit test verifies cache expansion, 30-minute retention, and LRU pruning behavior.
