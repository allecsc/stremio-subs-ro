# 06 — Stremio Subtitle Release Labeling

**What to build:** Investigate and implement release details in Stremio's subtitle track selection menu without violating Stremio's ISO 639-2 protocol validation.

**Blocked by:** 05 — Extracted WebVTT Memory Bridge & Romanian Diacritics Normalization

**Status:** wontfix

## Decision (Wontfix)

Stremio's Addon SDK and core player applications strictly require the `lang` property to be an ISO 639-2 (3-letter) code (`ron`). Passing custom labels (such as `ron - FLUX`) pollutes the player's language dropdown with duplicate fake language categories, breaks Stremio's "Default Subtitle Language" auto-selection, and causes playback failures on mobile and TV clients.

Furthermore, with the implementation of the **9-Tier Scene Matching Engine + 4K UHD Remux Tiebreakers + Dynamic Stream Ranking** in Ticket 03/04, manual release selection is no longer necessary: the exact synchronized subtitle is automatically calculated and placed at position #1 (`Romanian`), so Stremio auto-loads the correct track on startup.
