# Fixed North Sound HRRR replay

This historical case preserves the October 21, 2026 00 UTC HRRR run, forecast hours 14–27, over the North Sound bounding box `[-123.5, 47.8, -121.5, 49.0]`. The case freezes launch coordinates, the terrain-context snapshot, nine pressure levels and the minimum usable level count. Current live regions use the same capture/replay machinery with their own initialization and model.

## Run and inspect

Use Node 24 and pnpm 10.28.0. From `forecasts/`:

```sh
pnpm install --frozen-lockfile
pnpm run soaring:capture --case north-sound-20261021-00z
pnpm run soaring:replay --case north-sound-20261021-00z
```

Start `pnpm dev` in `web/`, then open `/soaring?case=north-sound-20261021-00z&hour=20`. The `hour` parameter is forecast lead time. The page synchronizes cell selection, windgram and sounding. `pnpm preview` provides a production build linked to the complete local dataset; `WINDGRAMS_BASE=/windgrams` exercises the project-site URL prefix.

At f20, the preserved legacy publication has w* 1.06 m/s and usable height 724.5 m MSL. Current v2 displays use w* 0.85 m/s, a 1 m/s ceiling of 465.5 m and a 225 ft/min ceiling of 446.8 m. Both calculation families remain available for comparison.

## Capture

`capture.mjs` fetches the original `.idx` and selected NOAA GRIB byte ranges. This historical case uses terrain from f001 and nine-level atmospheric columns from f014–f027. Optional fields include PBL depth, gusts, cloud layers, vertical velocity and HRRR smoke.

Validation checks HTTP range metadata, byte counts, GRIB framing, run and lead time, parameter/level identity and grid definition. A validated file receives a SHA-256 receipt. Resume verifies that receipt before reusing the file. The first capture timestamp is retained.

The full capture is roughly 820 MB in ignored `forecasts/.soaring-cache/`. `--cache DIR` chooses another location. A capture lock protects concurrent writers. A stale lock can be removed after the writer exits; a damaged record is repaired by removing its byte file and receipt, then recapturing.

## Replay and publication

Replay verifies the cache and runs offline. A shared two-worker JPEG2000 pool decodes fields while regional samples are retained. Native Lambert-grid geometry supplies scanning order, cell centers, wind rotation and site sampling. Cells are included by center point, so boundary polygons can extend half a cell beyond the requested box.

`vendor/derive-0.6.0.mjs` preserves the original pure derivation module and its MIT notice. V2 diagnostics are attached alongside it through the modular `forecasts/soaring/` domain modules (`thermodynamics.mjs`, `convective-lift.mjs`, `boundary-layer-wind.mjs`, `terrain-adjustment.mjs`, `grid-kinematics.mjs`, `diagnostics.mjs`, `grib-column.mjs`, and `audit-agreement.mjs`, re-exported via `science.mjs`). Full-precision inputs are converted and derived before publication rounding; map and site values sample the same canonical cell.

Replay's `--output DIR` selects a destination `soaring/v1` directory. A staged bundle is verified and renamed into `bundles/<manifest-sha256>` before the case pointer changes. The implementation inventory covers the replay's local module dependencies; changing an extracted calculation module changes the bundle hash. Repeating the same code and cache yields the same bytes.

The live-build wrapper prunes superseded bundles after a 48-hour grace period. Pages packaging then keeps the current and most recently superseded bundle for each active regional case. Historical cases remain available. The complete upload must fit the 1 GB Pages artifact limit.

## Bundle contents

- `manifest.json`: case, capture time, versions, source ranges/hashes, units, cell counts and file hashes.
- `grid.geojson`: native cell polygons, terrain and stable grid-cell identifiers, in hourly-array order.
- `f14.json`–`f27.json`: baseline and v2 diagnostic arrays, quality, captured-level counts and ceiling flags.
- `profile.json`: the schema-v2 site forecast with its `soaring` extension.
- `audit.json`: completeness, conversions, geometry, terrain difference and exact map/profile comparisons.
- `blanchard-raw.json`: decoded source values used for inspection and fixture provenance.

Heights are metres MSL, except model PBL depth in metres AGL. Browser unit selection converts the display. Case and capture times provide the scientific timestamps; replay progress uses wall-clock time.

## Interpreting the audit

Quality values are `valid`, `missing` and `insufficient-levels`. A valid column can have zero w* or a null lift ceiling at the selected sink threshold. Missing surface values, terrain or adequate vertical coverage have their own status.

The baseline's first-level crossing and sampled-column ceiling behavior are retained. V2 couples thermal strength and lift height to the resolved parcel/PBL depth. Shallow layers and limited pressure-level coverage remain approximations; their details are in the [diagnostic notes](forecast-improvement-plan.md).

The fixed model cell is about 1.576 km from Blanchard. Its terrain is 221.7 m MSL; the saved launch-context estimate is 378.5 m from MRDEM30. Cloud diagnostics distinguish surface condensation height from saturated ambient layers. HRRR smoke effects are already present in the model heat fluxes.

The initial archive contains 2,259 cells and 14 hours. It reproduces the frozen publication and exact map/site values. Those checks establish numerical consistency; matched observations provide the separate forecast-skill evidence.

## Tests and source credits

`pnpm test` in `forecasts/` covers archived Blanchard values, analytic columns, masks, grid geometry, wind rotation, transport validation, resume and deterministic replay. Web tests cover shared selection, profile decoding, units and chart geometry.

[Fixture provenance](../forecasts/soaring/fixtures/README.md) distinguishes original NOAA inventories and decoded values from the small synthetic GRIB transport. Routine offline tests use those compact files. The vendored meteo module retains its MIT attribution to Justin Watts.
