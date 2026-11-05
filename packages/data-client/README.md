# @windgrams/data-client

Fetch published point forecasts and regional map data in a browser or Node app.
The client handles retries and checks that a point profile belongs to the run
advertised by its manifest.

```ts
import { createForecastClient } from '@windgrams/data-client';

const requests = new AbortController();
const client = createForecastClient({
  baseUrl: '/data',
  signal: requests.signal,
});

const result = await client.loadProfile('hrrr-conus', 'wa-blanchard');
if ('document' in result && !result.stale) {
  console.log(result.document.hours);
}

// When the page or component is removed:
requests.abort();
```

`loadProfile` returns either a manifest/profile pair or a miss. A pair marked
`stale` still has mismatched run identities after a retry; check that flag before
presenting the profile as the advertised run. Forecast age is a separate question:
[`assessForecastFreshness`](src/freshness.ts) compares the initialization and last
valid time with an explicit clock and the model catalogue's update cadence.
Its `nextCheckAt` tells you when to reassess. Schedule that check in your app and
clear the timer when the view is removed.

For other documents, `readJson(path, validate)` returns your validated value,
returns `null` for a 404, and throws for invalid data or other HTTP failures.
Supply a custom `fetch` to add credentials or use a different transport.

## Regional maps

`/dataset` opens one immutable run and samples native cells at forecast times.
It discovers published regions, reads map hours and loads point profiles on
request. Queries preserve the requested position/time and identify the selected
cell/time. Missing coverage, missing fields and insufficient profiles remain
explicit. Values keep their published units and height references.

Start with the [dataset types](src/dataset-types.ts), then the
[query example and scope rules](docs/regional.md).

## Saved forecasts

`/offline` plans a download, verifies file sizes and SHA-256 hashes, then commits
it atomically. Interrupted downloads resume from verified files. `/offline-browser`
provides IndexedDB storage with a cross-tab lock. Native hosts provide the byte
store, transport and hashing implementations they need.

The host owns forecast-age notices, storage quotas, app-shell caching, basemaps
and location permissions. See the [storage contract](src/offline-types.ts) and
[download lifecycle](docs/offline.md).

For lower-level access, `readRegional` returns unvalidated JSON, and
[`createReplayProfileCache`](src/regional.ts) caches profile shards for an
existing manifest.

The [`/http` helpers](src/http.ts) are also available separately. Requests get up
to three attempts with a 15-second timeout per attempt by default. Cancellation
stops both requests and retry waits. See the [client types](src/products.ts) for
configuration and result types.

## AV publications

Configure `createForecastClient({ baseUrl, avApiBaseUrl, sites })` to read GFS,
ICON-EU and RRFS from AV. Other models use `baseUrl`. AV failures remain explicit.
`loadManifest` and `loadProfile` share one pinned run per model.

`/av` exposes `createAvClient` and `openAvRegionalDataset` for raster templates,
scalar batches and complete native point profiles. Heights remain MSL; native
model terrain and requested launch coordinates stay separate. Nullable pressure,
height, temperature, humidity and wind remain independent. Profiles retain the
native time axis; `mapFrames` selects the raster prefix. See the
[boundary types](src/av.ts) and [wire validation](src/av-wire.ts).

`createAvSnapshotRepository` saves selected native profiles and scoped scalar
samples, then commits their verified byte inventory. Supply the displayed
`build` to save that pinned run. Reopening uses stored bytes and allows subsets
of the saved points, fields and times. Route geometry, the selected launch and
native cursor travel with the snapshot. Interrupted saves checkpoint validated
immutable responses; retries verify cached blobs and refresh latest discovery.
`prune()` removes resume checkpoints and unreferenced files. The host owns app-shell and basemap
caching. See [snapshot types](src/av-offline.ts).
