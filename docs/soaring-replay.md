# North Sound HRRR replay

The first regional milestone captures one fixed public NOAA HRRR run and reproduces a lift map and Blanchard profile offline. The initial run is 2026-10-21 00 UTC, forecast hours 14–27, over [-123.5, 47.8, -121.5, 49.0]. The case definition freezes the catalogue coordinates, terrain-context snapshot, nine pressure levels, and minimum usable level count.

## Run and inspect

Use Node 24 and pnpm 10.28.0. In `forecasts/`, run:

```sh
pnpm install --frozen-lockfile
pnpm run soaring:capture --case north-sound-20261021-00z
pnpm run soaring:replay --case north-sound-20261021-00z
```

Start `pnpm dev` in `web/`, then visit `/soaring?case=north-sound-20261021-00z&hour=20`. The `hour` parameter is a forecast lead hour, not the slider index. At f20 the initial publication gives Blanchard W* = 1.06 m/s and usable-lift top = 724.5 m MSL (2,377 ft). At f14 W* is zero and usable-lift top is null.

The application uses the same base-path helper as the rest of the site. `/windgrams/soaring` reads `/windgrams/data/soaring/...` when built with `WINDGRAMS_BASE=/windgrams`. For a local production preview, run `pnpm preview` in `web/`; it builds the site and links the complete `forecasts/data` dataset so both soaring and launch pages work. Local development serves `forecasts/data` directly.

## Capture and reproducibility

`forecasts/scripts/soaring.mjs` is a small entry point. `forecasts/soaring/capture.mjs` fetches the `.idx` and exact selected GRIB ranges from NOAA's public HRRR S3 archive. Terrain comes from f01; each other hour selects the same 73 available fields as the pinned HRRR builder, including optional PBL, gusts, cloud layers, omega, and all three smoke fields. Required records must exist. Optional records absent from an index are explicitly recorded.

Capture checks HTTP 206 and Content-Range, byte count, GRIB framing, initialization time, forecast lead, parameter/level identity, and consistent grid definition. This case uses instantaneous GRIB product template 4.0; other layouts are rejected. Each file gets a SHA-256 receipt only after validation. A failed fetch does not produce a reusable receipt. Repeated capture verifies receipts before reusing files. The first capture timestamp is retained across resumes.

The default cache is ignored and outside the served dataset. A capture lock prevents concurrent writers. If a process is forcibly killed, confirm it has exited before removing its `capture.lock` directory and rerunning. Corrupt cached data fails explicitly; remove the affected byte file and matching `.json` receipt, then recapture to repair it. Do not edit the completed capture manifest by hand.

Replay verifies every file and inventory before decoding. It never calls fetch or resolves a latest cycle. Two decode lanes share at most two JPEG2000 workers; only regional samples persist between fields. Scanning order, cell centres/corners, nearest-point selection, and grid-relative wind rotation come from the native spherical Lambert grid. The region includes cells whose centres fall inside the bounding box; outer polygons may extend half a grid cell beyond it.

`vendor/derive-0.6.0.mjs` is an unchanged copy of the package's pure derivation module with its MIT notice. Public briefing helpers and forecast publication rounding remain pinned. Full-precision inputs are converted and derived before rounding. Both map and profile extract the same rounded canonical cell. No live model documents are overwritten.

## Output contract v1

`data/soaring/v1/<case>/index.json` points to `bundles/<manifest-sha256>`. A complete bundle is validated in a sibling staging directory and renamed into place before the pointer changes. Readers first load the pointer, then immutable files from that bundle. Old bundles remain available; they can be removed manually when no longer needed.

Each bundle contains:

- `manifest.json`: case definition, capture timestamp, algorithm/dependency versions, source URLs/ranges/digests, implementation hashes, units, cell count, Blanchard array index, and per-file hashes.
- `grid.geojson`: native cell polygons, model elevation, centre coordinates, stable `<grid-key>:<storage-index>` IDs. Feature order is the array order in hourly files.
- `f14.json` through `f27.json`: parallel arrays for W*, usable-lift top, parcel thermal top, cloud base, HRRR PBL depth, quality, above-ground level count, and ceiling flag. Heights are metres MSL except HRRR PBL depth, which is metres AGL. The UI converts usable top to feet.
- `profile.json`: the public schema-v2 Blanchard SiteForecast, validated by the public briefing contract guard.
- `audit.json`: input completeness, conversions, geometry, rotation, sampling distance, terrain mismatch, coverage counts, hourly PBL comparison, exact map/profile equality, and field-by-field differences against the frozen prior publication.
- `blanchard-raw.json`: decoded pre-conversion quantities and source columns for inspection and regression-fixture provenance.

All timestamps in these scientific outputs come from the case or capture; replay wall-clock progress goes to the terminal. Changing source code changes the implementation hashes and therefore the bundle ID. Repeating unchanged code/cache yields identical output bytes.

## Scientific limits

Quality is `valid`, `missing`, or `insufficient-levels`. Missing required surface values/terrain mask a cell. Incomplete individual levels are omitted; fewer than three complete levels above model terrain +20 m mask lift diagnostics. Blanchard must be valid at every requested hour or the bundle fails. Zero W* stays numeric zero; null usable top in a valid column means no lift above the configured sink threshold. Neither is interchangeable with missing data.

The parcel-derived thermal top is not the model's HPBL diagnostic. The baseline preserves its first-level stable-crossing behavior and its top-of-column fallback. A column with positive dry-parcel buoyancy at every sampled level gets a ceiling flag. That retained top is a sampled-column bound, not a resolved thermal ceiling. The audit and inspector disclose it.

Cloud base merges the surface LCL with the first near-saturated layer; it is not a probability of cumulus. HRRR smoke is radiatively coupled, so no extra smoke attenuation is applied. Nine levels miss shallow inversions and local flows. The model sample lies about 1.576 km from Blanchard; model terrain is 221.7 m versus the frozen launch-context elevation of 378.5 m. None of the equality checks validates real-world forecast skill.

The browser reads the published lift values. Existing windgram/sounding renderers still draw temperature, moisture, interpolated chart traces, and parcel overlays; these do not replace the replay's diagnostic values. Native map polygons have no spatial smoothing. Basemap tiles are optional network resources; choose the Offline basemap when disconnected.

## Verification and fixtures

`pnpm test` in `forecasts/` includes real archived Blanchard regression cases, an independent analytic dry-column reference, masking/ceiling behavior, grid/index round trips, wind rotation, a synthetic GRIB transport integration, capture resume, exact map/profile equality, contract validation, offline deterministic replay, failed/ignored range responses, and cache/run/field corruption. The synthetic integration disables global fetch during replay and verifies identical hashes across two replays. The web tests cover the shared selection state, historical labels, null/zero distinctions, and project-base URL construction.

`fixtures/blanchard-published.json` is the existing 14-hour publication from the 00 UTC run, generated 2026-10-21 07:43:32 UTC. `fixtures/blanchard-raw.json` holds full-precision decoded values from the new archive capture. `fixtures/grib-headers.json` records original GRIB metadata and source SHA-256 digests. The test helper combines those headers with a small synthetic 4×4 grid and simple-packed constants from the real column. It is not represented as a raw NOAA archive. Full downloaded fields remain ignored; ordinary CI requires no network or 820 MB download.

For the actual archive, replay twice after capture and compare the case pointer and manifest file hashes. The initial real run has 2,259 cells, 14 hours, 70 exact map/profile diagnostic comparisons, and an exact match to the saved publication excluding `run.generatedAt`. All cells in this particular run have sufficient usable levels and no sampled-column ceiling flags; synthetic cases exercise those other paths.
