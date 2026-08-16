# 03 — 7-Day Grouped Error Diagnostic Logging

**What to build:** Implement a structured 7-day rolling error diagnostic store in the metrics engine that deduplicates incoming errors by signature, tracking exact stack trace snippets, sanitized query context, occurrence counts, and first/last seen timestamps.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Metrics engine maintains a rolling 7-day store of distinct error diagnostic records.
- [x] Incoming errors matching an existing signature increment failure counts and update `lastSeen` without polluting memory.
- [x] Error entries capture error type (`REGEX_SYNTAX`, `UPSTREAM_500`, `PARSE_CORRUPT`, `TIMEOUT`), message, stack trace snippet, and sanitized query ID.
- [x] Automated unit test verifies 7-day retention, grouping logic, and timestamp tracking.
