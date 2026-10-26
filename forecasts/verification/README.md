# Forecast evaluation

The evaluator compares saved forecasts with supplied balloon soundings. It reads the values issued for each run, matches them to observation times and stations, and reports errors with the number of usable comparisons. Scoring uses the original published values.

## Compare published forecasts with WxToFly

The [scientific review tooling](wxtofly/README.md) has explicit capture and offline compare operations. It preserves the live publication, accounts for shared products and evidence gaps, and produces an interactive report without changing forecast calculations.

The [XC Skies supplement](xcskies/README.md) records authenticated PointCast response data separately and compares atmospheric profiles at exact UTC times and common above-ground heights. Its original-source hashes, field definitions and retrospective-history limitations remain explicit.

## Score archived forecasts

Run from `forecasts/`:

```sh
pnpm verify:history --from 2026-10-21T00:00:00Z --to 2026-10-22T00:00:00Z --max-runs 30
```

The command reads `data/history` and `data/raob` and writes JSON to stdout. It uses local files only. `--from` and `--to` select the observation window; `--max-runs` selects up to that many of the most recent archived runs per model.

Use `--models hrrr-conus,rrfs,rdps` to choose models, `--observations DIR` to read `DIR/raob`, or `--report PATH` to save the report. `--data DIR` changes the forecast archive root. A request is limited to 120 runs per model, 12 models, a 120-day observation window, and 241 soundings per site. The output lists the runs selected and any missing observation documents or issued profiles; an empty match set is reported as `no-matched-observations`.

## Read the results

Station matches prefer a separation of at most 50 km and allow at most 60 km. A forecast needs a valid initialization and a nonnegative lead time. Exact valid-time matches are summarized separately from the near-initialization fallback, which permits a time difference of at most 60 minutes at a lead of at most one hour.

Each metric has its own sample count because temperature, dew point and wind can be missing at different levels. Independent station-days count a station ID and UTC observation date once, even when several launches or models use that sounding. Reports also distinguish individual station observation times. These counts describe how much independent evidence supports the summary.

Evaluator version 3.0.0 identifies the matching and scoring rules. Each issued profile records the forecast method being scored; that version advances independently of the evaluator. Cross-model spread is reported separately from error against observations.

The saved [`skill-report.json`](skill-report.json) contains eight near-initialization comparisons using three station observation times on one date. It provides a dated example of matching and scoring. The [evaluation plan](../../docs/soaring-forecast-plan.md) describes the broader weather and terrain coverage needed to estimate forecast skill.

## Issued history

A run can have several issued revisions—for example, when missing diagnostics are repaired without changing its initialization. Each revision is saved under:

```text
history/<model>/<run>/revisions/<sha256>/
```

Profile payloads are stored as `sites/<slug>.json.gz` and, when selected,
`full-columns/sites/<slug>.json.gz`. The revision receipt continues to name and
hash the original uncompressed JSON bytes; compression does not create a new
issue or change scoring. Use `readIssuedHistoryFile(directory, logicalFile)` from
[`issued-history.mjs`](issued-history.mjs) for either old plain JSON or gzip.
It returns `null` for missing evidence and rejects ambiguous duplicate forms,
corrupt compressed data, and payloads larger than 64 MiB after decompression.
Manifests, revision receipts and indexes remain plain JSON.

The revision records hashes of the full issued source bytes, the diagnostic method and the recorded build identity. Repeating an identical archive operation leaves it unchanged; different content adds a revision. The run's `index.json` records issue order and the latest known revision. Scoring selects the first issue, preserving the evidence of what was originally forecast even after later repairs.

Older run directories retain their original files and are labeled `legacy` in the report. Some intentionally contain only selected sites. Import checks the identities of the profiles that exist and preserves their bytes; scoring reports the missing profiles. New revisions require the complete site inventory.

## Source columns and retention

Ordinary archived `sites/` records keep selected pressure levels and issued diagnostics for scoring. Recalculating diagnostics from a complete atmospheric column requires the full source profiles. To retain those for a method-impact study, call `archiveModelRun` with `retainFullColumns: true` for an explicitly pinned run; it writes the original bytes under `full-columns/sites/`.

Operator builds now also pass `retainFullColumnSites` for Blanchard, Tiger, Rampart and Baker Summit where those sites exist in the model inventory. Their first-issued full profile bytes are retained alongside compact scoring records on every run, with hashes checked by the same revision reader. Other sites remain compact. The staged and post-publish archive calls use the same selection, so they do not create a second issue solely because one call retained more source data. This preserves all *published source levels* at these cases; it does not recover unpublished model layers or substitute GRIB wire bytes.

