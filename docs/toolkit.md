# Weather toolkit

The toolkit provides the weather acquisition, calculations and charts used by
Windgrams. Its packages can also support a standalone chart, a server-generated
briefing or another forecast application. They are currently private workspace
packages.

Forecast generation runs in Node. Published forecasts are JSON documents that a
browser can read and render without downloading model files or running the
forecast calculations. Launch catalogues, regional preferences and deployment
configuration live in the Windgrams application.

## Packages

- [contracts](../packages/contracts/README.md) defines atmospheric records,
  forecast documents and diagnostic extensions to the Azohra forecast types.
- [geography](../packages/geography/README.md) works with positions, bounds and
  model coverage.
- [meteorology](../packages/meteorology/README.md) calculates thermodynamic
  quantities, layer winds and solar position.
- [soaring](../packages/soaring/README.md) derives thermal strength, lift ceilings
  and terrain-related diagnostics, including ensemble results.
- [providers](../packages/providers/README.md) discovers model runs, downloads
  source data and converts it to the toolkit's weather types.
- [pipeline](../packages/pipeline/README.md) plans acquisitions, validates their
  results and publishes complete datasets through a configured store.
- [data-client](../packages/data-client/README.md) reads published forecasts over
  HTTP, checks their identity and manages retries and profile caching.
- [windgram](../packages/windgram/README.md) builds and renders charts. Its DOM
  entry adds selection, inspection and keyboard interaction.

## Using the packages

Start with the README for the package you need. It links to its public types and
usage examples. The [consumer example](../examples/consumer/run.mts) follows a
custom provider through calculation and publication, then reads the result and
renders two charts. `pnpm test:consumer` compiles and runs it against packed
archives in a separate project.

For changes to the toolkit, see [API conventions](toolkit-contracts.md) and the
[development guide](toolkit-development.md). TypeScript generates the published
declarations from source; package checks catch private imports and undeclared
dependencies.
