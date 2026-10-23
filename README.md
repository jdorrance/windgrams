# Windgrams

Soaring forecasts for paragliding launches.

The forecast engine is [`@azohra/meteo.forecast`](https://meteo.azohra.com/) (MIT). Launches come from the adjacent `flyingsites` catalog (`data/us.geojson.json`).

The [soaring forecast plan](docs/soaring-forecast-plan.md) describes the path to regional lift and convergence maps, richer diagnostics, and a validated 1 km WRF pilot.

Published documents go through `forecasts/scripts/lib/store.mjs`. The built-in provider writes a directory (`WINDGRAMS_STORE=file` and `WINDGRAMS_DATA_DIR`). Another provider registers itself with `registerStoreProvider` and is selected with `WINDGRAMS_STORE`.

## Run it locally

Use Node 24 and pnpm 10.28.0 (the version pinned in both packages).

```sh
cd web
pnpm install
pnpm dev
```

Open http://localhost:4321. The dev server serves `forecasts/data` at `/data`. That directory is not in git. Build it before expecting a live chart.

## Build the local forecast

From `forecasts/`, with the dev server already running. The model build reads `/data` so it can see what is already published; a missing manifest means that model still needs a build.

```sh
pnpm install
node scripts/nws.mjs --output data
node scripts/ecmwf.mjs --output data
node scripts/raob.mjs --output data
node scripts/terrain.mjs --sites sites.json --output data/site-context.json
node scripts/solar.mjs --output data
pnpm exec meteo forecast catalogue --output data/models.json
cp sites.json data/sites.json
pnpm run build:model -- hrrr-conus
```

`build:model` also takes `hrdps-continental`, `rrfs`, `rdps`, `gfs`, `gdps`, and `geps`. Set `METEO_DATA_BASE` to build against a published dataset instead of the dev server. The build wrapper omits launches outside a model's grid, postprocesses soaring diagnostics, and preserves the last complete forecast if a refresh fails. The balloon script skips a launch with no upper-air station within 300 km, and exits non-zero if a station it did reach has no sounding in the last 48 hours. Sunlight tiles are the slow step: one elevation mosaic per launch.

### RRFS

RRFS uses NOAA's `noaa-rrfs-ops-pds` feed, with hourly CONUS forecasts through
84 hours from 00/06/12/18 UTC runs. Both the pressure and surface products must
be complete before building. `METEO_RRFS_BASE` can override the source root for
a compatible mirror. The old `noaa-rrfs-pds/rrfs_public` feed is retired.

From `forecasts/`, with the local web server running:

```sh
pnpm run build:model -- rrfs
node scripts/validate-rrfs.mjs --data data --sites sites.json
node scripts/build-live-soaring.mjs --model rrfs --output data
node scripts/merge-soaring-regions.mjs --output data
node scripts/write-runs-index.mjs --output data
```

The launch model picker discovers RRFS once its manifest is published. The
regional soaring page offers HRRR and RRFS where their native grid bundles
exist; changing model preserves the selected location and matching valid time.
Regional maps cover the first available local day's 07:00–20:00 window, matching
the HRRR regional view. Historical case links
retain their original model. RRFS regional bundles and caches have separate
namespaces, and their one-hour precipitation accumulations and geometric
vertical velocities are converted explicitly into the forecast contract.

Scheduled RRFS refreshes run at 03:55/09:55/15:55/21:55 UTC, independently of
the earlier HRRR schedule. Failed RRFS refreshes remain visible in Actions,
retain the last complete RRFS run, and allow other refreshed models to publish.
NOAA's October 15 notice schedules the production transition for November 3,
2026; the replacement bucket currently carries parallel forecasts. These
forecasts are labelled experimental in the model catalogue until that transition
is confirmed. [NWS implementation notice](https://www.weather.gov/media/notification/pdf_2026/scn26-048_Updated_RRFS_and_REFS_Implementation.aaf.pdf)

The Check workflow still builds a synthetic dataset (`pnpm run dev-data` in `web/`) and checks it against the meteo contract. `pnpm dev` does not serve that dataset.

## Replay North Sound soaring conditions

Use **Node 24** and **pnpm 10.28.0** (the version pinned in both packages). From the repository root:

```sh
cd forecasts
pnpm install --frozen-lockfile
pnpm run soaring:capture --case north-sound-20261021-00z
pnpm run soaring:replay --case north-sound-20261021-00z
cd ../web
pnpm install --frozen-lockfile
pnpm dev
```

Open [the North Sound replay](http://localhost:4321/soaring?case=north-sound-20261021-00z&hour=20). It shows the October 21, 2026 00 UTC HRRR run, forecast hours 14–27 (07:00–20:00 PDT), with native-cell thermal strength and usable-lift top, a synchronized Blanchard windgram, and the selected-hour sounding. Click a cell to inspect it; click a windgram column to change the hour. The expandable audit links to the machine-readable report.

Capture downloads about **820 MB** of original NOAA byte ranges into the ignored `forecasts/.soaring-cache/` directory. Verified downloads are resumable. Replay is entirely offline and publishes immutable, hashed bundles beneath `forecasts/data/soaring/v1/`, then atomically updates the case pointer. Replaying the same cache with the same code produces identical file hashes. Both commands accept `--cache DIR`; replay also accepts `--output DIR` (the `v1` directory). Keep the raw cache outside `forecasts/data`.

This is a historical baseline audit, not a forecast-skill assessment. It preserves meteo.forecast 0.6.0 physics, nine pressure levels, and the 1.0 m/s usable-lift threshold. The [replay implementation notes](docs/soaring-replay.md) describe the file contract, checks, limitations, and fixture provenance. Operational forecasts and schedules are unchanged.

## Refresh the launch list

From `forecasts/`, after `pnpm install`:

```sh
node scripts/import-flyingsites.mjs
```

That rewrites `forecasts/sites.json` and `web/src/data/launches.json` from `../flyingsites/data/us.geojson.json`. Set `FLYINGSITES_US` to point at a different file.
