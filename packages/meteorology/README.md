# @windgrams/meteorology

Thermodynamic, wind and solar calculations for weather profiles. The functions
work with numbers and atmospheric levels, so they can run in browsers, servers
or offline processing jobs.

```ts
import { parcelLclAglM } from '@windgrams/meteorology';
import { sunPosition } from '@windgrams/meteorology/sun';

const cloudBaseAglM = parcelLclAglM(20, 12);
const sun = sunPosition(Date.parse('2026-10-25T18:00:00Z'), 48.609, -122.424);
console.log(cloudBaseAglM, sun.elevationDeg);
```

The root module includes parcel and mixed-layer lifting condensation levels
(LCL), dew point from mixing ratio, geometric vertical velocity, surface pressure
and boundary-layer wind. Use °C, hPa, m/s and metres MSL unless the field or
function specifies otherwise. `parcelLclAglM` returns metres above ground.
Wind directions indicate where the wind comes from, clockwise from true north.

The [thermodynamic functions](src/thermodynamics.ts) document their missing-input
behavior. In particular, surface pressure falls back to 1013.25 hPa when its
inputs are missing, and dew point from mixing ratio falls back to −60 °C for
invalid or nonpositive inputs. Other calculations may return `null`.
Pressure/vertical-velocity conversions use dry-air density; humidity is not an
input to these helpers. Preserve the matching inverse when converting native
geometric vertical velocity. The pressure fallback is a compatibility estimate,
not a terrain-dependent standard atmosphere or a measured surface pressure.
[`computeBoundaryLayerWind`](src/boundary-layer-wind.ts) interpolates the layer
boundaries and averages wind components by height.
[`sampleWindAtHeight`](src/wind-sampling.ts) samples adjacent wind nodes at their
physical MSL heights. It returns the bracket or an explicit unavailable reason;
missing winds and duplicate heights block interpolation, and it never extrapolates.
Zero speed remains calm even without a direction.

The [`/sun` module](src/sun.ts) provides solar position, refraction, a sun vector
and sunrise/sunset times. It accepts UTC epoch milliseconds and coordinates in
degrees. Sunrise/sunset returns `null` when both crossings do not occur in the
requested interval, with sunrise before sunset. The search brackets solar maxima
and minima as well as ordinary crossings, including short polar daylight or night
intervals; it does not model a terrain horizon. Invalid intervals, including
times outside JavaScript's date range, return `null`.
Physical constants and lower-level calculations are available
from `@windgrams/meteorology/thermodynamics`; shared input types are exported from
the [root module](src/index.ts).
