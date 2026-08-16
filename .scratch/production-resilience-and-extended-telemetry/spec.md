# Spec: Production Resilience, Regex Hardening & Extended Telemetry

## Problem Statement

During live production usage with 400+ daily active users and concurrent evening traffic bursts, the Subs.ro Stremio Addon encountered three distinct operational challenges:
1. **Unescaped Special Character Crashes:** Search queries and release titles containing regular expression metacharacters (such as question marks `?` in movie titles like *"Who Framed Roger Rabbit?"* or Stremio stream query suffixes like `?index=0`) caused unhandled `SyntaxError: Invalid regular expression: Nothing to repeat` exceptions in the matching pipeline.
2. **Short Cache Retention & CPU Spikes:** The 60-second in-memory archive bridge expired too quickly during user playback pauses or repeated concurrent searches for trending releases, leading to redundant archive downloads and intensive CPU decompression cycles.
3. **Limited Long-Term Telemetry & Diagnostics:** The 24-hour rolling reset lacked long-term audience visibility (Monthly Active Users and All-Time cumulative installs), and error reporting consisted of basic counters rather than structured, multi-day error diagnostic records showing exact stack traces, sanitized context, and occurrence frequencies.

## Solution

1. **Regex Metacharacter Sanitization:** Implement rigorous regular expression escaping across all matcher and string comparison utilities, ensuring characters like `?`, `*`, `+`, `()`, `[]`, `^`, `$`, and `\` in titles or stream metadata are treated as literal text.
2. **Client-Side Cache Control:** Expose SDK `cacheMaxAge: 3600` on subtitle discovery responses to prevent Stremio desktop, mobile, and TV clients from issuing redundant search requests on stream seeks and audio track toggles.
3. **7-Day Grouped Error Diagnostic Logging:** Expand `MetricsEngine` to retain a structured 7-day rolling error diagnostic log that groups identical error signatures, tracking first/last seen timestamps, failure counts, sanitized query context, and stack snippets.
4. **4-Tier Audience Metrics (MAU & All-Time Installs):** Enhance user tracking to report four distinct operational windows:
   - 🟢 Active Now (15m live window)
   - 👥 Today's DAU (24h unique hashes)
   - 📅 30-Day MAU (Rolling 30-day unique hashes)
   - 🌐 All-Time Total Installs (Cumulative unique hashed installations)
5. **Surviving Ephemeral Container Restarts:** Retain long-term state across BeamUp/Dokku deployments via scheduled midnight snapshot records and graceful shutdown snapshot broadcasts.

## User Stories

1. As a Stremio user playing a movie with question marks or special characters in the title, I want the addon to search and match subtitles without throwing regex syntax errors, so that I receive Romanian subtitles smoothly.
2. As a Stremio user pausing a video or scrubbing through the timeline, I want my client to use cached subtitle discovery metadata, so that video playback does not stutter from repeated background server queries.
3. As an addon maintainer, I want to inspect a 7-day grouped error diagnostics table on the web admin dashboard, so that I can see the exact error message, frequency, and stack trace of any upstream or parser failures.
4. As an addon maintainer, I want to see both 30-Day Monthly Active Users (MAU) and All-Time Unique Installs on the admin dashboard and Discord bot, so that I understand true adoption and long-term user retention.
5. As an addon maintainer, I want error occurrences to be deduplicated by message signature, so that transient 5-minute upstream outages do not pollute memory with thousands of redundant log entries.
6. As a Discord user querying `/stats`, I want to receive the updated 4-tier audience breakdown (Live, DAU, MAU, All-Time) directly in the Discord embed.

## Implementation Decisions

1. **Regex Sanitization Seam:**
   - All dynamic string inputs passed into `new RegExp(str, ...)` in the matcher and parser modules will pass through a dedicated `escapeRegExp(string)` utility (`str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`).
   - Query string fragments (e.g. `?index=\d+`) will be sanitized from video titles and IDs before tokenization.

2. **Client Cache Header Strategy:**
   - The `subtitlesHandler` in the Stremio Addon SDK interface will include `cacheMaxAge: 3600` (1 hour) in standard responses, instructing Stremio clients to cache discovery lists.

3. **7-Day Rolling Error Diagnostic Store:**
   - An in-memory bounded data structure in `lib/metrics.js` will maintain distinct error entries for up to 7 calendar days.
   - Each error entry records: `signature`, `type`, `message`, `stackSnippet`, `context`, `count`, `firstSeen`, and `lastSeen`.
   - Incoming errors matching an existing signature increment the occurrence count and update `lastSeen` rather than appending duplicate entries.

4. **Extended Audience Retention:**
   - Maintain a 30-day rolling set of daily user sets (`rollingMauSets`) and a process-lifetime `Set<string>` of all distinct SHA-256 hashed API keys.
   - Update `getLiveStats()` to compute and return: `activeNow15m`, `today.uniqueActiveUsers`, `mau30d`, and `allTimeInstalls`.

5. **Dashboard & Bot Visual Alignment:**
   - Update `lib/adminStats.js` HTML template and JSON API to render:
     - Top metric cards for MAU and All-Time Installs.
     - A dedicated "7-Day Error Diagnostics" table displaying error type, count, first/last seen timestamps, and expandable stack traces.
   - Update `lib/discordBot.js` embed to present the 4-tier audience metrics in the `User Activity` section.

## Testing Decisions

1. **Regex Sanitation Tests:** Verify that search queries containing `?`, `*`, `+`, `[`, `]`, `(`, `)`, and `?index=0` successfully parse and execute matching scoring without throwing `SyntaxError`.
2. **7-Day Error Grouping Tests:** Verify that repeated identical error triggers increment counts on existing entries, track timestamps accurately, and prune entries older than 7 days.
3. **MAU & All-Time Tracking Tests:** Verify that unique hashes over multi-day simulated rollovers accumulate correctly into 30-day MAU and All-Time counters while preserving 15m active window pruning.
4. **SDK Response Cache Headers Tests:** Verify that `subtitlesHandler` returns `cacheMaxAge: 3600`.

## Out of Scope

- Client-side playback duration/heartbeat tracking (unsupported by stateless Stremio HTTP protocol).
- External relational database provisioning (all structures remain zero-dependency in-memory with snapshot persistence).
- Archive cache capacity changes (deferred to dedicated sizing discussion).

## Further Notes

- Memory impact of 10,000 all-time unique hashes + 7-day error logs is ~400 KB total, perfectly suited for BeamUp container constraints.
