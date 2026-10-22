# Plan to rival WxToFly's soaring information

Prepared October 22, 2026 against repository commit `dd1223e`, installed `@azohra/meteo.forecast` 0.6.0 and `@azohra/meteo.briefing` 0.6.2. All four phases of the local implementation—Phase 0 baseline/inventory/history archive (`forecasts/verification/`), Phase 1 v2 soaring diagnostics (`forecasts/soaring/`), Phase 2 regional 22-layer map, arbitrary-point soundings, multi-launch table, and terrain cross-section (`web/src/pages/soaring.astro`, `web/src/scripts/soaring.ts`, `forecasts/scripts/publish-soaring.mjs`), and Phase 3/4 1 km WRF-ARW pilot harness (`forecasts/wrf/`) plus multi-model/RAOB verification—are now implemented and built against the local datasets; see [replay commands, outputs, and audit](soaring-replay.md).

Build regional soaring products from the operational models first, then add a measured 1 km WRF forecast for terrain-sensitive areas. Success means pilots can inspect lift, clouds, wind, convergence, and changing conditions across a flying area, with enough observations and forecast history to judge reliability. Higher resolution alone is not evidence of better forecasts.

## Where the earlier proposal landed

The earlier proposal is saved outside the repository at `/Users/johndorrance/.cursor/plans/rasp_soaring_models_e4ca7396.plan.md`. Its three tasks—WRF prototype, profile publishing, and comparison with HRRR—were pending when this plan was prepared. At that point the checkout had no WRF runner, RASP postprocessor, or regional soaring-grid publisher, and no matching implementation commit appeared in the locally available Git history. The subsequent first milestone adds regional HRRR replay; WRF/RASP execution remains future work.

This document supersedes that proposal as the repository's implementation plan. The important corrections are:

- The installed forecast engine is JavaScript/TypeScript. Its `deriveHour` computes thermal depth from a dry parcel crossing the sampled temperature profile; the separately retained model `surface.pblHeightM` is not used for that calculation. DrJack explicitly distinguishes RASP's turbulence-based boundary-layer top from a TI=0 estimate. Existing field names therefore do not establish scientific equivalence. [DrJack parameter definitions](http://www.drjack.info/RASP/INFO/parameters.html)
- The actual local HRRR catalogue has **nine** pressure levels, 925–600 hPa, and already includes pressure-coordinate vertical velocity. Terrain masking can leave fewer levels. The work is to retain a much denser vertical profile and spatial fields, and define how to use them.
- The current cloud-base field combines a surface LCL estimate with the first nearly saturated layer. Preserve separate physical quantities in the new products. The current usable-lift calculation defaults to a 1.0 m/s sink threshold; WxToFly's windgram explanation specifies 225 ft/min, approximately 1.14 m/s. Match thresholds and altitude references when comparing. [WxToFly windgram explanation](http://wxtofly.net/windgramexplain.html)
- The catalogue contains 75 western sites and 10 eastern sites; the eastern sites are six in Virginia and four in North Carolina. Blanchard and Bingen are in different regions and should not be the two test sites for one small nest.
- Regional maps are an early deliverable. A pair of improved point forecasts does not reproduce the information pilots get from WxToFly's maps.
- The earlier runtime and monthly-cost claims were not benchmarks. Measure the chosen domain before budgeting operational WRF.

## What we need to match

I inspected WxToFly's public PNW navigation, windgram viewer, windgram explanation, and map/point parameter lists. These establish the advertised products, not the freshness of every image or the currently running WRF configuration. Sources: [PNW viewer](http://wxtofly.net/RASP/PNW/index.html), [map parameters](http://wxtofly.net/scripts/param_array.js), [point parameters](http://wxtofly.net/v2/js/blipspotParam.js).

The product checklist is:

- **Thermal opportunity:** W*, boundary-layer top and depth, dry usable-lift height, cloud-limited height, surface heating, and a clearly labelled sensitivity estimate for thermal height.
- **Winds through the flying layer:** 10 m wind, low-level wind at actual available heights, boundary-layer mean and top wind, and vector shear. Keep any buoyancy/shear diagnostic tied to a documented definition.
- **Clouds and precipitation:** surface LCL, cumulus potential, mixed-layer condensation level, overcast-development potential, model cloud information, and hourly rain. Overcast development is a cloud-coverage diagnostic; it is not a thunderstorm probability. CAPE/CIN and precipitation are separate information.
- **Lift patterns across terrain:** signed boundary-layer vertical motion, its height, pressure-level vertical motion with horizontal winds, and regional animation. A horizontal convergence field in s⁻¹ and vertical velocity in m/s must have different names and legends.
- **Ways to inspect it:** point windgrams, detailed hourly soundings, map inspection at arbitrary coordinates, and vertical cross-sections through a ridge or route.
- **Reality checks:** nearby station trends, pressure differences across meaningful station pairs, radar/satellite, webcam links, forecast discussions, and previous runs.

