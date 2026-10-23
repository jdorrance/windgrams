# Soaring diagnostic implementation notes

Status reviewed October 23, 2026. The v2 calculation and publication paths are implemented. Archived numerical checks pass; broader observational skill evaluation remains open. This document replaces the earlier implementation checklist with the behavior in the source.

## Inputs and height references

`forecasts/soaring/fields.mjs` defines the captured fields. The historical baseline uses nine pressure levels from 925 to 600 hPa. The expanded HRRR case requests 18 levels from 1000 to 400 hPa plus available 80 m winds and native cloud/convective fields. Each case records its actual levels and optional-field availability.

Published pressure-level heights, terrain, LCL and lift ceilings are metres MSL. Model `pblHeightM` is depth in metres AGL. Surface wind is sampled at 10 m AGL. Chart interpolation joins captured levels; vertical coverage is reported separately in `verticalResolution`.

RRFS captures its own pressure and surface products. Hourly accumulation intervals and the conversion between geometric vertical velocity and pressure velocity are checked during ingest.

## Calculations

The implementation is [`forecasts/soaring/science.mjs`](../forecasts/soaring/science.mjs), contract version `2.0.0`.

- `resolvedThermalTopM` follows a dry surface parcel through the captured temperature levels. A shallow crossing below the first level can use model PBL depth, capped at that level; the surface-flux fallback estimates shallow superadiabatic depth. The field is therefore a parcel/PBL estimate whose resolution depends on the input column.
- `thermalVelocityV2Mps` is the Deardorff convective velocity scale. The cube-root calculation combines surface sensible heat flux, the latent-heat contribution, potential temperature and the resolved layer depth. Its pressure reference is the lowest captured level. W* describes convective air motion; net glider climb also depends on sink and position within a thermal.
- `usableLiftTopV2M` uses a 1 m/s sink rate. `hcritWxtoflyM` uses 225 ft/min, exactly 1.143 m/s. Both sample the same updraft profile, with caps at the resolved thermal top and effective cloud base. `dryHcritM` uses the 1 m/s threshold with the cloud cap removed.
- `surfaceLclM` uses the Bolton condensation-temperature formula and dry-adiabatic ascent from model terrain. `mixedLayerLclM` averages potential temperature and water-vapor mixing ratio, recovers a surface parcel, then applies the same LCL calculation.
- Mixed-layer averaging weights the surface and selected levels equally. A shallow layer includes the first available level, which can lie above its estimated top. This is an explicit approximation for sparse columns.
- `buoyancyShearRatio` is w* divided by surface-to-layer-top vector shear, with a 0.2 m/s denominator floor. Layer wind, shear, convergence and vertical-velocity diagnostics retain distinct units and signs.

The effective cloud cap uses the original profile's `derived.cloudBaseM`, with surface LCL as a fallback. It can sit below the surface LCL when a nearly saturated ambient layer is present. The 225 ft/min ceiling can therefore be lower than an outlined LCL symbol.

At the fixed Blanchard case, 2026-10-21 20Z, model terrain is 221.7 m MSL. The legacy top was 778.9 m, w* 1.06 m/s and usable height 724.5 m. The v2 top is 504.3 m, w* 0.85 m/s, 1 m/s ceiling 465.5 m and 225 ft/min ceiling 446.8 m. Tests retain both diagnostic families and compare the map with its published site column.

## Model handling

`point-postprocess.mjs` adds `hours[].soaring` to deterministic profiles while preserving their baseline `derived` values. The browser chooses that published family consistently, including its nulls. The WxToFly ceiling is a separate field; older profiles can retain a 1 m/s line while the 225 ft/min symbol stays empty.

GEPS supplies ensemble percentiles. Published percentiles are preserved. The available member-column helper derives each member before aggregation, maintaining the relationship between temperature, moisture and wind.

The ECMWF and NWS adapters provide surface LCL and supported wind/layer fields. Their thermal-strength and usable-lift fields remain unavailable because those adapters supply a limited atmospheric profile and heat-flux set.

`soaring.experimental.terrainAdjustment` records the terrain difference and a vector-interpolated wind at launch altitude where the profile brackets it. Main diagnostic heights keep their model MSL reference. Launch elevation provenance comes from `site-context.json`; sources include Copernicus and available regional elevation products.

## Display

The browser presents published quantities in the selected Imperial or Metric units. Windgram colors and physical lapse-rate boundaries match [WxToFly's guide](http://wxtofly.net/windgramexplain.html). The symbols have distinct meanings:

- Outlined cloud: potential surface LCL, including heights above usable lift.
- White crosshatching: relative humidity above 94%.
- Pale cloud band: model cloud fraction of at least 30%.
- Paraglider: published 225 ft/min ceiling; blue line: 1 m/s ceiling.
- Snowflake: lowest freezing crossing.

One label is placed on each connected temperature contour when room is available. Mobile charts fit the day's hours. Strongest thermals selects the greatest published w*; the tallest cloud-base line can occur later.

## Verification and retention

`verification/history.mjs` keeps up to 120 rolling runs plus pinned cases. At four successful cycles per day, the rolling capacity is about 30 days. Regional live bundles have a separate 48-hour grace period for recently replaced content.

The sounding matcher prefers sites within 50 km and accepts a maximum separation of 60 km. It records exact-time matches separately from an initialization-near comparison within 60 minutes at lead time up to one hour. It reports elevation mismatch and compares 925, 850, 700 and 600 hPa where both sources have values.

`verify-observations.mjs` currently builds a report around the October 21, 2026 case and carries a fixed October 22 evaluation stamp. Its CLI output is a historical case audit. A continuing prospective scorecard and sufficient independent weather days remain evaluation work. Cross-model spread is reported separately from observation error.

The [project status](soaring-forecast-plan.md) tracks that work. Current operational commands and refresh times are in the [main README](../README.md).
