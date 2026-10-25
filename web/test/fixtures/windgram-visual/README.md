# Windgram visual QA

These frozen profiles from October 24, 2026 let you compare renderers offline. [`manifest.json`](manifest.json) lists the source URLs, run and publication times, and file and hour hashes. Each profile contains unchanged hourly records for one local day:

- Dog RRFS: 06Z, 24 hours, 9 native levels.
- Dog HRRR: 12Z, 18 hours, 9 levels.
- Dog HRDPS: 12Z, 18 hours, 11 levels.
- Dog GFS: 06Z, 8 hours, 8 levels.
- Aparan ICON-EU: 06Z, 13 hours, 29 levels. Starts at 11 AM local to test missing morning coverage.

Dog profiles came from the earlier live-site comparison; ICON came from the local forecast cache. The manifest retains their capture paths. Published URLs are mutable; hashes identify these frozen versions.

Three synthetic scenarios reuse [`convective-cycle.profile.json`](../../../dev-data-src/convective-cycle.profile.json) (MIT, Justin Watts, 2026), placed at 45°N, 0°E with UTC hours. [`scenarios.mjs`](scenarios.mjs) retains the source strong-lift weather, creates alternating dry inversions, or adds 75% cloud with near-saturated air. The latter two retain synthetic lift diagnostics without recalculation; they test appearance only.

## Run

Complete the [workspace setup](../../../../README.md#start-locally), then run from the repository root:

```sh
node --test web/test/windgram-visual-fixtures.test.ts
node web/scripts/windgram-visual-qa.mjs --out /tmp/windgram-visual-qa
python3 -m http.server 4331 --bind 127.0.0.1 --directory /tmp/windgram-visual-qa
```

The runner compares the current renderer with the Git revision pinned in the manifest. It extracts that revision's dependencies and checks the archived lock hash and installed forecast-reader version. Use `--baseline REVISION` to choose another baseline or `--fixtures dog-rrfs,aparan-icon-eu` to run fewer cases. You can remove temporary baseline directories afterward.

The full matrix is eight scenarios × four viewports × two units × two height ranges: 128 pairs, 256 SVGs. Viewports are 320×667, 390×844, 844×390 and 1280×900. A 17 px outer margin gives a 356 px chart at 390 px width. Baseline height follows its viewport; current height follows width.

Open in a browser at the matching viewport:

```text
http://127.0.0.1:4331/?fixture=dog-rrfs&viewport=390x844&units=imperial&range=soaring&version=before
```

Use `version=after` for the matching current render, `range=full` for full height and `clean=1` to hide QA controls. This static harness covers render output; selection, inspection, resizing and navigation need an application browser check.

## Checks

`report.json` records provenance, physics hashes and dimensions. Assertions cover parsed records, native samples, lapse classifications, published lift diagnostics, source immutability, finite SVG coordinates and AGL from both launch and model terrain. Inspector values are compared at native levels, layer midpoints and the lift line within the shared visible range. Rendered hours must map to source records; daylight cropping and empty columns are recorded separately.

Inspect screenshots for clipping, overlapping labels and legibility. Geometry, spacing and colours within a category may change while the checks above still pass. Use the captured WxToFly image as a layout reference; assessing forecast skill requires matched model runs and observations.
