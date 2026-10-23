# Synthetic sample sources

`scripts/make-dev-data.mjs` builds labelled synthetic data for contract and UI checks. Its default output is `web/dev-data`. The normal dev server reads the live local `forecasts/data` tree.

- `convective-cycle.profile.json`: synthetic scenario from [meteo by Azohra](https://github.com/azohra/meteo), `scenarios/generated/`. The generator changes its dates and site labels for local fixtures.
- `ensemble-wide.profile.json`: synthetic ensemble scenario from the same source.
- `models.json`: model catalogue shipped with `@azohra/meteo.forecast`.

These files use the MIT licence, Copyright (c) 2026 Justin Watts. They support reproducible tests; real-source fixture provenance lives in [forecasts/soaring/fixtures](../../forecasts/soaring/fixtures/README.md).
