/** Longitude is east-positive; bounds crossing the date line have west > east. */
export interface Position { latitude: number; longitude: number }
export type Bounds = readonly [west: number, south: number, east: number, north: number];
export type Coverage = { kind: 'global' } | { kind: 'bounds'; bounds: Bounds } | { kind: 'union'; areas: readonly Coverage[] };
/** GeoJSON ring vertices are longitude, latitude, then optional extra dimensions. */
export type PolygonRing = readonly (readonly number[])[];
export type PolygonCoordinates = readonly PolygonRing[];

export function validPosition(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false;
  const point = value as Position;
  return Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90
    && Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180;
}

export function normalizeLongitude(longitude: number): number {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

export function validBounds(value: unknown): value is Bounds {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const bounds = value as unknown as Bounds;
  const [west, south, east, north] = bounds;
  return [west, south, east, north].every(Number.isFinite)
    && west >= -180 && west <= 180 && east >= -180 && east <= 180
    && south >= -90 && north <= 90 && south <= north;
}

export function containsPoint(bounds: Bounds, point: Position): boolean {
  if (!validBounds(bounds) || !validPosition(point)) return false;
  const [west, south, east, north] = bounds;
  if (point.latitude < south || point.latitude > north) return false;
  if (west === -180 && east === 180) return true;
  const contains = (lon: number) => west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
  return contains(point.longitude) || (Math.abs(point.longitude) === 180 && contains(-point.longitude));
}

/** Acquisition envelopes are coarse filters; the decoded grid verifies actual coverage. */
export function coversPoint(coverage: Coverage, point: Position): boolean {
  if (!validPosition(point)) return false;
  if (coverage.kind === 'global') return true;
  if (coverage.kind === 'bounds') return containsPoint(coverage.bounds, point);
  return coverage.areas.some(area => coversPoint(area, point));
}

/** Great-circle distance in kilometres on a mean-radius sphere. */
export function distanceKm(a: Position, b: Position): number {
  if (!validPosition(a) || !validPosition(b)) return NaN;
  const r = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * r;
  const dLon = normalizeLongitude(b.longitude - a.longitude) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

/** Native-cell GeoJSON rings with short edges. Boundaries are covered; hole interiors are not. */
export function containsPolygon(rings: PolygonCoordinates, point: Position): boolean {
  if (!validPosition(point) || !rings.length || rings.some(ring => ring.length < 4
    || ring.some(vertex => vertex.length < 2 || !validPosition({ longitude: vertex[0], latitude: vertex[1] })))) return false;
  const inRing = (ring: PolygonRing): 0 | 1 | 2 => {
    // Unwrap each edge before ray casting so a cell at 180° stays a small cell.
    const vertices: [number, number][] = [[ring[0][0], ring[0][1]]];
    for (let i = 1; i < ring.length; i += 1) {
      vertices.push([vertices[i - 1][0] + normalizeLongitude(ring[i][0] - ring[i - 1][0]), ring[i][1]]);
    }
    const x = vertices[0][0] + normalizeLongitude(point.longitude - vertices[0][0]), y = point.latitude;
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const [ax, ay] = vertices[j], [bx, by] = vertices[i];
      const dx = bx - ax, dy = by - ay;
      if (Math.abs((x - ax) * dy - (y - ay) * dx) <= 1e-10 * (1 + Math.abs(dx) + Math.abs(dy))
        && x >= Math.min(ax, bx) - 1e-10 && x <= Math.max(ax, bx) + 1e-10
        && y >= Math.min(ay, by) - 1e-10 && y <= Math.max(ay, by) + 1e-10) return 2;
      if ((ay > y) !== (by > y) && x < ax + (y - ay) * dx / dy) inside = !inside;
    }
    return inside ? 1 : 0;
  };
  const outer = inRing(rings[0]);
  if (outer === 0) return false;
  if (outer === 2) return true;
  for (const hole of rings.slice(1)) {
    const result = inRing(hole);
    if (result === 2) return true;
    if (result === 1) return false;
  }
  return true;
}
