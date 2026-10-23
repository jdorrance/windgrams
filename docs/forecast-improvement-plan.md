# Forecast Data & Science Improvement Plan (Revised v2.0)

Status: **Implemented diagnostics; numerical checks pass. Forecast skill remains unverified.**

Publication notes: the legacy calculation remains reproducible. The newer thermal
height can use model PBL depth when the pressure levels do not bracket a shallow
mixed layer; it is an estimate, not an independently resolved parcel crossing.
Mixed-layer averages currently include the first sampled level for shallow layers
and use equal weights, so they may include air above the estimated layer. Those
approximations need observational evaluation before claims of improved skill.
The browser displays the published diagnostics and preserves missing values.


This plan incorporates the scientific and architectural audit findings and reorders implementation into five sequential gates:
1. **Track 1 — Capture Richer Real Inputs (No Synthetic Levels)**
2. **Track 2 — Correct, Audit, and Version the Soaring Science (Model-Aware & Experimental Terrain Isolation)**
3. **Track 3 — Establish Matched Observation Verification & 30-Day Retention**
4. **Track 4 — Trial One Region (`north-sound`) and Deterministic Models**
5. **Track 5 — Expand Coverage, UI Integration, and Availability-Aware Scheduling**

---

## Executive Summary of Audit Revisions

1. **Audited & Fixed `v2` Soaring Science Before Rollout (`forecasts/soaring/science.mjs`):**
   - **Root cause of Blanchard `f20` anomaly:** At Blanchard (`2026-10-21T20:00:00Z`), `v1` (`@azohra/meteo.forecast` 0.6.0) returned `boundaryLayerTopM = 778.9 m` MSL (`557.2 m` AGL) due to an `index === 0` fallback when the surface parcel (`17.0 °C`) was already cooler than the `925 hPa` environment (`14.46 °C` at `778.9 m` MSL). `v2` resolved the thermal top to the model `HPBL` estimate (`504.3 m` MSL / `282.6 m` AGL), but lines 158–169 previously passed `v1` `boundaryLayerTopM` (`778.9 m`) and `v1` `thermalVelocityMps` (`1.06 m/s`) into `usableLiftTopM()`, yielding `hcritWxtoflyM = 672.9 m` and `dryHcritM = 724.5 m` **above** the `504.3 m` thermal top.
   - **Correction:** `deriveDiagnosticsV2` now computes `wstarV2Mps` (`thermalVelocityV2Mps`) directly from `resolvedDepthM` (`resolvedThermalTopM - terrainM`) and the surface virtual sensible + latent heat flux via Deardorff convective velocity scaling, then derives `usableLiftTopV2M` (`1.0 m/s` sink), `hcritWxtoflyM` (`1.143 m/s` / `225 fpm` sink), `dryHcritM` (`1.0 m/s` sink unclipped by cloud base), and `buoyancyShearRatio` strictly from `resolvedThermalTopM`, `wstarV2Mps`, and `cloudBaseM`. By mathematical construction, `usableLiftTopV2M <= dryHcritM <= resolvedThermalTopM` and `hcritWxtoflyM <= usableLiftTopV2M <= resolvedThermalTopM` for every hour and site (at Blanchard `f20`, `resolvedThermalTopM = 504.3 m`, `wstarV2Mps = 0.85 m/s`, and `usableLiftTopV2M = dryHcritM = 465.5 m` and `hcritWxtoflyM = 446.8 m`. W* is a convective velocity scale, not the peak thermal-core speed or the glider climb rate).
   - **Removed unexplained `0.85` mixed-layer LCL multiplier:** `mixedLayerLclM` (`zblcl`) now averages dry potential temperature $\theta$ and water-vapor mixing ratio $r$ across the boundary layer (`heightM <= blTopForMixM`), recovers the mixed-layer parcel temperature and dewpoint at surface pressure via Tetens/Magnus inversion, and lifts from terrain via the approximate `125 m/°C` dewpoint-depression rule with no ad-hoc scaling factor.

