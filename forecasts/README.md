# Forecast operator

The forecast scripts fetch weather models for the launch catalogue, calculate soaring diagnostics, and write the dataset used by the website. They also collect balloon soundings, NWS guidance and launch terrain. Point forecasts are stored under `data/<model>/`; regional maps and soundings are stored under `data/soaring/v1/`.

Complete the [workspace setup](../README.md#start-locally). Run commands below from `forecasts/`.

## Local data

```sh
export METEO_DATA_BASE=https://jdorrance.github.io/windgrams/data
node scripts/write-models-catalogue.mjs --output data
WINDGRAMS_DATA_DIR=data node scripts/publish-sites.mjs
pnpm run build:model hrrr-conus
node scripts/write-runs-index.mjs --output data
```

Replace `hrrr-conus` with a model from the [registry](../packages/providers/src/registry.ts). A build selects a complete upstream run, checks which launches it covers, measures missing launch terrain, and derives the forecast. It replaces the previous model directory only after the new profiles pass validation. If acquisition or processing fails, the previous complete run remains available.

[Preview the dataset](../web/README.md#run-and-preview), add [regional grids](soaring/README.md), or build [optional products](docs/operations.md#optional-products).

## RRFS

Build RRFS with `pnpm run build:model rrfs`. Its pressure-level and surface fields arrive in separate NOAA products, so readiness checks cover both. See [RRFS operations](docs/operations.md#rrfs) for validation and regional-map commands.

## ICON-EU

ICON-EU uses a Python decoder and downloads native-grid fields. Follow [ICON setup](docs/operations.md#icon-eu) before the first build. The builder produces Armenian point forecasts and regional maps together, using the coverage configured in [`soaring/regions.json`](soaring/regions.json).

## Pages delivery

Providers refresh independently. The [Pages publisher](../.github/workflows/pages.yml) combines completed artifacts with the retained dataset, validates the result, and builds the website. Complete forecasts can publish while a late or failed provider keeps its older data. The hourly served-data check tests the public URLs for freshness and availability.

[Delivery operations](docs/operations.md#pages-delivery) covers manual refresh, retention, custom origins and stores.

## Launch catalogue

[`sites.json`](sites.json) lists launch coordinates and time zones. [`terrain-policy.json`](terrain-policy.json) selects the elevation and land-cover sources used at each launch. The [catalogue import procedure](docs/operations.md#launch-catalogue) explains how to add source records without overwriting manual edits.

## Checks

```sh
pnpm check
pnpm check:types
pnpm test
```

These checks use local fixtures. [Regional replay](soaring/README.md#historical-replay) reproduces forecasts from captured source fields, while [observation evaluation](verification/README.md) compares issued forecasts with soundings. The [root checks](../README.md) also exercise the reusable packages and website. For the calculation methods and their limitations, see [soaring diagnostics](../docs/forecast-improvement-plan.md).
