# Archive Workflow Benchmark — 2026-08-16

## Purpose

Measure representative Subs.ro archive work before choosing a cache or
concurrency policy. This benchmark compares the addon's current eager
all-track conversion with extracting one selected subtitle from an archive
already held in memory or reopened from local disk.

The API key was supplied through the process environment and is not stored in
the harness, dataset manifest, raw report, or this note.

## Dataset and request use

- 12 real archives: 4 RAR and 8 ZIP.
- Titles: Breaking Bad, Game of Thrones, The Matrix, Dune: Part Two, and
  Oppenheimer.
- 17 successful benchmark operations: 5 searches and 12 archive downloads.
- Together with the earlier successful diagnostic, this was 18 logical API
  operations against the authorised allowance of 20.
- Raw archives and the detailed JSON report are stored temporarily under
  `%TEMP%\subsro-archive-benchmark\` and are not committed.

The first downloader reused the addon's retrying API client and recorded
logical operations rather than each underlying HTTP attempt. No attempt-level
counter was captured, so the exact wire-request total cannot now be proven.
The harness has since been changed to disable retries, count each HTTP attempt,
and reject all new downloads until the user grants a fresh attempt budget.

Two planned downloads were not made because the selected search results did
not contain enough distinct archive IDs. The benchmark did not spend API
operations merely to reach the maximum allowance.

## Aggregate measurements

| Measurement | Result |
| --- | ---: |
| Average compressed archive | 0.300 MiB |
| High sampled compressed archive | 0.375 MiB |
| Largest sampled compressed archive | 0.455 MiB |
| Average subtitle tracks per archive | 17.3 |
| High sampled track count | 26 |
| Maximum sampled track count | 32 |
| Average original SRT total | 0.729 MiB |
| Average eager all-track VTT total | 0.698 MiB |
| Maximum eager all-track VTT total | 1.094 MiB |
| Average selected-track VTT | 0.062 MiB |
| Eager text retained versus one selected track | 11.3 times more |
| Average eager conversion time | 62.5 ms |
| Average selected-track conversion from RAM | 5.7 ms |
| Average selected-track conversion after disk reopen | 5.8 ms |

The sampled archives were much smaller than the configured 50 MiB download
ceiling. These results describe common-looking examples, not a proven maximum
archive or expansion ratio.

## Four-archive current-workflow batch

Four validated ZIP archives were loaded and eagerly converted together, which
matches one manifest request's configured archive-worker count.

| Measurement | Result |
| --- | ---: |
| Converted VTT text retained | 3.270 MiB |
| Elapsed time | 309 ms |
| JavaScript heap increase at the ending checkpoint | 56.464 MiB |
| Process RSS increase at the ending checkpoint | 73.738 MiB |

All four converted maps were kept alive through the ending memory checkpoint,
as they are when inserted into the addon's cache. The ending footprint was
much larger than the final VTT text. This is not a sampled peak, but it shows
that estimating memory from cached VTT string sizes alone materially
understates the load created by the live converted maps and processing
runtime.

The concurrency cap is local to one manifest request. Two simultaneous users
can start two separate four-archive batches; the implementation has no shared
process-wide archive-work limit.

## Cache-size projections

These figures count only measured VTT payload bytes. They exclude JavaScript
Map/string/object overhead and temporary conversion work.

| Scenario | Approximate VTT payload |
| --- | ---: |
| 30 typical archive maps | 20.9 MiB |
| 250 typical archive maps | 174.5 MiB |
| 250 high sampled archive maps | 217.0 MiB |

The active cache is configured for 250 archive maps with a 30-minute TTL. The
current source comment still describes 30 maps and 60 seconds, so the comment
does not describe runtime behaviour.

## What the benchmark supports

1. Eager conversion is fast in absolute terms, but it retains roughly eleven
   times more subtitle text than converting one selected track in this sample.
2. The larger immediate risk is not compressed archive size alone. Four small
   archives left a much larger RSS increase while their converted maps were
   still live.
3. Reopening these archives from local SSD showed no meaningful average timing
   penalty at this measurement resolution (5.8 ms versus 5.7 ms). This makes a
   temporary disk-backed compressed-archive cache worth evaluating on BeamUp.
4. An episode-aware design fits the measured workload: keep or reopen the
   compressed season archive, list its tracks, and convert only the requested
   episode. Later episodes can reuse the archive without retaining every VTT.
5. An LRU policy remains useful for choosing which cached archive to discard,
   but entry count alone does not describe memory. Any proposed cache must also
   account for the size of what it retains and the temporary work performed
   before insertion.

## What remains unverified

- BeamUp's real local-disk latency, capacity, and lifecycle.
- Peak production memory on BeamUp rather than checkpoint measurements on the
  local Windows machine.
- Multiple simultaneous user requests on the live container.
- Archives near the 50 MiB configured ceiling or unusually large expansion
  ratios.
- Whether temporary container disk is shared or survives BeamUp replacement;
  official BeamUp source does not establish that for this deployment.

## Reproduction

The benchmark harness is `.scratch/benchmark-archive-workflow.js`.

- `node --expose-gc .scratch/benchmark-archive-workflow.js self-test`
- `node --expose-gc .scratch/benchmark-archive-workflow.js measure`

The download mode additionally requires `SUBSRO_BENCH_API_KEY` in the process
environment and an explicitly authorised `SUBSRO_BENCH_HTTP_BUDGET`. It makes
no automatic retries and currently refuses all download attempts because the
first run's exact attempt count was not captured. A fresh user-authorised
attempt budget requires deliberately changing the locked constant. The API key
must not be placed in the script or committed.

When the temporary archives and detailed report are no longer needed, remove
them with:

- `node .scratch/benchmark-archive-workflow.js clean`

The command validates that its target is exactly
`%TEMP%\subsro-archive-benchmark\` before removing it.
