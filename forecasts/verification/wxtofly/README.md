# Windgrams / WxToFly scientific review

Capture preserves served evidence. Compare reads that snapshot offline and produces an interactive report and machine-readable results. Neither operation rebuilds model data, changes forecast calculations, nor deploys anything. WxToFly is a comparison forecast, not an observation.

## Run

From the repository root, using Node 24 or newer:

```sh
pnpm build:packages
pnpm --dir forecasts verify:wxtofly capture \
  --site-url https://jdorrance.github.io/windgrams/ \
  --wx-url http://wxtofly.net/ \
  --output .scientific-review/capture \
  --archive-root data --archive-days 30
pnpm --dir forecasts verify:wxtofly compare \
  --snapshot .scientific-review/capture --archive-days 30
```

Paths are relative to the command's working directory (`forecasts/` with the commands above). Capture needs public HTTP access. Use a new output directory for each capture; an exclusive capture lock prevents concurrent or interrupted directory reuse, and a completed `snapshot.json` is never replaced. An explicit `--data-url` resolves ambiguous discovery. Compare writes `report/report.json` and `report/index.html` by default; `--output DIR` selects a separate report directory. Open `index.html` in a browser or serve the snapshot directory locally. No network requests are made by compare or the report.

An optional `--inspection FILE` attaches a separately frozen inspection manifest. It contains `resources` in the snapshot's content-addressed store, `images` with hash-bound qualitative notes, and `browser` observations with site, model, UTC initialization/valid time, evidence hashes, and readings (`field`, original `display`, normalized `siValue`, rounding `tolerance`). Every referenced object is verified. This keeps human visual inspection and deployed-browser evidence distinct from automated checks of the current checkout.

## Output contract

- `snapshot.json`: retrieval timestamps, URLs, statuses, hashes, served catalogues, run/profile identities, exact original source objects, coordinate matches, map inventories and retained archive references. `objects/<sha256>` stores immutable bytes. HTTP failures and invalid/unstable products remain evidence.
- `report.json`: normalized pairs with both sources, original Wx text, units, UTC times, both initialization/lead times when known, model terrain, method version and cohort; exclusions and product/family coverage; signed, mean absolute, median and p95 absolute differences and counts by model pair, place, region, lead and day; event presence/timing, fixed cases, field/region maxima, independent checks, observation matches and recommendations.
- `index.html`: filters, matched numerical series, the three fixed-case chart pairs, evidence links, coverage/freshness, scientific explanations and prioritized validation work. Matched retained charts use the current renderer with original issued values; their caption identifies that distinction.

Latest live publication and latest mutually comparable rows have different owners (`rows[].cohort` and `latestMutual`). Older long-range forecasts never silently become today's issue. The optional 1–30 day window selects **existing** archives; it does not manufacture missing days. History readers preserve first-issued revisions. The local Git state is provenance for tooling, not a claim about deployed code.

## Scientific boundaries

[fields.mjs](fields.mjs) owns equivalence, original units, absence and height references. [coverage.mjs](coverage.mjs) owns the disposition of every discovered product and required field family. The previous labels in [provider-inventory.mjs](../provider-inventory.mjs) are explicitly reassessed in each report, not accepted as proof of inter-provider equality.

Compare exact UTC valid times first. Diagnose different source weather, model grids, terrain, layer definitions and algorithms separately. Wx tables do not necessarily publish initialization; a blank `ForecastPd` stays unknown. Model AGL uses each model's own ground. Name/explicit aliases plus geographic proximity establish matches; competing candidates and landing zones remain ambiguous. Both table coordinates and discrepancies with the legacy site catalogue are retained.

Conversions preserve printed precision: knots to m/s, feet to meters, ft/min to m/s and °F to °C. Missing text is null; zero remains zero. Wind vectors are compared in components. Directions require both speeds above 1 m/s. Ensemble median speed plus aggregate direction is not scored as a physical mean wind vector. Scalar ensemble medians remain labeled.

The 1 m/s and 225 ft/min (1.143 m/s) ceilings are separate. Potential LCL is not ambient cloud base. Parcel-derived depth is not native model PBL depth. Wx `cm/s_ Convergence` / `wblmaxmin` is vertical velocity, not horizontal convergence in 10⁻⁵ s⁻¹. Unspecified flux averaging and rain accumulation intervals are excluded. Upper-air interpolation uses bracketing levels above both model grounds and wind components, without extrapolation; there is no numeric upper-air score when the current counterpart is image-only or undated.

Image retrieval is not evidence of a model initialization or valid day. Source URLs and menu hours enumerate maps, while image dates require inspection. A chart can be available for visual review and still lack comparable timing. The report keeps this limitation visible. Only inspected, hash-matched images receive qualitative notes; other retrieved images remain available evidence, not claimed pixel-by-pixel validation.

[science.mjs](science.mjs) independently evaluates LCL, W*, lift-ceiling roots and physical bounds from frozen deterministic columns, with allowances for published rounding. These selected checks do not independently validate all parcel-depth/cloud algorithms. [cases.mjs](cases.mjs) preserves source columns and diagnostic inputs for the fixed sites and largest discrepancies. Recomputed values never replace issued forecasts in scores. Observation matching reuses evaluator 3.0.0 and its exact-time / near-initialization tiers and independent station-day counts.

## Validation and limits

```sh
node --test forecasts/verification/wxtofly/review.test.mjs
```

Run from the root after package build. Tests cover parsing, units, DST, intervals, aliases, direction wraparound, model terrain, missing versus zero, changing captures, hash tampering, identical inputs, explicit mismatch exclusions, interpolation bounds, renderer readouts and deterministic offline reproduction. Also run the [root checks](../../../README.md#development-checks).

Capture verifies live model manifests before/after collection, validates profile/run identity, and retries changing Blipspots. Images lack a machine-readable run identity; their unresolved identity is not inferred from HTTP modification time. Numeric regional comparisons use validated published bundles and hash verification, retaining native cell indices and terrain. Regional captures retry moving pointers and require the index to bind the exact manifest hash; unresolved changes stay unavailable in product coverage. External numeric map scores are withheld when no native Wx arrays are published. Browser inspection tests a stated sample of deployed readouts; local rendering checks must not be described as proof of the deployed JavaScript.

Archive and observation coverage are measured, not assumed to span the requested window. Multiple models or levels at one station/date are not independent station-days. Forecast disagreement can remain unexplained after a complete review; the report must give the missing evidence needed to distinguish the alternatives.
