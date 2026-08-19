const express = require("express");
const { globalMetrics, APP_VERSION } = require("./metrics");

const router = express.Router();

function renderDashboardHtml(snapshot, adminKey) {
  const u = snapshot.users || {};
  const tr = snapshot.traffic || {};
  const lat = snapshot.latency || {};
  const c = snapshot.cache || {};
  const up = snapshot.upstream || {};
  const lim = snapshot.limiter || {};
  const res = snapshot.resources || {};
  const errors = snapshot.errors || [];
  const samples = snapshot.recentSamples || [];

  const subBuckets = lat.subtitle?.buckets || {};
  const proxyBuckets = lat.proxy?.buckets || {};

  const errorRows = errors.map((e) => `
    <tr class="border-b border-stone-100 hover:bg-stone-50">
      <td class="py-2 px-3 font-mono font-bold text-red-600">${e.type}</td>
      <td class="py-2 px-3 text-right font-mono font-bold">${e.count.toLocaleString()}</td>
      <td class="py-2 px-3 font-mono text-slate-500 text-xs">${e.firstSeen ? e.firstSeen.slice(11, 19) : "-"}</td>
      <td class="py-2 px-3 font-mono text-slate-500 text-xs">${e.lastSeen ? e.lastSeen.slice(11, 19) : "-"}</td>
      <td class="py-2 px-3 text-xs text-slate-700 font-mono">${(e.sampleMessage || "").replace(/</g, "&lt;")}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Subs.ro Addon v${APP_VERSION} — Operational Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <meta http-equiv="refresh" content="30" />
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans antialiased p-6 md:p-10">
    <main class="max-w-6xl mx-auto space-y-8">
      <!-- Header -->
      <header class="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-4 border-b border-stone-200 pb-6">
        <div>
          <div class="text-xs font-bold uppercase tracking-widest text-indigo-600 mb-1">Operational Telemetry & Performance</div>
          <h1 class="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">Subs.ro Addon v${APP_VERSION}</h1>
          <div class="text-xs text-slate-500 font-mono mt-1">Instance: ${snapshot.instanceId} · Uptime: ${Math.round((snapshot.uptimeSeconds || 0) / 60)}m</div>
        </div>
        <div class="flex items-center gap-3 text-xs text-slate-500 font-mono">
          <span>UTC: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}</span>
          <a href="/admin/stats?key=${encodeURIComponent(adminKey)}&format=json" target="_blank" class="px-3 py-1.5 bg-white border border-stone-200 rounded font-bold text-indigo-600 hover:bg-stone-100 transition-colors">JSON View</a>
        </div>
      </header>

      <!-- Top Metric Cards -->
      <section class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        <div class="bg-white p-4 rounded-xl border border-stone-200 shadow-sm">
          <div class="text-xs font-bold uppercase text-slate-400">Active (15m)</div>
          <div class="text-2xl font-mono font-bold text-emerald-600 mt-1">${u.activeNow15m || 0}</div>
          <div class="text-[11px] text-slate-400">concurrent users</div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-stone-200 shadow-sm">
          <div class="text-xs font-bold uppercase text-slate-400">Today's DAU</div>
          <div class="text-2xl font-mono font-bold text-indigo-600 mt-1">${u.uniqueToday || 0}</div>
          <div class="text-[11px] text-slate-400">unique users today</div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-stone-200 shadow-sm">
          <div class="text-xs font-bold uppercase text-slate-400">List Requests</div>
          <div class="text-2xl font-mono font-bold text-slate-800 mt-1">${(tr.subtitleRequests || 0).toLocaleString()}</div>
          <div class="text-[11px] text-slate-400">avg ${lat.subtitle?.avgMs || 0}ms</div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-stone-200 shadow-sm">
          <div class="text-xs font-bold uppercase text-slate-400">Stream Requests</div>
          <div class="text-2xl font-mono font-bold text-slate-800 mt-1">${(tr.proxyRequests || 0).toLocaleString()}</div>
          <div class="text-[11px] text-slate-400">avg ${lat.proxy?.avgMs || 0}ms</div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-stone-200 shadow-sm">
          <div class="text-xs font-bold uppercase text-slate-400">Peak Concurrency</div>
          <div class="text-2xl font-mono font-bold text-indigo-600 mt-1">${lim.peakGlobalActive || 0}</div>
          <div class="text-[11px] text-slate-400">max user: ${lim.maxObservedPerUserActive || 0}/3</div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-stone-200 shadow-sm">
          <div class="text-xs font-bold uppercase text-slate-400">Process Memory</div>
          <div class="text-2xl font-mono font-bold text-slate-800 mt-1">${res.currentRssMb || 0} MB</div>
          <div class="text-[11px] text-slate-400">heap: ${res.currentHeapUsedMb || 0} MB</div>
        </div>
      </section>

      <!-- Cache Breakdown -->
      <section class="bg-white p-6 rounded-xl border border-stone-200 shadow-sm space-y-4">
        <h2 class="text-lg font-bold text-slate-900 border-b border-stone-100 pb-2">Cache Effectiveness Breakdown</h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div class="p-3 bg-stone-50 rounded-lg border border-stone-200">
            <div class="text-xs font-bold text-slate-500 uppercase">Ranked Response Cache</div>
            <div class="text-xl font-mono font-bold text-indigo-600 mt-1">${c.responseCache?.hitRate || 0}%</div>
            <div class="text-xs text-slate-500 font-mono mt-1">${c.responseCache?.hit || 0} hits · ${c.responseCache?.miss || 0} misses</div>
          </div>
          <div class="p-3 bg-stone-50 rounded-lg border border-stone-200">
            <div class="text-xs font-bold text-slate-500 uppercase">Archive / Package Cache</div>
            <div class="text-xl font-mono font-bold text-indigo-600 mt-1">${c.archiveCache?.hitRate || 0}%</div>
            <div class="text-xs text-slate-500 font-mono mt-1">${c.archiveCache?.hit || 0} hits · ${c.archiveCache?.miss || 0} misses</div>
          </div>
          <div class="p-3 bg-stone-50 rounded-lg border border-stone-200">
            <div class="text-xs font-bold text-slate-500 uppercase">Singleflight Deduplication</div>
            <div class="text-xl font-mono font-bold text-indigo-600 mt-1">${c.singleflight?.joined || 0} joins</div>
            <div class="text-xs text-slate-500 font-mono mt-1">${c.singleflight?.leaders || 0} leaders prepared</div>
          </div>
          <div class="p-3 bg-stone-50 rounded-lg border border-stone-200">
            <div class="text-xs font-bold text-slate-500 uppercase">WebVTT Stream Cache</div>
            <div class="text-xl font-mono font-bold text-indigo-600 mt-1">${c.vttCache?.hitRate || 0}%</div>
            <div class="text-xs text-slate-500 font-mono mt-1">${c.vttCache?.hit || 0} hits · ${c.vttCache?.miss || 0} misses</div>
          </div>
        </div>
      </section>

      <!-- Latency Buckets Distribution -->
      <section class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="bg-white p-6 rounded-xl border border-stone-200 shadow-sm space-y-3">
          <h2 class="text-base font-bold text-slate-900">List Latency Distribution (<span class="font-mono text-indigo-600">/subtitles</span>)</h2>
          <div class="space-y-1.5 font-mono text-xs">
            ${Object.entries(subBuckets).map(([bucket, count]) => `
              <div class="flex items-center justify-between py-1 border-b border-stone-50">
                <span class="text-slate-600 w-24">${bucket}</span>
                <span class="font-bold text-slate-800">${count.toLocaleString()}</span>
              </div>
            `).join("")}
          </div>
        </div>

        <div class="bg-white p-6 rounded-xl border border-stone-200 shadow-sm space-y-3">
          <h2 class="text-base font-bold text-slate-900">Stream Latency Distribution (<span class="font-mono text-indigo-600">/proxy</span>)</h2>
          <div class="space-y-1.5 font-mono text-xs">
            ${Object.entries(proxyBuckets).map(([bucket, count]) => `
              <div class="flex items-center justify-between py-1 border-b border-stone-50">
                <span class="text-slate-600 w-24">${bucket}</span>
                <span class="font-bold text-slate-800">${count.toLocaleString()}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </section>

      <!-- Upstream & Safety Filters -->
      <section class="bg-white p-6 rounded-xl border border-stone-200 shadow-sm space-y-4">
        <h2 class="text-lg font-bold text-slate-900 border-b border-stone-100 pb-2">Upstream Activity & Safety Guard Metrics</h2>
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 font-mono text-xs">
          <div class="p-2.5 bg-stone-50 rounded border border-stone-200">
            <span class="text-slate-500 block text-[10px] uppercase">Searches</span>
            <span class="text-base font-bold text-slate-800">${(up.searches || 0).toLocaleString()}</span>
          </div>
          <div class="p-2.5 bg-stone-50 rounded border border-stone-200">
            <span class="text-slate-500 block text-[10px] uppercase">Downloads</span>
            <span class="text-base font-bold text-slate-800">${(up.downloads || 0).toLocaleString()} (${up.totalCompressedMb || 0} MB)</span>
          </div>
          <div class="p-2.5 bg-stone-50 rounded border border-stone-200">
            <span class="text-slate-500 block text-[10px] uppercase">ZIP / RAR</span>
            <span class="text-base font-bold text-slate-800">${up.zipParsed || 0} / ${up.rarParsed || 0}</span>
          </div>
          <div class="p-2.5 bg-stone-50 rounded border border-stone-200">
            <span class="text-slate-500 block text-[10px] uppercase">Wrong Season Skipped</span>
            <span class="text-base font-bold text-emerald-600">${up.wrongSeasonSkipped || 0}</span>
          </div>
          <div class="p-2.5 bg-stone-50 rounded border border-stone-200">
            <span class="text-slate-500 block text-[10px] uppercase">Forced/Split Filtered</span>
            <span class="text-base font-bold text-emerald-600">${up.forcedSplitFiltered || 0}</span>
          </div>
          <div class="p-2.5 bg-stone-50 rounded border border-stone-200">
            <span class="text-slate-500 block text-[10px] uppercase">Corrupt / Oversized Rejects</span>
            <span class="text-base font-bold text-amber-600">${(up.corruptFailures || 0) + (up.oversizedArchiveRejects || 0) + (up.oversizedSelectedSrtRejects || 0)}</span>
          </div>
        </div>
      </section>

      <!-- Grouped Diagnostics & Errors -->
      <section class="bg-white p-6 rounded-xl border border-stone-200 shadow-sm space-y-4">
        <h2 class="text-lg font-bold text-slate-900 border-b border-stone-100 pb-2">Grouped Operational Error Counters</h2>
        ${errorRows.length > 0 ? `
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead>
                <tr class="border-b border-stone-200 text-xs font-bold text-slate-500 uppercase">
                  <th class="py-2 px-3">Type</th>
                  <th class="py-2 px-3 text-right">Count</th>
                  <th class="py-2 px-3">First Seen</th>
                  <th class="py-2 px-3">Last Seen</th>
                  <th class="py-2 px-3">Sample Message</th>
                </tr>
              </thead>
              <tbody>
                ${errorRows}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="text-sm text-emerald-600 font-mono py-2">✓ No errors recorded since process start.</div>
        `}
      </section>
    </main>
  </body>
</html>`;
}

const DEFAULT_ADMIN_SECRET = "subsro-stats-admin";

router.get("/admin/stats", (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET || DEFAULT_ADMIN_SECRET;

  const providedKey = req.query.key || req.headers["x-admin-secret"] || (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, "") : null);
  if (!providedKey || providedKey !== adminSecret) {
    return res.status(401).send("Unauthorized: Invalid ADMIN_SECRET key.");
  }

  const snapshot = globalMetrics.exportSnapshot();

  if (req.query.format === "json") {
    res.set("Content-Type", "application/json");
    return res.json(snapshot);
  }

  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderDashboardHtml(snapshot, providedKey));
});

module.exports = router;
