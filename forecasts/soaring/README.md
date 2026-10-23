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
catalogue and latest HRRR initialization. Rolling cases use a separate `-live`
namespace; historical URLs retain their original case. Daylight hours follow each
region's time zone, including DST and the remaining hours of today. Regions with
identical inputs share a capture. New bundles are staged and checked before an
atomic pointer update; recently superseded bundles remain for 48 hours. Stale
model comparisons and verification results are not carried into a new run.

Offline tests use checked-in compact numerical and inventory fixtures. Full
archives stay outside Git. Run `pnpm test` here, and `pnpm test`, `pnpm check` and
`pnpm build` in `web/`. Local production preview uses `pnpm preview` in `web/`.
Map and chart barbs use [NWS aviation conventions](https://www.weather.gov/hfo/windbarbinfo):
nearest 5 knots, half feather 5, full feather 10, pennant 50, calm circle, staff
pointing toward the wind's source.
