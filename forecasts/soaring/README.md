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

New HRRR, RRFS and ICON bundles publish compressed scalar map hours and separate
`cell-{index}.json.gz` profiles. A cell file appears in `manifest.files` only when
its complete profile is available. The same manifest records each stored file's
SHA-256 and `fileBytes`, including final launch and transect sidecars. Clients can
save selected hours and cells through the [offline client](../../packages/data-client/README.md#saved-forecasts).
Serve compressed objects as `application/gzip`, preserving their bytes until the
client has verified them. Existing immutable bundles remain readable in their
original format.

The [operator checks](../README.md#checks) and [website checks](../../web/README.md#checks) cover calculations, publication and rendering. Replaying a fixture establishes reproducibility; [matched observations](../verification/README.md) are needed to measure forecast error.

## Normalized NOAA source experiments

Capture points and an optional region together, decoding each source field once:

```sh
pnpm run noaa:capture --model hrrr-conus \
  --reference-time 2026-10-26T06:00:00Z --hours 1,2,3 \
  --sites selected-launches.json --bounds=-123.5,47.8,-121.5,49 \
  --mode legacy-pressure --output experiments/hrrr-legacy.json
```

The site file is an array or a catalogue with a `sites` array. Select only launches
inside the requested model coverage. Omit `--bounds` for point-only acquisition.
The output contains raw normalized columns, native cell geometry/terrain,
selected source hashes and time/field semantics; it does not publish profiles.
Existing output files are rejected before acquisition; a per-output lock prevents concurrent captures. Failed acquisitions release the lock for a retry. A separate `.metrics.json` records invocation timing and referenced source bytes
(including reused cache objects). Captures retain the provider implementation
digest and mark partial columns with explicit missing reasons. Cache receipts are keyed by exact
source URL and byte range and verified against content hashes on reuse.

For a controlled source-impact experiment, repeat with a new output filename and
`--mode expanded-pressure`, or with HRRR only `--mode hrrr-native`. These modes
add actual fields, never interpolated pseudo-levels. The HRRR native inventory
must contain every selected hybrid level and supplied pressure/height; acquisition
fails if it is unavailable. RRFS and GFS native are not advertised. GFS uses its own verified 15-level
pressure inventory and three-hour forecast schedule; six-hour-boundary flux and
precipitation products are recovered from companion fields with their intervals
verified. Use `--model gfs --hours 21,24` to exercise both window cases. Keep the selected run,
hours, cells and diagnostic method fixed when comparing modes, then inspect lower
profile gaps, terrain masking, pressure, wind rotation and downstream diagnostic
changes. Accept a production migration only after that measured impact is reviewed.

The shared [provider contract](../../packages/providers/README.md#noaa-source-experiments)
contains the acquisition limits. Existing regional replay uses the same pressure
field identities and scalar conversions; its legacy inventory remains unchanged.
