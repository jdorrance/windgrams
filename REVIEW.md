# Windgrams Repository Comprehensive Audit & Review

**Audit Date:** October 25, 2026\
**Repository:** `windgrams` (`pnpm@10.28.0` monorepo, Node `>=24`, TypeScript `5.9.3`)\
**Scope:** End-to-end zero-assumption review across folder/workspace topology, package boundaries, atmospheric thermodynamics, soaring physics, solar/terrain raymarching, cartographic projections, GitHub Actions CI/CD & refresh delivery pipelines, frontend controllers/components, Cloudflare Worker security, performance, and test/evaluation coverage.

## Implementation feedback — verified October 25, 2026

**Baseline: commit `54bd70f846776cceb24a382a2e01e79b729f56e4`. Do not implement the original finding list verbatim.** It mixes older repository states, confirmed defects, documented approximations and speculative improvements. Several proposed fixes would introduce regressions. The listed critical issue is already resolved. The original report below is preserved; this feedback takes precedence when deciding what to implement.

This review checked callers and public contracts, reproduced numerical and missing-data cases, and used independent frontend, pipeline and science reviews. The baseline passes 675 tests, coverage thresholds, package consumer checks, six browser tests, the production build and all five GitHub CI jobs. Passing tests establish a baseline, not scientific forecast accuracy.

### Implemented on `feature/feedback-10-25`

The confirmed corrections are implemented: F-02, F-04, F-07, lifecycle portions of F-09/F-25, F-14, the bounded display conversion in F-15, F-17, F-20, F-21, F-22 and the display explanation in F-23. F-11/F-12 approximation comments and F-16 method ownership are clarified without changing the retained formulas or relabeling sparse-provider output. F-08's startup banner is preserved after verifying its bootstrap owner. Already-fixed, unsupported and research-only findings remain excluded for the reasons below.

