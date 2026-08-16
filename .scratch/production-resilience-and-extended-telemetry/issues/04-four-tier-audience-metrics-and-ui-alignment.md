# 04 — 4-Tier Audience Metrics & UI/Bot Alignment

**What to build:** Upgrade user telemetry to track 30-Day Monthly Active Users (MAU) and All-Time cumulative installations, and update both the web admin dashboard (`/admin/stats`) and Discord bot (`/stats`) embed to display the complete 4-tier audience breakdown and 7-day error diagnostics table.

**Blocked by:** 03 — 7-Day Grouped Error Diagnostic Logging

**Status:** done

- [x] Metrics engine computes 4-tier audience telemetry: 15m Live, 24h DAU, 30-Day MAU, and All-Time Unique Installs.
- [x] Admin stats dashboard (`/admin/stats`) updated with top summary cards for MAU & All-Time Installs.
- [x] Admin stats dashboard renders an interactive "7-Day Error Diagnostics" table showing error types, counts, timestamps, and expandable stack traces.
- [x] Discord bot `/stats` embed updated to include MAU and All-Time stats in the User Activity section.
- [x] Automated unit test verifies 4-tier audience calculations, JSON API output, and HTML template rendering.
