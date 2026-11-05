# AV consumer cutover

Use the AV reader for GFS, ICON-EU and RRFS after its production publications pass
`node forecasts/scripts/verify-av-cutover.mjs --output /tmp/av-proof.json`.
The command verifies native profiles, horizons, point/sample agreement and raster
responses through the consumer boundary. Review the saved proof with browser and
offline checks before setting the Pages `AV_API_BASE` variable.

Retire each model's acquisition together with its seeding, packing, validation
and publication requirements. Keep HRRR, ECCC, observation and terrain workflows.
Keep immutable legacy bundles available for explicit archived links.