Windgrams already has point windgrams, annotated Skew-Ts, model selection, NWS guidance/discussions, balloon observations, station integration, terrain, and sunlight code. Retain those interfaces and add the missing regional information. Existing station support still depends on its provider configuration, and the Pages workflow explicitly omits sunlight tiles; source code availability is not proof that every production feature is operating.

## Phase 0 — establish the baseline and preserve evidence

**Estimate: 2–3 engineering days.** Start with North Sound/Blanchard as the regional pilot, while retaining operational-model point coverage for the full catalogue. Expand to Tiger, the Gorge, the east Cascades, and VA/NC in that order unless usage suggests a different priority.

1. Inventory actual provider records and published profiles: field, unit, AGL/MSL reference, vertical coordinate, time averaging, run availability, grid footprint, and missing-data behavior. Compare the installed implementation with DrJack's definitions; record deliberate differences.
2. Archive selected source fields, forecasts as originally issued, and observations. The current build uses `--no-history`; preserving just the latest profiles cannot support verification. Use immutable model/run keys, a bounded rolling archive, and permanently retain selected case days and compact scores.
3. Choose 10–20 historical case days covering blue thermals, marine cloud, sea breeze, strong gradient winds, convergence, and poor soaring. Hold out cases before tuning; add prospective runs as they arrive. Include terrain-elevation mismatch and station exposure in the case notes.
4. Audit feed lifecycle metadata. The local catalogue's NAM retirement date is October 6, 2026; NWS's updated notice schedules the NAM-to-RRFS transition for **November 3, 2026**, subject to operational delays. Verify actual products and update through source configuration/package releases; do not build a new dependency on NAM. [NWS updated notice](https://forecast.weather.gov/product.php?format=CI&glossary=1&issuedby=WSH&product=PNS&site=AFC&version=5)

**Acceptance:** a reproducible baseline report identifies which values are directly modelled, derived, approximated, or unavailable; archived forecasts and observations can be replayed by run and valid time. No synthetic development profile is treated as meteorological evidence.

## Phase 1 — improve the data and soaring diagnostics

**Estimate: 1–2 weeks, dependent on feed access and scientific review.**

Use HRRR as the initial source and HRDPS continental as an independent comparison where covered. Inventory and decode HRRR native/hybrid-level fields, including pressure, temperature, moisture, geopotential/height, wind, and vertical motion. Confirm which fields are actually distributed; model internals are not a promise about public output. Retain sufficient upper-air depth for cloud and wave inspection, and flag profiles that end before a diagnostic can be determined. Use denser pressure-level data as an explicitly labelled intermediate fallback if native ingestion takes longer.

Keep surface sensible/latent heat flux, model PBL height, surface pressure, cloud fields, precipitation, CAPE/CIN, and terrain alongside the profile. Compute diagnostics once on the canonical numerical fields; site profiles and map values must sample those same results.

Define and version the diagnostic contract:

- Keep model PBL top, parcel-derived thermal top, dry Hcrit, and cloud-limited usable height distinct. Record the chosen method and sink threshold. W* is an air-motion scale, not a guaranteed net glider climb rate.
- Preserve surface LCL, mixed-layer condensation level, and explicitly predicted cloud base separately. Publish cumulus/overcast potential only with their required inputs; never turn a missing input into zero or silently replace it with another cloud measure.
- Derive boundary-layer mean wind by averaging components through the layer with documented weighting. Sample BL-top wind and low-level wind only within supported vertical coverage.
- Normalize upward velocity to a consistent sign/unit. Where conversion from omega is justified, use local pressure, temperature, and density; do not treat Pa/s as m/s. Sparse pressure-level maxima are not equivalent to full boundary-layer extrema. Publish adequate-coverage flags and separate positive/negative extrema.
- Compute horizontal convergence on the native grid with appropriate map metrics and wind rotation before display reprojection. Do not infer a regional convergence map by interpolating the launch forecasts.

Audit the existing `hrdps-west` builder as a possible additional source before buying fine-grid compute. It is not enabled in the current scheduled model group. Check its actual footprint against launch coordinates and its current files; ECCC describes it as primarily BC/western Alberta, so PNW coverage cannot be assumed. ECCC also announces removal of this experimental feed in fall 2027. It is an optional comparison, not the long-term foundation. [ECCC product documentation](https://eccc-msc.github.io/open-data/msc-data/nwp_hrdps/readme_hrdps-datamart-alpha_en/), [ECCC removal announcement](https://comm.collab.science.gc.ca/mailman3/hyperkitty/list/dd_info@comm.collab.science.gc.ca/2026/8/)

**Acceptance:** selected real cases survive independent unit/sign checks, terrain masking, null handling, and diagnostic reference comparisons. The UI explains material differences from its previous values. Science changes live in owned source or a pinned upstream release, never edits to `node_modules`.

## Phase 2 — deliver regional maps and a useful forecast workflow

**Estimate: 2–3 weeks after the first numerical fields are available.** This is the first release that materially closes the gap with WxToFly.

Start with hourly North Sound grids and a 48-hour operational-model horizon where available. Add these map layers first: usable-lift top, W*, cumulus base/potential, 10 m and BL-mean winds, signed vertical motion, cloud cover, and rain. Follow with overcast potential, BL-top wind/shear, heating, and pressure-level wind/vertical motion. Expand regional coverage from the same pipeline after measuring data volume.

Add a model selector, local-time slider, animation, units/legends, domain boundary, and run/valid-time labels. Tapping a point returns numerical values and a sounding/windgram for that coordinate. Provide a concise hourly site table for pilots comparing launch windows, wind, lift ceiling, cloud base, and convergence.

Use the existing MapLibre setup. Publish display tiles and separately sampleable numerical data from the same canonical grid, with identical masks and interpolation rules. Do not recover numerical values from colored images. For arbitrary-point soundings, use bounded regional profile chunks or a cached sampling endpoint; decide with a measured browser/download benchmark before committing to a large 3-D delivery format.

Publish weather data independently of the static HTML deployment using the existing store abstraction and an object-storage provider. Keep raw GRIB/WRF files and large archives off the Pages artifact. Write an immutable complete run, validate it, then atomically advance its manifest. A failed build leaves the previous run available with its original timestamp and a stale indicator.

The present twice-daily `06:15/18:15 UTC` schedule underuses short-range updates. Initially target complete 00/06/12/18 UTC HRRR runs, driven by source readiness and with a defined timeout. Keep slower products on separate schedules. Target a usable morning forecast by **08:00 in the region's local time**, an afternoon refresh, and a clear indication when that deadline is missed; determine the exact trigger times from measured source latency.

**Acceptance:** a user can compare two launches and their intervening terrain at the same forecast hour, inspect a point, and switch model without losing that valid time. Map and point values agree within documented resampling tolerance. Missing hours/fields remain visibly unavailable. A delayed provider never makes an older forecast appear newly issued.

## Phase 3 — run a bounded 1 km WRF pilot

**Estimate: 2–4 engineering weeks to a repeatable pilot, plus verification time.** Begin once the grid publisher works so the experiment immediately produces both maps and point forecasts.

Use a maintained, pinned WRF-ARW/WPS release in a reproducible Linux image. Prototype a 3 km parent and 1 km child over North Sound, centred to include Blanchard and nearby coastal/inland observation sites. Define the footprint from forcing, terrain, buffer requirements, and representative stations. Add Bingen only with a separate Gorge domain. WRF recommends odd nesting ratios such as 3:1 and adequately large domains with boundaries away from steep terrain. [UCAR nesting guidance](https://www2.mmm.ucar.edu/wrf/users/namelist_best_prac_wps.html)

Prefer HRRR forcing if an end-to-end WPS test confirms complete atmospheric, surface, soil, and time-boundary inputs. This requires preprocessing; an HRRR forecast is not a drop-in WRF restart. If that path fails, use GFS with an appropriately staged parent grid and document the changed baseline. Evaluate RRFS forcing only after verifying product availability and preprocessing support.

Have someone with boundary-layer modelling experience review the PBL/surface-layer/land-surface/microphysics choices. Benchmark a suitable scale-aware PBL option and terrain treatment; copying a scheme name does not reproduce NOAA's assimilation or forecast skill. Use no conventional cumulus parameterization on the 1 km child. Fine grid spacing still does not resolve individual thermals or every launch ridge.

Test a 30–36-hour integration that includes a spin-up interval and a complete local flying day; exclude spin-up from evaluation. Save hourly native-level outputs, terrain, heat fluxes, PBL height, moisture/cloud variables, and signed vertical motion. Start with one morning cycle; add an evening run and longer horizon only if the morning deadline and cost targets hold.

Publish as a clearly identified model such as `wrf-north-sound-1km`, including forcing run, domain, grid spacing, physics configuration/version, and diagnostic version. Continue to show HRRR/HRDPS for comparison and outside the nest.

A second possible route is an agreed data feed from an existing regional operator. During the pilot, assess whether reusable numerical fields, provenance, redistribution permission, and update reliability are available. Do not make scraped forecast images the data foundation. Contacting an operator is a separate action from this plan.

**Acceptance:** rerunning a case produces traceable outputs, correct coverage, and validated point/grid documents. Record end-to-end time, memory, CPU-hours, input/output bytes, and publication latency. The pilot remains experimental until Phase 4 supports promotion.

## Phase 4 — demonstrate skill and complete the regional product

Archive forecasts before their valid time and score matched lead times against observations. Use held-out historical cases plus at least 30 independent prospective case days across relevant regimes; extend the evaluation if weather coverage or observation quality is inadequate. Starting in October means summer thermal skill will need archived warm-season cases and later seasonal validation.

Evaluate surface wind vector/speed errors, gust errors where comparable, temperature/dew-point bias, wind-change timing, observed cloud-base timing/height, and sounding structure. Use airport ceilings and distant balloons only where representative. Pilot/IGC climb and maximum-altitude reports are useful supporting evidence but reflect route choice, sink, and pilot behavior; they are not direct W* or PBL observations.

Set promotion thresholds before tuning. A proposed initial gate is at least a 10% reduction in held-out daytime wind-vector error against HRRR at representative pilot-area stations, with uncertainty reported by independent day, no material worsening of hazardous-wind misses or cloud-base errors, and at least 95% of scheduled morning products delivered by the agreed deadline over 30 days. These are project targets, not universal meteorological standards. If the sample cannot support the claim, keep the experimental label and extend evaluation.

Match any WxToFly comparison by valid time, issue time, units, sink threshold, and height reference. Agreement with another model is context; measured skill comes from observations. Promote benefits per region/regime rather than claiming one model wins everywhere.

Finish the wider product with terrain-following route cross-sections, pressure-gradient charts, region-appropriate observation/radar/satellite links or licensed feeds, webcam links, and run-to-run comparisons. Show model disagreement without calling a few deterministic models a calibrated probability forecast. Expand WRF to Tiger, the Gorge, east Cascades, and VA/NC only when each domain passes its own value/cost test.

## Implementation sequence in this repository

Use small reviewable changes with these intended boundaries:

1. **Evidence and contracts:** add a field inventory, real replay fixtures and observation alignment under a new `forecasts/verification/`; add diagnostic metadata and contract checks. Start forecast-history retention alongside the current publisher.
2. **Numerical worker:** introduce `forecasts/soaring/` for regional ingestion, canonical grids, diagnostics, and point extraction. Use one versioned diagnostic implementation for the new grid and site products; keep science out of browser rendering. Validate required dependencies with a small real run.
3. **Publishing:** add a thin `forecasts/scripts/publish-soaring.mjs` adapter using `forecasts/scripts/lib/store.mjs`. Preserve current profile semantics until an explicit versioned migration; put additional quantities in a versioned soaring sidecar where the current contract cannot represent them.
4. **Model integration:** extend catalogue/contract support, `forecasts/scripts/write-runs-index.mjs`, `forecasts/scripts/seed-published.mjs`, and the hard-coded `MODEL_ORDER` in `web/src/scripts/launch-page.ts`. A custom slug will not automatically appear merely because a JSON file exists. Cover the new model in availability and retention logic.
5. **Regional UI:** add `web/src/pages/soaring.astro` and supporting readers/controls, reusing `web/src/scripts/map.ts`; connect map selection to the existing windgram and sounding views. Add focused consistency and time-navigation tests.
6. **WRF and verification:** add `forecasts/wrf/` with pinned image/configuration, one domain, preprocessing/run/postprocessing commands, and measured resource reporting; feed its output through the same publisher. Keep long numerical runs separate from `.github/workflows/pages.yml`.

Existing point-forecast ingestion can continue on Actions while the regional worker is introduced. Schedule and host the numerical workload where its measured CPU, disk, memory, and deadline requirements fit. No cloud resources are provisioned by this plan.

## Effort, compute, and first milestone

Allow roughly **4–6 engineering weeks** for audited diagnostics and a first useful regional map release, and another **2–4 weeks** for a repeatable WRF pilot, assuming one experienced engineer with meteorological review available. Operational confidence takes additional elapsed verification time; this is a planning estimate, not a delivery commitment.

For WRF, benchmark a candidate 32-vCPU, 64–128 GiB Linux worker with fast local scratch disk; these are trial specifications, not proven requirements. Include input transfer, preprocessing, integration, postprocessing, storage, and retries in the measurement. CPU-hour price alone misses much of the system cost.

Compute cost is `runs/day × node-hours/run × billed node-hour rate × days`, plus storage, requests, and egress. For illustration only, two daily runs taking two node-hours at an assumed $2/node-hour yield $240/month in compute. Neither that rate nor runtime has been established. Use the measured pilot to produce an actual provider quote and spending cap before scheduling it continuously.

The first implementation milestone is a **replayable North Sound HRRR run with audited soaring fields, one regional lift map, and a matching Blanchard profile**. It proves the numerical data path and reveals scientific/contract gaps while leaving a direct integration point for the 1 km model.
