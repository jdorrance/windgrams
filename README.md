# Windgrams

Soaring forecasts for paragliding launches: hourly windgrams, model and balloon soundings, and regional HRRR/RRFS/ICON-EU maps.

The forecast engine is [`@azohra/meteo.forecast`](https://meteo.azohra.com/) 0.6.0; browser contracts and shared calculations use `@azohra/meteo.briefing` 0.6.2. Both are MIT licensed. US launch coordinates and facing directions come from the adjacent `flyingsites` catalogue (`data/us.geojson.json`). Armenia uses the checked-in [reviewed launch catalogue](forecasts/scripts/data/ARMENIA.md), with source links on each launch page.

## Forecasts and charts

The launch picker separates United States and Armenia. US sites offer HRRR, HRDPS, RRFS, RDPS, GFS, GDPS and GEPS where a published profile covers the site. Armenian sites prefer ICON-EU, with published GFS/GDPS/GEPS profiles available for comparison. Regional grids cover North Sound, Shenandoah–Blue Ridge and Armenia. Model changes preserve the selected location and matching forecast time.

Windgrams use the [WxToFly lapse-rate palette](http://wxtofly.net/windgramexplain.html). The full day fits on a phone. Temperature contours carry one label per connected line, where space permits. Outlined clouds mark potential LCL; white crosshatching marks relative humidity above 94%. Paraglider symbols use the published 225 ft/min sink ceiling; the blue usable-lift line uses 1 m/s. Chart heights are MSL. Balloon labels include local time zone and UTC observation cycle.

The header's Imperial/Metric setting is saved in the browser. Forecast files and diagnostic calculations retain their published physical units. [Display conventions](web/README.md#display-conventions) cover barbs, saved launch limits and scientific-unit exceptions. Strongest thermals selects the highest published w* for the selected day; cloud base and usable height can peak at another hour.

## Local development

Use Node 24 and pnpm 10.28.0, pinned in both packages.

```sh
cd web
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:4321. Astro serves the ignored `forecasts/data` directory at `/data`.

With the web server running, build a local dataset from `forecasts/`:

```sh
pnpm install --frozen-lockfile
node scripts/nws.mjs --output data
node scripts/ecmwf.mjs --output data
node scripts/raob.mjs --output data
node scripts/terrain.mjs --sites sites.json --output data/site-context.json
node scripts/write-models-catalogue.mjs --output data
cp sites.json data/sites.json
pnpm run build:model -- hrrr-conus
```

`build:model` also accepts `hrdps-continental`, `rrfs`, `icon-eu`, `rdps`, `gfs`, `gdps` and `geps`. `METEO_DATA_BASE` selects the published dataset used for run discovery; its local default is `http://127.0.0.1:4321/data`. The wrapper filters sites by grid coverage, adds soaring diagnostics and stages complete outputs before replacing the prior run. ICON-EU requires the memory allowance below.

Optional sunlight tiles: `node scripts/solar.mjs --output data`. These larger terrain products are available in local development and preview; the Pages artifact omits `data/solar` and forecast history.

## RRFS

RRFS reads NOAA's `noaa-rrfs-ops-pds` bucket. Synoptic 00/06/12/18 UTC runs provide hourly CONUS forecasts through f084. Readiness checks cover both `prslev` and `2dfld` products. `METEO_RRFS_BASE` selects a compatible mirror.

From `forecasts/`:

```sh
pnpm run build:model -- rrfs
node scripts/validate-rrfs.mjs --data data --sites sites.json
node scripts/build-live-soaring.mjs --model rrfs --output data
node scripts/merge-soaring-regions.mjs --output data
node scripts/write-runs-index.mjs --output data
```

The regional window is the first available local day, 07:00–20:00, within f002–f048. Each model uses its own grid, terrain and cache namespace. RRFS precipitation is the one-hour accumulation ending at valid time; geometric vertical velocity is converted to pressure velocity for the shared diagnostics.

As reviewed on October 23, 2026, the catalogue labels RRFS experimental. NOAA's [October 15 implementation notice](https://www.weather.gov/media/notification/pdf_2026/scn26-048_Updated_RRFS_and_REFS_Implementation.aaf.pdf) schedules the production transition for November 3; the replacement bucket carries parallel forecasts.

## Armenia and ICON-EU

Armenia has 40 reviewed launch points in `Asia/Yerevan` (UTC+4). This covers the reviewed public catalogues; current access and undocumented takeoffs remain with local operators. The country selector retains its session choice and accepts `?country=AM`. Armenian pages show ICON-EU and available global forecasts; US NWS forecasts and balloon feeds stay scoped to US pages. Unknown directions and wind limits remain `null` throughout launch displays, charts and the editor.

ICON-EU reads DWD's [native-grid feed](https://opendata.dwd.de/weather/nwp/v1/m/icon-eu/p/) directly. The 00/06/12/18 UTC cycles publish a 78-hour local product. Native model levels 45–74 retain actual pressure and MSL heights; point forecasts and regional diagnostics use the shared soaring calculations. The roughly 6.5 km grid smooths narrow ridges and valleys. Armenian launch-height references use independently sampled Copernicus GLO-90 terrain; source-reported catalogue elevations remain evidence with an unknown datum.

From `forecasts/`:

```sh
python3 -m venv .venv-icon
.venv-icon/bin/pip install -r scripts/lib/icon-requirements.txt
ICON_PYTHON=.venv-icon/bin/python NODE_OPTIONS=--max-old-space-size=6144 node scripts/build-icon.mjs --sites sites.json --output data
node scripts/build-icon.mjs --output data --validate-only
```

Use Python 3.11–3.13 (CI uses 3.12). Allow roughly 12 GB of downloads and 40 minutes for a full 78-hour run; transfer speed and CPU affect both. The decoder caches segmented native fields in `.soaring-cache/icon-eu` for reuse. Use the same `ICON_PYTHON` and `NODE_OPTIONS` settings with `pnpm run build:model -- icon-eu`.

`--reference-time 2026-10-24T00:00:00Z` pins a run. `--hours 1,2,3` builds a limited validation slice; production validation requires all 78 hours. The regional case is `armenia-icon-eu-live`; open `/soaring/?region=armenia` to select it.

## Publication

[Pages](.github/workflows/pages.yml) starts general refreshes at 01:55/07:55/13:55/19:55 UTC and separate RRFS refreshes at 03:55/09:55/15:55/21:55 UTC and ICON-EU refreshes at 04:55/10:55/16:55/22:55 UTC. Completion time depends on upstream availability and build duration. Failed model refreshes retain the last complete run while other providers can publish. Code pushes publish the cached dataset.

To refresh RRFS immediately, including its native maps:

```sh
gh workflow run pages.yml --repo jdorrance/windgrams --ref main -f refresh=rrfs
```

Tracked region definitions and geography bootstrap clean runners. Requested RRFS deployments validate point profiles and both native regions. Regional bundles publish through immutable content hashes and an atomic case pointer. Each active regional model retains its current and previous bundle; separate historical replays remain available. Publication checks the complete static artifact stays below GitHub Pages' 1 GB limit.

The dataset-store abstraction lives in `forecasts/scripts/lib/store.mjs`. Its file provider uses `WINDGRAMS_STORE=file` and `WINDGRAMS_DATA_DIR`; additional providers register with `registerStoreProvider`.

## Checks and replay

Run `pnpm test` in `forecasts/`. In `web/`, run `pnpm test`, `pnpm check` and `pnpm build`. `pnpm preview` builds the site and links the complete local dataset. CI's `pnpm run dev-data` creates labelled synthetic contract fixtures in `web/dev-data`; normal development reads `forecasts/data`.

The [North Sound replay](docs/soaring-replay.md) preserves the October 21, 2026 00Z HRRR case and its source records. [Regional operations](forecasts/soaring/README.md) covers live captures and publication. [Diagnostic notes](docs/forecast-improvement-plan.md) describe the implemented science and its approximations. [Project status](docs/soaring-forecast-plan.md) separates delivered work from the WRF experiment and observational evaluation.

## Launch catalogue

From `forecasts/`:

```sh
node scripts/import-flyingsites.mjs
```

This merges US and Armenian sources into `forecasts/sites.json` and `web/src/data/launches.json`. `--country=am` uses the checked-in Armenian source without sibling repositories or network access. `--country=us` reads `../flyingsites/data/us.geojson.json`; `FLYINGSITES_US` overrides that path. `FLYINGSITES_AM` selects another reviewed Armenian input.

Reimport adds missing entries and metadata while preserving existing coordinates, notes, wind settings and other countries. Source corrections and removals require deliberate catalogue edits. See the [Armenian source review](forecasts/scripts/data/ARMENIA.md) for provenance, exclusions and licensing.
