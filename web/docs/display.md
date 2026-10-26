# Charts and controls

The website displays published forecasts in windgrams, soundings and regional
maps. These views share location, model and time selection, with unit conversion
applied when values are displayed. See the [website README](../README.md) for
local development and the [windgram package](../../packages/windgram/README.md)
for the renderer's API.

Lead pilot-facing copy with the reading, units and time. Use short labels and the
caveat needed to interpret them; keep formulas and implementation details in the
[calculation reference](../../docs/forecast-improvement-plan.md).

## Data and selection

The country selector remembers the choice for the session and accepts
`?country=AM`. Armenian pages use `Asia/Yerevan`, select ICON-EU first and offer
available global models. US pages also show NWS forecasts and balloon soundings.
Launch directions and wind limits can be `null`; the chart then omits their bands
and direction-comparison marks. Admin fields accept blanks and retain stored values when
units change.

Launch readings name the model surface wind (10 m above model ground), model
terrain and launch elevation, and their signed difference. Saved direction and
speed comparisons use this model wind; they do not establish launch suitability.
A triangle means inside the saved direction window, a circle means outside, and
`?` means missing or light/calm wind. Missing speed, direction or gust remains
unknown. Nearby station observations retain their own location and time.

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
Live forecasts also show a fixed warning when their latest recorded refresh failed,
even if the forecast's age is still current. Refresh health does not change run age;
operator error details are not shown. Historical forecasts ignore current refresh health.

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
Physical interpolation starts at the published measurement height: 2 m above
model ground for temperature and moisture, and 10 m for wind. It does not extend
below the lowest measurement. Surface row positions remain a display layout;
they do not move these measurements to ground or launch elevation.

Hovering or tapping an hour shows AGL and MSL at the blue lift line. Arrow keys
change the hour; Escape or a tap outside clears inspection. The marker is hidden
when the ceiling is missing or outside the view. AGL is measured from launch terrain
where available, otherwise from model terrain, as labelled in the readout. This
reference stays the same in focused and full-height views.

The readout shows temperature, wind, dew point, RH and vertical motion (omega,
Pa/s; negative means ascent), plus surface weather and cloud limits. **Inspect any height**
follows pointer altitude. Up/down moves 100 m; left/right keeps the height.
Surface weather stays available when lift is missing. Published 80 m AGL wind
participates in interpolation. For models with declared omega levels,
availability requires three valid levels in view.

CAPE/CIN names its parcel basis or shows “unspecified”. Published V2 layer mean
wind, top wind and surface-to-top vector shear keep their values at every cursor
height. Native model cloud heights, LCL, LFC and equilibrium level have their own
labels. Shear at the cursor uses the surrounding native wind measurements, with
m/s per kilometre and both MSL bounds. Missing or duplicate wind nodes leave
interpolation and shear unavailable.

### Layers and symbols

Background lapse-rate colours follow [WxToFly](http://wxtofly.net/windgramexplain.html).
Smooth boundaries interpolate between layer centres and forecast hours. The
underlying lapse rates remain layer averages; inversions and missing-data
boundaries keep their source heights.

Diagonal hatching shows model cloud, white crosshatching shows RH above 94%, and
clouds with dashed outlines show potential surface LCL in V2; solid outlines
show the legacy/V1 effective cloud limit. A teal dashed
line shows the V2 effective cloud limit where it differs from surface LCL.
Each connected temperature contour gets one label where space permits.
Paraglider symbols use `hcritWxtoflyM`, the ceiling for
225 ft/min sink; the blue line uses `usableLiftTopV2M`, the ceiling for 1 m/s sink.
Missing estimates leave the corresponding marks empty. **Strongest thermals**
selects the day's highest published w*.
The amber dashed line is **Thermal top (parcel)**. It must not be labelled as the
native model boundary-layer depth, which remains a separate regional reading.

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

Skew-T shading compares the plotted temperatures. Parcel buoyancy also accounts
for moisture when available. Incomplete balloon or SRG humidity gives a dry
estimate with no cloud-base marker. Legacy SRG height
and wind decoding precision is retained; displayed wind barbs use the shared unit
conversion.
The model sounding plots surface temperature/moisture at 2 m and wind at 10 m
above model ground. Parcel initialization retains its ground-based calculation
convention. Supplied model surface pressure takes precedence over the labelled
hypsometric fallback. The experimental free-air wind estimate at launch elevation uses adjacent valid
wind nodes; missing or duplicate nodes break interpolation. It is distinct from
the model surface wind (10 m above model ground) and does not resolve
local terrain flow or gusts.

Page owners release chart observers, station polling and sunlight graphics on final
departure. Back/forward-cache suspension pauses playback and polling without destroying
the retained view. Pending reads are aborted on disposal and cannot mount late graphics.
