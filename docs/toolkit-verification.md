# Refactor verification

This record covers the package extraction and publication changes tested locally
on October 25, 2026, with Node 24 and pnpm 10.28.0. The comparisons used retained
forecasts and fixed fixtures. Forecast method 2.1.0 and the pinned Azohra versions
were unchanged.

The subsequent method 2.2.0 corrections have a separate [numerical comparison](refactor-plan.md#archived-comparison-and-rollout) and [native-grid convergence comparison](soaring-replay.md). The results below describe the earlier package extraction.

## Numerical and rendering comparisons

Eight profiles covering 646 forecast hours reproduced the previous postprocessor's
numerical results exactly. The sample included deterministic Dog forecasts, Aparan
ICON-EU and Dog GEPS. Three decoded ICON columns retained all 30 native levels and
their source metadata.

Forty scene, SVG, legend and readout hashes matched the earlier renderer. Visual
comparison covered 128 paired cases across four viewports, both unit systems and
both height ranges. [Manual browser measurements](toolkit-browser-verification.md)
cover layout and interaction.

Parsing comparisons preserved the identities, metadata, arrays and values in ten
manifests, 208 hourly products, 44 sidecars and ten profiles. Two terrain products
kept their compressed bytes and generation IDs. Terrain merging checked 634
profiles and 125 launch contexts without changing elevations.

These comparisons establish compatibility with the previous implementation.
[Observation scoring](../forecasts/verification/README.md) addresses forecast
accuracy separately; its matching and scoring rules use evaluator version 3.0.0.

## Package integration

The consumer check installed all eight packed libraries outside the workspace
and compiled all 27 public type entry points with strict library checking. Its
TypeScript example ran a custom adapter and model through diagnostics, publication
and an HTTP profile read, then rendered two charts.

Compile-time tests rejected private imports and invalid API inputs. The browser
bundle included the chart stylesheet and excluded acquisition, GRIB and embedded
style modules. Targeted package builds removed stale output and reproduced their
build-inventory hashes.

## Automated checks

The final local run passed:

- 616 JavaScript/TypeScript tests in 13.4 seconds with coverage enabled.
- Four native ICON decoder tests.
- Three Chromium tests in 3.6 seconds, using local weather fixtures and mocked map tiles.
- Type, dependency and public API checks; Astro reported zero errors, warnings or hints across 58 files.
- The production build and actionlint.

Kernel coverage was 99.33% of lines, 87.78% of branches and 96.71% of functions,
above all configured thresholds. The [root README](../README.md#development-checks)
lists the commands; [ICON setup](../forecasts/README.md#icon-eu) covers the native
test environment.

## Publication and recovery

A full publication dry run validated eight retained models, five regional cases
and 634 terrain profiles in 10.6 seconds. Source files and metadata stayed unchanged.
Failure tests covered truncated forecasts, failed completion probes, invalid
bundles, rollback, cancelled requests and conflicting artifact paths. Failed
refreshes recovered earlier successful artifacts. Partial observation updates
kept prior payloads and observation timestamps.

The production build contained 130 pages. Its Pages artifact held 5,686 files and
678,747,529 bytes, below the 800 MB warning threshold and 1 GB limit. Dataset assembly
preserved the 4,640 immutable bundle files byte-for-byte.

This run exercised local builds and publication preparation. Fresh provider
downloads and GitHub-hosted deployment were outside its scope.
