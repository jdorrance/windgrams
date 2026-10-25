import type { Grid } from '@windgrams/contracts/regional';
import { containsPolygon, distanceKm, validPosition, type Position } from '@windgrams/geography';
import type { RegionalCellSelection, RegionalTimeSelection } from './dataset-types.ts';

export function cellAt(grid: Grid, position: Position): RegionalCellSelection | null {
  if (!validPosition(position)) throw new Error('Invalid regional sample position');
  let selected: RegionalCellSelection | null = null;
  let distance = Infinity;
  for (const { geometry, properties } of grid.features) {
    if (!containsPolygon(geometry.coordinates, position)) continue;
    const candidateDistance = distanceKm(properties, position);
    // Grid order resolves an exact tie on shared cell edges.
    if (candidateDistance < distance) {
      const { cellIndex, gridIndex, latitude, longitude, modelElevationM } = properties;
      selected = { cellIndex, gridIndex, latitude, longitude, modelElevationM, distanceKm: candidateDistance };
      distance = candidateDistance;
    }
  }
  return selected;
}

export function instant(validAt: string): number {
  const value = Date.parse(validAt);
  if (!Number.isFinite(value)) throw new Error('Invalid regional forecast time');
  return value;
}

export function timeAt(hours: readonly RegionalTimeSelection[], validAt: string, toleranceMinutes = 0): RegionalTimeSelection | null {
  const target = instant(validAt);
  if (!Number.isFinite(toleranceMinutes) || toleranceMinutes < 0) throw new Error('Time tolerance must be finite and nonnegative');
  let selected: RegionalTimeSelection | null = null;
  let difference = Infinity;
  let selectedTime = Infinity;
  for (const hour of hours) {
    const time = instant(hour.validAt);
    const delta = Math.abs(time - target);
    if (delta <= toleranceMinutes * 60_000 && (delta < difference || (delta === difference && time < selectedTime))) {
      selected = { validAt: hour.validAt, forecastHour: hour.forecastHour };
      difference = delta;
      selectedTime = time;
    }
  }
  return selected;
}
