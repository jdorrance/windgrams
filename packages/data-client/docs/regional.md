# Regional datasets

Use `@windgrams/data-client/dataset` to discover published regions and query their
native grids:

```ts
import { discoverRegionalDatasets, openRegionalDataset } from '@windgrams/data-client/dataset';

const regions = await discoverRegionalDatasets({ baseUrl: '/data' });
const region = regions[0];
if (region) {
  const dataset = await openRegionalDataset({ baseUrl: '/data', caseId: region.id });
  const result = await dataset.sample({
    position: { latitude: 48.609, longitude: -122.424 },
    validAt: dataset.manifest.hours[0].validAt,
    fields: ['wind10mSpeedMps', 'usableLiftTopV2M'],
  });
  console.log(result.selected, result.gap, result.values);
}
```

The dataset follows the case pointer once and keeps that immutable bundle for
its lifetime. Open a new dataset to refresh. `manifest` and `grid` are frozen
copies; hourly fields and profiles load on demand. Both JSON and gzip files work
with the same reader. The client checks case, model, run, grid indexing and
forecast times before returning data.
For an archive that predates model metadata, supply its known `model` when
opening it. If the manifest already declares a model, that identity must match.

Sampling selects a native cell containing the requested coordinates and an
exact forecast time. A positive `timeToleranceMinutes` permits the nearest time
within that limit, choosing the earlier time on a tie. The result retains the
requested position/time and identifies the selected cell/time. Outside coverage
and unavailable times produce explicit gaps. Field readings distinguish valid
values, missing values, fields absent from the published product and insufficient
vertical profiles. Zero remains a measurement; a null value has no inferred
threshold meaning. See the [field definitions](../../contracts/src/fields.ts) for
units and height references.

`sampleRoute(requests)` applies those same rules to your chosen route positions
and times, preserving their order. It samples the supplied points without spatial
or temporal interpolation. Use `loadCellProfile(cellIndex)` to inspect one point
with [`@windgrams/windgram`](../../windgram/README.md). It reads a published profile
shard or reconstructs an older profile from its published hourly columns;
incomplete columns return `null`. Invalid documents, identity mismatches and
transport failures throw. Pass a cancellation signal when opening the dataset
to stop reads when its view is removed.

Reads share in-flight requests, keep eight hours and eight profiles, and limit
concurrent file reads to four. The [dataset types](../src/dataset-types.ts) describe
the result and the constructor for already-loaded documents. That constructor
also accepts a reader and explicit hour/profile scope for an offline snapshot.
Its optional `availableFiles` lists saved paths within the bundle; selected hours
and published profile shards must be included. A saved legacy `profile.json`
preserves the primary site's exact values when all map hours are available.


