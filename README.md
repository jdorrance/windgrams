# Windgrams

Soaring forecasts for paragliding launches.

The forecast engine is [`@azohra/meteo.forecast`](https://meteo.azohra.com/) (MIT). Launches come from the adjacent `flyingsites` catalog (`data/us.geojson.json`).

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

## Refresh the launch list

From `forecasts/`, after `pnpm install`:

```sh
node scripts/import-flyingsites.mjs
```

That rewrites `forecasts/sites.json` and `web/src/data/launches.json` from `../flyingsites/data/us.geojson.json`. Set `FLYINGSITES_US` to point at a different file.
