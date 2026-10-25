# @windgrams/soaring

Calculate thermal strength, usable lift ceilings, cloud levels and layer wind
from an atmospheric column. The calculations run in browsers and Node.

For a convective velocity estimate, supply the surface conditions and the depth
of the convective layer:

```ts
import { computeThermalVelocityMps } from '@windgrams/soaring';

const thermalVelocityMps = computeThermalVelocityMps({
  surfaceTemperatureC: 20,
  surfaceDewPointC: 12,
  sensibleHeatFluxWm2: 150,
  latentHeatFluxWm2: 80,
  boundaryLayerDepthM: 1200,
  surfacePressureHpa: 950,
});
```

Heat fluxes are positive upward in W/m². Temperatures are °C, pressure is hPa
and wind speed is m/s. Layer depths are metres AGL; elevations and calculated
ceilings are metres MSL.

[`deriveDiagnosticsV2`](src/diagnostics.ts) combines the calculations for a full
column, using model elevation and the baseline cloud cap. Validate external
columns with [`parseAtmosphericColumn`](../contracts/README.md) first. The
function returns `null` when essential inputs are missing or fewer than three
levels lie more than 20 m above model terrain. Individual diagnostic fields can
also be `null` when unavailable.

The outputs include separate ceilings for 1 m/s and 1.143 m/s sink rates.
[`SOARING_CONTRACT_VERSION`](src/index.ts) identifies the diagnostic method;
the [scientific notes](../../docs/forecast-improvement-plan.md) explain its
assumptions and limitations. Experimental launch-height wind interpolation
requires levels bracketing the launch elevation and leaves published MSL cloud
and lift heights unchanged.

## Working with published profiles

[`@windgrams/soaring/compatibility`](src/compatibility.ts) postprocesses existing
point profiles and supports sparse NWS/ECMWF documents, ensemble members and
cross-model summaries. Ensemble diagnostics are calculated per member before
percentiles are aggregated. The [public types](src/types.ts) describe all
diagnostic fields.
