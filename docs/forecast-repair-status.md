# Scientific review repairs

These changes address defects and evidence gaps found in the WxToFly/XC Skies
review. They change local code and add reproducible experiments. Source-product
migration remains opt-in; observation skill is a separate release decision.

## Implemented

- Launch panels, direction markers and supplemental charts identify **model
  surface wind** and the launch/model-ground difference. Missing comparisons stay
  unavailable. The parcel thermal-top curve has its own label; native PBL depth
  remains separate.
- Windgram interpolation locates surface temperature/moisture at 2 m and wind
  at 10 m above model ground. The surface glyph row remains a display convention.
  Soundings preserve the model-ground parcel convention independently of plotted
  measurements. Published source values and lift heights are unchanged.
- Diagnostic method **2.3.0** respects supplied model surface pressure, retains
  hypsometric fallback and preserves pressure through point reconstruction.
  Experimental launch-altitude wind uses valid adjacent wind nodes at their real
  heights, records the target/bracket, and rejects extrapolation and missing or
  duplicate brackets. It is a free-air estimate, not resolved slope wind or gusts.
- Optional support metadata exposes native sampling geometry, thermal-depth
  branches, profile-top limits, cloud-cap source and pressure source. The
  [contract](../packages/contracts/src/diagnostic-support.ts) owns the meanings.
