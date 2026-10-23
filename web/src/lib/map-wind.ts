import type { FeatureCollection, Point } from 'geojson';

interface CellCentre { longitude: number; latitude: number }

/** Meteorological directions name the source; arrowheads point downwind. */
export function windArrows(
  cells: CellCentre[],
  speeds: (number | null)[],
  directions: (number | null)[],
): FeatureCollection<Point, { speedMps: number; bearing: number }> {
  const features: FeatureCollection<Point, { speedMps: number; bearing: number }>['features'] = [];
  for (let i = 0; i < cells.length; i++) {
    const speed = speeds[i], direction = directions[i], cell = cells[i];
    // Calm air has no meaningful arrow direction. MapLibre handles spacing.
    if (speed == null || direction == null || !Number.isFinite(speed) || !Number.isFinite(direction) || speed < 0.1) continue;
    features.push({
      type: 'Feature',
      properties: { speedMps: speed, bearing: ((direction + 180) % 360 + 360) % 360 },
      geometry: { type: 'Point', coordinates: [cell.longitude, cell.latitude] },
    });
  }
  return { type: 'FeatureCollection', features };
}
