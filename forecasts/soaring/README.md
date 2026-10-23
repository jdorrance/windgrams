# Regional soaring forecasts

Native HRRR and RRFS grids serve North Sound and Shenandoah–Blue Ridge. Tracked region configuration lives in `regions.json`; `regions/` supplies launch and cross-section geometry for a clean build.

## Live regions

From `forecasts/`, using Node 24 and pnpm 10.28.0:

```sh
node scripts/build-live-soaring.mjs --output data
node scripts/build-live-soaring.mjs --model rrfs --output data
node scripts/merge-soaring-regions.mjs --output data
```

The builders follow each model's published initialization. The regional window is the first available local day between 07:00 and 20:00, selected within f002–f048. Model time zones include daylight-saving changes. Identical inputs share a capture.

HRRR and RRFS have separate cache and `-live` / `-rrfs-live` case namespaces. RRFS reads `prslev` and `2dfld` from `noaa-rrfs-ops-pds`; `METEO_RRFS_BASE` selects a compatible mirror. Its one-hour precipitation accumulation ends at valid time. Its geometric vertical velocity is converted to pressure velocity for the shared calculations.

Bundles are staged, hashed and checked before the case pointer changes. Recently superseded live bundles remain for 48 hours. Model comparisons and verification sidecars carry matching run metadata. Launches and transects are sampled on each model's own grid and terrain. The browser retains geographic selection and matching valid time across model changes.

Validate the current RRFS regional set with:

```sh
node scripts/build-live-soaring.mjs --model rrfs --output data --validate-only
```

## Historical replay

```sh
pnpm run soaring:capture --case north-sound-20261021-00z
pnpm run soaring:replay --case north-sound-20261021-00z
```

Capture stores original NOAA records in ignored `.soaring-cache/`. Replay runs offline from verified cache receipts. `--cache DIR` selects another archive; replay's `--output DIR` selects the destination `soaring/v1` directory. The manifest records inputs and implementation hashes; `audit.json` compares the published site profile with its regional cell.

The baseline `derived` block preserves the original calculation. `hours[].soaring` carries the v2 diagnostics used by current charts. See [replay details](../../docs/soaring-replay.md) and [diagnostic definitions](../../docs/forecast-improvement-plan.md).

## Display and tests

Published w*, lift top and condensation values feed the map, windgram and sounding. Paraglider symbols use the 225 ft/min ceiling; the blue line uses the separate 1 m/s ceiling. Heights are MSL; native model PBL depth is AGL. The browser converts visible units through its Imperial/Metric setting.

Imperial barbs follow [NWS aviation conventions](https://www.weather.gov/hfo/windbarbinfo): nearest 5 knots, half feather 5, full feather 10 and pennant 50. Metric barbs round to 2.5 m/s, with half feather 2.5, full feather 5 and pennant 25 m/s. Both use a calm circle and a staff pointing toward the wind's source. Windgram colors follow [WxToFly](http://wxtofly.net/windgramexplain.html); RH above 94% uses white crosshatching and potential LCL uses an outlined cloud.

Unit selection changes display values; source JSON, diagnostic contracts and physical thresholds stay unchanged. The [website conventions](../../web/README.md#display-conventions) describe the display units and exceptions.

`pnpm test` exercises compact checked-in fixtures. Run `pnpm test`, `pnpm check` and `pnpm build` in `web/` for browser code; `pnpm preview` serves the complete local dataset. Numerical checks establish reproducibility and internal consistency. Forecast skill is assessed separately against matched observations.
