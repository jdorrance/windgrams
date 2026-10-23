# Offline soaring fixtures

These compact files support numerical and transport regression tests. Full GRIB captures stay in the ignored cache.

## HRRR

`hrrr-20261021-00z-f20.idx` is the original [NOAA HRRR inventory](https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20261021/conus/hrrr.t00z.wrfprsf20.grib2.idx) for October 21, 2026 00Z, forecast hour 20.

SHA-256: `ef7da8921168818bc2f678e5a45a654d784ac289e4a7431372db6e28e0cb8850`.

`blanchard-published.json` is the saved 14-hour baseline publication, generated October 21, 2026 at 07:43:32Z. `blanchard-raw.json` contains decoded source columns at full precision. `grib-headers.json` records original GRIB metadata and source digests.

The transport helper combines those headers with a synthetic 4×4 grid and simple-packed constants from the decoded column. This separates byte-selection tests from the larger real-source numerical replay.

## RRFS

`rrfs-20261022-12z-f20-2dfld.idx` and `rrfs-20261022-12z-f20-prslev.idx` are original NOAA inventories from `noaa-rrfs-ops-pds`, under `rrfs.20261022/12/`. They cover the split surface/pressure products, one-hour precipitation windows, total cloud cover, MSLET and DZDT selections.

`rrfs-native-column.json` retains original GRIB sections 1, 3 and 4 for f001 terrain and f008 North Sound fields, plus decoded Blanchard values from the October 23, 2026 06Z CONUS run. Its transport test substitutes the small synthetic grid and constant packing while retaining field identities and precipitation intervals. Separate native-grid runs exercised both active regions.

`rrfs-blanchard-published.json` is the complete f001–f084 point forecast from that 06Z run. It uses the pinned meteo.forecast 0.6.0 adapter and the repository's v2 postprocessor. Tests cover the public schema, full horizon and diagnostic bounds.

Source weather fields and inventories: NOAA. Derivation and transport software retain their repository and upstream licence notices.
