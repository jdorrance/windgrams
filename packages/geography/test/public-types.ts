import { validPosition, validBounds, containsPoint, type Position, type Bounds } from '@windgrams/geography';
declare const raw: unknown;
if (validPosition(raw)) { const point: Position = raw; containsPoint([-180, -90, 180, 90], point); }
if (validBounds(raw)) containsPoint(raw, { latitude: 1, longitude: 1 });
// @ts-expect-error geographic coordinates are numeric degrees
const invalid: Position = { latitude: '0', longitude: 0 };
// @ts-expect-error geographic bounds have exactly four ordered coordinates
const incomplete: Bounds = [1, 2, 3];
void [invalid, incomplete];
