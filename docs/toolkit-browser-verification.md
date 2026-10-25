# Browser verification

Manual checks in Chrome on October 25, 2026 used a local production build with
retained Dog/GFS and North Sound/Blanchard forecasts.

## Layout and interaction

At a 390 × 844 phone viewport, the chart measured 356 × 379 px and the page stayed
within the 390 px width. Reducing viewport height to 650 px left chart height and
hour selection unchanged. At 1280 × 900, both pages showed centred 800 × 704 px
charts.

Changing the hour updated the chart, sounding and URL; the regional map followed
its selected hour. Full height changed the altitude range while preserving chart
dimensions and selection. Switching to metric updated the chart, legend, inspector
and sounding.

Keyboard selection moved to 2 PM with Arrow Left. The inspector showed 569 m AGL
and 1,214 m MSL, consistent with the saved 645.5 m launch elevation after rounding.
About-page disclosures worked with both pointer and keyboard input, and the
launch chart guide linked to the shared reference.

## Rendering

Both charts loaded their external stylesheets. Lift headings used Arial/Helvetica
at 14 px with colour `rgb(255, 255, 124)`; wind-barb strokes measured 1.1 px. The
session recorded no console errors.

Screenshots were inspected during the checks; this record retains the measurements.
See [refactor verification](toolkit-verification.md) for the numerical comparisons
and automated browser results.
