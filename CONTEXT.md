# Domain Context & Glossary

Domain concepts and terms used across the Subs.ro Stremio Addon.

## Glossary

### Subtitle Package (Archive)
A compressed archive (`.zip` or `.rar`) hosted on Subs.ro containing one or more `.srt` subtitle files, often corresponding to different release groups or entire series seasons.

### Subtitle List Request
A Stremio discovery request for the available subtitle tracks for one movie or episode. Its response contains track descriptions and delivery URLs, not subtitle content.
_Avoid_: Player request, package request, search request

### Subtitle Delivery Request
A Stremio request to fetch the WebVTT content of one track selected from a previous Subtitle List Request.
_Avoid_: Stream request, playback request, proxy request

### Subtitle Track
An individual subtitle file (`.srt` extracted from a Subtitle Package) representing a specific language, season, episode, and release synchronization.

### Usable Subtitle Track
A Subtitle Track that remains eligible for listing and playback after permanent exclusions are applied. A track for a later episode is still usable, not rejected.
_Avoid_: Accepted subtitle, non-rejected subtitle

### Prepared Subtitle Track
A Usable Subtitle Track that has been converted to WebVTT and is ready to stream without further conversion.
_Avoid_: Converted subtitle, cached VTT

### Cached Package
A retained representation of one Subtitle Package containing its Usable and Prepared Subtitle Tracks as a single reuse unit. It is identified globally by the Subs.ro package ID, independent of any user or API key.
_Avoid_: Cache item, archive cache

### Extracted Track Cache
A disposable collection of Cached Packages retained so later playback can reuse their tracks without fetching and extracting the Subtitle Package again.
_Avoid_: Archive cache, decompressed subs

### Movie Edition (Cut)
The cut or edition variation of the release (e.g. `EXTENDED`, `UNRATED`, `DIRECTORS CUT`, `REMASTERED`, `IMAX`, `THEATRICAL`). A fundamental synchronization factor determining timeline offsets.

### Streaming Network
The source digital service or platform (e.g. `AMZN`, `NF`, `DSNP`, `ATVP`, `HMAX`, `HULU`, `MAX`, `CR`, `BBC`) from which a web release was captured. Network tags dictate platform-specific intro bumpers and delay timings.

### Source Tag
The media format / transfer type (e.g. `BluRay`, `WEB-DL`, `WEBRip`, `HDTV`, `DVDRip`, `REMUX`) indicating the video transfer and frame timing standard.

### Release Group
The scene or P2P group (e.g. `DIMENSION`, `NTb`, `FLUX`, `SPARKS`, `YIFY`) that encoded the video release.

### Forced Subtitles
Subtitle tracks designed only to translate non-primary language scenes (e.g. alien or foreign dialogue). Automatically excluded by the addon in favor of complete dialogue tracks.

### Split Subtitles (Multi-CD)
Legacy multi-part subtitle files (e.g. `CD1`, `CD2`, `Part 1`, `Part 2`). Automatically excluded by the addon to prevent partial playback on modern single-file streams.

### Pass-through Proxy
The addon's runtime role: accepting user-scoped Stremio subtitle requests, communicating with the Subs.ro API using the user's API key, and streaming on-the-fly converted WebVTT subtitles directly to the player without long-term server-side persistence.

### Quota
The daily allocation of API requests provided by Subs.ro per user API key (typically 200 requests/24h).

### Anonymous Telemetry Hash
A one-way cryptographic hash (`SHA-256(apiKey)`) used to anonymously track daily active users without retaining, storing, or logging any personal user identity, raw key, IP address, or video watch history.

### Operational Metrics
Aggregate, zero-PII in-memory telemetry recording daily active users (DAU), total requests, cache hit rates, average latency, and archive format ratios (ZIP vs RAR).

### Match Tier Distribution
Statistical distribution of search results across the 9-tier matching hierarchy (Exact, Edition/Network/Source matches vs Fuzzy Fallbacks), used to evaluate and refine regex sync rules over time.

### Daily Summary Beacon
An optional asynchronous out-of-band notification dispatched at 00:00 UTC to a configured webhook (e.g. Discord or Telegram) summarizing daily traffic without persisting data to an external database.
