# @windgrams/geography

Small geographic calculations for selecting forecast models and locating native
weather cells. The functions run in browsers and Node without fetching data.

```ts
import { containsPoint, distanceKm } from '@windgrams/geography';

const blanchard = { latitude: 48.609, longitude: -122.424 };
const bellingham = { latitude: 48.751, longitude: -122.478 };

containsPoint([-123, 48, -122, 49], blanchard); // true
distanceKm(blanchard, bellingham); // great-circle distance in kilometres
```

Positions use degrees with east-positive longitude. Bounds are
`[west, south, east, north]`; a west value greater than east describes an area
crossing the date line. `coversPoint` accepts global coverage, bounds or a union
of areas. These broad areas help select a model to try; use decoded cell geometry
to establish whether a point is covered by the acquired grid.

`containsPolygon` accepts GeoJSON polygon rings in longitude/latitude order.
It handles date-line crossings and holes for cells with short edges. Points on
an outer edge or a hole's edge count as covered; points inside a hole are excluded.

See the [types and functions](src/index.ts) for position validation and longitude
normalization, or the [coverage examples](test/coverage.test.mjs) and
[polygon tests](test/polygon.test.mjs) for edge cases.
