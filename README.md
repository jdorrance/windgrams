# Windgrams

Soaring forecasts for paragliding launches.

The forecast engine is [`@azohra/meteo.forecast`](https://meteo.azohra.com/) (MIT). Launches come from the adjacent `flyingsites` catalog (`data/us.geojson.json`).

The [soaring forecast plan](docs/soaring-forecast-plan.md) describes the path to regional lift and convergence maps, richer diagnostics, and a validated 1 km WRF pilot.

Published documents go through `forecasts/scripts/lib/store.mjs`. The built-in provider writes a directory (`WINDGRAMS_STORE=file` and `WINDGRAMS_DATA_DIR`). Another provider registers itself with `registerStoreProvider` and is selected with `WINDGRAMS_STORE`.

## Run it locally

Requires Node 22 or later and pnpm.

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

`build:model` also takes `hrdps-continental`, `rrfs`, `rdps`, `gfs`, `gdps`, and `geps`. Set `METEO_DATA_BASE` to build against a published dataset instead of the dev server. HRDPS refuses the whole build when any launch lies outside its grid; Jones Knob in North Carolina does, so that model has to be built from a sites file that omits it. RRFS often has no complete run. The balloon script skips a launch with no upper-air station within 300 km, and exits non-zero if a station it did reach has no sounding in the last 48 hours. Sunlight tiles are the slow step: one elevation mosaic per launch.

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
