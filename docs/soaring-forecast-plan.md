# Soaring project status

Original plan: October 22, 2026, at commit `dd1223e`. Status reviewed October 24, 2026. This record replaces the earlier phase estimates with the current implementation and remaining work.

## Delivered

- Point forecasts for HRRR, HRDPS, RRFS, RDPS, GFS, GDPS and GEPS in their published coverage; ICON-EU for 40 reviewed Armenian launches. NWS and balloon guidance serve US sites; ECMWF adds global context.
- Native HRRR/RRFS regional maps for North Sound and Shenandoah–Blue Ridge, plus ICON-EU for Armenia; location and forecast-hour selection synchronize the map, windgram and sounding.
- Hourly site comparisons, regional diagnostics and terrain cross-sections from published model data.
- Versioned v2 thermal diagnostics, distinct 1 m/s and 225 ft/min lift ceilings, surface and mixed-layer LCL, layer winds, shear and native-grid convergence.
- Immutable regional bundles, resumable source capture, a 120-run forecast archive and observation-matching utilities.
- Availability probes and separate general, RRFS and ICON-EU refresh schedules.
- A full-day mobile windgram, shared Imperial/Metric preference, WxToFly colors, potential-LCL symbols and RH >94% hatching.

The [diagnostic notes](forecast-improvement-plan.md) describe the calculations and approximations. [Regional operations](../forecasts/soaring/README.md) and the [fixed HRRR replay](soaring-replay.md) provide reproducible commands.

## Experimental work

`forecasts/wrf/` contains North Sound domain settings, namelists and a runner scaffold for a 3 km parent / 1 km nest. The Dockerfile installs dependencies and copies those settings. The default runner writes dry-run estimates; a real integration expects WRF/WPS executables, geographic inputs and forcing to be supplied separately. Runtime, cost and forecast benefit still need measurements from completed integrations.

Additional regional entries identify candidate areas for grid publication. Their point comparisons and configuration are distinct from the three active regional forecast areas.

## Evaluation still to do

The verification code reports sounding matches, errors and forecast spread. The project still needs a sustained prospective record across weather regimes, warm-season thermal cases, and representative terrain exposures. The 120-run retention limit provides about 30 days at four cycles per day; the archive's actual span depends on successful builds.

The original promotion targets remain project goals: at least 30 independent evaluation days, a 10% reduction in daytime wind-vector error against the HRRR baseline, stable cloud-base and hazardous-wind performance, and 95% morning delivery by the regional deadline. Evidence for those targets belongs in measured reports before expanding the WRF experiment.

Potential additions include further native-grid regions, richer atmospheric levels, pressure-gradient views, observation and webcam links, and run-to-run comparisons. Their priority depends on forecast value, data availability and measured operating cost.

## References

- [WxToFly windgram explanation](http://wxtofly.net/windgramexplain.html): display colors, units and 225 ft/min glider threshold.
- [DrJack parameter definitions](http://www.drjack.info/RASP/INFO/parameters.html): RASP diagnostic definitions for comparison with this project's parcel-based estimates.
- [UCAR WPS namelist guidance](https://www2.mmm.ucar.edu/wrf/users/namelist_best_prac_wps.html): nesting and domain setup.
- [NWS RRFS implementation notice](https://www.weather.gov/media/notification/pdf_2026/scn26-048_Updated_RRFS_and_REFS_Implementation.aaf.pdf): transition scheduled for November 3, 2026 in the October 15 update.
