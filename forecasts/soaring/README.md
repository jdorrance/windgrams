# Regional soaring forecasts

Regional forecasts show how lift, clouds and wind vary across a model's native grid. Each published case contains map fields, soundings and launch profiles calculated from the same source columns, so selecting a cell or forecast hour keeps those views aligned.

[`regions.json`](regions.json) selects the regions and models to build; [`regions/`](regions/) contains launch and transect geometry. Start with the [forecast operator](../README.md) to build point forecasts and prepare the local dataset. Published diagnostic heights are metres MSL. The model's native boundary-layer depth is metres AGL.

## Live regions

Armenia's ICON-EU grid is the published regional product. The North Sound and
Shenandoah/Blue Ridge HRRR and RRFS grids are retired from production to make
room for Mexican launch forecasts. Their launch windgrams and soundings continue
to use the point models. Historical source cases below remain available for
local scientific replay; their generated map bundles are excluded from delivery.

[`regions.json`](regions.json) owns the active production regions. The HRRR/RRFS
live builder remains available for explicitly configured trials, but scheduled
refreshes do not acquire grids for retired regions.

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

Before a new bundle becomes active, validation checks its files, forecast hours and agreement between map and profile values. The case pointer then selects the completed immutable bundle. Pages retains the current and previous bundle for each active case, along with historical cases outside retired public regions. [Publication operations](../docs/operations.md#publication-and-retention) describes retirement and storage limits.

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

### Source impact and full-horizon trials

Compare retained captures:

```sh
pnpm run verify:noaa-sources --captures experiments/hrrr-legacy.json,experiments/hrrr-expanded.json \
  --output experiments/hrrr-impact.json --profiles experiments/hrrr-profiles
```

The report matches run, valid time, native grid/cell, coordinates and terrain,
isolates pressure, level and 80 m wind effects, and lists missing columns and forecast hours.
It includes capture hashes, available acquisition timings, source bytes and a
linear estimate of full-horizon bytes. Source bytes include cached objects.
`--profiles` writes experimental profiles to a new directory, retaining native
cloud and convective heights and the CAPE/CIN parcel basis.

Use `--hours all` with `noaa:capture` to select the model's complete registered
schedule. `--offline` reads verified cached objects; omit it to acquire from
upstream. Save each source mode to a new output file, then compare the captures.
Horizon coverage and acquisition timing come from each capture; byte estimates
scale the captured sample to the full schedule.
