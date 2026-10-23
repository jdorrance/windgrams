# Regional soaring forecasts

Use Node 24 and the repository's pinned pnpm. From `forecasts/`:

```sh
pnpm run soaring:capture --case north-sound-20261021-00z
pnpm run soaring:replay --case north-sound-20261021-00z
```

Capture saves original NOAA records in ignored `.soaring-cache/`. Replay makes
no network requests; corrupt or incomplete inputs fail instead of changing runs.
Use `--output /absolute/path` to replay privately without updating the local data
pointer. The manifest records input and code hashes, and `audit.json` checks both
the legacy profile and its published `hours[].soaring` diagnostics against the map.

The browser uses the same published diagnostic family for maps, windgrams and
soundings. Missing newer values never fall back to positive legacy lift. The
legacy `derived` block remains unchanged for reproducibility. Numerical agreement
does not establish forecast skill. See the audit for shallow-profile assumptions.

`node scripts/build-live-soaring.mjs --output data` reads the published region
catalogue and latest HRRR initialization. Add `--model rrfs` to build the same
regions from the latest published RRFS run, then run
`node scripts/merge-soaring-regions.mjs --output data` to combine the model indexes.
RRFS reads pressure levels from `prslev` and surface fields from `2dfld` in the
`noaa-rrfs-ops-pds` bucket. `METEO_RRFS_BASE` can select an equivalent mirror.
Its precipitation is the one-hour accumulation ending at the selected valid time;
geometric vertical velocity is converted to pressure velocity before diagnostics.

Rolling cases use separate `-live` and `-rrfs-live` namespaces; historical URLs
retain their original case. Daylight hours follow each
region's time zone, including DST and the remaining hours of today. Regions with
identical inputs share a capture. New bundles are staged and checked before an
atomic pointer update; recently superseded bundles remain for 48 hours. Stale
model comparisons and verification results are not carried into a new run.
Launches and cross-sections are remapped to each model's own grid and terrain.
The browser keeps the selected launch or geographic location when changing
models, and keeps the selected valid time where it is available in both runs.

Offline tests use checked-in compact numerical and inventory fixtures. Full
archives stay outside Git. Run `pnpm test` here, and `pnpm test`, `pnpm check` and
`pnpm build` in `web/`. Local production preview uses `pnpm preview` in `web/`.
Map and chart barbs use [NWS aviation conventions](https://www.weather.gov/hfo/windbarbinfo):
nearest 5 knots, half feather 5, full feather 10, pennant 50, calm circle, staff
pointing toward the wind's source.
