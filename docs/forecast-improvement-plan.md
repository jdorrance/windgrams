# Soaring diagnostics

Soaring diagnostics estimate thermal strength, lift ceilings, cloud base and layer winds from forecast columns. They describe the atmosphere represented by the model: terrain smoothing, vertical resolution and missing source fields all affect the result. Convective velocity characterizes air motion; glider climb also depends on sink rate and position within a thermal.

The calculations below describe method 2.3.0. Published point profiles store them in `hours[].soaring`; regional maps and soundings use the same diagnostic fields. [Regional operations](../forecasts/soaring/README.md) explains how to build them, and [observation evaluation](../forecasts/verification/README.md) explains how to measure their errors.

## Inputs and heights

Terrain, pressure-level heights, condensation levels and lift ceilings are expressed in metres above mean sea level (MSL). Native model boundary-layer depth is measured above ground (AGL), and surface wind is measured at 10 m AGL. Launch elevation is stored separately from model terrain; substituting one for the other would change the parcel calculation.

The available vertical levels depend on the model and capture. The [historical HRRR case](soaring-replay.md) has nine pressure levels from 925 to 600 hPa. The expanded case requests 18 levels from 1000 to 400 hPa, available 80 m winds, and additional cloud and convective fields. [Field selection](../forecasts/soaring/fields.mjs) defines the HRRR/RRFS requests, and each case records what it actually captured. RRFS pressure-level and surface data arrive separately; ingest checks their accumulation intervals and converts vertical velocity.

ICON-EU uses model levels 45–74 with cell-specific pressure. Full-level heights are calculated from bounding HHL interfaces, and dew point is calculated from specific humidity. The resulting temperature, moisture and wind columns use the same parcel and layer calculations as HRRR and RRFS. Armenian launch elevations come from Copernicus GLO-90; catalogue elevations with an unconfirmed datum are retained only as source information.

`verticalResolution` records the native and above-ground level counts. Its optional `sampling` section reports the first measured height AGL, native samples in the lowest kilometre and the full native-node gap intersecting that kilometre, separately for temperature, moisture and wind. Surface nodes are excluded from these counts. Interpolated values retain the source column's vertical resolution. `diagnosticSupport` records the thermal-depth branch, bracket or profile-top limit, cloud-cap source and pressure source; it is evidence of support, not a calibrated quality score.

## Thermal depth and strength

`resolvedThermalTopM` follows a dry parcel from the model surface through the captured temperatures, using a lapse rate of 0.0098°C/m. If the parcel crosses the environment below the first captured level, the calculation can use model boundary-layer depth, capped at that first level. A heat-flux fallback estimates shallow superadiabatic depth when PBL depth is unavailable. Sparse near-surface sampling makes this part of the estimate particularly uncertain.

The convective velocity `thermalVelocityV2Mps` is the Deardorff scale:

$$
w_*=\left[\frac{g z_i\,\overline{(w'\theta_v')_s}}{\theta_{v0}}\right]^{1/3}.
$$

Surface density uses pressure and virtual temperature. Method 2.3 composition uses a supplied positive model surface pressure, or estimates it hypsometrically when absent; sea-level pressure is never substituted. Available inputs depend on the adapter. The heat flux and reference temperature use the same potential-temperature factor, which cancels in the ratio.