2. **Removed Synthetic Atmospheric Levels; Harvested Real Levels & `80 m` Winds (`forecasts/soaring/fields.mjs`):**
   - Interpolation cannot recover an unresolved temperature inversion, and extrapolation above `600 hPa` cannot supply real mid/upper-tropospheric structure. No code path synthesizes or extrapolates missing pressure levels.
   - `forecasts/soaring/fields.mjs` defines the full 18-level HRRR capture profile (`1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 700, 650, 600, 550, 500, 450, 400 hPa`), `80 m above ground` wind (`UGRD:80 m above ground`, `VGRD:80 m above ground`), and native GRIB cloud/convective diagnostics (`HGT:cloud base`, `HGT:cloud ceiling`, `HGT:cloud top`, `HGT:level of adiabatic condensation from sfc`, `HGT:level of free convection`, `HGT:equilibrium level`, `MAXUVV`, `MAXDVV`) directly from the HRRR `.idx` inventory.
   - Existing 9-level cached profiles (`925..600 hPa`) are preserved honestly as sparse (`levelCount: 9`, `isSparseProfile: true`), and any continuous visual curve in the Windgram or Skew-T views is explicitly labeled as display interpolation (`displayInterpolation: "linear-between-captured-levels"`) and excluded from vertical resolution claims.

3. **Model-Aware Post-Processing & Versioned `v2.0.0` Contract (`forecasts/soaring/point-postprocess.mjs`):**
   - **GEPS Ensemble Awareness:** Published GEPS site profiles (`forecasts/data/geps/sites/*.json`) store marginal ensemble percentiles (`p10, p25, p50, p75, p90` across 21 members), not coherent single-member physical columns. Applying nonlinear soaring physics to independently selected `p50` medians violates physical covariance between temperature, moisture, and wind. `point-postprocess.mjs` provides `deriveEnsembleSoaringDiagnostics(memberColumns)` to compute nonlinear `v2` diagnostics **per member before percentile aggregation** when raw member columns are available, and marks pre-aggregated percentile documents with `modelKind: "ensemble-percentiles"` and `derivationMode: "per-member-upstream-preserved"` without running deterministic single-column physics on medians.
   - **Explicit Versioned Contract:** Retains the baseline `v1` `derived` object untouched for backward compatibility while attaching a versioned `soaring` diagnostic block (`contractVersion: "2.0.0"`) and an isolated `experimental` block.

4. **Kept Unsupported ECMWF & NWS Diagnostics Unavailable (`forecasts/scripts/lib/ecmwf.mjs`, `nws.mjs`):**
   - Current ECMWF (Open-Meteo IFS) and NWS (NDFD grid) adapters lack surface sensible/latent heat fluxes and dense vertical thermodynamic profiles needed for physical `W*` or `usableLiftTopM` calculations.
   - Post-processing computes only physically supported fields for those adapters: surface-based Bolton `surfaceLclM` (from 2 m temperature, 2 m dewpoint, and elevation) and available surface/transport/upper-level wind metrics. `thermalVelocityMps` (`W*`) and `usableLiftTopM` remain explicitly `null` (`status: "unavailable-missing-heat-flux-and-profile"`).

5. **Isolated Terrain Adjustment as an Explicit Experiment (`experimental.terrainAdjustment`):**
   - Raw MSL heights (`surfaceLclM`, `mixedLayerLclM`, `resolvedThermalTopM`, `usableLiftTopV2M`, `hcritWxtoflyM`, `dryHcritM`) are preserved without elevation-delta shifting.
   - When the captured atmospheric profile brackets the USGS 3DEP launch altitude (`modelElevationM <= launchElevationM <= maxProfileHeightM`), `experimental.terrainAdjustment` linearly interpolates `(u, v)` wind components to `launchElevationM`. Any experimental elevated-parcel sensitivity estimate is quarantined inside `experimental.terrainAdjustment` with explicit assumptions (`assumptions: [...]`) and never overwrites raw MSL diagnostics.

