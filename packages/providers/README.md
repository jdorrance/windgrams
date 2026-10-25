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

The [area types](src/area-types.ts) also describe the interface for another area
adapter. ICON is the current implementation; HRRR/RRFS regional acquisition
lives in the forecast application. The ICON result's `native` member lets that
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
  missing cells and required coverage. [`/terrain-policy`](src/terrain-policy.ts)
  checks cached measurements against the sources requested by your application.

To add a source, implement [`AcquisitionAdapter`](src/types.ts) with your own
model descriptor. Return either normalized columns or processed profiles, and
identify the package and version that derived the latter. The legacy adapter's
result keeps its exact Azohra dependency version. Each built package also includes
`/build-inventory.json` with implementation hashes and dependency versions.