- [NOAA acquisition](../packages/providers/README.md#noaa-source-experiments)
  shares normalized columns and native cells between point and area adapters.
  Legacy, expanded-pressure and HRRR native modes are explicit experiments.
  Exact GRIB identities, run/time/grid, bytes and missing columns are checked.
  The LFC selector now uses fixed-surface code 14, not tropopause code 7.
  GFS has its own regular-grid geometry, RH conversion and verified three-hour
  precipitation/heat-flux intervals, including same-run companion windows.
- [Comparison definitions](../forecasts/verification/definitions.mjs) separate
  convergence from vertical velocity, LCL from CCL/cloud base, native PBL from
  parcel depth, and the two sink thresholds. Strict comparisons exclude
  unverified initialization and incompatible quantities, datums and intervals.
- Issued-history operators retain available runs for a 30-day calendar floor and
  preserve full published source columns at the four regression sites. First
  issues remain the scoring baseline. Calendar coverage and UTC-normalized
  independent station-days describe the evidence actually available. Retention
  does not guarantee 30 scored days: the scorer defaults to 30 runs, accepts up
  to 120, and reports retained days omitted by the selected run limit.

## Evidence and reproduction

Run from the repository root with Node 24 after `pnpm build:packages`:

```sh
node forecasts/verification/publication-baseline.mjs --output /tmp/new-baseline
node forecasts/verification/method-impact.mjs /tmp/new-baseline/baseline.json /tmp/new-impact.json
node forecasts/verification/thermal-experiment.mjs --output /tmp/new-reference.json
```

Output paths must be new. The first command reads public served bytes; the latter
two run offline and never replace issued forecasts. The capture takes the served
client, actual data origin, model inventories, refresh status, regression-site
profiles and hash-verified regional bundle manifests, retrying moving pointers.
It is an implementation baseline, not a new full-coverage external skill review.

The October 26 capture is retained under
`forecasts/.scientific-review/2026-10-26-release-baseline/`. It discovered 268
published sites, eight live model manifests and five stable regional pointers;
four additional catalogue models had no served manifest. Its four regression
sites are Blanchard, Tiger Mountain, Rampart Ridge and Baker Summit. Six sampled
deterministic models already served method 2.2.0. ICON has no site in that US-only
regression selection; GEPS retains its separate ensemble derivation.

The earlier same-session point capture and its method-impact experiment are in
`2026-10-26-fix-baseline/`: 1,864 hours and 72,696 scalar comparisons had zero
differences when reconstructing the unchanged published inputs with 2.3.0.
Those rounded inputs do not include new model surface-pressure measurements;
this does not imply that expanded/native source products leave diagnostics
unchanged. The immutable October 25 WxToFly and XC Skies snapshots remain intact.

The independent source-column experiment is in
`2026-10-26-thermal-reference/experiment-with-native-icon.json`: 18 frozen columns,
126 checks, zero failures. It derives depth and cloud cap independently before
checking W* and both ceilings. Three real ICON columns were reduced from 30 to
nine existing native nodes to measure sampling sensitivity. Analytic inversion
and branch-transition cases cover behavior absent from those weather samples.
Agreement establishes implementation consistency with the declared policy;
it does not validate that policy against observations.

The [visual QA notes](../web/test/fixtures/windgram-visual/README.md) record the
intentional near-surface sampling changes and unchanged native data/lift markers.

The live NOAA trials are in
`2026-10-26-noaa-source-impact/source-impact.json`, with final snapshots in its
`checked/` directory. All seven captures (HRRR legacy/expanded/native, RRFS
legacy/expanded and GFS legacy/expanded) completed at four sites and reproduced
offline with network fetches disabled. There are 36 source rows and 20 same-run
contrasts; pressure-only and levels-only experiments isolate those two effects.
Additional 80 m winds can also change layer-wind diagnostics in the full candidate.
HRRR native has 50 levels, with its first near 10 m AGL. GFS expanded uses its
actual 15-level inventory, not the 18-level HRRR/RRFS inventory.

The added levels materially change some diagnostics. At Blanchard, the same
00Z/f20 RRFS column changes thermal top from 512.4 to 142.3 m **MSL**, W* from
0.73 to 0.34 m/s, and the 225 ft/min ceiling becomes unavailable. HRRR expanded
changes thermal top from 641.4 to 348.9 m MSL and W* from 0.90 to 0.61 m/s.
Levels-only experiments reproduce these differences; pressure-only changes
round to zero in these cases. GFS lower sampling improves while its sampled
rounded lift outputs remain unchanged. More vertical detail does not imply more
lift or proven accuracy; these effects justify a separate source-migration gate.

## Release gates and outstanding evidence

1. Keep the [root checks](../README.md#development-checks) passing. Review the presentation,
   method and acquisition changes separately. Production acquisition still uses
   its existing source mode until an explicit migration is accepted.
2. Compare legacy/expanded/native data at the **same run, valid time and cell**.
   Separate the effects of surface pressure, additional levels and diagnostic
   method. Keep the recorded model terrain; never substitute launch elevation.
3. Benchmark full horizons before promoting native HRRR. The four-site one-hour
   trial required about 64 MB for legacy fields, 121 MB for expanded fields and
   524 MB for native fields before cache reuse. More detail has a material
   acquisition cost. A native-product failure must retain the last complete
   publication or select an explicitly identified whole pressure product.
4. Collect held-out station-days and relevant cloud/lift observations. Existing
   observations are too sparse to establish general forecast improvement or to
   tune thermal-depth/cloud-cap policy. No change to that physical policy is
   justified solely by agreement with XC Skies. The 30-day retention floor is
   prospective and cannot recover missing historical data.
5. After a separately managed deployment, capture a new served baseline, verify
   method/adapter identities and refresh status, and compare browser readings
   with those exact files. Keep the previous complete dataset available for
   rollback. No deployment or source-mode promotion is performed by this work.

RRFS native-level availability remains unverified. Native GFS is not advertised.
Launch interpolation does not resolve ridge acceleration, shelter or local gusts.
Those limits remain visible rather than being converted into accuracy claims.

## Initial implementation validation

The initial October 26 local run passed all five root commands: `pnpm check`,
`pnpm test` (792 tests), `pnpm test:consumer` (34 public entry points),
`pnpm test:browser` (13 Chromium tests), and `pnpm build` (130 pages).
Types, package boundaries and public declarations passed without diagnostics.

The visual QA run passed 128 before/after scene pairs using the documented
`--allow-surface-anchor-change` review mode. It checks the intentional 2 m/10 m
sampling change against an independent reference while preserving source values,
published lift diagnostics and native samples. Strict parity mode still rejects
the intentional change. Representative mobile and desktop pairs were also
visually inspected.

Logs, the paired SVG gallery, source-file hashes and the immutable-evidence hash
check are retained in
[`2026-10-26-implementation-validation/`](../forecasts/.scientific-review/2026-10-26-implementation-validation/receipt.json).
The October 25 WxToFly/XC Skies snapshots and reports retain their original hashes.
These checks validate the local implementation; they do not certify a deployment
or establish forecast skill.

## Refactor and delivery review

The follow-up review separated responsibilities without changing the declared
thermal policy. Meteorology owns adjacent-node vector wind sampling; launch
adjustment and Skew-T supply their own physical heights and bounds. Parcel-depth
policy owns its branch provenance independently of W* and ceiling calculations.
NOAA point and area adapters share field inventories, interval handling, native
cell selection and acquisition receipts. Verification providers share immutable
evidence storage and retention policy, with provider-specific parsing and findings
kept separate. Presentation reuses wind formatting and comparison-row rendering.

The review corrected missing and calm wind handling, retained valid near-ground
wind nodes independently of parcel filtering, and protected capture directories
from accidental overwrite. Frozen WxToFly and XC Skies replays retained their
comparison summaries and counts; the WxToFly replay passed 49,612 independent
reference checks. No original captured evidence was rewritten.

Delivery now preserves validated 2.2 products during staggered 2.3 refreshes,
prevents old origins or artifacts from downgrading current products, and requires
consistent method identities within each product. The served-data monitor accepts
legitimate null soaring diagnostics while still enforcing freshness. All 28
actual frozen 2.2 profiles passed the retained-method validator. Science source
changes dispatch model producers, and Pages requires a successful Check run for
its exact checkout. The [operations guide](../forecasts/docs/operations.md#publication-and-retention)
owns the rollout and recovery details.

Two integration and release concerns remain explicit:

- Remote `main` at `9c2f046a73ef25a910f8794b130c88c10cc68166` was four commits ahead
  of this checkout. An isolated trial merge found six conflicts in ignore rules,
  chart fixtures/tests, launch presentation and browser tests. Preserve upstream
  New Zealand/daylight work during integration, then review the combined charts
  and regenerate their baselines; all 40 combined scenes differ from both
  branches. This trial did not merge or modify the working branch.
- Archive capacity needs a representative 30-day storage and timing rehearsal
  before promotion. The recorded estimate is roughly 20 GB uncompressed across
  the sampled seven-model inventory at the 120-run floor, including four full
  columns per run, before additional revisions and staging copies. This is an
  extrapolation, not a measured live archive or a quota failure. Pages excludes
  history, but caches, provider artifacts and staging still carry it.

### Follow-up validation

All five root checks passed after the refactor: 809 tests, 34 packed consumer
entry points, 13 Chromium tests and a 130-page production build. CI kernel
coverage also passed: 99.40% lines, 91.46% branches and 97.06% functions.
Presentation review passed 128 paired scenes; this refactor retained the prior
implementation's 40 scene hashes. The added tests focus on scientific boundaries,
capture integrity, publication rollover and CI gating.

A temporary checkout also passed a frozen-lockfile install, engine dry run,
sample-data generation, and five native ICON decoder tests with freshly installed
pinned Python dependencies. That checkout preceded the final delivery and gate
edits; the complete final suite above ran in the working checkout. These are local
checks, not a remote CI result for the uncommitted patch.

The [follow-up receipt](../forecasts/.scientific-review/2026-10-26-refactor-validation/receipt.json)
records logs, source hashes, replay summaries, visual evidence, the integration
assessment and the capacity estimate. Original snapshot, report and experiment
hashes remain unchanged. No commit, deployment, main-branch merge or source-mode
promotion was performed.
