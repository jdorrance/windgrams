# @windgrams/providers

Acquire weather profiles, native atmospheric columns and terrain products from
upstream feeds. Acquisition runs on Node 24; the model registry and terrain
source policy helpers can also be used in a browser.

The legacy adapter wraps the pinned Azohra forecast builders for NOAA and ECCC
models. Give it a selected initialization time and the sites to acquire:

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
diagnostics before publishing them; the [consumer example](../../examples/consumer/README.md)
shows that step.

`maxSteps` is a positive count of entries in the adapter's forecast schedule.
For an hourly schedule beginning at hour 1, a limit of 6 selects hours 1–6. Requests use
ISO UTC timestamps. Adapters reject missing core data and mismatched runs, sites
or forecast hours; optional diagnostic values can be `null`.

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
