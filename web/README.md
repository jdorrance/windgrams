# Website

The website uses Astro for pages and TypeScript for maps, charts and controls.

Complete the [workspace setup](../README.md#start-locally). Run commands below from `web/`.

## Run and preview

```sh
pnpm dev
pnpm preview
```

`dev` serves `../forecasts/data` at `/data`. [Build a local forecast](../forecasts/README.md#local-data) first, or use the synthetic example below. `preview` builds the site and links the same dataset into `dist/data`, including sunlight tiles when available.

To preview the Pages path, run `WINDGRAMS_BASE=/windgrams pnpm preview --host 127.0.0.1 --port 4323`. `pnpm build` creates site assets; the [Pages workflow](../.github/workflows/pages.yml) adds forecast data.

To work offline with a small synthetic dataset:

```sh
pnpm dev-data --site wa-blanchard --skip-solar
pnpm dev:fixtures
# Or build and serve the same fixtures:
pnpm preview:fixtures
```

Open `/launches/wa-blanchard` or `/soaring?case=synthetic-archive`. The fixture commands
set `WINDGRAMS_DATA_MODE=fixtures`, serve `web/dev-data` and show a “Synthetic test data”
banner. Unset `PUBLIC_WINDGRAMS_DATA_BASE` before using them.

## Working on the app

Pages are in `src/pages/`; their browser code is in `src/scripts/`. `src/lib/` contains chart helpers, launch selection and unit preferences. The [windgram package](../packages/windgram/README.md) renders windgrams; the [toolkit guide](../docs/toolkit.md) describes the other shared packages.

Use [display rules](docs/display.md) when changing charts or controls. They cover units, height references, missing data, model selection and saved preferences. See [regional operations](../forecasts/soaring/README.md) to build map forecasts.

Station panels use the optional Worker at `/api/stations/<id>`. Its provider key stays in the Worker, which is deployed separately from the static site.

## Checks

```sh
pnpm test
pnpm check
pnpm build
```

The [fixture guide](dev-data-src/README.md) describes the generated examples. Use [visual QA](test/fixtures/windgram-visual/README.md) to compare windgram screenshots against frozen profiles.

Run `pnpm exec playwright install chromium` once to install the browser. Then
`pnpm test:browser` generates a small repeatable dataset, builds a fixture
preview on port 4397 and checks model switching, chart lifecycle, stale notices
and archived replay. The tests use local forecast files and replace external map
tiles, so they run without live weather services. Failed runs retain Playwright traces in
`test-results/`.
