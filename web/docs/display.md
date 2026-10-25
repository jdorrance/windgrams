# Charts and controls

The website displays published forecasts in windgrams, soundings and regional
maps. These views share location, model and time selection, with unit conversion
applied when values are displayed. See the [website README](../README.md) for
local development and the [windgram package](../../packages/windgram/README.md)
for the renderer's API.

## Data and selection

The country selector remembers the choice for the session and accepts
`?country=AM`. Armenian pages use `Asia/Yerevan`, select ICON-EU first and offer
available global models. US pages also show NWS forecasts and balloon soundings.
Launch directions and wind limits can be `null`; the chart then omits their bands
and suitability marks. Admin fields accept blanks and retain stored values when
units change.

`/soaring/?region=armenia` selects `armenia-icon-eu-live`. Regional maps load
compressed hourly fields from [published bundles](../../forecasts/docs/operations.md#regional-bundles)
and fetch profiles as cells are selected. The client checks grid, run and time
identity and caches eight cells. Switching models keeps the location and matching
time. The slider covers the published horizon, while the windgram shows daylight
for the selected local date. Layers with no finite values are omitted.

Notices beside the main controls identify delayed, old, ended or mismatched
forecasts. The [freshness check](../../packages/data-client/src/freshness.ts) uses
the model's update schedule, run time and last forecast hour. It runs again when
a time threshold passes or the tab resumes. Archived cases are labelled historical;
missing timestamps or update intervals produce an unknown-age notice. Forecast
details show the run and publication times.

## Units

Imperial is the default. The header toggle saves the preference in local storage,
with session storage and a `units` URL parameter as fallbacks. An explicit URL
preference takes precedence. Switching units reloads the page with the same model,
day, time and location.

- Imperial uses ft, mi, °F, mph, ft/min, in, in/h and inHg, with lapse rate in °F/1,000 ft.
- Metric uses m, km, °C, km/h, m/s, mm, mm/h and hPa, with lapse rate in °C/km.
- CAPE stays in J/kg, radiation in W/m² and smoke in µg/m³. NWS bulletins retain their original units.

The [shared formatters](../../packages/windgram/README.md) convert display values;
[the app unit module](../src/lib/units.ts) saves preferences. Data and calculations
retain their source units. Temperature differences use scale conversion only.
Launch wind limits are stored in mph. Metric edits convert on save, while unchanged
values retain their original precision.

## Windgram

### Framing and inspection

Single-day charts span sunrise to sunset, with hatching for missing daylight hours.
Polar days and nights, undated data wholly outside daylight, and multi-day inputs
use the supplied hours. The toolbar shows three days and a model picker; later
dates are available by swiping. The info icon opens date, time-zone and run details,
and hour controls sit below the chart.

Chart height is calculated from width, so scrolling or browser toolbar movement
leaves it fixed. Rotation or a container-width change resizes the chart. Desktop
shows the full height range.

On mobile, the focused view starts at the higher of launch and model terrain. Its
upper limit follows the lift ceilings, including ensemble p75, with at least
500 m of headroom and 1,000 m above model terrain, capped at the highest available
level. Missing lift estimates show the upper profile; zero w* selects the lower
layer. **Full height** expands the altitude range. Surface rows continue to show
model-surface values.

Hovering or tapping an hour shows AGL and MSL at the blue lift line. Arrow keys
change the hour; Escape or a tap outside clears inspection. The marker is hidden
when the ceiling is missing or outside the view. AGL is measured from launch terrain
where available, otherwise from model terrain, as labelled in the readout. This
reference stays the same in focused and full-height views.

### Layers and symbols

Background lapse-rate colours follow [WxToFly](http://wxtofly.net/windgramexplain.html).
Smooth boundaries interpolate between layer centres and forecast hours. The
underlying lapse rates remain layer averages; inversions and missing-data
boundaries keep their source heights.

Diagonal hatching shows model cloud, white crosshatching shows RH above 94%, and
outlined clouds show potential LCL. Each connected temperature contour gets one
label where space permits. Paraglider symbols use `hcritWxtoflyM`, the ceiling for
225 ft/min sink; the blue line uses `usableLiftTopV2M`, the ceiling for 1 m/s sink.
Missing estimates leave the corresponding marks empty. **Strongest thermals**
selects the day's highest published w*.

Wind-barb staffs point toward the wind's source, following
[NWS conventions](https://www.weather.gov/hfo/windbarbinfo). Half feathers, full
feathers and pennants represent 5, 10 and 50 kt in Imperial, or 2.5, 5 and 25 m/s
in Metric. Speeds round to the half-feather increment; calm winds use a circle.

Chart heights are MSL. ICON soundings keep native pressure levels; their windgram
axis uses median heights at fixed isobars. Balloon observations show local time
zone and UTC cycle. Regional views, windgrams and model soundings read the same
published diagnostics. The [calculation reference](../../docs/forecast-improvement-plan.md)
explains those values; [visual QA](../test/fixtures/windgram-visual/README.md) covers
rendering regressions.