Numerical changes use method 2.2.0, with analytic tests, archived source comparisons and same-run rebuild checks. See [method evidence](docs/refactor-plan.md#archived-comparison-and-rollout), [projection comparison](docs/soaring-replay.md#projected-convergence) and [rollout instructions](forecasts/docs/operations.md#publication-and-retention). The remaining physical closure transition and limited observation sample are still documented; this work does not claim empirical forecast calibration.

The second review tightened resource ownership and async behavior: stalled station bodies time out, suspended sunlight rendering stays paused, failed terrain tiles can retry, and older selections cannot overwrite newer ones. Parcel curves own their humidity status, and diagnostic version types follow the runtime version constant. Pilot copy uses short readings and explicit limits; calculation details remain in the linked references. Independent cross-reviews found no remaining blockers in these changes.

Final local verification: `pnpm check`, all 702 tests with coverage thresholds, the isolated consumer check (33 public entry points), all 12 browser tests and `pnpm build` passed. After the last copy edits, all 279 web tests, web type checks and all 12 browser tests passed again. No historical issued forecast was rewritten. The fixes must be merged and refreshed before production uses the new method.

### Resolved, false-positive, or unsafe recommendations

- **F-01 — Already fixed on `main`.** [PR #2](https://github.com/jdorrance/windgrams/pull/2) restored token-dispatched publication. The [workflow](.github/workflows/refresh-provider.yml) and its [test](forecasts/scripts/pages-workflow.test.mjs) contain the step and pass. Keep the current `!cancelled()`, main-ref, dispatch-event and bot-actor conditions. The proposed `always()` replacement discards deliberate cancellation and duplicate-dispatch guards. Its quoted test is not the current test.

- **F-05 — Reject the proposed solar/force change.** Solar is intentionally excluded from Pages for size; see [operations](forecasts/docs/operations.md) and [dataset preparation](scripts/prepare-dataset.mjs). Adding it to provider artifacts does not make Pages serve it. [Terrain freshness](forecasts/scripts/terrain.mjs) checks coordinates, finite elevation, source policy, measurement-policy identity and timestamps, not merely site IDs. A separately hosted solar refresh or an explicit force option could be a feature, but neither justifies forcing every manual dispatch.

- **F-06 — Fixed in the current checkout / PR #3.** [Launch pages](web/src/scripts/launch-page.ts) and live regional pages both fetch provider health and pass it to the notice. [PR #3](https://github.com/jdorrance/windgrams/pull/3) must be accounted for before editing this area; do not add duplicate readers or warnings. This is distinct from whether that PR has been merged and deployed.

- **F-09, routing portion — Proposed fix is wrong.** The [Worker router](web/worker/index.ts) deliberately owns root `/api/admin/launches` and `/api/stations/<id>`, as described in [web deployment](web/README.md). Prefixing these routes with the static `BASE_URL` breaks the router. A GitHub Pages subpath does not supply a Worker API. Treat timer cleanup separately below.

- **F-10 — Current workflow already has the requested ordering.** [Pages](.github/workflows/pages.yml) saves its cache after validation, build, artifact assembly, upload and deployment, guarded by `success() && !inputs.dry_run`. Provider jobs intentionally restore a publisher-owned cache. Branch-scoped cache access is expected [GitHub behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching), not evidence of the alleged ordering defect.

- **F-13, boundary portion — Do not change `>` to `>=`.** In [horizon interpolation](packages/providers/src/internal/solar/horizon.ts), an exact last-row/last-column sample is valid: its interpolation fraction is zero, and clamping the adjacent offset is correct. Rejecting that sample can lower the calculated terrain horizon. This edit does not fix the separate mid-latitude distance approximation.

- **F-18, duplicate-files portion — Already centralized.** The [legacy Python entry](forecasts/scripts/lib/icon-decode.py) is a compatibility launcher for the package decoder, and [legacy requirements](forecasts/scripts/lib/icon-requirements.txt) reference the canonical pins. Package `dist` assets are generated. Do not remove these compatibility entry points as duplicate implementations.

- **F-19 — Invalid subset data is already rejected.** [Regional profile validation](packages/data-client/src/regional.ts) and the [legacy dataset reader](packages/data-client/src/dataset-reader.ts) require matching hour counts and positional `validAt` values before rendering. Saved subsets retain the complete manifest and track availability separately. The proposed `find(...) ?? hours[index]` fallback would conceal mismatched data rather than repair a supported case.

- **F-24, CORS portion — Intentional public access, not a vulnerability.** Separate browser-accessible data origins are supported. Restricting CORS would break legitimate consumers and does not stop non-browser downloads. [R2 internet egress is free](https://developers.cloudflare.com/r2/pricing/); request operations and upstream station quotas are the relevant cost questions. Station IDs are [allowlisted before upstream I/O](web/worker/stations.ts), and the checked-in allowlist is empty. Concurrent misses or repeated failures for future listed stations may warrant coalescing/backoff/rate limits, but arbitrary IDs cannot currently trigger the alleged upstream enumeration.

- **F-26 — Stale and potentially destructive advice.** `git ls-files` found none of the named cache/build artifacts tracked, and `git check-ignore` confirmed they are already ignored. At this baseline the only untracked work was this review. Remove the instruction to commit/revert unrelated working-tree edits; do not clean another contributor's work based on this finding.

### Confirmed issues with narrower implementation guidance

- **F-07 — Confirmed UI omission.** [The audit loader](web/src/scripts/soaring.ts) clears but never populates `audit-limitations`, despite validated limitations in the bundle. Render those strings with `textContent` in the existing details list and test an actual limitation. Keep immediate stale/error notices outside that disclosure.

- **F-08 — Already handled by the startup controller; preserve the banner.** [Launch bootstrap](web/src/scripts/launch-bootstrap.ts) wires `forecast-error` and `forecast-reload` for dynamic-import and startup failures. [Launch loading](web/src/scripts/launch-page.ts) separately renders “Forecast unavailable.” and a working “Retry forecast” button that clears a cached model miss. The earlier recommendation to remove the banner overlooked the bootstrap owner and would break initialization; no markup removal is needed.

- **F-09 lifecycle / F-25 — Cleanup APIs are incomplete; persistent leak impact is unproved.** Station polling and several chart observers lack owner-controlled cleanup. However, this site uses full-document navigation, and [Sunlight3D already has `dispose()`](web/src/scripts/sunlight3d.ts); the missing part is ownership/wiring. A targeted lifecycle change must cover observers, timers, pending work and map/renderer resources, while preserving the [existing bfcache lifecycle](web/src/scripts/page-lifecycle.ts). Do not dispose everything on a persisted `pagehide`.

- **F-14 — Confirmed parser limitation; broaden fixtures and token parsing together.** [The SRG parser](web/src/lib/srg.ts) rejects EDT/EST. But no currently ingested Eastern bulletin using this format was demonstrated. Also, three separate header/trigger expressions accept exactly three zone characters, so adding `AKDT`, `AKST` or `Z` to the map alone is insufficient. Use representative bulletins to test all parsing paths and rollover behavior.

- **F-17 — Confirmed missing-versus-zero defect; not a one-line fix.** Replaying the published RRFS fixture with missing optional fields reconstructs zero heat flux/precipitation/cloud and default SLP, then yields W* = 0. Merely preserving null in [reconstruction](packages/soaring/src/point-postprocess.ts) still yields zero because [convective velocity](packages/soaring/src/convective-lift.ts) also applies `?? 0`. The public diagnostic type requires numeric W*, and [publication validation](forecasts/scripts/lib/diagnostic-completeness.mjs) rejects null. Plan a coordinated missing-input policy across derivation, types, validation, publication and consumers. The synthetic SLP is not the pressure used for this W*: diagnostics estimates surface pressure hypsometrically.

- **F-22 — Confirmed synthetic-moisture path, chiefly observed/SRG soundings.** Normal model sounding construction rejects missing dew points, but balloon and SRG data can reach the fallback in [parcel lifting](web/src/lib/skewt.ts). A 20°C surface with unknown dew point produced an artificial LCL near 4,769 m and moist ascent above it. Preserve unknown moisture/cloud status; choose an explicitly qualified dry-only curve or omit unsupported parcel diagnostics. Cover SRG and partially missing observed moisture. This changes displayed physics.

- **F-23 — Confirmed semantic mismatch; the suggested predicate alone is insufficient.** [Skew-T shading](web/src/lib/skewt-chart.ts) depicts positive raw-temperature excess split around the LCL; it does not currently draw CIN shading or interpolate a buoyancy crossover. `thermalTop` uses virtual buoyancy. A reproduced layer had parcel 22.344°C, environment 23°C and positive virtual buoyancy of 2.575°C. Either clarify temperature-shading wording or implement consistent virtual-temperature geometry and crossing logic. Switching only the comparison leaves polygon coordinates on the raw-temperature traces.

### Scientific concerns that need a justified method change

- **F-02 — Real, already documented discontinuity; proposed recipe not approved.** The 1,000 → 0 → 3,000 m example reproduces and is already covered by [known-issue documentation](docs/refactor-plan.md) and characterization tests. Its upper environmental lapse is 10°C/km, not the implementation's 9.8°C/km dry adiabat. Clamping the denominator removes the zero but still leaves the first-level-to-upper-column jump; carrying a heat-flux boost through the column is another physical assumption. Derive the neutral limit, test PBL/no-PBL and heat-flux branches, measure changes on archived columns, and define method-version/rebuild policy. Operational frequency remains unmeasured.

- **F-03 — Real fallback policy, overstated production failure.** The hypsometric equation correctly uses height difference; there is no demonstrated scale-height-versus-height bug. Calling `computeThermalVelocityMps` with neither explicit surface pressure nor a first level returns zero, not a W* calculated at 1013.25 hPa. A truthy malformed level can reach the fallback, while normal validated diagnostics require adequate valid levels. A standard-atmosphere fallback is an alternative estimate, not an observed surface pressure. Document and test its domain and missing-input policy before changing this [public contract](packages/meteorology/README.md); the asserted alpine production impact has not been established.

- **F-04 — Projection approximation is real; multiply-only correction is incomplete.** Full map-coordinate divergence includes spatial derivatives of map factors and consistent vector orientation, not just a multiplier on the existing derivatives. Use the [WRF technical formulation](https://www2.mmm.ucar.edu/wrf/users/docs/technote/v4_technote.pdf), analytic vector-field tests, edge stencils and archived regional comparisons. Quantify the actual diagnostic impact before assigning high severity or changing the method. Do not imply this alone explains the Rampart thermal forecast differences.

- **F-11 — Constants differ; blanket unification is not justified.** The [numerical-compatibility notes](docs/refactor-plan.md) already record the gas-constant split. In W*, the potential-temperature exponent cancels algebraically between reference temperature and heat flux, so unifying that exponent does not correct a W* bias. Specific humidity and mixing ratio also require different denominators. Bolton/Magnus differences depend on conditions; representative 10/20/30 hPa vapor pressures gave roughly 0.011/0.022/0.029°C differences, not a demonstrated general 0.03–0.06°C bias. Treat any consolidation as measured method maintenance.

- **F-12 — Accurate approximation, unproved medium-severity defect.** Using dry rather than virtual temperature has a small humidity-dependent effect; the quoted warm/moist example gives about 0.19 hPa difference over 200 m. Preserve the paired RRFS geometric-w/omega inverse. An optional humidity correction needs explicit available/missing-moisture behavior, paired conversion tests and method-impact comparisons, not a unilateral formula substitution.

- **F-13, distance approximation — Real approximation, no demonstrated output defect.** Ray offsets use the domain's middle latitude; curvature/refraction are already represented. Quantify horizon and sunlight changes across supported domains before replacing the distance model. Keep this separate from the incorrect boundary edit rejected above.

- **F-15 — Low-priority consistency issue; example is numerically wrong.** At 3.8583 m/s the exact and rounded factors give 7.499935 and 7.499918 kt: both round to the same barb. A split exists in a much smaller interval near 3.858338 m/s. [Legacy factors are deliberate compatibility choices](packages/windgram/src/windgram-format.ts), and `mpsToMph` itself preserves a legacy factor. Review actual display boundaries before consolidation; the cited station conversion constant is absent.

- **F-16 — Different method labels are real; incompatibility is unproved.** [Provider public types](packages/providers/src/supplemental.ts) explicitly expose sparse method 2.0.0; their CLIs publish those outputs directly. Optional soaring postprocessing applies method 2.1.0 and can change elevation fallback and layer eligibility. These versions are not interchangeable schema labels. Do not relabel provider output as the latest method without establishing equivalent semantics, and do not introduce a providers-to-soaring dependency that violates package layering. Clarify version ownership first.

- **F-20 — Confirmed latent polar-graze limitation, narrower than stated.** A reproduced 86-second daylight interval near 67.396°N was missed by ten-minute sampling. Current catalogue sites span about 35.1–49.0°N. Returning null when both crossings are not in the requested window is the [documented API contract](packages/meteorology/README.md), not a separate bug. A general extrema/root-search improvement needs polar, midnight-crossing and arbitrary-window tests; checking only the window midpoint is insufficient.

- **F-21 — Tiny underpadding, not the overview's overpadding.** The current domains showed at most about 1.1 m first-order latitude-padding shortfall within a deliberate 500 m coarse-grid margin; no current terrain truncation was demonstrated. The proposed minimum of endpoint scales also fails for a domain crossing the equator. If changed, use a minimum over the full interval and verify geodesic coverage, including equator/pole edge cases.

### Maintenance, evidence, and report corrections

- **F-18, private import portion — Real maintenance coupling.** The pinned upstream terrain import is a documented workaround. A guarded shared bridge may reduce upgrade risk, but it is optional refactoring, not a reproduced runtime failure.
- **F-27 — Keep the evidence limitation; correct the count.** The [verification report](forecasts/verification/skill-report.json) contains eight comparisons sharing three station observations on one date, with zero exact-valid-time comparisons. The [verification README](forecasts/verification/README.md) already qualifies this. It does not establish empirical W*/usable-lift calibration; expanding independent observations is research work, not a workflow fix.
- **F-28 — Intentional compatibility wrappers.** Existing wrappers name their package owner. Several files cited in the finding do not exist. Removing forwarding modules without checking consumers has no demonstrated benefit here.
- **F-29 — Require profiling, not an automatic typed-array rewrite.** Geometry allocation depends on actual dimensions; “25k objects” is unmeasured. [Hour selection updates the cursor](web/src/scripts/windgram-controller.ts) without rebuilding geometry, and layout caching limits rebuilds. `Float32Array` changes precision and null representation and does not eliminate contour allocations. The ECCC disk cleanup is deliberately gated to ECCC + Linux + GitHub Actions and has no demonstrated defect.

The report's strengths also need factual corrections before being treated as verified architecture:

- There is no `packages/pipeline/src/publication.ts`; regional bundles use the full 64-character SHA-256 and case `index.json`, not a 16-character hash and `current.json`. [Bundle validation](forecasts/scripts/lib/artifact-products.mjs) checks sizes only when `fileBytes` exists for legacy compatibility. [Whole-dataset preparation](forecasts/scripts/prepare-publication.mjs) uses staging and rollback with two directory renames, not a globally atomic dataset swap.
- Provider execution writes acquisition health; collector/merge validate and combine it. They do not synthesize provider acquisition outcomes. Publication can still fail shared terrain or minimum-complete-model checks, so “an outage never blocks other models” is too absolute.
- The ensemble helper is `deriveEnsembleSoaringDiagnostics`, not `deriveEnsembleMemberHour`. It derives per-member diagnostics when member columns are available. Published GEPS percentile profiles retain upstream results and explicitly refuse nonlinear median postprocessing; do not generalize the helper's capability to every production GEPS path.
- Native capture/replay integrity checks should not be described as every legacy provider retaining original GRIB/NetCDF byte-range provenance. Byte integrity, method compatibility and observation-based accuracy are separate evidence.
- The original severity totals are also inconsistent with its rows (nine Low and three Info rows, not eight and four). Recount and reprioritize only after removing resolved/unsupported findings. Replace stale line numbers and illustrative snippets with evidence tied to a commit.

**Implementation scope:** the user authorized the confirmed corrections on `feature/feedback-10-25`. Preserve the startup error banner and existing retry paths. Implement audit limitations, SRG timezone support, owned resource disposal, missing-input semantics, parcel-depth interpolation, projection metrics, qualified dry parcel displays, solar graze detection and conservative terrain bounds. Numerical changes require analytic tests, archived comparisons and a method/rebuild decision; the unsupported recommendations above remain excluded.

## Executive Summary

Windgrams is an exceptionally well-engineered meteorological and soaring forecast platform. Its architecture demonstrates strong software and scientific discipline: strict zero-`any` TypeScript package boundaries enforced by AST inspection (`scripts/check-boundaries.mjs` and `scripts/check-api.mjs`), content-addressed immutable bundle staging with atomic pointer swaps, explicit distinction between model terrain and measured launch elevation, per-member nonlinear ensemble derivation before percentile aggregation, and SHA-256 provenance verification across GRIB2/NetCDF byte ranges.

Even with this high baseline, a zero-assumption audit across the mathematical models, physical constants, coordinate geometry, GitHub Actions workflows, frontend runtime controllers, and worker code surfaces **29 prioritized findings** (1 Critical, 4 High, 12 Medium, 8 Low, 4 Architectural/Operational).

### Prioritized Findings Overview

| ID | Priority | Category | Finding Summary | Primary Location(s) |
| :--- | :--- | :--- | :--- | :--- |
| **F-01** | **Critical** | GitHub Actions / CI | `.github/workflows/refresh-provider.yml` is missing the `- name: Request publication after token dispatch` step, breaking both `forecasts/scripts/pages-workflow.test.mjs` and `workflow_dispatch` refresh publishing | `.github/workflows/refresh-provider.yml:59-67`, `forecasts/scripts/pages-workflow.test.mjs:52-60` |
| **F-02** | **High** | Math / Physics | Near-neutral parcel-depth discontinuity (`denom <= 1e-5`) causes a 0 m → 3,000 m jump across a 0.01 °C surface change | `packages/soaring/src/convective-lift.ts:116-143` |
| **F-03** | **High** | Math / Physics | Scale-height $H$ vs. $\Delta z$ bug in `hypsometricSurfacePressureHpa` fallback (uses $1013.25$ hPa instead of standard atmosphere at `terrainM`) | `packages/meteorology/src/thermodynamics.ts:44-50` |
| **F-04** | **High** | Math / Physics | Horizontal convergence on Lambert grid omits map-scale factor $m(\phi)$ and curvature correction terms | `forecasts/soaring/grid-kinematics.mjs:15-39` |
| **F-05** | **High** | GitHub Actions / Pipeline | No GitHub Actions workflow ever runs `forecasts/scripts/solar.mjs --sync`; `refresh-terrain.yml` only syncs `site-context.json` (and skips when seeded from live site) | `.github/workflows/refresh-terrain.yml:11-26`, `forecasts/scripts/refresh-provider.mjs:11-12`, `forecasts/scripts/terrain.mjs:192-196` |
| **F-06** | **Medium** | Frontend / UX | `launch-page.ts` never wires `createRefreshHealthReader` into `createFreshnessNotice`, so launch pages silently omit degraded provider-refresh health warnings | `web/src/scripts/launch-page.ts:127-135`, `web/src/scripts/soaring.ts:95-108` |
| **F-07** | **Medium** | Frontend / DOM | `soaring.ts` clears `#audit-limitations` (`el('audit-limitations').replaceChildren()`) and never populates `audit.limitations` when `audit.json` loads | `web/src/scripts/soaring.ts:325-332`, `web/src/pages/soaring.astro:176` |
| **F-08** | **Medium** | Frontend / Dead UI | `#forecast-error` alert banner and `#forecast-reload` button in `launches/[slug].astro` have zero references or click handlers in `launch-page.ts` | `web/src/pages/launches/[slug].astro:55-57`, `web/src/scripts/launch-page.ts` |
| **F-09** | **Medium** | Frontend / Routing & Lifecycle | `station.ts` and `admin.ts` hardcode root-relative `/api/...` paths (ignoring `BASE_URL`/`href()`), and `station.ts` leaks two `setInterval` timers and a `visibilitychange` listener without `createPageLifecycle` | `web/src/scripts/station.ts:43,155-163`, `web/src/scripts/admin.ts:107,149` |
| **F-10** | **Medium** | GitHub Actions / Cache | `refresh-provider.yml` restores `forecast-data-${{ github.run_id }}` on non-`main` branches without ever saving, and `pages.yml` saves cache before `prepare-pages` even on `dry_run` | `.github/workflows/refresh-provider.yml:48-52`, `.github/workflows/pages.yml:76-97` |
| **F-11** | **Medium** | Math / Physics | Split thermodynamic constants ($R_d = 287.05$ vs $287.04$, $\kappa = 0.2854$ vs $R_d/c_{pd} = 0.2859$ vs $0.2857$, Magnus coefficients) across modules | `packages/meteorology/src/thermodynamics.ts`, `packages/providers/src/internal/icon-native.ts`, `web/src/lib/skewt.ts`, `web/src/lib/skewt-chart.ts` |
| **F-12** | **Medium** | Math / Physics | Dry-only virtual temperature in `geometricWFromOmegaMps` and `hypsometricSurfacePressureHpa` underestimates density altitude in moist air | `packages/meteorology/src/thermodynamics.ts:23-50`, `forecasts/soaring/grib-column.mjs:62-64` |
| **F-13** | **Medium** | Math / Physics | Solar horizon raymarching (`traceHorizons`) uses flat-plane azimuth offsets $(dc, dr)$ evaluated at `midLat` over 20 km and clamps right/bottom boundary pixels | `packages/providers/src/internal/solar/horizon.ts:20-76` |
| **F-14** | **Medium** | Math / Physics | `srgInstant` hardcodes only Mountain, Pacific, and Central US time zones (`MDT`/`MST`/`PDT`/`PST`/`CDT`/`CST`), silently dropping Eastern (`EDT`/`EST`) or other offices | `web/src/lib/srg.ts:59-65` |
| **F-15** | **Medium** | Math / Units | Dual unit conversion constants (`FEET_PER_METRE` vs `LEGACY_FEET_PER_METRE`, `KNOTS_PER_MPS` vs `LEGACY_KNOTS_PER_MPS`) create subtle cross-view discrepancies | `packages/windgram/src/windgram-format.ts:9-33`, `web/src/lib/skewt-chart.ts:20-22` |
| **F-16** | **Medium** | Pipeline / Data | `postprocessPointForecast` and `buildSiteDocument` stamp `"contractVersion": "2.0.0"` on ECMWF/NWS documents while `point-postprocess.ts` stamps `"2.1.0"` | `packages/providers/src/internal/ecmwf.ts:174,193`, `packages/providers/src/internal/nws.ts:226,256`, `packages/soaring/src/point-postprocess.ts:144,162` |
| **F-17** | **Medium** | Pipeline / Data | `sourceFromPublishedDeterministicHour` defaults missing heat fluxes (`sensibleHeatFluxWm2`, `latentHeatFluxWm2`) and precipitation to `0` and SLP to `1013.25` | `packages/soaring/src/point-postprocess.ts:110-124` |
| **F-18** | **Low** | Architecture / Packaging | Duplicate `icon-decode.py` and `icon-requirements.txt` across `packages/providers/src/internal/` and `forecasts/scripts/lib/` plus private deep-import of `@azohra/meteo.forecast/dist/terrain.js` | `forecasts/scripts/terrain.mjs:25-26`, `forecasts/scripts/solar.mjs:29-30`, `packages/providers/src/legacy.ts:44-63` |
| **F-19** | **Low** | Frontend / Data Indexing | `soaring.ts` indexes `cellForecast.hours[index]` by manifest hour position rather than matching `validAt`, risking hour misalignment on subset snapshots | `web/src/scripts/soaring.ts:421` |
| **F-20** | **Low** | Math / Geometry | `sunriseSunset` 10-minute coarse stepping misses polar/high-latitude graze events ($<10$ min daylight/night) and double-sunsets on shifted windows | `packages/meteorology/src/sun.ts:62-82` |
| **F-21** | **Low** | Math / Geometry | `expandBounds` evaluates `metresPerDegree` at `Math.abs(mid) + Math.abs(north - south) / 2`, over-expanding latitude slightly while using poleward longitude scale | `packages/providers/src/internal/solar/grid.ts:110-119` |
| **F-22** | **Low** | Math / Physics | `liftParcel` in `web/src/lib/skewt.ts` substitutes `t - 40` when dew point is `NaN`, inventing a synthetic 40 °C dew-point depression LCL instead of dry-only ascent | `web/src/lib/skewt.ts:154-164` |
| **F-23** | **Low** | Math / Physics | Skew-T buoyant polygon splitter (`web/src/lib/skewt-chart.ts`) compares raw `r.parcelC > r.environmentC` whereas `thermalTop` uses virtual buoyancy `r.buoyancyC > 0` | `web/src/lib/skewt-chart.ts:183-201`, `web/src/lib/skewt.ts:181-193` |
| **F-24** | **Low** | Security / Worker | Cloudflare Worker `/data/<key>` sets `Access-Control-Allow-Origin: *` and `/api/stations/<id>` lacks per-IP rate limiting on cache-miss paths | `web/worker/index.ts:55`, `web/worker/stations.ts:75-134` |
| **F-25** | **Low** | Frontend / Memory | `Sunlight` (`web/src/scripts/sunlight.ts`), `SkewTChart` (`web/src/lib/skewt-chart.ts`), and `HourlyChart` (`web/src/lib/hourly-chart.ts`) do not expose/wire `ResizeObserver` and WebGL disposal into `createPageLifecycle` | `web/src/scripts/sunlight.ts`, `web/src/lib/skewt-chart.ts:105-118`, `web/src/lib/hourly-chart.ts:75-86`, `web/src/lib/sun-curve.ts:27-39` |
| **F-26** | **Low** | Repo Hygiene | Tracked/lingering local artifacts (`forecasts/.soaring-cache`, `web/dist`, `artifacts/windgram-visual`, `.DS_Store`) and uncommitted test diffs in working tree | Root / `forecasts/` / `web/` |
| **F-27** | **Info** | Verification Science | Observation verification (`skill-report.json`) currently spans 1 synoptic date (Oct 21, 2026) and 3 stations; prospective 30-day multi-regime sample is still pending | `forecasts/verification/verify-observations.mjs`, `forecasts/verification/skill-report.json` |
| **F-28** | **Info** | Architecture / Coupling | `forecasts/soaring/*.mjs` maintains thin wrapper modules forwarding to `@windgrams/*` packages alongside legacy replay scripts | `forecasts/soaring/` |
| **F-29** | **Info** | Performance & CI Ops | `buildStabilityFieldPaths` allocates a dense $(24 \cdot N_{\text{hours}}) \times \lceil H / 1.5\text{ px}\rceil$ grid on every windgram render; `prepareRefreshRunner` runs `sudo rm -rf` on ECCC runners | `packages/windgram/src/windgram-geometry.ts:102-304`, `scripts/prepare-refresh-runner.mjs:5-10` |

---

## 1. Repository & Package Architecture Review

### 1.1 Folder & Workspace Structure
The repository is organized as a `pnpm` workspace (`pnpm-workspace.yaml`) with three top-level domains:
- `packages/*`: Eight reusable, strictly typed TypeScript libraries (`contracts`, `geography`, `meteorology`, `soaring`, `providers`, `pipeline`, `data-client`, `windgram`).
- `forecasts/`: Node ESM operational forecast acquisition, GRIB2 regional capture/replay, DEM terrain/solar tile generation, issued-history archiving, observation verification, and experimental WRF-ARW configuration.
- `web/`: Astro 7 static site, MapLibre GL 2D maps, Three.js 3D relief/sunlight viewer, SVG windgram/Skew-T/cross-section visualizers, and a Cloudflare Worker (`web/worker/`) for serving dataset objects and live Weather Underground station proxies.
- `scripts/`: Workspace-level build orchestration (`build-packages.mjs`), AST boundary enforcement (`check-boundaries.mjs`), TypeScript declaration auditing (`check-api.mjs`), consumer tarball integration testing (`test-consumer.mjs`), and GitHub Pages artifact assembly.

### 1.2 Dependency Graph & Boundary Enforcement
The dependency DAG across `packages/*` is clean, acyclic, and enforced automatically by `scripts/check-boundaries.mjs`:
- `contracts` → `[]`
- `geography` → `[]`
- `meteorology` → `['contracts']`
- `soaring` → `['contracts', 'meteorology']`
- `providers` → `['contracts', 'geography']`
- `pipeline` → `['contracts', 'geography', 'meteorology', 'soaring', 'providers']`
- `data-client` → `['contracts', 'geography']`
- `windgram` → `['contracts', 'geography', 'meteorology']`

`scripts/check-boundaries.mjs` also verifies that:
1. No file in `packages/*/src` uses `any`, `@ts-ignore`, or `@ts-nocheck`.
2. Browser-compatible packages (`contracts`, `geography`, `meteorology`, `soaring`, `data-client`, `windgram`) never import `node:*` built-ins.
3. `web` and `forecasts` only import `@windgrams/*` subpaths explicitly declared in each package's `exports` map.
4. `scripts/test-consumer.mjs` bundles browser entrypoints with `esbuild` and asserts that server-only modules (`@windgrams/pipeline`, `@azohra/meteo.forecast`, `@azohra/meteo.grib`, `icon-decode.py`) are never pulled into browser builds.

---

## 2. Detailed Prioritized Findings

### Critical & High Priority Findings

#### F-01 (Critical): Missing `Request publication after token dispatch` Step in `.github/workflows/refresh-provider.yml` Breaks Both CI Tests and `workflow_dispatch` Refresh Publishing
- **Locations:**
  - `.github/workflows/refresh-provider.yml:59-67`
  - `forecasts/scripts/pages-workflow.test.mjs:52-60`
  - `.github/workflows/pages.yml:36-61`
- **Analysis:**
  In `forecasts/scripts/pages-workflow.test.mjs:52-60`, the workflow contract test explicitly asserts:
  ```js
  test('token-dispatched refreshes request publication after upload, including failed refreshes', () => {
    const dispatch = refresh.split('- name: Request publication after token dispatch')[1];
    assert.ok(dispatch, 'token dispatches need an explicit replacement for suppressed workflow_run events');
    assert.match(dispatch, /if:\s*\$\{\{\s*always\(\)\s*&&\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*github\.ref_name\s*==\s*'main'\s*\}\}/);
    assert.match(dispatch, /gh workflow run pages\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f refresh=none/);
  });
  ```
  However, `.github/workflows/refresh-provider.yml` ends right after the `actions/upload-artifact` step (line 67) and **does not contain** `- name: Request publication after token dispatch`!
  This has two immediate consequences:
  1. **Broken Test Suite:** Running `forecasts/scripts/pages-workflow.test.mjs` fails immediately with `AssertionError [ERR_ASSERTION]: token dispatches need an explicit replacement for suppressed workflow_run events`.
  2. **Broken Manual Refresh Pipeline in Production:** When a user triggers `pages.yml` via `workflow_dispatch` with `refresh: all | rrfs | icon-eu | ...`, the `dispatch` job invokes `node scripts/dispatch-refresh.mjs "$REFRESH"` authenticated with `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. Because GitHub Actions suppresses `workflow_run` triggers for workflows started by `GITHUB_TOKEN`, the child `Refresh *` workflows finish and upload their `refresh-*` artifacts, **but `pages.yml` (`on: workflow_run`) is never triggered afterward** to merge and publish those artifacts!
- **Recommendation:** Restore the missing step at the end of `.github/workflows/refresh-provider.yml` (with `actions: write` permission on the reusable workflow job):
  ```yaml
      - name: Request publication after token dispatch
        if: ${{ always() && github.event_name == 'workflow_dispatch' && github.ref_name == 'main' }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
        run: gh workflow run pages.yml --repo "$GITHUB_REPOSITORY" --ref main -f refresh=none
  ```

#### F-02 (High): Near-Neutral Parcel-Depth Discontinuity in `resolvedParcelDepthM`
- **Location:** `packages/soaring/src/convective-lift.ts:116-143` (documented in `docs/refactor-plan.md`)
- **Analysis:** When a dry parcel lifted from the surface (`parcelSurfaceTC`) is already cooler than the environment at the lowest above-ground pressure level (`index === 0`), and `pblHeightM` is absent/zero, `resolvedParcelDepthM` falls back to estimating a shallow superadiabatic depth from `sensibleHeatFluxWm2`:
  $$\text{superadiabaticExcessC} = \max\left(0,\, \Delta T_C + \min(1.5,\, \max(0, H_s) \times 0.012)\right)$$
  $$\text{envLapse} = \frac{T_1 - T_{\text{sfc}}}{\max(1, z_{1,\text{AGL}})}, \quad \text{denom} = \Gamma_d + \text{envLapse}$$
  ```ts
  if (denom <= 1e-5) return 0;
  return Math.min(altitudeAglM, Math.max(0, superadiabaticExcessC / denom));
  ```
  Consider an environmental layer between $z=0$ and $z_1 = 1000\text{ m}$ where $T_1 = 10\text{ °C}$ and upper levels cool at the dry adiabatic lapse rate ($0\text{ °C}$ at $2000\text{ m}$, $-10\text{ °C}$ at $3000\text{ m}$):
  - At $T_{\text{sfc}} = 19.700\text{ °C}$, $\text{envLapse} = -0.0097\text{ °C/m}$, so $\text{denom} = 0.0098 - 0.0097 = 0.0001\text{ °C/m}$. With $H_s = 100\text{ W/m}^2$, $\text{superadiabaticExcessC} = 1.2\text{ °C}$, yielding $\min(1000, 1.2 / 0.0001) = 1000\text{ m}$.
  - At $T_{\text{sfc}} = 19.795\text{ °C}$, $\text{envLapse} = -0.009795\text{ °C/m}$, so $\text{denom} = 0.000005 \le 10^{-5}\text{ °C/m}$. The guard `if (denom <= 1e-5) return 0;` triggers and **returns `0 m`**!
  - At $T_{\text{sfc}} = 19.805\text{ °C}$, the surface parcel ($19.805 - 9.8 = 10.005\text{ °C} > 10\text{ °C}$) clears `index === 0` and continues through the neutral upper column to **`3,000 m`**.
  - Physically, as the surface-to-first-level environmental lapse rate approaches the dry adiabat ($\text{denom} \to 0^+$) with positive sensible heat flux, the layer is *neutral*, not strongly stable; clamping to `0` when $\text{denom} \le 10^{-5}$ inverts the physical limit.
- **Recommendation:** Replace the hard `if (denom <= 1e-5) return 0` cliff when `superadiabaticExcessC > 0`. Evaluating `Math.min(altitudeAglM, superadiabaticExcessC / Math.max(denom, 1e-6))` (or allowing the `superadiabaticExcessC`-boosted parcel to continue into upper levels) eliminates the non-physical drop to `0 m` right before convective break-through. Bump `SOARING_CONTRACT_VERSION` (e.g., to `2.2.0`) when deploying this numerical change.

#### F-03 (High): Sea-Level Pressure Fallback in `hypsometricSurfacePressureHpa`
- **Location:** `packages/meteorology/src/thermodynamics.ts:44-50`
- **Analysis:**
  ```ts
  export function hypsometricSurfacePressureHpa(terrainM: number | null | undefined, surfaceTempC: number | null | undefined, firstLevel: PressureLevel | null | undefined): number {
    if (!finite(terrainM) || !finite(surfaceTempC) || !firstLevel || !finite(firstLevel.pressureHpa) || !finite(firstLevel.heightM) || !finite(firstLevel.temperatureC)) {
      return 1013.25;
    }
    const meanTempK = 0.5 * (surfaceTempC + firstLevel.temperatureC) + 273.15;
    return firstLevel.pressureHpa * Math.exp((GRAVITY_MPS2 * (firstLevel.heightM - terrainM)) / (RD_J_PER_KG_K * meanTempK));
  }
  ```
  When `firstLevel` is missing or invalid, `hypsometricSurfacePressureHpa` returns `1013.25` hPa regardless of whether `terrainM` is finite (e.g., a high-altitude launch or model cell at $2,000\text{–}3,000\text{ m}$ MSL where $P_{\text{sfc}} \approx 700\text{–}800\text{ hPa}$). In `computeThermalVelocityMps` (`packages/soaring/src/convective-lift.ts:47-51`), if `surfacePressureHpa` is omitted and `firstLevel` is missing/invalid, using `1013.25` hPa overstates surface air density $\rho_{\text{sfc}}$ by ~25–35% at alpine sites.
- **Recommendation:** When `finite(terrainM)` holds but `firstLevel` is unavailable, fall back to the ICAO Standard Atmosphere barometric formula at `terrainM`:
  $$P_{\text{std}}(z) = 1013.25 \times (1 - 2.25577 \times 10^{-5}\, z)^{5.25588}$$
  (matching the formula already used in `web/src/lib/balloon.ts:103`), reserving `1013.25` only when `terrainM` itself is unknown.

#### F-04 (High): Lambert Conformal Map-Scale Factor $m(\phi)$ Omitted in `computeNativeGridConvergence`
- **Location:** `forecasts/soaring/grid-kinematics.mjs:15-39`
- **Analysis:** `computeNativeGridConvergence` computes horizontal convergence on the 3 km Lambert conformal conic grid using nominal grid spacing `grid.dxM` and `grid.dyM`:
  ```js
  const dudx = (uE - uW) / (spanX * dx);
  const dvdy = (vN - vS) / (spanY * dy);
  const convergencePerSec = -(dudx + dvdy);
  ```
  1. **Grid-relative vs. Earth-relative wind components:** In `forecasts/soaring/replay.mjs:80-82`, `decoded.u` and `decoded.v` are raw GRIB2 `UGRD`/`VGRD` values on the Lambert grid (`grid.uvRelativeToGrid === true` for HRRR/RRFS), which is *correct* for finite-differencing along grid axes $(x, y)$, whereas if Earth-relative winds were passed without rotation, $\partial u/\partial x + \partial v/\partial y$ would mix meridian convergence. However, `computeNativeGridConvergence` does not check `grid.uvRelativeToGrid`.
  2. **Lambert map-scale factor $m(\phi)$:** On a Lambert conformal conic projection with standard parallels $\phi_1, \phi_2$ and cone constant $n$, `grid.dxM` and `grid.dyM` are defined at the reference latitude `grid.laD`. At any cell latitude $\phi$, true physical grid spacing is $\Delta x_{\text{phys}} = \text{dxM} / m(\phi)$, and true horizontal divergence in map coordinates is:
     $$\nabla_H \cdot \mathbf{V} = m^2 \left[ \frac{\partial (U_{\text{grid}}/m)}{\partial x} + \frac{\partial (V_{\text{grid}}/m)}{\partial y} \right] \approx m(\phi) \left( \frac{\partial U_{\text{grid}}}{\partial x} + \frac{\partial V_{\text{grid}}}{\partial y} \right)$$
     For HRRR/RRFS (`latin1 = latin2 = 38.5°N`) evaluated over North Sound WA ($\phi \approx 48.6°\text{N}$), $m(\phi)$ differs from $1$ by ~1.5%.
- **Recommendation:** Multiply by the local Lambert map-scale factor $m(\phi)$ (or document the $m \approx 1$ approximation in `grid-kinematics.mjs`) and assert or rotate $(u, v)$ if `computeNativeGridConvergence` is ever called on an Earth-relative grid.

#### F-05 (High): No GitHub Actions Workflow Runs `solar.mjs --sync`, and `terrain.mjs --sync` Skips Rebuilds When Seeded From Live Data
- **Locations:**
  - `.github/workflows/refresh-terrain.yml:11-26`
  - `forecasts/scripts/refresh-provider.mjs:11-12`
  - `forecasts/scripts/terrain.mjs:192-196`
  - `forecasts/scripts/solar.mjs`
- **Analysis:**
  1. `refreshCommands('terrain', ...)` in `forecasts/scripts/refresh-provider.mjs:11-12` only runs `['scripts/terrain.mjs', '--sync']` (which generates `site-context.json`). **No GitHub Actions workflow anywhere in `.github/workflows/` ever runs `scripts/solar.mjs --sync`** (`pnpm --filter @windgrams/forecasts solar:sync`) to build or update the `solar/<slug>/manifest.json`, `.bin` horizon tiles, and `relief.bin` 3D meshes when `sunlight-areas.json` or `sites.json` changes!
  2. Even for `site-context.json`, `.github/workflows/refresh-provider.yml:55` runs `node scripts/seed-published.mjs --output data` *before* `node scripts/refresh-provider.mjs "${GROUP}"`. In `terrain.mjs:192-196`, `--sync` checks `contextIsFresh(catalogue.sites, context)` and returns early if every site ID in `sites.json` is present in `site-context.json`—meaning a manual `workflow_dispatch` of `refresh-terrain.yml` cannot force a rebuild of existing site terrain contexts unless `sites.json` adds/removes a site ID (because `--force` is never passed).
- **Recommendation:** Add `['scripts/solar.mjs', '--sync']` to the `terrain` refresh group in `forecasts/scripts/refresh-provider.mjs` (and include `solar/` in `forecasts/scripts/pack-refresh.mjs` for `group === 'terrain'`), and pass `--force` when `github.event_name == 'workflow_dispatch'` so manual terrain workflow dispatches actually recompute terrain/solar artifacts.

---

### Medium Priority Findings

#### F-06 (Medium): Frontend `launch-page.ts` Omits `createRefreshHealthReader`, Never Showing Degraded Provider Refresh Warnings
- **Locations:**
  - `web/src/scripts/launch-page.ts:127-135`
  - `web/src/scripts/soaring.ts:95-108`
  - `web/src/scripts/freshness-notice.ts:24-46`
- **Analysis:**
  In `web/src/scripts/soaring.ts:95-108`, the regional soaring page reads `health/${group}.json` via `createRefreshHealthReader` and passes `refresh: refreshHealth` into `createFreshnessNotice`. When a provider refresh fails and the pipeline retains a prior run (`outcome: 'retained' | 'unavailable'`), `freshness-notice.ts` surfaces `"Latest update did not complete; showing the available forecast."`.
  In `web/src/scripts/launch-page.ts:127-135`, however, `createRefreshHealthReader` is never imported or called:
  ```ts
  const freshnessNotice = createFreshnessNotice(document.getElementById("forecast-freshness"), () => ({
    referenceTime: currentDoc?.referenceTime,
    validUntil: currentDoc?.hours.at(-1)?.validAt,
    policy: activePolicy(),
  }), lifetime.signal);
  ```
  Because `refresh` is always `undefined`, individual launch pages (`/launches/<slug>`) never inform pilots when the active model's latest scheduled refresh failed.
- **Recommendation:** Wire `createRefreshHealthReader({ baseUrl: DATA_BASE, signal: lifetime.signal })` into `launch-page.ts` whenever `activeModel` changes and pass `refresh: refreshHealth` to `createFreshnessNotice`.

#### F-07 (Medium): Frontend `soaring.ts` Empties `#audit-limitations` and Never Renders `audit.limitations`
- **Locations:**
  - `web/src/scripts/soaring.ts:325-332`
  - `web/src/pages/soaring.astro:174-178`
- **Analysis:**
  `web/src/pages/soaring.astro:176` renders `<ul id="audit-limitations"></ul>` inside the `#replay-audit` details card. In `web/src/scripts/soaring.ts:325-332`:
  ```ts
  set('audit-summary', 'About this forecast');
  el('audit-limitations').replaceChildren();
  el<HTMLAnchorElement>('audit-download').href = `${root}/audit.json`;
  void optionalBundle('audit.json', raw => { try { return validateReplayAudit(raw); } catch { return null; } }).then(audit => {
    if (lifetime.disposed) return;
    set('audit-results', audit
      ? `${audit.mapProfileAgreement.valuesChecked.toLocaleString('en-US')} map and profile values checked across ${audit.mapProfileAgreement.hours} hours...`
      : 'Forecast audit unavailable.');
  });
  ```
  `validateReplayAudit` validates that `audit.limitations` is a `string[]`, and `el('audit-limitations').replaceChildren()` clears the `<ul>`, but the `.then(audit => ...)` callback never populates `#audit-limitations` with `<li>` elements from `audit.limitations`!
- **Recommendation:** Populate `el('audit-limitations')` inside the `audit.json` resolution handler:
  ```ts
  if (audit?.limitations?.length) {
    el('audit-limitations').replaceChildren(...audit.limitations.map(item => {
      const li = document.createElement('li');
      li.textContent = item;
      return li;
    }));
  }
  ```

#### F-08 (Medium): Dead `#forecast-error` Alert Banner and `#forecast-reload` Button in `launches/[slug].astro`
- **Locations:**
  - `web/src/pages/launches/[slug].astro:55-57`
  - `web/src/scripts/launch-page.ts:368-396`
- **Analysis:**
  `web/src/pages/launches/[slug].astro:55-57` includes:
  ```html
  <p id="forecast-error" class="notice" role="alert" hidden>
    Forecast unavailable. <button id="forecast-reload" type="button" class="button secondary">Reload</button>
  </p>
  ```
  Neither `forecast-error` nor `forecast-reload` is referenced anywhere in `web/src/scripts/launch-page.ts` (or anywhere else in `web/src/`). When `loadModel` fails in `launch-page.ts:392`, it writes text into `#windgram-status`, leaving `#forecast-error` permanently hidden and `#forecast-reload` without an event listener.
- **Recommendation:** Either wire `#forecast-error` and `#forecast-reload` into `loadModel`'s catch block (calling `void loadModel(activeModel)` on click) or remove the unused DOM elements from `[slug].astro`.

#### F-09 (Medium): Unprefixed `/api/...` Fetch Paths and Uncleaned Polling Timers in `station.ts` and `admin.ts`
- **Locations:**
  - `web/src/scripts/station.ts:43, 155-163`
  - `web/src/scripts/admin.ts:107, 149`
- **Analysis:**
  1. **Subpath deployment (`BASE_URL`) bug:** `station.ts:43` fetches `` `/api/stations/${encodeURIComponent(config.id)}` `` and `admin.ts:107,149` fetches `"/api/admin/launches"` as root-relative URLs instead of using `href("api/...")` from `../lib/site.ts`. If `WINDGRAMS_BASE` is configured to a non-root base path (e.g., `/windgrams` on preview/Pages deployments), these requests hit the domain root `/api/...` and 404.
  2. **Uncleaned timers & listeners:** `station.ts:156-163` registers two `setInterval` timers (`REFRESH_MS` and `30_000`) and a `document.addEventListener("visibilitychange", ...)` without `createPageLifecycle` or `pagehide` cleanup, unlike `launch-page.ts` and `soaring.ts`.
- **Recommendation:** Use `href(...)` for `/api/stations/...` and `/api/admin/launches`, and wrap `station.ts`'s intervals and `visibilitychange` listener in `createPageLifecycle` (or register them on `lifetime.signal` from `launch-page.ts`).

#### F-10 (Medium): GitHub Actions Cache Key Asymmetry Across `refresh-provider.yml` and `pages.yml`
- **Locations:**
  - `.github/workflows/refresh-provider.yml:48-52`
  - `.github/workflows/pages.yml:76-97`
- **Analysis:**
  - `.github/workflows/refresh-provider.yml` calls `actions/cache/restore` with `key: forecast-data-${{ github.run_id }}` and `restore-keys: forecast-data-`, but never calls `actions/cache/save`. Because GitHub Actions scopes cache access by branch, feature/PR branches only see caches saved on the default branch (`main`).
  - Meanwhile, `.github/workflows/pages.yml` saves `forecast-data-${{ github.run_id }}` unconditionally on line 93 (even when `inputs.dry_run == true` or on `workflow_dispatch` on a non-`main` branch) *before* `pnpm --filter @windgrams/web prepare-pages` validates that the merged dataset passes `prepare-dataset.mjs`! If `prepare-pages` fails due to a corrupted or schema-invalid artifact, the poisoned `forecasts/data` directory has already been saved to the `forecast-data-*` cache prefix and will be restored by subsequent `refresh-provider.yml` runs.
- **Recommendation:** Move the `actions/cache/save` step in `.github/workflows/pages.yml` to run **after** `pnpm --filter @windgrams/web prepare-pages` succeeds, and gate it on `github.ref_name == 'main' && inputs.dry_run != true`.

#### F-11 (Medium): Inconsistent Thermodynamic Constants Across Packages and Frontend
- **Locations:**
  - `packages/meteorology/src/thermodynamics.ts:6-15`: `RD_J_PER_KG_K = 287.05`, `CPD_J_PER_KG_K = 1004.0`, `POISSON_KAPPA = 0.2854`, `MAGNUS_A = 17.625`, `MAGNUS_B_C = 243.04`, `MAGNUS_ES0_HPA = 6.1094` (Alduchov & Eskridge 1996).
  - `packages/soaring/src/convective-lift.ts:61`: `const kappa = RD_J_PER_KG_K / CPD_J_PER_KG_K;` ($287.05 / 1004.0 = 0.28590637...$, whereas `thermodynamics.ts` uses `POISSON_KAPPA = 0.2854`).
  - `packages/providers/src/internal/icon-native.ts:65-70`: `iconDewPointC` uses Bolton (1980) Magnus constants `6.112`, `17.67`, `243.5` and `0.622 + 0.378 * specificHumidity` instead of `thermodynamics.ts`'s Alduchov & Eskridge (1996) constants (`6.1094`, `17.625`, `243.04`).
  - `web/src/lib/skewt.ts:17`, `web/src/lib/balloon.ts:20`, `forecasts/scripts/lib/raob.mjs:75`: `RD = 287.04` (vs `287.05` in `@windgrams/meteorology`).
  - `web/src/lib/skewt-chart.ts:163`: Dry adiabat curve rendering uses `(p / 1000) ** 0.2857` ($2/7$ ideal diatomic gas) instead of `POISSON_KAPPA` ($0.2854$ or $287.05/1004.0$).
- **Analysis:** In `iconDewPointC`, converting specific humidity $q$ to dew point with Bolton (1980) constants (`6.112 / 17.67 / 243.5`) and then converting back to mixing ratio in `computeMixedLayerLclM` (which uses Alduchov & Eskridge `6.1094 / 17.625 / 243.04`) introduces a small round-trip offset ($\sim 0.03\text{–}0.06\text{ °C}$).
- **Recommendation:** Document all constant choices in `docs/refactor-plan.md` and plan a coordinated method version bump (`2.2.0`) to unify `RD_J_PER_KG_K`, `POISSON_KAPPA`, and the Magnus saturation vapor pressure constants in `@windgrams/meteorology`.

#### F-12 (Medium): Dry Temperature Used Instead of Virtual Temperature in `geometricWFromOmegaMps` and `hypsometricSurfacePressureHpa`
- **Locations:** `packages/meteorology/src/thermodynamics.ts:23-28`, `packages/meteorology/src/thermodynamics.ts:44-50`, `forecasts/soaring/grib-column.mjs:62-64`
- **Analysis:**
  - `geometricWFromOmegaMps` computes $\rho = \frac{p}{R_d T}$ using dry temperature $T$ instead of virtual temperature $T_v = T(1 + 0.608 q)$, and `grib-column.mjs:63` converts RRFS geometric $w$ to $\omega$ using `-(p * 100 * 9.80665 * get('VVEL')) / (287.05 * get('TMP'))` (which uses the exact inverse dry-temperature formula so RRFS $w \to \omega \to w$ round-trips cleanly).
  - `hypsometricSurfacePressureHpa` uses `meanTempK = 0.5 * (surfaceTempC + firstLevel.temperatureC) + 273.15` rather than mean virtual temperature $\overline{T_v}$. In warm, humid boundary layers ($r \approx 15\text{ g/kg}$), $T_v - T \approx 2.7\text{ K}$ (~0.9%), shifting hypsometric pressure across a $200\text{ m}$ layer by ~0.2 hPa.
- **Recommendation:** Preserve the exact inverse pairing between `grib-column.mjs` and `geometricWFromOmegaMps`, and consider optional virtual-temperature correction in `hypsometricSurfacePressureHpa` in the next method version.

#### F-13 (Medium): Flat-Earth Azimuth Step Approximation and Boundary Clamping in `traceHorizons`
- **Location:** `packages/providers/src/internal/solar/horizon.ts:20-76`
- **Analysis:**
  1. `traceHorizons` precomputes `offsets` (`dc`, `dr` in grid columns/rows) once per domain using `const midLat = (domain.bounds.south + domain.bounds.north) / 2; const m = metresPerDegree(midLat);`. Over a large regional sunlight area plus a 20 km raymarch radius (`maxDistanceM = 20000`), $\cos(\text{lat})$ varies between the northern and southern edges of the coarse grid by up to ~1%.
  2. At the right/bottom boundary of the coarse grid (`xi === GW - 1` or `yi === GH - 1`), `const x1 = xi + 1 < GW ? 1 : 0;` clamps to the edge pixel before breaking on the next step.
- **Recommendation:** Change the bounds check on line 58 from `if (x < 0 || y < 0 || x > GW - 1 || y > GH - 1) break;` to `if (x < 0 || y < 0 || x >= GW - 1 || y >= GH - 1) break;` (which simplifies `x1 = 1` and `y1 = GW` unconditionally inside the inner loop).

#### F-14 (Medium): Incomplete Timezone Offset Table in `srgInstant`
- **Location:** `web/src/lib/srg.ts:59-65`
- **Analysis:**
  ```ts
  export function srgInstant(date: string, hhmm: string, zone: string): string | null {
    const m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(date);
    if (!m || !/^\d{4}$/.test(hhmm)) return null;
    const offset = zone === "MDT" ? 6 : zone === "MST" ? 7 : zone === "PDT" ? 7 : zone === "PST" ? 8 : zone === "CDT" ? 5 : zone === "CST" ? 6 : null;
  ```
  The launch catalogue includes launches in **Virginia, Maryland, and North Carolina** (`America/New_York`, i.e., `EDT`/`EST`). If an Eastern US NWS office issues an SRG product with `EDT` (UTC−4) or `EST` (UTC−5) or `UTC`/`GMT`/`Z`, `srgInstant` returns `null`, causing `observedTable`, `modelTables`, and `triggerTime` to silently fail to parse.
- **Recommendation:** Add `EDT: 4, EST: 5, AKDT: 8, AKST: 9, HST: 10, UTC: 0, GMT: 0, Z: 0` to the timezone lookup map in `srgInstant`.

#### F-15 (Medium): Coexistence of Exact and Rounded ("Legacy") Unit Conversion Factors
- **Locations:**
  - `packages/windgram/src/windgram-format.ts:9-33`
  - `web/src/lib/skewt-chart.ts:20-22` (`const FT = 3.28084; const MPH = 2.23694; const KT = 1.94384;`)
  - `web/src/scripts/station.ts:183` (`const MPS_TO_MPH = 2.23694;`)
- **Analysis:** Near a 5-knot rounding boundary (e.g., $3.8583\text{ m/s} = 7.50003\text{ kt}$), `p.windSpeedMps * 1.94384` in `skewt-chart.ts:249` gives `7.49986 kt` (rounds to 5 kt barb), whereas `mpsToKnots(p.windSpeedMps)` gives `7.50003 kt` (rounds to 10 kt barb).
- **Recommendation:** Import `mpsToKnots`, `metresToFeet`, and `mpsToMph` from `./units.ts` in `skewt-chart.ts` and `station.ts` rather than defining file-local approximate constants.

#### F-16 (Medium): Sparse Adapter `contractVersion` Mismatch (`"2.0.0"` vs `"2.1.0"`)
- **Locations:**
  - `packages/providers/src/internal/ecmwf.ts:174, 193` (`contractVersion: "2.0.0"`)
  - `packages/providers/src/internal/nws.ts:226, 256` (`contractVersion: "2.0.0"`)
  - `packages/soaring/src/point-postprocess.ts:144, 162` (`contractVersion: SOARING_CONTRACT_VERSION` which is `"2.1.0"`)
- **Analysis:** When ECMWF and NWS site documents are built directly by `@windgrams/providers` (`ecmwf.ts` and `nws.ts`), their `hours[].soaring.contractVersion` and `soaringMeta.contractVersion` are hardcoded to `"2.0.0"`. When `postprocessSparseAdapterDocument` in `@windgrams/soaring` processes an ECMWF or NWS document, it stamps `SOARING_CONTRACT_VERSION` (`"2.1.0"`).
- **Recommendation:** Align `ecmwf.ts` and `nws.ts` with `SOARING_CONTRACT_VERSION` or export a shared constant from `@windgrams/contracts`.

#### F-17 (Medium): Silent Zero-Defaulting of Missing Fluxes and SLP in `sourceFromPublishedDeterministicHour`
- **Location:** `packages/soaring/src/point-postprocess.ts:110-124`
- **Analysis:** When `postprocessPointForecast` reconstructs an `AtmosphericColumn` from an already-published deterministic `SiteForecast` hour, any missing (`null`/`undefined`) `sensibleHeatFluxWm2` or `latentHeatFluxWm2` is coerced to `0`, causing `deriveDiagnosticsV2` to compute `thermalVelocityV2Mps = 0` rather than `null`.
- **Recommendation:** In the next schema/contract version, preserve `null` for absent surface heat fluxes in `sourceFromPublishedDeterministicHour` and return `thermalVelocityV2Mps: null` when required convective flux inputs are absent.

---

### Low Priority & Operational Findings

#### F-18 (Low): Duplicate Python Decoder Files and Private Deep Imports into `@azohra/meteo.forecast`
- **Locations:** `packages/providers/src/internal/icon-decode.py` vs `forecasts/scripts/lib/icon-decode.py`, `packages/providers/src/internal/icon-requirements.txt` vs `forecasts/scripts/lib/icon-requirements.txt`, `forecasts/scripts/terrain.mjs:25-26`, `forecasts/scripts/solar.mjs:29-30`.
- **Recommendation:** Centralize the `@azohra/meteo.forecast` `dist/terrain.js` bridge inside `@windgrams/providers` (with the `0.6.0` version guard used in `legacy.ts`), and have `forecasts` reference a single canonical `icon-requirements.txt`.

#### F-19 (Low): `soaring.ts` Indexes `cellForecast.hours[index]` by Array Position Instead of `validAt`
- **Location:** `web/src/scripts/soaring.ts:421`
- **Analysis:**
  ```ts
  const builtSounding = cellForecast ? buildSounding(cellForecast, cellForecast.hours[index]) : null;
  ```
  Elsewhere in `soaring.ts` (e.g., line 396 `windgramDayHours(cellForecast, hours[index].validAt, ...)` and line 447 `mh.validAt === hour.validAt`), hours are matched by `validAt` timestamp. Indexing `cellForecast.hours[index]` directly assumes 1:1 positional alignment with `manifest.hours[index]`. If an offline snapshot or custom bundle ever subsets `manifest.hours` relative to `cellForecast.hours`, `cellForecast.hours[index]` will render the wrong hour's sounding.
- **Recommendation:** Look up `const cellHour = cellForecast?.hours.find(h => h.validAt === hour.validAt) ?? cellForecast?.hours[index];` before calling `buildSounding`.

#### F-20 (Low): `sunriseSunset` 10-Minute Step Edge Cases at High Latitudes
- **Location:** `packages/meteorology/src/sun.ts:62-82`
- **Analysis:** Stepping in 10-minute increments can step over $<10$-minute polar horizon grazes or return `null` when `sunset < sunrise` within a UTC-aligned window.
- **Recommendation:** Check solar culmination near the window midpoint when no crossing is detected on the 10-minute grid.

#### F-21 (Low): `expandBounds` Latitude/Longitude Degree Scaling Asymmetry
- **Location:** `packages/providers/src/internal/solar/grid.ts:110-119`
- **Analysis:** `metresPerDegree` evaluated at the poleward edge slightly under-expands latitude (~0.05%) because `m.lat` increases toward the poles on the WGS-84 ellipsoid.
- **Recommendation:** Use `Math.min(metresPerDegree(bounds.south).lat, metresPerDegree(bounds.north).lat)` for latitude degree expansion.

#### F-22 (Low): Synthetic `t - 40` Dew Point Fallback in `liftParcel` (`web/src/lib/skewt.ts`)
- **Location:** `web/src/lib/skewt.ts:154-164`
- **Analysis:** Substituting `t - 40` when dew point is `NaN` creates an artificial LCL around ~5,000 m AGL above which `parcelAscent` switches to moist-adiabatic lapse rate.
- **Recommendation:** Keep the parcel strictly on the dry adiabat when `td` is `NaN`.

#### F-23 (Low): Skew-T Buoyant Polygon Splitter Uses Dry Temperature Instead of Virtual Temperature
- **Locations:** `web/src/lib/skewt-chart.ts:183-201`, `web/src/lib/skewt.ts:181-193`
- **Analysis:** `thermalTop` uses virtual buoyancy (`r.buoyancyC > 0`, i.e., $T_{v,\text{parcel}} - T_{v,\text{env}}$), whereas the green/pink CAPE/CIN shading in `SkewTChart` splits on `r.parcelC > r.environmentC`.
- **Recommendation:** Use `r.buoyancyC > 0` for the polygon crossover interpolation in `skewt-chart.ts` or document that the Skew-T shading depicts dry-temperature parcel excess.

#### F-24 (Low): Cloudflare Worker Wildcard CORS and Unthrottled Upstream Cache-Miss Fetches
- **Locations:** `web/worker/index.ts:55`, `web/worker/stations.ts:75-134`
- **Analysis:** `/data/<key>` sets `Access-Control-Allow-Origin: *`, allowing third-party sites to hotlink R2 dataset tiles directly, and `/api/stations/<id>` has no per-IP rate limit if callers vary valid station IDs on cache misses.
- **Recommendation:** Restrict `/data/` CORS to allowed origins if R2 egress becomes a concern, and add a lightweight Cloudflare Rate Limiting rule on `/api/stations/*`.

#### F-25 (Low): Missing `ResizeObserver` / WebGL Disposal Wiring in `Sunlight`, `SkewTChart`, and `HourlyChart`
- **Locations:** `web/src/scripts/sunlight.ts:81-235`, `web/src/lib/skewt-chart.ts:105-118`, `web/src/lib/hourly-chart.ts:75-86`, `web/src/lib/sun-curve.ts:27-39`
- **Analysis:** `SoaringMap` and `WindgramController` expose `.dispose()` methods wired into `lifetime.onDispose(...)`, whereas `SkewTChart`, `HourlyChart`, `SunCurve`, and `Sunlight` (which allocates a Three.js `WebGLRenderer`, textures, geometries, and a MapLibre instance) do not disconnect their `ResizeObserver`s or release WebGL contexts on page teardown.
- **Recommendation:** Add `.dispose()` methods to `SkewTChart`, `HourlyChart`, `SunCurve`, and `Sunlight` and register them with `lifetime.onDispose(...)`.

#### F-26 (Low): Lingering Local Build/Cache Artifacts and Uncommitted Working Tree Edits
- **Locations:** `forecasts/.soaring-cache/`, `web/dist/`, `artifacts/windgram-visual/`, `.DS_Store`, and modified test/package files in `git status`.
- **Recommendation:** Add `.DS_Store` and `artifacts/` to `.gitignore` and commit or revert working-tree test edits.

#### F-27 (Info): Prospective Multi-Day / Multi-Regime RAOB Verification Sample Size
- **Locations:** `forecasts/verification/verify-observations.mjs`, `forecasts/verification/skill-report.json`
- **Analysis:** `skill-report.json` currently evaluates 3 matched station-run pairs on a single synoptic date (`2026-10-21`). Expanding the archived verification corpus across 30+ convective days will strengthen empirical calibration of `thermalVelocityV2Mps` and `usableLiftTopV2M`.

#### F-28 (Info): Transitional Wrapper Modules in `forecasts/soaring/*.mjs`
- **Locations:** `forecasts/soaring/contracts.mjs`, `convective-lift.mjs`, `cross-section.mjs`, `grid-indexing.mjs`, `point-postprocess.mjs`, `thermodynamics.mjs`
- **Analysis:** Several `forecasts/soaring/*.mjs` files are 1–5 line re-exports from `@windgrams/*` packages retained for internal script compatibility.

#### F-29 (Info): Windgram Stability Field Grid Allocation & ECCC Runner Disk Cleanup
- **Locations:** `packages/windgram/src/windgram-geometry.ts:102-304`, `scripts/prepare-refresh-runner.mjs:5-10`
- **Analysis:** `buildStabilityFieldPaths` allocates ~25k objects per windgram render; reusing a flat `Float32Array` buffer would eliminate GC churn during rapid scrubbing. In CI, `prepareRefreshRunner` runs `sudo rm -rf /usr/local/lib/android /usr/share/dotnet /opt/ghc /opt/hostedtoolcache/CodeQL` when `group === 'eccc'` and `GITHUB_ACTIONS === 'true'`, which is appropriate for 7 GB HRDPS GRIB2 extraction on standard GitHub-hosted Ubuntu runners.

---

## 3. Summary of Strengths Confirmed During Audit

1. **Zero-`any` Type Safety & Enforced Architectural Boundaries:** `scripts/check-boundaries.mjs` and `scripts/check-api.mjs` enforce strict package layering, explicit exports, and browser/server separation.
2. **Scientific Integrity in Ensemble & Terrain Processing:** `packages/soaring/src/point-postprocess.ts` computes nonlinear convective diagnostics (`W*`, `usableLiftTop`, `mixedLayerLcl`, `blWindShear`, `buoyancyShearRatio`) **per ensemble member** before aggregating p10/p50/p90 percentiles (`deriveEnsembleMemberHour`), avoiding Jensen's inequality bias from averaging temperature/wind profiles first.
3. **Immutable Content-Addressed Publishing:** `packages/pipeline/src/publication.ts` stages regional bundles under `bundles/<sha256-16>/`, verifies every file's SHA-256 digest and byte size against `manifest.json`, and updates `current.json` pointers only after all bundles pass contract validation (`forecasts/scripts/prepare-publication.mjs`).
4. **Resilient GitHub Actions Refresh Delivery Architecture:** `scripts/collect-refresh-artifacts.mjs` and `forecasts/scripts/merge-artifacts.mjs` validate `soaringContractVersion`, source SHA, and `referenceTime` monotonicity before merging provider artifacts, and synthesize per-model degraded/unavailable health statuses (`health/<group>.json`) so a single upstream NWP outage never blocks other models from publishing.
