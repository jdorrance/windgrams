# @windgrams/pipeline

Build and publish forecast datasets with validation and recovery around each
model. This Node 24 package connects acquisition, diagnostics and storage; you
supply the adapters and calculations used by your application.

For example, decide whether a selected run needs a build:

```ts
import { planModelBuild } from '@windgrams/pipeline';

const plan = planModelBuild({
  run: {
    provider: 'NOAA',
    model: 'hrrr-conus',
    product: 'hrrr/conus/wrfprs',
    referenceTime: '2026-10-25T12:00:00Z',
  },
  publishedRun: '2026-10-25T06:00:00Z',
  complete: true,
  inventoryMatches: true,
});

console.log(plan?.reason); // 'new-run'
```

The [planner](src/planning.ts) also identifies repairs and site backfills, and
returns `null` when no build is needed. `executeModelTasks` runs those builds with
bounded concurrency and calls each task's `lastGood` function after a failure.
Results distinguish updated, retained and unavailable models.

## From a build to a dataset

[`stageModel`](src/staging.ts) builds in a temporary directory, runs your
postprocessor and validates the result before replacing the published model.
Incomplete output and attempts to replace a newer run throw. If replacement
fails, it restores the previous directory. Readers can briefly see an absent
path between the two renames.

Use [`validateModelDirectory`](src/completeness.ts) to check a model's site
inventory, run, location metadata and forecast hours. Timestamps are ISO UTC,
forecast leads are hours and elevations are metres MSL.

For individual files, [`fileStore`](src/store.ts) replaces each file atomically.
`publishImmutableFiles` writes content before its commit pointers. A custom
`DatasetStore` can target another backend; its implementation determines how
concurrent writers and multi-pointer updates behave.

[`mergeRegionCatalogues`](src/regions.ts) combines published regional cases.
An overlay can update entries for its declared model, including a custom model
ID. [`packProvider`](src/artifacts.ts) selects files for a provider artifact.

The [consumer example](../../examples/consumer/README.md) shows a custom adapter,
diagnostic strategy, file publication and HTTP read in one program. The
[public exports](src/index.ts) link to the remaining helpers.
