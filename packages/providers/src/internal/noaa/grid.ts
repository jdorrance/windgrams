import { lambertConeConstant, lambertEarthWind } from '@azohra/meteo.grib';
import type { LambertGrid } from '@azohra/meteo.grib';
import { validBounds, type Bounds } from '@windgrams/geography';
import type { NoaaGrid } from './types.ts';

const rad = Math.PI / 180;
const wrap = (lon: number) => ((lon + 180) % 360 + 360) % 360 - 180;
// Spherical Lambert conformal inverse, using the GRIB's radius and standard
// parallels. Storage order is independent of geographic north/east.
export function projection(grid: LambertGrid) {
  if (grid.kind !== 'lambert' || grid.projectionCentreFlag !== 0) throw new Error('Expected northern Lambert grid');
  const n = lambertConeConstant(grid.latin1, grid.latin2);
  const f = Math.cos(grid.latin1 * rad) * Math.tan(Math.PI / 4 + grid.latin1 * rad / 2) ** n / n;
  const rho = (lat: number) => grid.earthRadiusM * f / Math.tan(Math.PI / 4 + lat * rad / 2) ** n;
  const rho0 = rho(grid.laD);
  const forward = (lon: number, lat: number) => {
    const theta = n * wrap(lon - grid.loV) * rad;
    return [rho(lat) * Math.sin(theta), rho0 - rho(lat) * Math.cos(theta)];
  };
  const inverse = (x: number, y: number): [number, number] => [wrap(grid.loV + Math.atan2(x, rho0 - y) / n / rad),
    (2 * Math.atan((grid.earthRadiusM * f / Math.hypot(x, rho0 - y)) ** (1 / n)) - Math.PI / 2) / rad];
  const [x0, y0] = forward(grid.longitudeOfFirstGridPoint, grid.latitudeOfFirstGridPoint);
  const dx = grid.dxM * (grid.iScansNegatively ? -1 : 1), dy = grid.dyM * (grid.jScansPositively ? 1 : -1);
  const scaleAt = (latitude: number) => n * rho(latitude) / (grid.earthRadiusM * Math.cos(latitude * rad));
  const gridWind = (longitude: number, u: number, v: number) => {
    // Inverse of lambertEarthWind: physical east/north to projected axes.
    const angle = n * wrap(longitude - grid.loV) * rad;
    return [u * Math.cos(angle) - v * Math.sin(angle), u * Math.sin(angle) + v * Math.cos(angle)];
  };
  return { forward, inverse, scaleAt, gridWind, point: (i: number, j: number) => inverse(x0 + i * dx, y0 + j * dy),
    fractional: (lon: number, lat: number) => { const [x, y] = forward(lon, lat); return [(x - x0) / dx, (y - y0) / dy]; } };
}
export function storageIndex(grid: NoaaGrid, i: number, j: number) {
  if (grid.jPointsAreConsecutive) return i * grid.nj + (grid.alternativeRowScanning && i % 2 ? grid.nj - 1 - j : j);
  return j * grid.ni + (grid.alternativeRowScanning && j % 2 ? grid.ni - 1 - i : i);
}
/** Inverse of GRIB storage indexing, independent of scan direction. */
export function storageCoordinates(grid: NoaaGrid, index: number): [number, number] {
  if (grid.jPointsAreConsecutive) {
    const i = Math.floor(index / grid.nj), row = index % grid.nj;
    return [i, grid.alternativeRowScanning && i % 2 ? grid.nj - 1 - row : row];
  }
  const j = Math.floor(index / grid.ni), col = index % grid.ni;
  return [grid.alternativeRowScanning && j % 2 ? grid.ni - 1 - col : col, j];
}
export function wind(grid: NoaaGrid, longitude: number, u: number | null | undefined, v: number | null | undefined) {
  if (typeof u !== 'number' || typeof v !== 'number' || !Number.isFinite(u) || !Number.isFinite(v)) return null;
  if (grid.kind === 'lambert' && grid.uvRelativeToGrid) [u,v] = lambertEarthWind(u, v, longitude, grid.loV, lambertConeConstant(grid.latin1, grid.latin2));
  return { windSpeedMps: Math.hypot(u, v), windDirectionDeg: ((Math.atan2(-u, -v) * 180 / Math.PI) % 360 + 360) % 360 };
}

/** Native geographic geometry for the GFS regular global grid; no longitude extrapolation. */
export function geographicProjection(grid: NoaaGrid) {
  if (grid.kind === 'lambert') return projection(grid);
  const dx = grid.iDirectionIncrement * (grid.iScansNegatively ? -1 : 1), dy = grid.jDirectionIncrement * (grid.jScansPositively ? 1 : -1);
  return { point: (i: number, j: number): [number, number] => [wrap(grid.longitudeOfFirstGridPoint + i * dx), grid.latitudeOfFirstGridPoint + j * dy],
    fractional: (lon: number, lat: number) => [((lon - grid.longitudeOfFirstGridPoint) * Math.sign(dx) % 360 + 360) % 360 / Math.abs(dx), (lat - grid.latitudeOfFirstGridPoint) / dy] };
}

export function assertNoaaBounds(bounds: Bounds): void {
  if (!validBounds(bounds) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error('Invalid NOAA bounds');
}

/** Native cells inside geographic bounds, plus explicitly requested point-support cells. */
export function selectGridCells(grid: NoaaGrid, { bounds, indices = [], maxCells = Infinity }: {
  bounds?: Bounds; indices?: readonly number[]; maxCells?: number;
}) {
  const p = geographicProjection(grid), selected = new Set(indices);
  if (bounds) {
    assertNoaaBounds(bounds);
    const [west, south, east, north] = bounds;
    // Sample each edge: a projected corner rectangle can omit curved-boundary cells.
    const edges = Array.from({ length: 101 }, (_, i) => i / 100).flatMap(t => [
      p.fractional(west + t * (east - west), south), p.fractional(west + t * (east - west), north),
      p.fractional(west, south + t * (north - south)), p.fractional(east, south + t * (north - south)),
    ]);
    const xs = edges.map(([x]) => x), ys = edges.map(([, y]) => y);
    const spansSeam = grid.kind === 'latlon' && Math.max(...xs) - Math.min(...xs) > grid.ni / 2;
    const firstI = spansSeam ? 0 : Math.max(0, Math.floor(Math.min(...xs)) - 2);
    const lastI = spansSeam ? grid.ni - 1 : Math.min(grid.ni - 1, Math.ceil(Math.max(...xs)) + 2);
    const firstJ = Math.max(0, Math.floor(Math.min(...ys)) - 2);
    const lastJ = Math.min(grid.nj - 1, Math.ceil(Math.max(...ys)) + 2);
    for (let j = firstJ; j <= lastJ; j++) for (let i = firstI; i <= lastI; i++) {
      const [lon, lat] = p.point(i, j);
      if (lon < west || lon > east || lat < south || lat > north) continue;
      selected.add(storageIndex(grid, i, j));
      if (selected.size > maxCells) throw new Error(`NOAA request exceeds ${maxCells} cells`);
    }
  }
  if (selected.size > maxCells) throw new Error(`NOAA request exceeds ${maxCells} cells`);
  return [...selected].sort((a, b) => a - b).map(index => {
    const [i, j] = storageCoordinates(grid, index), [longitude, latitude] = p.point(i, j);
    return {
      index, id: `${grid.gridKey}:${index}`, longitude, latitude,
      corners: [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5], [-.5, -.5]].map(([di, dj]) => p.point(i + di, j + dj)),
    };
  });
}
