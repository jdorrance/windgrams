# A weather app built from the packages

[run.mts](run.mts) follows one forecast from acquisition to two SVG windgrams.
It defines a custom provider and model, adds soaring diagnostics, publishes a
manifest/profile pair to a file store, then reads that pair through the forecast
client. The charts use metric and imperial units with the same weather values.

Run it from the repository root after installing the workspace dependencies:

```sh
pnpm build:packages
pnpm test:consumer
```

The [runner](../../scripts/test-consumer.mjs) packs the libraries and installs
them into a temporary app outside the workspace. It copies a retained forecast
fixture beside the example, compiles the TypeScript and runs the emitted
JavaScript. The custom adapter reads that fixture locally. The client uses an
injected transport backed by the file store, so the forecast flow needs no live
weather feed. Installing package dependencies may use the network.

The generated dataset and SVG files live in the temporary app and are removed
when the runner exits. To adapt the example, replace the fixture adapter with
your source and choose a persistent store and transport.

[contracts.mts](contracts.mts) contains compile-time examples of accepted and
rejected API use. The runner also compiles every public package entry and bundles
a browser entry with the chart stylesheet. These checks exercise the packages
as another application would consume them.
