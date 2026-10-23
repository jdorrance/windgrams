# Offline soaring fixtures

`hrrr-20261021-00z-f20.idx` is the original NOAA HRRR pressure-file inventory
for the October 21, 2026 00 UTC initialization, forecast hour 20:
https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20261021/conus/hrrr.t00z.wrfprsf20.grib2.idx

SHA-256: `ef7da8921168818bc2f678e5a45a654d784ac289e4a7431372db6e28e0cb8850`.
It tests actual field availability without a local capture cache or network.
Full GRIB archives remain outside Git.

`rrfs-20261022-12z-f20-2dfld.idx` and
`rrfs-20261022-12z-f20-prslev.idx` are the original NOAA RRFS inventories from
the replacement operational bucket, under `rrfs.20261022/12/`. They exercise
separate surface and pressure products, exact one-hour precipitation windows,
single-layer total cloud cover, MSLET and DZDT selections.

`rrfs-native-column.json` contains original GRIB sections 1, 3 and 4 for terrain
at f001 and the North Sound fields at f008, plus decoded Blanchard values from
the `rrfs.20261023/06/` CONUS run. Its test transport substitutes a synthetic
4×4 grid and constant simple packing; the original field parameters and
precipitation interval metadata are retained. The full live run was separately
decoded on the native grid and verified for both active regions.

`rrfs-blanchard-published.json` is the full 84-hour Blanchard point forecast from
NOAA RRFS `rrfs.20261023/06`, f001–f084, using the 2dfld surface and prslev
pressure products. It was built with the pinned meteo.forecast 0.6.0 adapter and
the repository's v2 soaring postprocessor. It exercises the published schema
and numeric bounds across the complete RRFS horizon.
