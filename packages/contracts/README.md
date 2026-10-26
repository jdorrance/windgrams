# @windgrams/contracts

Runtime validation and TypeScript types for atmospheric columns, point forecasts
and regional map data. Use this package when reading JSON before passing weather
data to the calculation or chart libraries. It works in browsers and Node.

```ts
import { parseAtmosphericColumn } from '@windgrams/contracts';

const column = parseAtmosphericColumn({
  validAt: '2026-10-25T12:00:00Z',
  temperatureC: 18,
  dewPointC: 10,
  windSpeedMps: 3,
  windDirectionDeg: 240,
  levels: [],
});

if (column === null) throw new Error('Invalid atmospheric column');
```

A valid column may have too few levels for a particular calculation. The
calculation determines which diagnostics it can produce from those levels.

Temperatures are °C, pressures hPa, wind speeds m/s and heights metres MSL.
Boundary-layer depth is metres AGL. Moisture can be supplied as dew point or dew
point depression. Optional measurements can be absent or `null`; zero is a
measurement. The [atmospheric types](src/atmosphere.ts) describe these fields,
along with source runs, native cells and the time interval represented by each
measurement.

## Reading published data

- [`@windgrams/contracts/published-lift`](src/published-lift.ts) parses profile
  JSON and reads published lift, cloud-base and ceiling diagnostics. It preserves
  profile extensions and replaces malformed optional measurements with `null`.
  `surfaceExtensionsSchema` defines the native surface fields retained during publication.
  `publishedLiftFamily(hour)` names the family an hour carries: `'v2'` when
  `hour.soaring` publishes `thermalVelocityV2Mps`, otherwise `'v1-legacy'`, in
  which case `publishedLift` returns the upstream `hour.derived` values from
  `@azohra/meteo.forecast`'s earlier method. Ensemble percentile products (GEPS)
  are always `'v1-legacy'`, because V2 is calculated per member and not for
  percentiles. Readers label each family separately. V2 nulls, including the effective cloud limit,
  stay unavailable. V1 ceilings and surface LCL remain separate readings.
  The V1 method is pinned in several places that
  move together: `LEGACY_FORECAST_VERSION` and the `catalogue-0.6.0.json` /
  `forecast-hours-0.6.0.json` tables in [`@windgrams/providers`](../providers/src/legacy.ts),
  the `@azohra/meteo.forecast` dependency in `packages/providers/package.json` and
  `forecasts/package.json`, the `versions` table in `forecasts/soaring/common.mjs`,
  the vendored `forecasts/soaring/vendor/derive-0.6.0.{mjs,d.mts}` recorded in
  `forecasts/soaring/inventory.mjs`, and [`docs/soaring-replay.md`](../../docs/soaring-replay.md).
- [`@windgrams/contracts/regional`](src/regional.ts) validates regional
  catalogues, manifests, grids, forecast hours and supporting documents.
  Grid and audit validation throw on invalid input; the optional-document
  validators return `null`.
- [`@windgrams/contracts/fields`](src/fields.ts) describes regional field units,
  height references and availability. It also converts an MSL height to AGL
  against an explicitly compatible ground datum, preserving negative clearance.
- [`@windgrams/contracts/provider-health`](src/provider-health.ts) validates refresh
  outcomes and lifecycle times against a caller-supplied provider/model inventory.
  Refresh attempts are separate from forecast age; reasons are operator diagnostics.

`@windgrams/contracts/wire-schemas.json` contains structural JSON Schemas generated
from the same runtime schemas at build time. Use these for another language's
document reader. Runtime validators also check relationships between fields,
including cell-array lengths and model identity; the schema alone cannot express
all of those checks.

Column parsers return the accepted object itself, including extra metadata and
native arrays, or `null` on invalid input. The [public exports](src/index.ts)
include the shared forecast types.
