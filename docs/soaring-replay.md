# Fixed North Sound HRRR replay

This replay rebuilds a regional forecast from saved HRRR source records. It is useful for investigating a calculation, checking a decoder change, or comparing a proposed method with the same atmospheric inputs.

The case uses the October 21, 2026 00 UTC initialization, forecast hours 14–27, and bounds `[-123.5, 47.8, -121.5, 49.0]`. Its [configuration](../forecasts/soaring/cases/north-sound-20261021-00z.json) fixes the launch coordinates, terrain context, nine pressure levels and minimum usable level count.

## Run and inspect

Use Node 24 and pnpm 10.28.0 from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build:packages
pnpm --dir forecasts run soaring:capture --case north-sound-20261021-00z
pnpm --dir forecasts run soaring:replay --case north-sound-20261021-00z
```

Capture needs the original NOAA files to remain available, or a complete retained cache. Once those records are saved, replay runs offline. It prints the bundle directory containing the manifest, numerical outputs and audit.

Start with `audit.json` to check the sampled cell and map/profile agreement, then compare `profile.json` with the decoded values in `blanchard-raw.json`. The [Blanchard example](forecast-improvement-plan.md#reproducible-example) lists the baseline and method 2.1.0 results for forecast hour 20.

The standalone replay produces the numerical bundle described below. Website publication also uses launch and cross-section sidecars, which the [live regional builder](../forecasts/soaring/README.md#live-regions) adds. For a prepared website dataset, `/soaring?case=north-sound-20261021-00z&hour=20` selects this case at f20; `hour` is forecast lead time.

## Capture

[`capture.mjs`](../forecasts/soaring/capture.mjs) downloads NOAA inventories and the selected GRIB byte ranges. Terrain comes from f001; the atmospheric columns come from f014–f027. Optional fields include PBL depth, gusts, clouds, vertical velocity and smoke.

Each record is checked for range metadata, byte count, GRIB framing, initialization, lead time, field identity and grid definition. SHA-256 receipts let a resumed capture reuse verified records. The original capture timestamp is preserved when work resumes.

The complete cache is roughly 820 MB under the ignored `forecasts/.soaring-cache/` directory. Use `--cache DIR` on both commands to store it elsewhere. A lock prevents concurrent writers from changing the same capture. If a writer has exited without removing its lock, remove that stale lock before retrying. To recapture a damaged record, remove its byte file and receipt together.

## Replay and publication

Replay verifies the cached inputs and decodes them through a shared two-worker JPEG2000 pool. Native Lambert-grid geometry determines scanning order, cell centres, wind rotation and site sampling. Cells are selected by their centres, so polygons at the edge can extend half a cell beyond the requested bounds.

The vendored `derive-0.6.0.mjs` reproduces the legacy calculations. The [meteorology](../packages/meteorology/README.md) and [soaring](../packages/soaring/README.md) packages calculate the newer diagnostics. Conversion and derivation use full-precision source values before publication rounding. Map and launch outputs sample the same grid cell.

`--output DIR` selects the destination `soaring/v1` directory. Replay writes a temporary bundle, checks its serialized profile and file hashes, then places it under `bundles/<manifest-sha256>` and updates the case pointer. The manifest records application and package hashes as well as source identities, so identical code and captured inputs produce identical bundle bytes.

For live builds and Pages retention, see [delivery operations](../forecasts/docs/operations.md#pages-delivery).

## Bundle contents

- `manifest.json` records the case, capture time, versions, source ranges and hashes, units, cell counts and output checksums.
- `grid.geojson` contains native polygons, terrain and stable cell identifiers in hourly-array order.
- `f14.json`–`f27.json` contain baseline and newer diagnostic arrays, quality flags, level counts and ceiling flags.
- `profile.json` is the site forecast with `soaring` diagnostics.
- `audit.json` records completeness, conversions, geometry, terrain difference and map/profile agreement.
- `blanchard-raw.json` retains decoded inputs before conversion and rounding.

Diagnostic heights are metres MSL; model PBL depth is metres AGL. The browser converts display units. Source initialization and capture time identify the inputs; neither is replaced with the time at which a replay finishes.

## Audit and tests

The case contains 2,259 cells and 14 hours. Its sampled cell is about 1.576 km from Blanchard, at model terrain 221.7 m MSL. The configured launch elevation is 378.5 m from MRDEM30. The audit records that terrain difference, and calculations keep the model column at its original height.

Column quality is `valid`, `missing` or `insufficient-levels`. A valid column can still have zero W* or no usable lift ceiling. Shallow layers and limited vertical coverage are approximations described in the [diagnostic reference](forecast-improvement-plan.md). Cloud calculations distinguish surface LCL from saturated ambient layers; the source model's heat fluxes already include its modeled smoke effects.

Root `pnpm test` exercises archived values, analytic columns, masks, geometry, wind rotation, transport, resume behavior and deterministic replay, along with browser data and selection behavior. These tests answer whether the software reproduces the expected result. [Matched observations](../forecasts/verification/README.md) answer how far that result differs from the atmosphere.

[Fixture provenance](../forecasts/soaring/fixtures/README.md) identifies the original NOAA inventories, decoded values and synthetic GRIB transport used by offline tests. The vendored meteo module retains Justin Watts's MIT attribution.

### Projected convergence

Method 2.2.0 uses the spherical Lambert projection encoded in each GRIB record.
Its scale `m` is projected distance divided by ground distance. For physical
grid-axis winds `U,V`, convergence is `-m² [∂(U/m)/∂x + ∂(V/m)/∂y]`, preserving
both the local distance scale and its spatial derivatives. Earth-relative winds
are rotated to grid axes first. Signed native spacing handles every GRIB scan
direction, with centered differences inside the region and one-sided differences
at its edges. Missing stencil values remain unavailable. This is the conformal
metric formulation described in the [WRF technical note](https://www2.mmm.ucar.edu/wrf/users/docs/technote/v4_technote.pdf).

The archived North Sound comparison used all 2,259 cells and 14 hours from HRRR
October 21, 2026 00Z (f014–f027) and RRFS October 23, 2026 06Z (f008–f021), decoded
from retained original GRIB records. Compared with the prior Cartesian stencil,
the mean/maximum absolute changes at 10 m were 0.41179/6.80 for HRRR and
0.29037/3.75 for RRFS, in the published units of 10⁻⁵ s⁻¹. Each comparison included
31,612 valid cell-hours. At 925 hPa, with the existing terrain mask applied, they
were 0.03654/0.17 over 23,282 HRRR cell-hours and 0.16213/2.26 over 25,052 RRFS
cell-hours. No nonzero value changed sign. Zero can become a small nonzero
convergence because spatially constant grid winds need not be nondivergent on
the sphere. These comparisons establish the change's magnitude, not forecast
skill against observations.

The [analytic tests](../forecasts/soaring/grid-kinematics.test.mjs) check
nondivergent spherical solid-body rotation, uniform northward flow, constant
metric flux, missing data and edge stencils. The broader geometry test covers
every scan order with a linear metric-flux field. The saved native wind
stencils retain small, reproducible HRRR/RRFS regression cases.
