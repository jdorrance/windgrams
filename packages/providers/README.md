# @windgrams/providers

Acquire weather profiles, native atmospheric columns and terrain products from
upstream feeds. Acquisition runs on Node 24; the model registry and terrain
source policy helpers can also be used in a browser.

The legacy adapter wraps the pinned Azohra forecast builders for NOAA and ECCC
models. Set `METEO_DATA_BASE` to your published dataset URL; the pinned builder
requires it even when writing fresh local files. Give the adapter a selected
initialization time and the sites to acquire:

```ts
import { createLegacyAdapter, type SiteLocation } from '@windgrams/providers';

async function acquireHrrr(referenceTime: string, sites: readonly SiteLocation[]) {
  const adapter = createLegacyAdapter('hrrr-conus');
  return adapter.acquire({
    run: {
      provider: adapter.model.provider,
      model: adapter.model.id,
      product: adapter.model.sourceProducts[0],
      referenceTime,
    },
    sites,
    outputRoot: './forecast-work',
    maxSteps: 6,
  });
}
```

This writes the model's files and returns validated profiles plus their manifest.
The profiles already contain upstream-derived fields. Choose any additional
diagnostics with [`@windgrams/soaring`](../soaring/README.md) before publishing them.

`maxSteps` is a positive count of entries in the adapter's forecast schedule.
For an hourly schedule beginning at hour 1, a limit of 6 selects hours 1–6. Requests use
ISO UTC timestamps. Adapters reject missing core data and mismatched runs, sites
or forecast hours; optional diagnostic values can be `null`.

## NOAA source experiments

`/noaa` supplies first-party HRRR, RRFS and GFS normalized columns for points and
native areas. `createNoaaAdapter`, `createNoaaAreaAdapter`, and `acquireNoaa` use
one field selector, decoder and unit conversion owner, also used by the forecast
application's regional replay. This is opt-in; existing publication continues to
use the legacy adapter until source and diagnostic impact checks are accepted.

Choose `legacy-pressure` for the pinned nine-level HRRR/RRFS or eight-level GFS inventory, `expanded-pressure`
for 18 real HRRR/RRFS or 15 real GFS pressure levels plus available surface pressure and 80 m winds, or
`hrrr-native` for HRRR's contiguous hybrid levels. Native ingest requires a
complete run's 50 contiguous PRES/HGT/TMP/SPFH/U/V levels from `wrfnat`; absent products,
missing required levels, incompatible grids and wrong times fail explicitly.
There is no automatic cross-product, cross-run or legacy fallback. RRFS and GFS native-level acquisition are not implemented by this adapter.
GFS pressure-level moisture comes from RH; heat fluxes and precipitation retain
preceding-three-hour support, using companion fields to recover six-hour-window
products. It samples the regular latitude/longitude grid without Lambert rotation.

Inputs are an exact supported UTC cycle, ascending forecast hours, an explicit cache
folder, and launch coordinates and/or geographic bounds. Output retains selected
native cells, each model's terrain, per-field units/time support and source byte
hashes. Pressure levels at/below model terrain or below the supplied surface
pressure are excluded. Missing fields remain absent; missing required columns
are null with explicit reasons and `completeness: partial` in a capture or area,
and errors for a point adapter. Required missing above-ground nodes invalidate
the column rather than allowing interpolation across the omitted level. Supplied HGT geopotential heights remain in the model MSL convention; no
geopotential-to-geometric or geoid correction is applied. HRRR native pressure
and height come from PRES/HGT fields, without reconstructing hybrid coordinates. The
source normalizer performs no thermal calculations or launch-altitude correction.

[Operator commands](../../forecasts/soaring/README.md#normalized-noaa-source-experiments)
write these experiments separately from published and first-issued forecasts.
The [public types](src/internal/noaa/types.ts) define limits and provenance.

## Native areas

The ICON area adapter selects native cells inside caller-supplied bounds and
returns one normalized column per cell and forecast hour:

```ts
import { createIconAreaAdapter } from '@windgrams/providers/area';

const adapter = createIconAreaAdapter();
const area = await adapter.acquire({
  run: {
    provider: adapter.model.provider,
    model: adapter.model.id,
    product: adapter.model.sourceProducts[0],
    referenceTime: '2026-10-25T06:00:00Z',
  },
  bounds: [44.5, 40.2, 44.9, 40.5],
  forecastHours: [1, 2, 3],
  fields: ['windSpeedMps', 'levels'],
  cacheDir: './forecast-cache',
});

console.log(area.cells, area.hours[0].columns);
```

Bounds use `[west, south, east, north]`. A cell is included when its centre falls
inside the bounds; its polygon retains the native edges. Each hourly `columns`
array follows `cells`, with `null` for an unavailable column. Records retain
source, field and native-grid provenance alongside the normalized weather.

`fields` declares the capabilities your calculation needs. Unsupported names
throw before acquisition; the result contains complete normalized columns, and
optional measurements can still be absent. Forecast hours must be unique,
ascending integers from 1 to 78. Supply an `AbortSignal` to cancel downloads and
stop the decoder. ICON extraction supports up to 12,000 native cells per request
and uses the [same Python setup](../../forecasts/docs/operations.md#icon-eu) as
point acquisition.

The [area types](src/area-types.ts) also describe the interface for area
adapters. ICON drives current native publication. The opt-in NOAA adapter also
implements area acquisition; live HRRR/RRFS regional publication remains in the
forecast application until the migration gate is accepted. The ICON result's `native` member lets that
application reuse the acquisition for point and regional publication. Optional
`sites` supplied to the adapter retain their additional support cells there.

## Other feeds and custom adapters

- [`/registry`](src/registry.ts) lists model coverage, cycles, forecast schedules
  and field availability. [`/readiness`](src/readiness.ts) selects candidate
  cycles and probes for completion.
- [`/icon`](src/icon.ts) acquires native ICON columns and their source metadata.
  It needs an explicit cache directory and a Python decoder. The package exports
  `/icon-decoder` and `/icon-requirements`; the
  [ICON setup guide](../../forecasts/docs/operations.md#icon-eu) gives the commands.
- [`/nws`](src/nws.ts) and [`/ecmwf`](src/ecmwf.ts) fetch supplemental site
  documents and manifests.
- [`/solar`](src/solar.ts) builds terrain tiles and relief from supplied elevation
  grids. The [input types](src/internal/solar/types.ts) describe resolution,
  missing cells and required coverage. `expandBounds` conservatively pads those
  bounds on WGS84, including equator crossings; reaching either pole covers all
  longitudes. Bounds use ordered, unwrapped longitudes (`west <= east`), and
  padding must be finite and nonnegative. [`/terrain-policy`](src/terrain-policy.ts)
  checks cached measurements against the sources requested by your application.

Supplemental NWS/ECMWF documents identify the sparse method declared by
[`SparseSoaring`](src/supplemental.ts). That method supports surface/cloud and
layer-wind estimates while leaving unsupported convective diagnostics null.
Optional [`@windgrams/soaring/compatibility`](../soaring/src/compatibility.ts)
postprocessing applies its own method and labels the result accordingly; it can
also change elevation fallbacks and layer eligibility. Method labels describe
the calculation actually applied, not a universal JSON schema or package version.

To add a source, implement [`AcquisitionAdapter`](src/types.ts) with your own
model descriptor. Return either normalized columns or processed profiles, and
identify the package and version that derived the latter. The legacy adapter's
result keeps its exact Azohra dependency version. Each built package also includes
`/build-inventory.json` with implementation hashes and dependency versions.
