# Windgram visual QA

These fixtures freeze the October 24, 2026 Dog comparison. The JSON manifest records source URLs, run times, publication times, original file hashes, selected-hour hashes, and compressed-file hashes. Real fixtures contain complete, unchanged hour records for one local calendar day. No forecast is fetched by this QA workflow.

- Dog RRFS: October 24 06Z, 24 selected hours, 9 native levels.
- Dog HRRR: October 24 12Z, 18 selected hours, 9 native levels.
- Dog HRDPS: October 24 12Z, 18 selected hours, 11 native levels.
- Dog GFS: October 24 06Z, 8 selected hours, 8 native levels.
- Aparan ICON-EU: October 24 06Z, 13 selected hours, 29 native levels. Its first forecast is 11 AM local; the missing morning tests daylight padding.

The Dog records came from `/tmp/dog-model-audit`, saved during the earlier live-site comparison. The normal `forecasts/data` cache held older Dog runs when these fixtures were frozen. ICON came from the existing `forecasts/data/icon-eu/sites/am-aparan.json`. The source URLs identify mutable published endpoints; the recorded hashes identify the frozen versions.

Three clearly labelled synthetic scenarios reuse `web/dev-data-src/convective-cycle.profile.json` (MIT, Justin Watts, 2026). `scenarios.mjs` places its fictional site at 45°N, 0°E with UTC display hours. The strong-lift case retains its source weather values. The inversion case sets alternating warm/cold layers and dry air. The cloud case adds a 75% cloud layer with near-saturated air. These two visual stress cases retain synthetic lift diagnostics; they are illustrative combinations, not internally recomputed forecasts.

## Run

From the repository root, with Node 24 and the existing web dependencies installed:

```sh
node --test web/test/windgram-visual-fixtures.test.ts
node web/scripts/windgram-visual-qa.mjs --out /tmp/windgram-visual-qa
python3 -m http.server 4331 --bind 127.0.0.1 --directory /tmp/windgram-visual-qa
```

The script takes the baseline and its local library dependencies directly from Git revision `b4a0824cb3d9370d959222b59f54daab0942735f`. It renders the working library separately. Both use the dependency lock recorded in `manifest.json`; a changed lock fails the comparison. `--baseline <revision>` selects an explicit alternative. `--fixtures dog-rrfs,aparan-icon-eu` limits a diagnostic run. Temporary baseline directories can be removed after QA.

The full matrix contains eight scenarios × four viewports (320×667, 390×844, 844×390, 1280×900) × imperial/metric × focused/full height: 128 before/after pairs, 256 SVGs. The harness uses 17 px margins, so a 390 px viewport supplies a 356 px chart container. The baseline receives the specified viewport height; the revised renderer determines height from width. Each version uses its actual SVG renderer, key renderer, and global stylesheet.

Open this URL through CUA for screenshots:

```text
http://127.0.0.1:4331/?fixture=dog-rrfs&viewport=390x844&units=imperial&range=soaring&version=before
```

Switch `version=after` for the matching scene. `range=full` selects full height. Add `clean=1` to hide QA controls and metadata. The page is a static renderer harness; selected-hour controls, hover/tap, resizing, navigation and launch-page layout require a separate browser check on the application. Viewport parameters set scene geometry; use the matching browser viewport for the final screenshot. This matrix supplies one local-day selection; explicit-hour and multi-day selection behavior stays covered by the application tests.

## Acceptance checks

`report.json` records the baseline, source and fixture hashes, run/publication timestamps, physical-data hashes, and before/after dimensions for every pair. The script checks parsed forecast records, all native column samples, lapse-rate category boundaries and assignments, published lift diagnostics, source immutability, finite SVG output, and AGL relative to both launch and model terrain. Inspector readings are compared at native heights, layer midpoints and the lift line throughout the common visible range. Changes to displayed hours or empty daylight columns are recorded separately; each rendered forecast hour must still refer to a real source record.

The checks allow presentation changes: geometry, labels, spacing, colours within a category, and daylight cropping. They do not verify meteorological accuracy against observations or assert that WxToFly used the same model run. The manifest's WxToFly image reference, when present, records the captured layout comparison and its measured plot bounds only. Human screenshot review remains required for legibility, overlaps, and interaction quality.
