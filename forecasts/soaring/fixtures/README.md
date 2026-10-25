# Offline soaring fixtures

These files let the tests check decoded weather values, forecast calculations and GRIB selection without downloading a complete model run. The full GRIB captures belong in the ignored capture cache; the small transport fixtures described here combine original metadata with synthetic packing.

## HRRR

`hrrr-20261021-00z-f20.idx` is the original [NOAA HRRR inventory](https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20261021/conus/hrrr.t00z.wrfprsf20.grib2.idx) for October 21, 2026 00Z, forecast hour 20. Its SHA-256 is `ef7da8921168818bc2f678e5a45a654d784ac289e4a7431372db6e28e0cb8850`.

`blanchard-published.json` is the saved 14-hour baseline publication, generated October 21, 2026 at 07:43:32Z. `blanchard-raw.json` contains decoded source columns at full precision, and `grib-headers.json` records the original GRIB metadata and source digests. The [fixed replay](../../../docs/soaring-replay.md) explains the case and its numerical audit.

The transport helper combines those headers with a synthetic 4×4 grid and simple-packed constants taken from the decoded column. This tests byte selection and decoding with small files. The larger real-source replay tests the numerical calculations across the region.

## RRFS

`rrfs-20261022-12z-f20-2dfld.idx` and `rrfs-20261022-12z-f20-prslev.idx` are original NOAA inventories from `noaa-rrfs-ops-pds`, under `rrfs.20261022/12/`. They exercise selection from the separate surface and pressure products, including one-hour precipitation windows, total cloud cover, MSLET and DZDT.

`rrfs-native-column.json` contains original GRIB sections 1, 3 and 4 for f001 terrain and f008 North Sound fields, plus decoded Blanchard values from the October 23, 2026 06Z CONUS run. Its transport test replaces the grid and packing with small synthetic equivalents while retaining the field identities and precipitation intervals. The numerical evidence in this fixture is limited to the saved column and forecast hour.

`rrfs-blanchard-published.json` is the complete f001–f084 point forecast from that 06Z run, produced with the pinned meteo.forecast 0.6.0 adapter and the repository's soaring postprocessor. Tests use it to check the published profile format, forecast horizon and diagnostic bounds. Regenerating this file requires the corresponding full-run inputs; the f008 column alone is insufficient.

## Provenance

The weather fields and inventories are from NOAA. The transport grids and packing are synthetic constructions used to exercise the decoder. Derivation and transport software retain their repository and upstream licence notices. When updating an expectation, keep the source identity and timestamps and inspect the numerical differences.
