# Soaring diagnostic implementation notes

Status reviewed October 23, 2026. The v2.1 calculation and publication paths are implemented. Archived numerical checks pass; broader observational skill evaluation remains open. This document replaces the earlier implementation checklist with the behavior in the source.

## Inputs and height references

`forecasts/soaring/fields.mjs` defines the captured fields. The historical baseline uses nine pressure levels from 925 to 600 hPa. The expanded HRRR case requests 18 levels from 1000 to 400 hPa plus available 80 m winds and native cloud/convective fields. Each case records its actual levels and optional-field availability.

Published pressure-level heights, terrain, LCL and lift ceilings are metres MSL. Model `pblHeightM` is depth in metres AGL. Surface wind is sampled at 10 m AGL. Chart interpolation joins captured levels; vertical coverage is reported separately in `verticalResolution`.

RRFS captures its own pressure and surface products. Hourly accumulation intervals and the conversion between geometric vertical velocity and pressure velocity are checked during ingest.

## Calculations

The implementation is [`forecasts/soaring/science.mjs`](../forecasts/soaring/science.mjs), contract version `2.1.0`.

- `resolvedThermalTopM` follows a dry surface parcel through the captured temperature levels. A shallow crossing below the first level can use model PBL depth, capped at that level; the surface-flux fallback estimates shallow superadiabatic depth. The field is therefore a parcel/PBL estimate whose resolution depends on the input column.
- `thermalVelocityV2Mps` is the surface-density-consistent Deardorff convective velocity scale $w_* = \left(\frac{g z_i}{\theta_{v0}} \overline{(w'\theta_v')_s}\right)^{1/3}$. Both the kinematic virtual heat flux and reference virtual potential temperature use the same surface-to-reference factor $(P_{\text{ref}}/P_{\text{sfc}})^{R_d/c_{pd}}$ (so $P_{\text{ref}}$ cancels identically) and surface air density $\rho_{\text{sfc}} = \frac{P_{\text{sfc}}}{R_d T_{v0}}$ derived from actual or hypsometric surface pressure rather than a fixed sea-level density or lowest upper-level pressure. `W*` describes convective air motion; net glider climb also depends on sink and position within a thermal.
- `usableLiftTopV2M` uses a 1.0 m/s sink rate. `hcritWxtoflyM` uses 225 ft/min, exactly 1.143 m/s. Both solve the Lenschow & Stephens (1980) updraft profile $F(\zeta) = 4\zeta^{1/3}(1 - 0.8\zeta)$ on its monotone descending branch starting at $\zeta = 0.3125$ ($F_{\max} = 2.03581321244618$, $F(1) = 0.8$), bounded by the resolved thermal top and effective cloud limit (`effectiveCloudLimitM`). `dryHcritM` uses the 1.0 m/s threshold with the cloud cap removed.
- `surfaceLclM` uses the Bolton (1980) condensation-temperature formula and dry-adiabatic ascent from model terrain. `mixedLayerLclM` integrates potential temperature $\theta$ and water-vapor mixing ratio $r$ over pressure mass ($\Delta p$) across the resolved layer up to an interpolated boundary at `resolvedThermalTopM` (without including free-tropospheric levels above shallow layers), recovers the mixed surface parcel, and applies the same Bolton LCL calculation.
- `blMeanWindSpeedMps`, `blMeanWindDirDeg`, `blTopWindSpeedMps`, and `blWindShearMps` integrate horizontal wind components $(u, v)$ over geometric height using trapezoidal integration across all valid wind heights (10 m surface, 80 m AGL when available, and pressure levels), sorting and merging coincident heights and clipping strictly at `resolvedThermalTopM`.
- `buoyancyShearRatio` is $w_*$ divided by surface-to-layer-top vector shear, with a 0.2 m/s denominator floor. Layer wind, shear, convergence and vertical-velocity diagnostics retain distinct units and signs.

