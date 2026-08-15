const express = require("express");
const { globalMetrics } = require("./metrics");

const router = express.Router();

function renderDashboardHtml(stats, adminKey) {
  const t = stats.today;
  const historyRows = stats.history.map((h) => `
    <tr class="border-b border-stone-100 hover:bg-stone-50/50">
      <td class="py-2.5 px-3 font-mono font-medium text-slate-900">${h.date}</td>
      <td class="py-2.5 px-3 text-right font-mono text-indigo-600 font-bold">${h.uniqueActiveUsers.toLocaleString()}</td>
      <td class="py-2.5 px-3 text-right font-mono text-slate-700">${h.totalRequests.toLocaleString()}</td>
      <td class="py-2.5 px-3 text-right font-mono text-slate-500">${h.searchRequests.toLocaleString()}</td>
      <td class="py-2.5 px-3 text-right font-mono text-slate-500">${h.proxyRequests.toLocaleString()}</td>
      <td class="py-2.5 px-3 text-right font-mono ${h.cacheHitRate >= 80 ? 'text-emerald-600 font-semibold' : 'text-amber-600'}">${h.cacheHitRate}%</td>
      <td class="py-2.5 px-3 text-right font-mono text-slate-500">${h.avgSearchLatencyMs}ms</td>
      <td class="py-2.5 px-3 text-right font-mono text-slate-500">${h.avgProxyLatencyMs}ms</td>
    </tr>
  `).join("");

  const totalSearches = t.searchRequests || 1;
  const exactPct = Math.round((t.matchTiers.exact / totalSearches) * 100);
  const highSyncPct = Math.round((t.matchTiers.highSync / totalSearches) * 100);
  const medSyncPct = Math.round((t.matchTiers.medSync / totalSearches) * 100);
  const fallbackPct = Math.round((t.matchTiers.fallback / totalSearches) * 100);

  const totalArchives = (t.archiveFormats.zip + t.archiveFormats.rar) || 1;
  const zipPct = Math.round((t.archiveFormats.zip / totalArchives) * 100);
  const rarPct = Math.round((t.archiveFormats.rar / totalArchives) * 100);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Subs.ro Addon — Operational Metrics</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <meta http-equiv="refresh" content="30" />
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans antialiased selection:bg-indigo-100 selection:text-indigo-900">
    <main class="max-w-6xl mx-auto px-6 py-10 space-y-8">
      <!-- Header -->
      <header class="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-4 border-b border-stone-200 pb-6">
        <div>
          <div class="text-xs font-bold uppercase tracking-widest text-indigo-600 mb-1">Live Telemetry</div>
          <h1 class="text-2xl sm:text-3xl font-serif font-bold text-slate-900 tracking-tight">Subs.ro Addon — Operational Metrics</h1>
        </div>
        <div class="flex items-center gap-3 text-xs text-slate-500 font-mono">
          <span>UTC: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}</span>
          <a href="/admin/stats?key=${encodeURIComponent(adminKey)}&format=json" target="_blank" class="px-2.5 py-1 bg-white border border-stone-200 rounded text-indigo-600 hover:bg-stone-100 transition-colors">JSON API</a>
        </div>
      </header>

      <!-- Top Metric Cards -->
      <section class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <div class="bg-white p-4 rounded-xl border border-stone-200 shadow-sm flex flex-col justify-between">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-400">Active Now (15m)</span>
          <div class="text-3xl font-mono font-bold text-emerald-600 mt-2">${stats.activeNow15m}</div>
          <span class="text-[11px] text-slate-400 mt-1">live unique users</span>
        </div>

        <div class="bg-white p-4 rounded-xl border border-stone-200 shadow-sm flex flex-col justify-between">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-400">Today's Active</span>
          <div class="text-3xl font-mono font-bold text-indigo-600 mt-2">${t.uniqueActiveUsers}</div>
          <span class="text-[11px] text-slate-400 mt-1">24h unique hashes</span>
        </div>

        <div class="bg-white p-4 rounded-xl border border-stone-200 shadow-sm flex flex-col justify-between">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-400">Total Requests</span>
          <div class="text-3xl font-mono font-bold text-slate-900 mt-2">${t.totalRequests.toLocaleString()}</div>
          <span class="text-[11px] text-slate-400 mt-1">${t.searchRequests} search / ${t.proxyRequests} stream</span>
        </div>

        <div class="bg-white p-4 rounded-xl border border-stone-200 shadow-sm flex flex-col justify-between">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-400">Cache Hit Rate</span>
          <div class="text-3xl font-mono font-bold ${t.cacheHitRate >= 80 ? 'text-emerald-600' : 'text-amber-600'} mt-2">${t.cacheHitRate}%</div>
          <span class="text-[11px] text-slate-400 mt-1">${t.cacheHits} hits / ${t.cacheMisses} miss</span>
        </div>

        <div class="bg-white p-4 rounded-xl border border-stone-200 shadow-sm flex flex-col justify-between">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-400">Avg Search Time</span>
          <div class="text-3xl font-mono font-bold text-slate-800 mt-2">${t.avgSearchLatencyMs}<span class="text-sm font-normal text-slate-400">ms</span></div>
          <span class="text-[11px] text-slate-400 mt-1">upstream manifest</span>
        </div>

        <div class="bg-white p-4 rounded-xl border border-stone-200 shadow-sm flex flex-col justify-between">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-400">Avg Stream Time</span>
          <div class="text-3xl font-mono font-bold text-slate-800 mt-2">${t.avgProxyLatencyMs}<span class="text-sm font-normal text-slate-400">ms</span></div>
          <span class="text-[11px] text-slate-400 mt-1">proxy VTT delivery</span>
        </div>
      </section>

      <!-- Operational Breakdowns Grid -->
      <section class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <!-- Match Tier Distribution -->
        <div class="bg-white p-5 rounded-xl border border-stone-200 shadow-sm space-y-3">
          <div class="flex items-center justify-between border-b border-stone-100 pb-2">
            <h2 class="text-sm font-bold text-slate-900 uppercase tracking-wider">Scene Match Tiers</h2>
            <span class="text-xs text-slate-400 font-mono">Sync Accuracy</span>
          </div>
          <div class="space-y-2 text-xs">
            <div class="flex items-center justify-between">
              <span class="text-slate-600">Tier 1 (Exact Match 100)</span>
              <span class="font-mono font-bold text-emerald-600">${t.matchTiers.exact} (${exactPct}%)</span>
            </div>
            <div class="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
              <div class="bg-emerald-500 h-1.5" style="width: ${exactPct}%"></div>
            </div>

            <div class="flex items-center justify-between pt-1">
              <span class="text-slate-600">Tiers 2–4 (Edition/Net/Group)</span>
              <span class="font-mono font-bold text-indigo-600">${t.matchTiers.highSync} (${highSyncPct}%)</span>
            </div>
            <div class="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
              <div class="bg-indigo-500 h-1.5" style="width: ${highSyncPct}%"></div>
            </div>

            <div class="flex items-center justify-between pt-1">
              <span class="text-slate-600">Tiers 5–7 (Source/Network)</span>
              <span class="font-mono font-bold text-slate-700">${t.matchTiers.medSync} (${medSyncPct}%)</span>
            </div>
            <div class="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
              <div class="bg-slate-500 h-1.5" style="width: ${medSyncPct}%"></div>
            </div>

            <div class="flex items-center justify-between pt-1">
              <span class="text-slate-600">Tier 10 (Fuzzy Fallback)</span>
              <span class="font-mono font-bold ${fallbackPct > 15 ? 'text-red-600' : 'text-slate-500'}">${t.matchTiers.fallback} (${fallbackPct}%)</span>
            </div>
            <div class="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
              <div class="bg-amber-500 h-1.5" style="width: ${fallbackPct}%"></div>
            </div>
          </div>
        </div>

        <!-- Archive Formats -->
        <div class="bg-white p-5 rounded-xl border border-stone-200 shadow-sm space-y-3">
          <div class="flex items-center justify-between border-b border-stone-100 pb-2">
            <h2 class="text-sm font-bold text-slate-900 uppercase tracking-wider">Archive Formats</h2>
            <span class="text-xs text-slate-400 font-mono">Decompression</span>
          </div>
          <div class="space-y-3 text-xs pt-1">
            <div class="flex items-center justify-between">
              <span class="text-slate-700 font-medium">ZIP Archives (AdmZip)</span>
              <span class="font-mono font-bold text-slate-900">${t.archiveFormats.zip} (${zipPct}%)</span>
            </div>
            <div class="w-full bg-stone-100 rounded-full h-2 overflow-hidden">
              <div class="bg-indigo-600 h-2" style="width: ${zipPct}%"></div>
            </div>

            <div class="flex items-center justify-between pt-2">
              <span class="text-slate-700 font-medium">RAR Archives (node-unrar-js)</span>
              <span class="font-mono font-bold text-slate-900">${t.archiveFormats.rar} (${rarPct}%)</span>
            </div>
            <div class="w-full bg-stone-100 rounded-full h-2 overflow-hidden">
              <div class="bg-amber-600 h-2" style="width: ${rarPct}%"></div>
            </div>
          </div>
        </div>

        <!-- Upstream Health -->
        <div class="bg-white p-5 rounded-xl border border-stone-200 shadow-sm space-y-3">
          <div class="flex items-center justify-between border-b border-stone-100 pb-2">
            <h2 class="text-sm font-bold text-slate-900 uppercase tracking-wider">Upstream Subs.ro Health</h2>
            <span class="text-xs text-slate-400 font-mono">API Status</span>
          </div>
          <div class="space-y-2 text-xs pt-1">
            <div class="flex items-center justify-between p-2 rounded bg-stone-50 border border-stone-100">
              <span class="text-slate-600">Quota Limit Hits (429)</span>
              <span class="font-mono font-bold ${t.upstreamErrors.quota429 > 0 ? 'text-amber-600' : 'text-slate-700'}">${t.upstreamErrors.quota429}</span>
            </div>
            <div class="flex items-center justify-between p-2 rounded bg-stone-50 border border-stone-100">
              <span class="text-slate-600">Rejected API Keys (403)</span>
              <span class="font-mono font-bold text-slate-700">${t.upstreamErrors.invalid403}</span>
            </div>
            <div class="flex items-center justify-between p-2 rounded bg-stone-50 border border-stone-100">
              <span class="text-slate-600">Socket / Network Errors</span>
              <span class="font-mono font-bold ${t.upstreamErrors.networkErrors > 0 ? 'text-red-600' : 'text-slate-700'}">${t.upstreamErrors.networkErrors}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 30-Day Historical Table -->
      <section class="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden">
        <div class="p-5 border-b border-stone-200 flex items-center justify-between">
          <div>
            <h2 class="text-base font-bold text-slate-900">30-Day Daily Traffic History</h2>
            <p class="text-xs text-slate-400 mt-0.5">Archived snapshots at 00:00 UTC</p>
          </div>
          <span class="text-xs font-mono text-slate-400">${stats.history.length} snapshots retained</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-stone-50 text-slate-500 font-semibold border-b border-stone-200 uppercase tracking-wider">
              <tr>
                <th class="py-2.5 px-3">Date (UTC)</th>
                <th class="py-2.5 px-3 text-right">Active Users</th>
                <th class="py-2.5 px-3 text-right">Total Requests</th>
                <th class="py-2.5 px-3 text-right">Searches</th>
                <th class="py-2.5 px-3 text-right">Streams</th>
                <th class="py-2.5 px-3 text-right">Cache Hit %</th>
                <th class="py-2.5 px-3 text-right">Avg Search</th>
                <th class="py-2.5 px-3 text-right">Avg Stream</th>
              </tr>
            </thead>
            <tbody>
              ${historyRows || '<tr><td colspan="8" class="py-6 text-center text-slate-400 italic">No historical snapshots yet. Midnight rollover runs at 00:00 UTC.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

router.get("/admin/stats", (req, res) => {
  const configuredSecret = process.env.ADMIN_SECRET;
  const providedKey = req.query.key || (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, "") : null);

  if (!configuredSecret || !providedKey || providedKey !== configuredSecret) {
    return res.status(404).send("Not Found");
  }

  const liveStats = globalMetrics.getLiveStats();

  if (req.query.format === "json" || req.headers.accept?.includes("application/json")) {
    res.set("Content-Type", "application/json; charset=utf-8");
    return res.json(liveStats);
  }

  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderDashboardHtml(liveStats, providedKey));
});

module.exports = router;
