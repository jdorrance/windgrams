import { lambertConeConstant, nearestGridpoint, lambertEarthWind } from '@azohra/meteo.grib';

const rad = Math.PI / 180;
const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;
// Spherical Lambert conformal inverse, using the GRIB's radius and standard
// parallels. Storage order is independent of geographic north/east.
export function projection(grid) {
  if (grid.kind !== 'lambert' || grid.projectionCentreFlag !== 0) throw new Error('Expected northern Lambert grid');
  const n = lambertConeConstant(grid.latin1, grid.latin2);
  const f = Math.cos(grid.latin1 * rad) * Math.tan(Math.PI / 4 + grid.latin1 * rad / 2) ** n / n;
  const rho = lat => grid.earthRadiusM * f / Math.tan(Math.PI / 4 + lat * rad / 2) ** n;
  const rho0 = rho(grid.laD);
  const forward = (lon, lat) => {
    const theta = n * wrap(lon - grid.loV) * rad;
    return [rho(lat) * Math.sin(theta), rho0 - rho(lat) * Math.cos(theta)];
  };
  const inverse = (x, y) => [wrap(grid.loV + Math.atan2(x, rho0 - y) / n / rad),
    (2 * Math.atan((grid.earthRadiusM * f / Math.hypot(x, rho0 - y)) ** (1 / n)) - Math.PI / 2) / rad];
  const [x0, y0] = forward(grid.longitudeOfFirstGridPoint, grid.latitudeOfFirstGridPoint);
  const dx = grid.dxM * (grid.iScansNegatively ? -1 : 1), dy = grid.dyM * (grid.jScansPositively ? 1 : -1);
  return { forward, inverse, point: (i, j) => inverse(x0 + i * dx, y0 + j * dy),
    fractional: (lon, lat) => { const [x, y] = forward(lon, lat); return [(x - x0) / dx, (y - y0) / dy]; } };
}
export function storageIndex(grid, i, j) {
  if (grid.jPointsAreConsecutive) return i * grid.nj + (grid.alternativeRowScanning && i % 2 ? grid.nj - 1 - j : j);
  return j * grid.ni + (grid.alternativeRowScanning && j % 2 ? grid.ni - 1 - i : i);
}
export function regionalGrid(grid, c) {
  const p = projection(grid), [west, south, east, north] = c.bbox;
  // Bounding rectangle plus padding in projected space; sample each edge so
  // curvature cannot omit interior cells in this small domain.
  const edges = Array.from({ length: 101 }, (_, i) => i / 100).flatMap(t => [
    p.fractional(west + t * (east - west), south), p.fractional(west + t * (east - west), north),
    p.fractional(west, south + t * (north - south)), p.fractional(east, south + t * (north - south))]);
  const bounds = [Math.max(0, Math.floor(Math.min(...edges.map(v => v[0]))) - 2), Math.max(0, Math.floor(Math.min(...edges.map(v => v[1]))) - 2),
    Math.min(grid.ni - 1, Math.ceil(Math.max(...edges.map(v => v[0]))) + 2), Math.min(grid.nj - 1, Math.ceil(Math.max(...edges.map(v => v[1]))) + 2)];
  const cells = [];
  for (let j = bounds[1]; j <= bounds[3]; j++) for (let i = bounds[0]; i <= bounds[2]; i++) {
    const [longitude, latitude] = p.point(i, j);
    if (longitude < west || longitude > east || latitude < south || latitude > north) continue;
    const index = storageIndex(grid, i, j);
    cells.push({ index, id: `${grid.gridKey}:${index}`, latitude, longitude,
      corners: [[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5],[-.5,-.5]].map(([di, dj]) => p.point(i + di, j + dj)) });
  }
  cells.sort((a, b) => a.index - b.index);
  const nearest = nearestGridpoint(grid, c.site.latitude, c.site.longitude);
  const siteCell = cells.findIndex(cell => cell.index === nearest.index);
  if (siteCell < 0 || nearest.distanceKm > 5) throw new Error('Blanchard is outside the replay grid or >5 km from its sample');
  return { cells, siteCell, nearest };
}
export function wind(grid, longitude, u, v) {
  if (![u,v].every(x => typeof x === 'number' && Number.isFinite(x))) return null;
  if (grid.uvRelativeToGrid) [u,v] = lambertEarthWind(u, v, longitude, grid.loV, lambertConeConstant(grid.latin1, grid.latin2));
  return { windSpeedMps: Math.hypot(u, v), windDirectionDeg: ((Math.atan2(-u, -v) * 180 / Math.PI) % 360 + 360) % 360 };
}
