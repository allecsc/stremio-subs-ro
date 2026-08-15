# 0002: Transient In-Memory Archive Bridge

To prevent double-downloading Subs.ro ZIP/RAR archives during Stremio's 2-step flow (Step 1: Manifest listing, Step 2: Stream playback), downloaded archive buffers are retained in memory for a transient window of 60 seconds with bounded size (max 30 items). Persistent multi-hour memory caching is rejected to keep the memory footprint under 50MB and prevent OOM restarts on Dokku/BeamUp containers. If a proxy request arrives after the buffer has expired, the archive is fetched on-demand and immediately freed.
