# Serialized Extracted-Track Cache

**Status:** Deprecated

The package-cache lifecycle is superseded by ADR 0006. The scheduling decision in this ADR was rejected and has no accepted replacement yet.

The addon prepares one complete subtitle-list request at a time to remove concurrent decompression as the leading suspected cause of the observed CPU saturation and outages. Searches may complete while another request is being prepared, but only the request at the front of the global preparation queue may download archives. All eligible archives for that one request may download concurrently; their contents are then inspected and extracted one archive at a time. Permanently excluded tracks are discarded, and the remaining SRT tracks are retained on temporary disk as globally reusable Cached Packages; each downloaded archive is then discarded. A selected SRT is converted once and replaced by its ready-to-serve VTT, while later episode tracks remain SRT until selected.

Cached Packages are disposable, shared by Subs.ro package ID without retaining an API key, and maintained as whole-package LRU entries with a 24-hour sliding lifetime and a 16 GB disk ceiling. The cache always starts empty with a new addon process. Before downloading a series archive, metadata may exclude it only when it explicitly identifies a different season; missing or ambiguous season information remains eligible.

This deliberately overlaps network waiting only within the active request while keeping CPU-heavy archive extraction serialized. It favors predictable CPU use and simple recovery over maximum throughput. Requests already accepted for preparation run to completion and populate the cache; there is no request switching or abandoned-request cancellation.
