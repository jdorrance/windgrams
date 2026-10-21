# Windgrams

Soaring forecasts for paragliding launches in Virginia, Washington, Maryland, North Carolina, and Oregon.

The forecast engine is [`@azohra/meteo.forecast`](https://meteo.azohra.com/) (MIT). Launches come from the adjacent `flyingsites` catalog (`data/us.geojson.json`): every US paragliding takeoff whose coordinates fall in those five states.

Published documents go through `forecasts/scripts/lib/store.mjs`. The built-in provider writes a directory (`WINDGRAMS_STORE=file` and `WINDGRAMS_DATA_DIR`). Another provider registers itself with `registerStoreProvider` and is selected with `WINDGRAMS_STORE`.

## Run it locally

Requires Node 22 or later and pnpm.

```sh
cd web
pnpm install
pnpm dev
```

Open http://localhost:4321. The dev server builds a sample dataset from the launch list and serves it at `/data`. The charts are labelled as sample data. They are not a live forecast.

## Refresh the launch list

From `forecasts/`, after `pnpm install`:

```sh
node scripts/import-flyingsites.mjs
```

That rewrites `forecasts/sites.json` and `web/src/data/launches.json` from `../flyingsites/data/us.geojson.json`. Set `FLYINGSITES_US` to point at a different file. Maryland is included in the filter; the current source has no takeoffs inside the state, so that group is empty.
