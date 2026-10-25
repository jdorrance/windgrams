# Saved forecasts

Use `/offline` to plan and save one immutable regional forecast. The download
contains its manifest, grid, selected map hours and selected cell profiles.
Each map hour includes all published scalar fields; a cell profile retains its
full forecast horizon. The plan reports file sizes before downloading.
Legacy profiles require all map hours. Saving their primary cell also retains
the published `profile.json` when present, preserving its exact values and site
identity. Other legacy cells are reconstructed from the saved hourly columns.

```ts
import { prepareRegionalSnapshot, createSnapshotRepository } from '@windgrams/data-client/offline';
import { createBrowserSnapshotStore } from '@windgrams/data-client/offline-browser';

const store = createBrowserSnapshotStore('my-forecast-app');
const saved = createSnapshotRepository({ store });
const downloads = new AbortController();
const inventory = await prepareRegionalSnapshot({
  baseUrl: '/data', casePath: 'soaring/v1/armenia-icon-eu-live',
  forecastHours: [7, 8, 9], cellIndices: [0],
});
await saved.save('weekend', inventory, { signal: downloads.signal });

// After restart, including without a connection:
const forecast = await saved.open('weekend');
if (forecast) {
  const gridBytes = await saved.read(forecast, 'grid.geojson');
  console.log(forecast.inventory.referenceTime, gridBytes);
}
```

The planner authenticates the manifest against the case pointer. Saving verifies
each file's SHA-256 and byte count before committing the saved selection.
Cancellation, connection loss and storage errors leave the previous selection
usable. A retry reuses verified whole files from the interrupted download.
The default byte reader allows two minutes per request and accepts cancellation.
`list()` returns saved selections; `remove(name)` releases one selection and its
unshared files. `prune()` also discards abandoned downloads when space is needed.
Replacing or removing a slot can release its old files. Reopen the slot before
further reads from an existing `SavedSnapshot` handle.

`open()` performs no network reads. Use `read()` for verified bytes and
`decodeRegionalJson` for JSON/gzip decoding, then pass the manifest, grid, reader
and saved hour/cell scope to `openRegionalDatasetFromDocuments`. Pass the saved
file paths as `availableFiles` so the reader can use a retained primary profile.
A file outside the saved scope returns `null`; missing or corrupt saved files throw.

The browser adapter requires IndexedDB and Web Locks. IndexedDB commits each
object atomically; the shared lock protects downloads and removal across tabs.
A native host can implement the [four byte-store operations](../src/offline-types.ts),
with atomic replacement per key. It must own the storage namespace exclusively
or provide `withLock` across all users of that namespace. Supply `read` and
`sha256` when the host has its own networking and cryptography APIs.

Hashes and sizes refer to exact stored files. Serve `.gz` objects as
`application/gzip` without `Content-Encoding: gzip`; decompress them after
verification. Older bundles without `fileBytes` remain readable online but need
a new publication before the snapshot planner can save them.

Saving retains the original initialization and valid times. Assess forecast age
separately, including after reopening an expired save. The host owns storage
quotas, location permissions, basemap downloads and app-shell availability.
