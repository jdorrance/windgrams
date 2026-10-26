# NOAA test evidence

`noaa-gfs.json` retains actual NOAA GFS 2026-10-26 00Z GRIB section 1/3/4
metadata and sampled Blanchard values at f003 terrain, f021 and f024. Every field
records its public source URL, byte range and SHA-256. The test transport only
replaces packing with compact constant fields and reduces the grid to four by
four cells. It is not a substitute for the full immutable source capture.

The pair tests a three-hour window and a six-hour window recovered using its
three-hour companion, including RH moisture, native HPBL local parameter code,
cloud fractions and the regular latitude/longitude grid. Temporal metadata is
unaltered, so wrong initialization, support, missing-count and increment-type
checks exercise the real product definitions.
