# Regional soaring forecasts

Native HRRR and RRFS grids serve North Sound and Shenandoah–Blue Ridge. ICON-EU serves Armenia, using actual native model-level pressure and terrain. Tracked region configuration lives in `regions.json`; `regions/` supplies launch and cross-section geometry for a clean build.

## Live regions

From `forecasts/`, using Node 24 and pnpm 10.28.0:

```sh
node scripts/build-live-soaring.mjs --output data
node scripts/build-live-soaring.mjs --model rrfs --output data
node scripts/merge-soaring-regions.mjs --output data
```

The HRRR/RRFS builders follow each model's published initialization. The regional window is the first available local day between 07:00 and 20:00, selected within f002–f048. Model time zones include daylight-saving changes. Identical inputs share a capture.

HRRR and RRFS have separate cache and `-live` / `-rrfs-live` case namespaces. RRFS reads `prslev` and `2dfld` from `noaa-rrfs-ops-pds`; `METEO_RRFS_BASE` selects a compatible mirror. Its one-hour precipitation accumulation ends at valid time. Its geometric vertical velocity is converted to pressure velocity for the shared calculations.

Bundles are staged, hashed and checked before the case pointer changes. Publication keeps the current and most recently superseded bundle for each active HRRR, RRFS and ICON-EU region. The previous bundle supports open browser tabs through the next refresh. Separate historical cases remain available. After provider artifacts merge, publication applies this limit again and checks the entire static site against the 1 GB Pages limit. Seeding fetches fresh catalogues and case pointers, then reuses cached immutable files whose SHA-256 matches; missing or damaged files are fetched again. Model comparisons and verification sidecars carry matching run metadata. Launches and transects are sampled on each model's own grid and terrain. The browser retains geographic selection and matching valid time across model changes.

Validate the current RRFS regional set with:

```sh
node scripts/build-live-soaring.mjs --model rrfs --output data --validate-only
```

## Armenia / ICON-EU

From `forecasts/`:

```sh
python3 -m venv .venv-icon
.venv-icon/bin/pip install -r scripts/lib/icon-requirements.txt
ICON_PYTHON=.venv-icon/bin/python NODE_OPTIONS=--max-old-space-size=6144 node scripts/build-icon.mjs --sites sites.json --output data
node scripts/build-icon.mjs --output data --validate-only
```

DWD's [native ICON-EU feed](https://opendata.dwd.de/weather/nwp/v1/m/icon-eu/p/) supplies the 00/06/12/18 UTC cycles. Production builds require hourly f001–f078. `--reference-time ISO` selects an initialization; `--hours 1,2,3` limits a trial build. The case is `armenia-icon-eu-live`; its local clock is `Asia/Yerevan` (UTC+4). Launch data and source decisions are documented in the [Armenian catalogue review](../scripts/data/ARMENIA.md).

A full run downloads roughly 12 GB and takes about 40 minutes, depending on transfer speed and CPU. Use Python 3.11–3.13 (CI uses 3.12). The 6 GB Node heap allowance supports all 78 hours; CI sets it for the DWD job. Segmented source fields are retained in `.soaring-cache/icon-eu` for reuse.

Native profiles use model levels 45–74, retaining pressure in hPa, height in m MSL, temperature/dew point in °C and wind in m/s/degrees true. Full-level height is the mean of bounding HHL interfaces. Published ICON bundles compress scalar map hours and separate `cell-{index}.json.gz` profiles. The browser fetches only visited cell profiles and caches eight; it never loads the full regional vertical cube. The replay reader also accepts `levelsByModel` arrays from retained engineering slices and `levelsByPressure` arrays from HRRR/RRFS. Map-cell soundings use actual native pressure, and their published lift diagnostics are shared with point profiles. Missing vertical velocity remains unavailable. Surface flux and precipitation intervals follow the source metadata and shared normalization tests.

Armenian launch terrain is sampled independently from Copernicus GLO-90. Model terrain remains the origin for model parcels and surface fields. US NWS/RAOB adapters are excluded from this region; their absence does not substitute another distant station.

DWD artifacts carry `site-context-armenia.json`, scoped to Armenian points. Publication merges that fragment after provider overlays, preserves other countries and newer matching terrain, then removes the fragment. This prevents DWD's seeded cache from replacing another terrain job's measurements.

## Historical replay

```sh
pnpm run soaring:capture --case north-sound-20261021-00z
pnpm run soaring:replay --case north-sound-20261021-00z
```

Capture stores original NOAA records in ignored `.soaring-cache/`. Replay runs offline from verified cache receipts. `--cache DIR` selects another archive; replay's `--output DIR` selects the destination `soaring/v1` directory. The manifest records inputs and implementation hashes; `audit.json` compares the published site profile with its regional cell.

The baseline `derived` block preserves the original calculation. `hours[].soaring` carries the v2 diagnostics used by current charts. See [replay details](../../docs/soaring-replay.md) and [diagnostic definitions](../../docs/forecast-improvement-plan.md).

## Display and tests

Published w*, lift top and condensation values feed the map, windgram and sounding. Paraglider symbols use the 225 ft/min ceiling; the blue line uses the separate 1 m/s ceiling. Heights are MSL; native model PBL depth is AGL. The browser converts visible units through its Imperial/Metric setting.

Imperial barbs follow [NWS aviation conventions](https://www.weather.gov/hfo/windbarbinfo): nearest 5 knots, half feather 5, full feather 10 and pennant 50. Metric barbs round to 2.5 m/s, with half feather 2.5, full feather 5 and pennant 25 m/s. Both use a calm circle and a staff pointing toward the wind's source. Windgram colors follow [WxToFly](http://wxtofly.net/windgramexplain.html); RH above 94% uses white crosshatching and potential LCL uses an outlined cloud.

Unit selection changes display values; source JSON, diagnostic contracts and physical thresholds stay unchanged. The [website conventions](../../web/README.md#display-conventions) describe the display units and exceptions.

`pnpm test` exercises compact checked-in fixtures. Run `pnpm test`, `pnpm check` and `pnpm build` in `web/` for browser code; `pnpm preview` serves the complete local dataset. Numerical checks establish reproducibility and internal consistency. Forecast skill is assessed separately against matched observations.
