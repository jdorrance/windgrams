# Developing the toolkit

The [package guide](toolkit.md) describes the libraries and their entry points.
This guide covers adding data sources, building packages and publishing the app.

## Add a product or region

### A new model

Start with the [provider API](../packages/providers/README.md). Describe the model's
coverage, run schedule, forecast horizon and available fields. Its adapter selects
a run, downloads data and returns either normalized atmospheric columns or
processed profiles. Include the source units, time intervals and height references
when converting fields.

The existing Azohra adapter returns processed profiles; the application then
adds its soaring diagnostics. An adapter returning raw columns can use a different
processing strategy. For ensembles, calculate each member's diagnostics before
aggregating the results.

Wire the model into [provider policy](../forecasts/provider-policy.json) and add
fixtures for incomplete runs and missing fields. The pipeline validates a complete
candidate before replacing published data. The
[consumer fixtures](../scripts/fixtures/consumer/run.mts) check custom adapters
independently of the app's built-in model catalogue.

### A new region

A region can use an existing model wherever its coverage and fields are suitable.
[Import launch records](../forecasts/README.md#launch-catalogue), configure
[terrain sources](../forecasts/terrain-policy.json), and set any country-specific
model preferences in [forecast-capabilities.ts](../web/src/lib/forecast-capabilities.ts).
Countries without preferences use geographically applicable models from the
registry. Published manifests determine which forecasts are available.

Regional map products also need a model, case and forecast-hour range in their
catalogue and manifest. The [regional forecast guide](../forecasts/soaring/README.md)
explains extraction and publication.

## Build and release

Library code uses strict TypeScript. Operator and build scripts use Node ESM;
the native ICON decoder uses Python. Package builds compile dependencies first,
clean their output directories and emit JavaScript, declarations and assets.
You can build one package with its dependencies:

```sh
pnpm --filter @windgrams/windgram build
```

Chart styles come from CSS source, used both by the browser stylesheet and portable
SVG output. Each package build records file hashes and dependency versions in
`dist/build-inventory.json`. These hashes let a forecast replay identify the code
that produced it.

Packages are private to the workspace. `pnpm test:consumer` packs them, installs
the archives in a separate project, and checks their public APIs and browser
bundles. Publishing packages to a registry would require a separate release process.

## Tests

The [root commands](../README.md#development-checks) cover types, behavior, package
integration, browser interaction and the production build. `pnpm test:coverage`
runs the suite with coverage thresholds for the science and terrain kernels;
[package.json](../package.json) defines those thresholds.

`pnpm test:browser` uses a small synthetic dataset to exercise model switching,
chart resizing, page restoration, stale notices and archived replay. The
[web guide](../web/README.md#checks) has browser setup and fixture commands.

## Delivery

[CI](../.github/workflows/check.yml) runs on pull requests and pushes to `main`.
Provider refreshes run independently, so one slow source can keep its previous
forecast while completed updates publish. Their artifacts feed a serialized
[Pages job](../.github/workflows/pages.yml), which validates the data, builds the
site and measures the upload before deployment. Code pushes also publish; changes
confined to the root README or `docs/` skip deployment.

Publication requires a successful `Check` run for the exact checked-out commit
on `main`. The [check gate](../scripts/await-publication-check.mjs) waits up to
15 minutes and stops on a failed check or timeout. Dry runs can still inspect
candidate data without authorizing a deployment.

Forecast generation and website compilation are separate. The deployment step
combines the static site with the prepared dataset. The
[operations guide](../forecasts/docs/operations.md#pages-delivery) covers refresh
controls, artifact recovery, storage limits and separate data origins.

The app uses the [freshness API](../packages/data-client/README.md) to show forecast
age and expired coverage. An hourly [served-data check](../forecasts/docs/operations.md#refresh-health)
checks published products and provider health. [Live probes](../.github/workflows/live-smoke.yml)
check upstream services separately.

## Scientific compatibility

Refactoring a calculation should reproduce its existing results. Changes to
physical assumptions, interpolation, defaults or rounding need a numerical review
and a decision about the diagnostic method version. Package releases, scientific
methods and document schemas are versioned separately.

The [calculation reference](forecast-improvement-plan.md) describes current methods
and known limitations. [Recorded comparisons](toolkit-verification.md) document the
package extraction; [observation scoring](../forecasts/verification/README.md)
evaluates forecasts against measurements.

## Application boundaries

Applications supply location, time, rendering and persistent storage. The weather
packages own validation, field semantics and native-cell selection. The
[regional reader](../packages/data-client/docs/regional.md) and
[snapshot repository](../packages/data-client/docs/offline.md) preserve forecast
run identity and scope across online and saved datasets.

`sampleRoute` accepts positions and valid times supplied by an application. A
route planner can use estimated arrival times. Sampling returns coverage gaps and
native-cell offsets. Denser route points retain the source model's resolution.

Terrain queries at different zoom levels remain a separate extension. They need
explicit source resolution, grid alignment, interpolation, datum and missing-data
handling. Model blending and route uncertainty likewise need scientific contracts
beyond the existing sampling API. Observation scoring can build on the
[verification tools](../forecasts/verification/README.md).
