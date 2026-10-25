# Forecast operations

The [forecast README](../README.md) covers a routine point build. This guide covers supplemental data, model-specific setup, delivery and troubleshooting. Run the commands from `forecasts/` unless a different directory is stated.

## Optional products

The website can display NWS guidance, ECMWF forecasts, balloon soundings, launch terrain and sunlight maps alongside the model profiles:

```sh
node scripts/nws.mjs --output data
node scripts/ecmwf.mjs --output data
node scripts/raob.mjs --output data
node scripts/terrain.mjs --sites sites.json --output data/site-context.json
node scripts/solar.mjs --output data
```

NWS and balloon feeds cover US launches. The ECMWF adapter reads the Open-Meteo product. Sunlight tiles can be served in [local development and preview](../../web/README.md#run-and-preview), but they are excluded from Pages because of their size.

NWS and ECMWF refreshes merge by site. If a site refresh fails, publication keeps an available prior payload with its original timestamps. The attempt remains `ok: false` in the manifest; `retained: true` indicates that older data is still available. NWS office products used by retained sites are kept too. This lets the display show the age of the data without presenting a failed refresh as successful.

## RRFS

The configured NOAA source is `noaa-rrfs-ops-pds`, with 00/06/12/18 UTC CONUS runs through f084. Readiness checks cover both `prslev` and `2dfld`, since a complete pressure-level product alone is insufficient. Set `METEO_RRFS_BASE` to use a compatible mirror.

```sh
pnpm run build:model rrfs
node scripts/validate-rrfs.mjs --data data --sites sites.json
node scripts/build-live-soaring.mjs --model rrfs --output data
node scripts/merge-soaring-regions.mjs --output data
node scripts/write-runs-index.mjs --output data
```

The catalogue labels RRFS experimental. The source reviewed for that setting was NOAA's [October 15, 2026 notice](https://www.weather.gov/media/notification/pdf_2026/scn26-048_Updated_RRFS_and_REFS_Implementation.aaf.pdf), which scheduled the production transition for November 3, 2026. The integration review was made on October 23, 2026.

## ICON-EU

ICON-EU uses DWD's [native-grid feed](https://opendata.dwd.de/weather/nwp/v1/m/icon-eu/p/) and a Python decoder. The configured 00/06/12/18 UTC cycles provide hourly f001–f078 forecasts for Armenia.

Create the decoder environment before the first build:

```sh
python3 -m venv .venv-icon
.venv-icon/bin/pip install -r scripts/lib/icon-requirements.txt
ICON_PYTHON=.venv-icon/bin/python NODE_OPTIONS=--max-old-space-size=6144 pnpm run build:model icon-eu
node scripts/build-icon.mjs --output data --validate-only
node scripts/merge-soaring-regions.mjs --output data
node scripts/write-runs-index.mjs --output data
```

Use Python 3.11–3.13; CI uses 3.12. A full build has taken roughly 12 GB of downloads and 40 minutes. Native fields are cached under `.soaring-cache/icon-eu`, so subsequent work can reuse them.

Run selection waits for mixing height (`MH`) through the requested horizon as well as native, precipitation and flux fields. DWD can publish mixing height later; until it arrives, the builder selects the preceding complete main run. Transfer errors include the upstream field URL for diagnosis.

To investigate a few hours from a particular run, use `node scripts/build-icon.mjs --reference-time ISO --hours 1,2,3 --output TRIAL_DIR` with the same environment settings. Write the trial to a separate directory: production validation requires the complete 78-hour horizon.

### Native data and terrain

The roughly 6.5 km grid smooths narrow ridges and valleys. Levels 45–74 carry pressure in hPa, height in metres MSL, temperature and dew point in °C, and wind in m/s and degrees true. Full-level height is the mean of the bounding HHL interfaces. Flux and precipitation normalization follows the source intervals; missing vertical velocity remains unavailable.

Copernicus GLO-90 supplies launch elevations independently of model terrain. Model parcels and surface fields still use model terrain. The [Armenian catalogue notes](../scripts/data/ARMENIA.md) explain why source-reported elevations are not substituted for these measurements.

DWD artifacts include `site-context-armenia.json`. During publication, its measurements are compared with the retained terrain by site, source policy and measurement time. Newer matching measurements are kept, and the fragment is removed after a successful merge.

### Regional bundles

The Armenian regional case is `armenia-icon-eu-live`, using `Asia/Yerevan` (UTC+4). Its bundle separates compressed scalar map hours from `cell-{index}.json.gz` profiles. The browser fetches a profile when a cell is selected, verifies its grid, model, run and valid times, and caches eight cells.

Map soundings retain native pressure levels and read the same published lift diagnostics as point profiles. Replay accepts ICON's `levelsByModel` arrays as well as the HRRR/RRFS `levelsByPressure` representation.

## Pages delivery

Provider workflows share the [refresh setup](../../.github/workflows/refresh-provider.yml) but run independently. Each completed refresh triggers the serialized [Pages publisher](../../.github/workflows/pages.yml). A slow provider can therefore leave its older forecast in place while other completed products publish. Code pushes also collect the latest compatible artifacts.

Refreshes dispatched by `GITHUB_TOKEN` explicitly request publication after uploading their artifact because GitHub [suppresses their automatic follow-up events](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs). Uploaded artifacts can publish while the provider finishes runner cleanup, including when acquisition failed and older products were retained.

To request a refresh and publication:

```sh
gh workflow run pages.yml --repo jdorrance/windgrams --ref main -f refresh=rrfs
```

The `refresh` choices are `all`, `rrfs`, `icon-eu` and `none`. Choose `none` to publish completed artifacts without requesting another refresh. Add `-f dry_run=true` to prepare and validate the candidate dataset without deployment. GitHub can dispatch a new workflow only after that file exists on `main`.

### Schedule troubleshooting

The provider schedules use UTC. Check the provider workflow's scheduled runs separately from Pages: a successful publication can contain retained forecasts. Compare the expected cron time with the run's `created_at`, then compare that with the job's `started_at`. A missing run or late creation points to event delivery; a created run waiting for a job points to runner or concurrency queues. Errors after a job starts belong to the refresh itself.

GitHub documents that [scheduled events can be delayed or dropped](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule). The hourly served-data monitor uses the same scheduler, so it cannot independently detect a scheduler outage. Use the manual dispatch above for recovery; verify new model initialization times and refresh health before treating publication as a successful refresh.

### Publication and retention

For a local rehearsal with downloaded artifacts in `../incoming`:

```sh
node scripts/prepare-publication.mjs --incoming ../incoming --output data --dry-run
```

The collector considers the latest 20 runs per provider, accepting completed uploads from repository-owned `main` workflows with compatible source, format and diagnostic method. A run still in progress is eligible only once its artifact is available; this keeps concurrent publication requests from losing an upload while the provider finishes cleanup. Following an unsuccessful or unfinished run, it keeps that artifact and an earlier successful artifact as separate candidates, applying them oldest first by run ID. A failed attempt can thus supply useful completed products without erasing the record of the failure.

Complete newer products replace their retained counterparts. Older runs, partial profiles and invalid bundles leave the prior product in place. If a cached model itself is invalid, publication removes it from the prepared dataset and reports it unavailable while healthy models continue. An invalid regional pointer is removed from active catalogues; its immutable bundle files remain for diagnosis.

Preparation works in a temporary copy of the forecast products. If no point model is complete, or terrain validation fails, the original dataset is unchanged. Sunlight and scratch caches are transferred without copying their bytes. A dry run performs the same preparation and checks, then discards the temporary result.

Seeding checks immutable files against SHA-256 hashes. Pages keeps each active regional case's current and previous bundle, plus historical cases. Packaging compacts ordinary JSON, preserves bundle bytes and reports size by product. It warns at 800 MB and stops at 1 GB. Forecast history stays in provider artifacts and caches rather than Pages; see [history retention](../verification/README.md#source-columns-and-retention). Refresh artifacts expire after two days, with the published dataset and saved cache providing the fallback.

### Site and data locations

The `WINDGRAMS_SITE` and `WINDGRAMS_BASE` repository variables override the site URL and path. `WINDGRAMS_DATA_BASE` selects a separate data origin; the build passes it to `PUBLIC_WINDGRAMS_DATA_BASE`. That origin must allow browser requests and use appropriate cache rules for mutable indexes and immutable bundles.

Scripts with `--publish` or `--sync` select a store through `WINDGRAMS_STORE`. The default file store uses `WINDGRAMS_DATA_DIR` as its root. Additional stores are registered in [`lib/store.mjs`](../scripts/lib/store.mjs).

## Launch catalogue

```sh
node scripts/import-flyingsites.mjs
```

The importer merges US and Armenian records into `sites.json` and `web/src/data/launches.json`. `--country=am` uses the bundled Armenian source; `--country=us` reads the adjacent `flyingsites/data/us.geojson.json`. `FLYINGSITES_US` and `FLYINGSITES_AM` override those inputs.

Imports add missing records and metadata while preserving existing coordinates, notes, wind settings and other countries. Apply deliberate corrections and removals directly to the retained records. The [Armenian source notes](../scripts/data/ARMENIA.md) explain the coordinate choices, exclusions and licences.

## Refresh health

`run-provider.mjs --group GROUP --output data` records each model's attempt in `health/GROUP.json`, including its outcome and last successful refresh. Groups are `noaa-cloud`, `eccc`, `rrfs` and `dwd`; DWD runs the native ICON builder. Attempt times are separate from forecast initialization times. If a process is terminated, its attempt remains `running`, while successfully completed sibling models can still publish.

Any model acquisition failure makes the refresh command exit unsuccessfully, including when a valid older forecast is retained. Other models still finish, and the workflow still packs their results and health records for publication. An already-current forecast that passes validation is successful.

The [health helper](../scripts/lib/provider-health.mjs) validates these records and merges them by attempt time, independently of which forecast run publication accepts.

Check the public dataset with:

```sh
node scripts/monitor-served.mjs --from https://jdorrance.github.io/windgrams/data
```

The monitor exits unsuccessfully for delayed, stale, expired or inconsistent products; failed refreshes; missing health records; and missing or invalid served documents. It reads a representative profile for each configured model, every active regional pointer and profile, and the first and last map hours of each regional horizon. These probes check what the website can actually fetch; full build validation checks the complete dataset before upload.

Freshness limits come from model cadence, as they do in the UI. An unfinished attempt is allowed one run interval; a completed refresh must be within three intervals plus lag. Reads are limited to 32 MiB with a 10-second timeout and HTTP retries. Use `--now ISO_UTC` to repeat an investigation with a fixed clock.
