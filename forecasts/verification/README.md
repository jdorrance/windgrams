# Forecast evaluation

The evaluator compares saved forecasts with supplied balloon soundings. It reads the values issued for each run, matches them to observation times and stations, and reports errors with the number of usable comparisons. Scoring uses the original published values.

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

Evaluator version 3.0.0 identifies the matching and scoring rules. Forecast method 2.1.0 identifies the calculations being scored. The two version numbers advance independently, and cross-model spread is reported separately from error against observations.

The saved [`skill-report.json`](skill-report.json) contains eight near-initialization comparisons using three station observation times on one date. It provides a dated example of matching and scoring. The [evaluation plan](../../docs/soaring-forecast-plan.md) describes the broader weather and terrain coverage needed to estimate forecast skill.

## Issued history

A run can have several issued revisions—for example, when missing diagnostics are repaired without changing its initialization. Each revision is saved under:

```text
history/<model>/<run>/revisions/<sha256>/
```

The revision records hashes of the full issued source bytes, the diagnostic method and the recorded build identity. Repeating an identical archive operation leaves it unchanged; different content adds a revision. The run's `index.json` records issue order and the latest known revision. Scoring selects the first issue, preserving the evidence of what was originally forecast even after later repairs.

Older run directories retain their original files and are labeled `legacy` in the report. Some intentionally contain only selected sites. Import checks the identities of the profiles that exist and preserves their bytes; scoring reports the missing profiles. New revisions require the complete site inventory.

## Source columns and retention

Ordinary archived `sites/` records keep selected pressure levels and issued diagnostics for scoring. Recalculating diagnostics from a complete atmospheric column requires the full source profiles. To retain those for a method-impact study, call `archiveModelRun` with `retainFullColumns: true` for an explicitly pinned run; it writes the original bytes under `full-columns/sites/`.

Retention counts runs. The default keeps 120 rolling runs plus pins, preserving every revision within each retained run.
