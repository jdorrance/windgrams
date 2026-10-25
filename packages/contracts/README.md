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
  profile extensions and replaces malformed lift fields with `null`.
- [`@windgrams/contracts/regional`](src/regional.ts) validates regional
  catalogues, manifests, grids, forecast hours and supporting documents.
  Grid and audit validation throw on invalid input; the optional-document
  validators return `null`.
- [`@windgrams/contracts/fields`](src/fields.ts) describes regional field units,
  height references and availability. It also converts an MSL height to AGL
  against an explicitly compatible ground datum, preserving negative clearance.

`@windgrams/contracts/wire-schemas.json` contains structural JSON Schemas generated
from the same runtime schemas at build time. Use these for another language's
document reader. Runtime validators also check relationships between fields,
including cell-array lengths and model identity; the schema alone cannot express
all of those checks.

Column parsers return the accepted object itself, including extra metadata and
native arrays, or `null` on invalid input. The [public exports](src/index.ts)
include the shared forecast types.
