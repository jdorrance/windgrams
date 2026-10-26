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
node web/scripts/windgram-visual-qa.mjs --allow-surface-anchor-change --out /tmp/windgram-visual-qa
python3 -m http.server 4331 --bind 127.0.0.1 --directory /tmp/windgram-visual-qa
```

The runner compares the current renderer with the Git revision pinned in the manifest. It extracts that revision's dependencies and checks the archived lock hash and installed forecast-reader version. Use `--baseline REVISION` to choose another baseline or `--fixtures dog-rrfs,aparan-icon-eu` to run fewer cases. You can remove temporary baseline directories afterward.

Unknown options and fixture names fail. Starting a run replaces any old receipt
with `status: incomplete`; only a finished comparison writes `status: passed`.

The full matrix is eight scenarios × four viewports × two units × two height ranges: 128 pairs, 256 SVGs. Viewports are 320×667, 390×844, 844×390 and 1280×900. A 17 px outer margin gives a 356 px chart at 390 px width. Baseline height follows its viewport; current height follows width.

Open in a browser at the matching viewport:

```text
http://127.0.0.1:4331/?fixture=dog-rrfs&viewport=390x844&units=imperial&range=soaring&version=before
```

Use `version=after` for the matching current render, `range=full` for full height and `clean=1` to hide QA controls. This static harness covers render output; selection, inspection, resizing and navigation need an application browser check.

## Checks

`report.json` records provenance, physics hashes and dimensions. Assertions cover parsed records, native samples, lapse classifications, published lift diagnostics, source immutability, finite SVG coordinates and AGL from both launch and model terrain. Current readers preserve additional soaring and source metadata; every added field must match the frozen input exactly. Inspector values are compared at native levels, layer midpoints and the lift line within the shared visible range. Rendered hours must map to source records; daylight cropping and empty columns are recorded separately.

Inspect screenshots for clipping, overlapping labels and legibility. Geometry, spacing and colours within a category may change while the checks above still pass. Use the captured WxToFly image as a layout reference; assessing forecast skill requires matched model runs and observations.

## Physical near-surface anchors, October 26, 2026

The package scene baseline now places the model surface temperature and moisture
at terrain + 2 m, and wind at terrain + 10 m. The earlier renderer placed both at
terrain. Physical interpolation no longer supplies values below those nodes;
the surface-row position remains a display choice. Parcel-top and surface-wind
labels also identify their basis explicitly.

The 40-scene baseline update first reproduced all previous HEAD hashes, then
checked unchanged input records, published lift, valid times, vertical extents
and 1,017 native upper-air temperature values across 81 hours. At the tested
near-surface heights (20 m AGL and the first-layer midpoint), the largest change
was 0.0931 °C and 0.310 m/s vector distance. These describe the sampled frozen
cases, not bounds for other profiles. Paired RRFS mobile and ICON-EU desktop
renders were inspected for clipping, labels, missing coverage and lift markers.

The runner is strict by default and rejects these changed anchors against the
pinned revision. The explicit `--allow-surface-anchor-change` option above uses
an independently constructed expected change: move only temperature/moisture
nodes by 2 m and wind nodes by 10 m, then recompute the affected layer gradients.
It checks the current inspector against the archived reader using those expected
nodes and humidity layers. Native values, published diagnostics, timestamps,
ground references and all other sampling fields must remain identical.

The report names and hashes this expected-change profile, preserves before/after
physics hashes, and reports measured temperature and vector-wind differences and
availability changes. Additional sampling at terrain + 0, 1, 2, 5, 10 and 20 m
checks the new lower bounds. Reported maxima describe those frozen samples, not
universal tolerances. No source data is regenerated or modified. Omit the flag
when reviewing a change that must preserve all physical interpolation.

## Integrated daylight review, October 26, 2026

The 40-scene baseline also includes the solar-crossing layout from main
`9c2f046a73ef25a910f8794b130c88c10cc68166`. It retains the physical anchors above,
keeps the forecast samples bracketing sunrise and sunset for interpolation, and
clips the visible time axis to daylight. The existing 128-pair numerical review
passes with only the explicitly named surface-anchor change.

An additional checkpoint-to-integrated comparison used frozen October 25 RRFS
profiles for Blanchard, Tiger Mountain and Rampart Ridge, plus an explicitly
synthetic Coronet Peak summer scene. At 390 px and 1280 px in both unit systems,
180 shared hourly samples and 2,428 physical readings are unchanged. All four
source profiles remain unchanged. Thirty-two SVGs and 36 screenshots document
the comparison; mobile pairs and desktop integrated scenes were inspected for
clipping, units, contours, lift marks and daylight labels. The New Zealand case
tests appearance and calendar handling, not forecast accuracy. Screenshots wait
for fonts and two animation frames before capture.

Local review artifacts are in
`forecasts/.scientific-review/2026-10-26-integrated-charts/`; `review.json` records
source hashes, the exact checkpoint, comparison counts and review limitations.
All 14 merged browser tests pass, including launch terrain/support labels,
calm winds, New Zealand local-date selection and model changes. Additional
Coronet Peak application screenshots cover the 390 px and 1280 px layouts,
conditions, hour selection and sounding; these use labelled synthetic fixtures.

## Readout provenance fields, October 26, 2026

The 40-scene baseline was regenerated after two fields were added to the internal
scene for the inspector readout: `gustSemantics` (the document's declared gust
class, `profile.semantics.gust`, or null) and per-hour `liftFamily`
(`publishedLiftFamily`, `'v2'` or `'v1-legacy'`). The parity hash serializes the
whole internal scene, so every key changed. Before writing the new baseline, the
same 40 payloads were hashed with only those two keys removed; all 40 reproduced
the previous hashes, so the SVGs, keys, physical readings and every other scene
field are unchanged. The frozen fixtures all publish V2 diagnostics and declare
their gust class (`instant` or `hourMax`); no fixture exercises the undeclared or
V1-only readout wording here, which the unit tests cover instead.
