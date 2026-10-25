# Forecast evaluation and development

The next scientific questions are how well the published forecasts describe observed wind and thermals, where their errors are systematic, and whether a higher-resolution regional model improves useful guidance. Answering them requires forecasts saved before the observations arrive, enough independent weather days, and comparisons separated by lead time and weather regime.

Use [issued-history evaluation](../forecasts/verification/README.md) to score archived forecasts against supplied soundings. The [diagnostic reference](forecast-improvement-plan.md) describes the quantities being evaluated.

## Forecast coverage

The operator builds HRRR, HRDPS, RRFS, RDPS, GFS, GDPS and GEPS point forecasts within their configured coverage, plus ICON-EU for Armenian launches. NWS and balloon soundings provide US context; the ECMWF adapter supplies additional surface and upper-air guidance.

North Sound and Shenandoah–Blue Ridge have native HRRR/RRFS maps, and Armenia has an ICON-EU map. These views share forecast-hour and location selection with the windgram, sounding and terrain cross-section. The other regional entries currently support point comparisons.

The [region configuration](../forecasts/soaring/regions.json) lists enabled models and publication settings. Build commands are in [regional operations](../forecasts/soaring/README.md); the [North Sound replay](soaring-replay.md) provides a fixed numerical example.

## Evaluation backlog

The retained comparison report covers eight near-initialization comparisons using three station observation times on one date. Comparisons that share a sounding also share the same atmospheric evidence. The sample is useful for checking matching and scoring, but too narrow to estimate performance across seasons, terrain or weather regimes.

Collect a prospective sample spanning warm-season thermals, marine intrusions, inversions, strong winds and different terrain exposures. Summaries should keep exact-time errors, near-initialization comparisons and cross-model spread separate. Report each metric's usable sample count and independent station-days, since temperature, dew point and wind can have different missing data.

The archive retains 120 rolling runs plus pinned cases—about 30 days at four successful cycles per day. Its ordinary records preserve issued values for scoring. Full source columns must be retained separately for studies that recalculate diagnostics under a proposed method change.

Method 2.2.0 corrects the numerical near-neutral zero-depth cliff and missing-input behavior; the [method-change evidence](refactor-plan.md#method-220-parcel-depth-and-missing-inputs) records analytic tests, archived comparisons and the remaining physical closure boundary. Further atmospheric levels, regional maps, pressure-gradient views and run comparisons should be chosen according to the errors they help explain and the cost of acquiring and serving their data.

## Experimental WRF work

[`forecasts/wrf/`](../forecasts/wrf/) contains a North Sound configuration with a 3 km parent domain and a 1 km nest. The runner's default mode estimates the work involved. Running the integration requires WRF/WPS executables, geographic inputs and forcing data. Runtime and cost must be measured from completed integrations.

The proposed criteria for operational WRF use are 30 independent evaluation days, at least 10% lower daytime wind-vector error than HRRR, stable cloud-base and hazardous-wind performance, and delivery before the regional morning deadline on at least 95% of days. These targets still need measured evidence. Compare both atmospheric performance and delivery reliability before deciding whether the nest merits routine operation.

## References

- [WxToFly guide](http://wxtofly.net/windgramexplain.html): windgram display scale and the 225 ft/min threshold.
- [DrJack parameters](http://www.drjack.info/RASP/INFO/parameters.html): RASP quantities for comparison with the parcel estimates used here.
- [UCAR WPS guidance](https://www2.mmm.ucar.edu/wrf/users/namelist_best_prac_wps.html): nesting and domain setup.
- [NWS RRFS transition notice](https://www.weather.gov/media/notification/pdf_2026/scn26-048_Updated_RRFS_and_REFS_Implementation.aaf.pdf): the source notice consulted for the October 2026 integration.