6. **Moved Matched Observation Verification Ahead of Broad Rollout (`forecasts/verification/`):**
   - Replaced the mismatched `KUIL 00Z` vs `wa-blyn f14` comparison with strict spatial (`distanceKm <= 50 km`, elevation delta reported) and temporal (`|t_forecast - t_obs| == 0` for RAOB soundings) matching gates across all 9 regional RAOB stations (`KUIL`, `KSLE`, `KMFR`, `KOTX`, `KBOI`, `KREV`, `KIAD`, `KRNK`, `KGSO`).
   - Distant coastal soundings (`KUIL` at `113.0 km` from `wa-blyn` and `170.3 km` from `wa-blanchard`) are explicitly flagged as `unmatched-spatial-distance` rather than treated as direct site verification, and valid-time comparisons are locked to `2026-10-21T00:00:00Z` (`00Z` sounding vs `00Z` model valid time).
   - Verification scores are stratified by **lead-time bucket** (`f00–f06`, `f07–f12`, `f13–f24`, `f25–f48`) and **weather regime** (`coastal-marine-inflow`, `rogue-valley-thermal`, `intermountain-high-desert`, `columbia-basin`, `appalachian-lee-ridge`, `piedmont-blue-thermal`), and separated from cross-model ensemble/deterministic spread.
   - Increased rolling history retention in `forecasts/verification/history.mjs` from `16` runs (4 days) to `120` runs (**30 full days** at 4 runs/day) to satisfy the 30-day prospective gate.