`effectiveCloudLimitM` exposes the model-derived near-saturation ceiling proxy (`derived.cloudBaseM`, with `surfaceLclM` as fallback) separately from `surfaceLclM`. Because a nearly saturated ambient layer can sit below the surface LCL, `effectiveCloudLimitM` and the 225 ft/min ceiling can be lower than the outlined potential-LCL symbol.

At the fixed Blanchard case, 2026-10-21 20Z, model terrain is 221.7 m MSL. The frozen v1 baseline top is 778.9 m, $w_*$ 1.06 m/s and usable height 724.5 m. Under v2.1.0, the resolved thermal top is 504.3 m, $w_*$ 0.88 m/s, 1.0 m/s ceiling 470.2 m, 225 ft/min ceiling 452.2 m, surface LCL 1315.0 m, and mixed-layer LCL 1608.0 m. Tests retain both diagnostic families and compare the map with its published site column.

## Model handling

`point-postprocess.mjs` adds `hours[].soaring` to deterministic profiles while preserving their baseline `derived` values. The browser chooses that published family consistently, including its nulls. The WxToFly ceiling is a separate field; older profiles can retain a 1 m/s line while the 225 ft/min symbol stays empty.

GEPS supplies ensemble percentiles. Published percentiles and scalar circular-median wind directions are preserved. In multi-model comparisons, legacy v1 ensemble percentiles remain explicitly labeled as `v1` whenever per-member v2 columns are not available. The member-column helper derives each member before aggregation when raw member columns are supplied, maintaining temperature-moisture-wind covariance.

The ECMWF and NWS adapters provide surface LCL and supported wind/layer fields. Their thermal-strength and usable-lift fields remain unavailable because those adapters supply a limited atmospheric profile and heat-flux set.

`soaring.experimental.terrainAdjustment` records the terrain difference and a vector-interpolated wind at launch altitude where the profile brackets it. Main diagnostic heights keep their model MSL reference. Launch elevation provenance comes from `site-context.json`; sources include Copernicus and available regional elevation products.

## Display

The browser presents published quantities in the selected Imperial or Metric units. Windgram colors and physical lapse-rate boundaries match [WxToFly's guide](http://wxtofly.net/windgramexplain.html), representing temperature gradients as constant interval quantities within each source layer and preserving missing temperature intervals without bridging vertically or bleeding into adjacent hours. The symbols have distinct meanings:

- Outlined cloud: potential surface LCL (`surfaceLclM`), including heights above usable lift.
- White crosshatching: relative humidity above 94%.
- Pale cloud band: model cloud fraction of at least 30%.
- Paraglider: published 225 ft/min ceiling; blue line: 1 m/s ceiling.
- Snowflake: lowest freezing crossing.

One label is placed on each connected temperature contour when room is available. Mobile charts fit the day's hours. Strongest thermals selects the greatest published $w_*$; the tallest cloud-base line can occur later.

## Verification and retention

`verification/history.mjs` keeps up to 120 rolling runs plus pinned cases. At four successful cycles per day, the rolling capacity is about 30 days. Regional live bundles have a separate 48-hour grace period for recently replaced content and invalidate cached bundles whenever `soaringContractVersion` changes.

The sounding matcher prefers sites within 50 km and accepts a maximum separation of 60 km. It records exact-time matches separately from an initialization-near comparison within 60 minutes at lead time up to one hour. It reports elevation mismatch and compares 925, 850, 700 and 600 hPa where both sources have values.

`verify-observations.mjs` builds a reproducible report around the October 21, 2026 case by default while parameterizing observation times, site-timezone daytime windows, and sample counts (`coverageSamples` and `coverageSpanHours`). Empty comparison windows return `null` with `status: 'unavailable'`. Cross-model spread is reported separately from observation error.

The [project status](soaring-forecast-plan.md) tracks that work. Current operational commands and refresh times are in the [main README](../README.md).
