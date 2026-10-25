# Regional soaring forecasts

Regional forecasts show how lift, clouds and wind vary across a model's native grid. Each published case contains map fields, soundings and launch profiles calculated from the same source columns, so selecting a cell or forecast hour keeps those views aligned.

[`regions.json`](regions.json) selects the regions and models to build; [`regions/`](regions/) contains launch and transect geometry. Start with the [forecast operator](../README.md) to build point forecasts and prepare the local dataset. Published diagnostic heights are metres MSL. The model's native boundary-layer depth is metres AGL.

## Live regions

Run from `forecasts/`, after building the matching point forecast:

```sh
node scripts/build-live-soaring.mjs --output data
node scripts/build-live-soaring.mjs --model rrfs --output data
node scripts/merge-soaring-regions.mjs --output data
```

HRRR and RRFS use the first local day whose 07:00–20:00 hours fit within forecast leads f002–f048. The time conversion accounts for daylight saving; the chart itself spans sunrise to sunset. Each model keeps its own grid, terrain, capture cache and case directory. Repeating an identical capture request reuses the existing records.

RRFS precipitation is the one-hour accumulation ending at valid time. Its geometric vertical velocity is converted to pressure velocity during ingest. To check existing RRFS regions without downloading or rebuilding them, run:

```sh
node scripts/build-live-soaring.mjs --model rrfs --output data --validate-only
```

## ICON-EU

The ICON-EU builder produces Armenian point and regional forecasts in one run. Follow [ICON setup](../docs/operations.md#icon-eu) for installation and build commands. The [native-data notes](../docs/operations.md#native-data-and-terrain) explain its vertical coordinates and launch terrain; [bundle details](../docs/operations.md#regional-bundles) describe how the browser loads cell profiles.

## Historical replay

```sh
pnpm run soaring:capture --case north-sound-20261021-00z
pnpm run soaring:replay --case north-sound-20261021-00z
```

Capture downloads the selected original records into the ignored `.soaring-cache/` directory and saves their checksums. Once the capture is complete, replay can run offline. The [fixed North Sound replay](../../docs/soaring-replay.md) explains the source selection, output files and numerical checks.

## Display and verification

Map, windgram and sounding read the published lift diagnostics. The paraglider symbol marks the 225 ft/min sink ceiling; the blue line marks the separate 1 m/s ceiling. See [display conventions](../../web/docs/display.md) for wind barbs, cloud shading and units, and [soaring diagnostics](../../docs/forecast-improvement-plan.md) for the calculations.

Before a new bundle becomes active, validation checks its files, forecast hours and agreement between map and profile values. The case pointer then selects the completed immutable bundle. Pages retains the current and previous bundle for each active case, along with historical cases.

The [operator checks](../README.md#checks) and [website checks](../../web/README.md#checks) cover calculations, publication and rendering. Replaying a fixture establishes reproducibility; [matched observations](../verification/README.md) are needed to measure forecast error.