Operator builds and artifact merges share [`history-policy.mjs`](history-policy.mjs): at least 30 UTC initialization dates, plus the most recent 120 rolling runs and pins, preserving every revision within each retained run. The calendar floor is anchored to the newest retained initialization, so importing an old study does not erase it because of today's date. `archiveModelRun` and `mergeHistoryArchives` expose `minimumCalendarDays` (0–120); their library default remains zero for callers that explicitly want run-count-only retention. This retains available days prospectively; it cannot restore deleted archives.

`verify:history` now reports `archiveCalendarCoverage`: retained runs and selected first-issued runs per UTC day, absent initialization dates, and retained runs omitted by the scoring limit. A day with one run is not a complete daily inventory. Its separate independent station-day counts retain the existing observation matching rules. Increase `--max-runs` up to 120 to inspect more retained runs; the report makes the remaining selection gap explicit.

## Storage maintenance and rehearsal

CI migrates restored plain archives before use:

```sh
node forecasts/verification/compact-history.mjs --data forecasts/data
```

Run this command from the repository root. It verifies each affected run,
compresses a staged copy, checks exact byte round trips, then replaces the run.
Already compressed runs need only a filename scan. Imports also compress older
producer artifacts before accepting them, so a late artifact cannot undo the
storage transition. Publication shares immutable revision files through hard
links when supported; mutable indexes and legacy files are copied independently.
Removing a candidate or pruning a run cannot remove another link's evidence.

To reproduce the storage rehearsal from a complete local model dataset:

```sh
node forecasts/verification/history-capacity.mjs --source forecasts/data --output /tmp/new-history-rehearsal
```

The output must be new and its parent needs 40 GiB free. Node 24, `tar` and zstd
are required. The workload uses every source-manifest site and horizon, configured
model cycles, 120 rolling runs, two older pins, and one additional revision per
ten runs. It retains the four selected full columns. Twice-daily models span 60
days because the run-count floor still applies. Published weather is reused with
shifted times: these files measure storage and operations, **never historical
forecast skill**. Do not place the scratch workload inside a scored archive.

The report measures real file sizes, compressed transfer bytes, restore, merge,
staging and first-issued verification. Byte hashes must agree through every
round trip. Repeated synthetic weather can compress across runs unusually well;
cache budgets therefore use the sum of individual file sizes plus tar overhead.
`--measure EXISTING_REHEARSAL --output NEW_DIRECTORY` repeats the storage checks
with current code without regenerating weather. The [operations guide](../docs/operations.md#publication-and-retention)
records runner reservations, cache limits and the completed rehearsal's limits.

## Independent diagnostic experiment

Run after `pnpm build:packages` from the repository root:

```sh
node forecasts/verification/thermal-experiment.mjs --output /tmp/thermal-reference.json
```

The default uses 14 frozen HRRR source columns, one RRFS column, and three DWD ICON cells containing 30 native levels each. The ICON sensitivity experiment retains nine existing nodes spread across the original column; it records their native indices, pressures and heights. This tests loss of vertical detail in real weather without inventing new levels. `--input FILE` accepts an array of `{id, model, referenceTime, terrainM, column, evidence}` records, where `column` contains full source weather in the atmospheric-column units. Use retained full columns, never compact scoring profiles. Output creation refuses to overwrite an existing file. The result records the input hash, current method, per-field differences, diagnostic branches, cloud crossing brackets, source-pressure choice, and a controlled removal of sampled levels. It never rewrites issued history.

[`thermal-reference.mjs`](thermal-reference.mjs) independently resolves parcel depth, potential LCL, ambient saturation crossing, the resulting cloud cap, W* and both sink ceilings from source weather. It does not use published top/cap values as inputs or import production calculations. [`thermal-experiment.mjs`](thermal-experiment.mjs) compares those results against the production path in a separate experiment. Analytic tests and a synthetic inversion-removal case exercise the reference independently. Passing this test establishes numerical agreement with the declared policy, not observed forecast accuracy or validation of a dense native-level product.

## Scientific comparison definitions

[`definitions.mjs`](definitions.mjs) owns the provider inventory and distinctions among vertical velocity/horizontal convergence, native PBL/parcel thermal top, LCL/CCL/ambient cloud base, and sink thresholds. The legacy inventory re-exports those definitions. [`comparability.mjs`](comparability.mjs) gates normalized quantities, height references, exact UTC times, accumulation/mean intervals and verified initialization/native-cell identity. WxToFly and XC rows retain qualified forecast disagreement while exposing `strictSameRunIssue`; the strict cohort excludes unknown runs and incompatible definitions. Runtime routing metadata alone cannot establish a PointCast column's initialization.

## Review tooling ownership

[`evidence-store.mjs`](evidence-store.mjs) owns immutable bytes, hashing, bounded HTTP reads and exclusive capture directories. Provider modules own their decoders and scientific meanings. Each review keeps profile comparison, evidence capture, interpretation and HTML rendering separate; public compare entry points retain their original exports. Malformed products are retained as evidence and excluded with a reason. Completed captures cannot accept additional responses.