Method 2.2.0 preserves missing heat fluxes as null, so W* and its dependent lift ceilings and buoyancy/shear ratio remain unavailable. Measured zero heat flux or a known zero layer depth produces zero W* when the other required inputs are available. Layer means can still use a known model PBL depth; an unknown depth does not become a surface-only mixed layer. The first-layer fallback now reaches its first-level cap in the neutral limit, and upper-layer crossings use bracketed linear interpolation. The [method-change notes](refactor-plan.md#method-220-parcel-depth-and-missing-inputs) derive the limit, document the remaining closure boundary and report archived comparisons.

## Lift ceilings

The lift ceilings combine W* with the Lenschow–Stephens vertical profile:

$$
F(\zeta)=4\zeta^{1/3}(1-0.8\zeta).
$$

The calculation solves the descending branch from $\zeta=0.3125$, then limits the height to the resolved thermal top and effective cloud limit.

- `usableLiftTopV2M` uses a 1 m/s sink rate.
- `hcritWxtoflyM` uses 225 ft/min, exactly 1.143 m/s.
- `dryHcritM` uses 1 m/s with the cloud cap removed.

The two sink thresholds are deliberately separate. The windgram's blue line uses the 1 m/s ceiling, while the paraglider symbol uses the 225 ft/min ceiling. A null ceiling means no usable height was resolved for that diagnostic.

## Cloud base

`surfaceLclM` uses Bolton's condensation-temperature formula and dry ascent from model terrain. `mixedLayerLclM` first pressure-mass averages potential temperature and mixing ratio through the resolved layer, interpolating at its upper boundary, then applies the same LCL calculation.

`effectiveCloudLimitM` uses the near-saturation proxy `derived.cloudBaseM`, falling back to surface LCL. A saturated ambient layer can therefore cap lift below the surface parcel's potential LCL. The outlined cloud symbol shows that potential surface LCL, including when it lies above usable lift; humidity and cloud-fraction hatching describe the ambient column. See [layers and symbols](../web/docs/display.md#layers-and-symbols) for the shading thresholds.

## Wind and shear

Layer winds are integrated as horizontal vector components over height, using surface wind, available 80 m wind, and the captured upper-air levels. Coincident heights are merged and integration stops at the resolved thermal top.

The buoyancy/shear ratio is W* divided by the surface-to-layer-top vector shear, with a 0.2 m/s denominator floor. Native-grid convergence and vertical velocity are separate fields with their own units and sign conventions.

## Open scientific change: boundary-layer wind lower node

This is recorded as a separate scientific change and is **not** part of the current method. `computeBoundaryLayerWind` integrates layer winds from a surface node placed at model terrain, while terrain adjustment and the sounding place the same 10 m surface wind at terrain + 10 m. The trapezoidal mean, BL-top shear and therefore the buoyancy/shear ratio depend on that choice, especially for shallow layers.

Before any calculation changes:

1. Define the candidate lower-layer policies explicitly: (a) anchor the surface node at terrain + 10 m and integrate from 10 m to the layer top, (b) extrapolate to the ground with a stated profile (for example log-law with a named roughness), or (c) retain the ground node as a documented approximation with measured effect.
2. Measure the effect on frozen columns (the method-impact harness, not live data): distribution of changes in BL mean wind, BL-top wind, shear and buoyancy/shear ratio per model and per layer-depth band, including calm and shallow-layer cases.
3. Decide from that evidence, then ship any change as a method-version bump with retained-method handling and regenerated impact evidence. Display or documentation edits must not be used to imply the calculation already follows the chosen policy.

## Model handling

Point postprocessing adds the soaring diagnostics while retaining the baseline `derived` fields. The browser selects the published diagnostic family and preserves its nulls. Older profiles may provide a 1 m/s ceiling without a 225 ft/min ceiling.

The reusable atmospheric-column and compatibility APIs permit absent optional flux inputs. The pinned production point-source contract still requires numeric or supported ensemble heat-flux fields; a missing-source profile fails full publication validation. Nullable diagnostic support does not relax that source contract.

For ensembles, nonlinear quantities must be calculated for each member before taking percentiles; otherwise the temperature, moisture and wind relationships within a member are lost. GEPS retains upstream percentiles and scalar circular-median wind directions. Comparisons label legacy percentiles `v1` where member columns for the newer derivation are unavailable. When raw member columns are supplied, they are derived before aggregation.

ECMWF and NWS adapters expose surface LCL and the wind or layer fields their sources support. Their limited profiles and heat-flux inputs leave thermal strength and usable lift unavailable.

`soaring.experimental.terrainAdjustment` records the difference between launch and model terrain and, where adjacent valid wind nodes bracket launch ground elevation MSL, an experimental free-air wind estimate. Model surface wind is at terrain + 10 m, optional 80 m wind at terrain + 80 m. Missing or duplicate brackets and extrapolation are excluded; local slope flow and gusts are not inferred. Diagnostic heights remain in model MSL coordinates. `site-context.json` supplies the launch elevation and its provenance.

## Reproducible example

The [Blanchard regression](../forecasts/soaring/soaring.test.mjs) uses the October 21, 2026 20Z column at model terrain 221.7 m MSL. The saved v1 publication has a thermal top of 778.9 m, W* of 1.06 m/s and usable height of 724.5 m. Methods 2.1.0 and 2.2.0 give a thermal top of 504.3 m, W* of 0.88 m/s, a 1 m/s ceiling of 470.2 m, a 225 ft/min ceiling of 452.2 m, surface LCL of 1315.0 m and mixed-layer LCL of 1602.3 m.

The [fixed replay](soaring-replay.md) reproduces this example from captured source fields to check numerical consistency. [Issued-history evaluation](../forecasts/verification/README.md) measures error against observations, and the [evaluation plan](soaring-forecast-plan.md) describes the broader sample still needed.

For implementation details, thermodynamic and layer-wind routines are in [meteorology](../packages/meteorology/README.md); parcel depth, lift ceilings, diagnostic composition and ensemble handling are in [soaring](../packages/soaring/README.md). The [review repair status](forecast-repair-status.md) records implemented fixes, reproducible evidence and source-migration gates.
