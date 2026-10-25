# Synthetic sample sources

Run `pnpm --dir web run dev-data` from the repository root to generate synthetic forecasts in `web/dev-data`. Then use `dev:fixtures` or `preview:fixtures` from `web/` to view them with a test-data banner. The ordinary `dev` and `preview` commands serve `forecasts/data`.

Use `--site wa-blanchard --skip-solar` for a small dataset, or `--solar-site SLUG`
to choose which launches get terrain maps. `--now ISO_TIMESTAMP` fixes the clock for repeatable
tests. The generator also creates the one-cell `synthetic-archive` regional bundle
from the first selected launch's synthetic profile. Browser regression tests use
that bundle and a fixed browser clock.

- `convective-cycle.profile.json`: synthetic scenario from [meteo by Azohra](https://github.com/azohra/meteo), `scenarios/generated/`. The generator adjusts dates, sites, heights and winds for local scenarios.
- `ensemble-wide.profile.json`: synthetic ensemble scenario from the same source.
- `models.json`: model catalogue shipped with `@azohra/meteo.forecast`.

These files use the MIT licence, Copyright (c) 2026 Justin Watts. For tests using captured weather data, see [forecasts/soaring/fixtures](../../forecasts/soaring/fixtures/README.md).
