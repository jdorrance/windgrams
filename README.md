# Windgrams

Windgrams turns weather-model forecasts into launch windgrams, atmospheric
soundings and regional soaring maps. The app currently covers launches in the
United States and Armenia.

The weather readers, calculations and charts are also available as independent
TypeScript packages within this workspace. See the [package guide](docs/toolkit.md)
for using them in another application.

## Start locally

Use Node 24 and the pnpm version pinned in [package.json](package.json).
These commands start a small demo with synthetic weather data:

```sh
pnpm install --frozen-lockfile
pnpm build:packages
pnpm --dir web dev-data --site wa-blanchard --skip-solar
pnpm --dir web dev:fixtures
```

Open http://localhost:4321/launches/wa-blanchard. To work with real forecasts,
[build a local dataset](forecasts/README.md#local-data) and run `pnpm --dir web dev`.
The [web guide](web/README.md) covers previewing the production build and choosing
a data source.

## Documentation

- [Packages and architecture](docs/toolkit.md)
- [Adding models and regions](docs/toolkit-development.md#add-a-product-or-region)
- [Forecast generation and deployment](forecasts/README.md)
- [Weather calculations](docs/forecast-improvement-plan.md)

## Development checks

```sh
pnpm check
pnpm test
pnpm test:consumer
pnpm test:browser
pnpm build
```

`check` covers types, package boundaries and public declarations. `test:consumer`
installs the packed libraries in a separate project and checks their public APIs.
Browser tests use local fixtures; install Chromium once with
`pnpm --dir web exec playwright install chromium`.

See [development](docs/toolkit-development.md) for builds, coverage and CI, and
[verification results](docs/toolkit-verification.md) for the recorded refactor
comparisons.