7. **Scheduled Around Complete-Run Availability, Not Initialization Time (`.github/workflows/pages.yml`, `forecasts/scripts/check-readiness.mjs`):**
   - Replaced the `15 0,6,12,18 * * *` cron proposal with availability-aware scheduling (`55 1,7,13,19 * * *` UTC, 115 minutes after `00/06/12/18Z` initialization—after HRRR's ~107-minute complete-run availability window), paired with `forecasts/scripts/check-readiness.mjs` for upstream completion-URL probing, bounded retries, and per-region local-timezone freshness deadlines (`08:00` local briefing deadline in `America/Los_Angeles`, `America/Boise`, `America/Denver`, and `America/New_York`).

---

## Track 1: Capture Richer Real Inputs (No Synthetic Levels)

### 1.1 Real HRRR Inventory Harvesting
Our captured `.soaring-cache/north-sound-20261021-00z/f14.idx`..`f27.idx` inventories (711 records per forecast hour) contain:
- **40 isobaric pressure levels (`1000 mb` to `50 mb` at `25 mb` spacing):**
  - Low-level boundary-layer structure below `925 hPa`: `1000, 975, 950 hPa` (`HGT`, `TMP`, `DPT`, `UGRD`, `VGRD`, `VVEL`).
  - Core lower/mid-tropospheric levels: `925, 900, 875, 850, 825, 800, 775, 750, 700, 650, 600 hPa`.
  - Upper-air wave & high-mountain levels above `600 hPa`: `550, 500, 450, 400 hPa`.
- **Near-surface rotor & launch-layer wind:**
  - `UGRD:80 m above ground` (record 605) and `VGRD:80 m above ground` (record 606).
- **Native HRRR cloud & convective height diagnostics:**
  - `HGT:cloud ceiling` (record 658), `HGT:cloud base` (record 659), `HGT:cloud top` (record 662).
  - `HGT:level of adiabatic condensation from sfc` (record 692), `HGT:level of free convection` (record 700), `HGT:equilibrium level` (record 697).
  - Hourly maximum updraft/downdraft velocity: `MAXUVV:100-1000 mb` (record 621), `MAXDVV:100-1000 mb` (record 622).

### 1.2 Honest Representation of Sparse Legacy Profiles
- Legacy 9-level profiles (`925, 900, 875, 850, 800, 750, 700, 650, 600 hPa`) are never padded with interpolated or extrapolated pseudo-levels.
- Every post-processed profile records:
  - `verticalResolution.capturedPressureLevelsHpa`: exact list of real pressure levels in the column.
  - `verticalResolution.levelCount`: integer count of real levels (`9` for legacy cached profiles, `18` for expanded HRRR captures).
  - `verticalResolution.has80mWind`: boolean indicating whether real `80 m` winds are present.
  - `verticalResolution.isSparseProfile`: `true` when `levelCount < 14` or bottom pressure level `< 950 hPa`.
  - `verticalResolution.displayInterpolation`: explicit UI notice (`"UI curves between captured pressure levels are linear display interpolations only and do not resolve sub-grid inversions"`).

---

## Track 2: Correct, Audit, and Version the Soaring Science

### 2.1 Audited `v2.0.0` Formulas (`forecasts/soaring/science.mjs`)

| Diagnostic Field | Formula & Inputs | Invariant / Audit Guarantee |
|---|---|---|
| `resolvedThermalTopM` | `v1.boundaryLayerTopM` unless `v1` jumped solely due to the `index === 0` fallback when parcel is already cooler than the first above-ground pressure level (`p_0`), in which case `terrainM + pblHeightM` is used. | Eliminates artificial jump to `925 hPa` (`778.9 m` at Blanchard `f20`) when the surface parcel is stable against the lowest pressure level. |
| `resolvedDepthM` | `Math.max(0, resolvedThermalTopM - terrainM)` | Always non-negative and consistent with `resolvedThermalTopM`. |
| `wstarV2Mps` (`thermalVelocityV2Mps`) | Deardorff convective velocity scale $w_* = \left(\frac{g}{\theta_{v0}} \, \overline{(w'\theta_v')_0} \, z_i\right)^{1/3}$ evaluated with $z_i = \text{resolvedDepthM}$, surface virtual heat flux from `sensibleHeatFluxWm2` and `latentHeatFluxWm2`, and surface pressure. | Strictly coupled to `resolvedDepthM`; replaces `v1` `W*` in all `v2` usable-lift and buoyancy/shear formulas. |
| `usableLiftTopV2M` | `usableLiftTopM(terrainM, resolvedThermalTopM, cloudBaseM, wstarV2Mps, 1.0)` | Guaranteed `terrainM <= usableLiftTopV2M <= Math.min(resolvedThermalTopM, cloudBaseM)`. |
| `hcritWxtoflyM` | `usableLiftTopM(terrainM, resolvedThermalTopM, cloudBaseM, wstarV2Mps, 1.143)` (`225 fpm` sink threshold) | Guaranteed `terrainM <= hcritWxtoflyM <= usableLiftTopV2M <= resolvedThermalTopM`. |
| `dryHcritM` | `usableLiftTopM(terrainM, resolvedThermalTopM, null, wstarV2Mps, 1.0)` | Guaranteed `terrainM <= usableLiftTopV2M <= dryHcritM <= resolvedThermalTopM`. |
| `surfaceLclM` | `terrainM + 125 * Math.max(0, surfaceTempC - surfaceDewpointC)` | Standard Espy/Bolton surface parcel LCL in meters MSL. |
| `mixedLayerLclM` (`zblcl`) | Mean potential temperature $\bar{\theta}_{\text{BL}}$ and mean water-vapor mixing ratio $\bar{r}_{\text{BL}}$ across all levels within `[terrainM, resolvedThermalTopM]`, converted to surface-referenced parcel $(T_{\text{ML}}, T_{d,\text{ML}})$ and lifted via `terrainM + 125 * Math.max(0, T_ML - Td_ML)`. | Removes the undocumented `0.85` dewpoint-depression multiplier. |
| `buoyancyShearRatio` | $\text{BS} = \frac{w_{*,v2}}{\Delta V_{\text{BL}}} \times 10$ where $\Delta V_{\text{BL}}$ is the vector wind shear magnitude across `[terrainM, resolvedThermalTopM]`. | Coupled to `wstarV2Mps` and `resolvedThermalTopM`. |

### 2.2 Model-Aware Post-Processing Matrix (`forecasts/soaring/point-postprocess.mjs`)

| Model Family | Models | Post-Processing Policy |
|---|---|---|
| **Deterministic Full-Column** | `hrrr-conus`, `hrdps-continental`, `rrfs`, `rdps`, `gfs`, `gdps`, `nam` | Preserves `hour.derived` (`v1` contract) and attaches `hour.soaring` (`contractVersion: "2.0.0"`) + `hour.experimental.terrainAdjustment`. |
| **Ensemble Percentile (`GEPS`)** | `geps` | Refuses single-column nonlinear derivation on pre-aggregated `p50` medians (`derivationMode: "per-member-upstream-preserved"`). Exposes `deriveEnsembleSoaringDiagnostics(memberColumns)` so nonlinear `v2` diagnostics are computed per member (`0..N-1`) prior to percentile aggregation (`p10, p25, p50, p75, p90`). |
| **Surface / Sparse-Level Adapters** | `ecmwf`, `nws` | Computes only physically supported `surfaceLclM` (from 2 m `T`/`Td` + elevation) and available surface/transport/upper-level wind metrics. Keeps `thermalVelocityMps` (`W*`) and `usableLiftTopM` explicitly `null` (`unavailableReason: "missing-surface-heat-flux-and-vertical-profile"`). |

### 2.3 Experimental Terrain Adjustment Isolation
- `hour.experimental.terrainAdjustment` records:
  - `launchElevationM` (USGS 3DEP launch elevation), `modelElevationM` (model grid terrain), `terrainDeltaM`.
  - `bracketsLaunchAltitude`: `true` iff `launchElevationM >= modelElevationM` and `launchElevationM <= maxLevelHeightM`.
  - `launchWindSpeedMps`, `launchWindDirectionDeg`: vector-interpolated `(u, v)` at `launchElevationM` when `bracketsLaunchAltitude === true`, else `null`.
  - `assumptions`: explicit documentation stating that raw MSL heights (`surfaceLclM`, `mixedLayerLclM`, `resolvedThermalTopM`, `usableLiftTopV2M`) are unshifted because a grid elevation delta does not determine slope surface temperature, moisture flux, or sensible heating.

---

## Track 3: Establish Matched Observation Verification & 30-Day Retention

### 3.1 Strict Observation Matching Rules (`forecasts/verification/verify-observations.mjs`)
1. **Temporal Matching Gate:**
   - Upper-air RAOB soundings (`00Z`, `12Z`): `|validTime_forecast - validTime_raob| === 0 minutes` (exact synoptic valid time match). Comparing a `00Z` RAOB against an `f14` (`14Z`) forecast column is rejected as `temporal-mismatch`.
   - Surface station observations: `|validTime_forecast - validTime_obs| <= 30 minutes`.
2. **Spatial & Elevation Gate:**
   - **Direct / Co-located Verification Tier (`matched-site`, `distanceKm <= 50 km`):** Pairs RAOB stations with launches within 50 km in the same airmass regime (e.g., `KMFR` Medford vs `or-woodrat-mountain` at `27.3 km`; `KBOI` Boise vs `id-cervidae-peak` at `25.8 km`; `KSLE` Salem vs `or-peterson-butte` at `45.3 km`; `KRNK` Blacksburg vs `va-eagle-rock` at `46.5 km`), reporting horizontal distance and `elevationDeltaM`.
   - **Regional Boundary / Excluded Tier (`unmatched-spatial-distance`, `distanceKm > 50 km`):** Distant soundings such as `KUIL` Quillayute (`113.0 km` from `wa-blyn`, `170.3 km` from `wa-blanchard` across the Olympic Mountains / Strait of Juan de Fuca) are excluded from site-level skill claims and reported separately as regional upstream boundary checks at matched `00Z` valid time.
3. **Stratification & Skill Separation:**
   - Scores are broken down by **lead-time bucket** (`f00–f06`, `f07–f12`, `f13–f24`, `f25–f48`) and **weather regime** (`coastal-marine-inflow`, `rogue-valley-thermal`, `intermountain-high-desert`, `columbia-basin`, `appalachian-lee-ridge`, `piedmont-blue-thermal`).
   - **Observation Verification Skill** (MAE, bias, RMSE, vector wind error against RAOBs) is reported in a separate section from **Cross-Model Diagnostic Spread** (which measures inter-model variance, not accuracy).
4. **30-Day Rolling History Retention (`forecasts/verification/history.mjs`):**
   - `maxRollingRuns` increased from `16` to `120` (`30 days × 4 cycles/day`), aligning retention capacity with the `30-day` prospective verification gate (`minProspectiveIndependentDays: 30`).

---

## Track 4: Trial One Region (`north-sound`) and Deterministic Models

- Before expanding to all regions, run and validate the corrected `v2.0.0` pipeline on the `north-sound` trial region (`wa-blanchard`, `wa-tiger-mountain`, `wa-black-mountain`, `wa-sumas-mountain`, `wa-blyn`, `wa-deer-park`) and deterministic models (`hrrr-conus`, `hrdps-continental`, `rdps`, `gfs`, `gdps`).
- Verify all physical invariants on `north-sound-20261021-00z`:
  - At Blanchard `f20`: `resolvedThermalTopM = 504.3 m`, `wstarV2Mps = 0.85 m/s`, `usableLiftTopV2M = 465.5 m`, `hcritWxtoflyM = 446.8 m`, `dryHcritM = 465.5 m` (all `<= 504.3 m`).
  - Across all 14 hours (`f14..f27`) and all 6 launches (`84` site-hours): `usableLiftTopV2M <= dryHcritM <= resolvedThermalTopM` and `hcritWxtoflyM <= usableLiftTopV2M <= resolvedThermalTopM` hold with zero violations.
  - Baseline `v1` `profile.json` parity against `blanchard-published.json` passes with `0` diffs.

---

## Track 5: Expand Coverage, UI Integration, and Availability-Aware Scheduling

### 5.1 Upstream Feed Availability & Scheduling Table

| Model Feed | Cycles (UTC) | Horizon | Complete-Run Availability Lag | Target Fetch Window (UTC) |
|---|---|---|---|---|
| `hrrr-conus` | `00, 06, 12, 18Z` (+ hourly `f18`) | `f01–f48` | ~107 min (`~1h 47m`, max ~150 min) | `T + 115 min` (`01:55, 07:55, 13:55, 19:55 UTC`) |
| `rrfs` | `00, 06, 12, 18Z` | `f01–f84` | ~165–210 min (`~2h 45m – 3h 30m`) | Readiness poll w/ fallback to prior synoptic cycle |
| `rdps` | `00, 06, 12, 18Z` | `f01–f84` | ~210–240 min (`~3h 30m – 4h 00m`) | Readiness poll w/ fallback to prior synoptic cycle |
| `hrdps-continental` | `00, 06, 12, 18Z` | `f01–f48` | ~240–270 min (`~4h 00m – 4h 30m`) | Readiness poll w/ fallback to prior synoptic cycle |
| `gfs` | `00, 06, 12, 18Z` | `f003–f384` | ~300–330 min (`~5h 00m – 5h 30m`) | Readiness poll w/ fallback to prior synoptic cycle |
| `gdps` | `00, 12Z` | `f003–f240` | ~330–360 min (`~5h 30m – 6h 00m`) | Readiness poll w/ fallback to prior synoptic cycle |
| `geps` | `00, 12Z` | `f003–f384` | ~360–390 min (`~6h 00m – 6h 30m`) | Readiness poll w/ fallback to prior synoptic cycle |

### 5.2 Regional Timezone Freshness Deadlines (`forecasts/scripts/check-readiness.mjs`)
- Each flying region declares its IANA timezone (`America/Los_Angeles`, `America/Boise`, `America/Denver`, `America/New_York`) and local morning briefing deadline (`08:00` local time).
- `check-readiness.mjs` verifies whether the target cycle's complete-run indicator is available upstream before harvesting, applies bounded retries (`maxAttempts`, exponential backoff), and reports per-region freshness against the local morning briefing window.
- `.github/workflows/pages.yml` schedules builds at `55 1,7,13,19 * * *` UTC (115 minutes after `00/06/12/18Z` initialization, when HRRR complete runs are published) rather than 15 minutes after initialization.
