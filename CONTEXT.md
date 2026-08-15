# Domain Context & Glossary

Domain concepts and terms used across the Subs.ro Stremio Addon.

## Glossary

### Subtitle Package (Archive)
A compressed archive (`.zip` or `.rar`) hosted on Subs.ro containing one or more `.srt` subtitle files, often corresponding to different release groups or entire series seasons.

### Subtitle Track
An individual subtitle file (`.srt` extracted from a Subtitle Package) representing a specific language, season, episode, and release synchronization.

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
