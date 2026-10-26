import test from 'node:test';
import assert from 'node:assert/strict';
import { expandBounds, gridFromFunction } from '../src/solar.ts';
import { sampleGrid } from '../src/internal/solar/grid.ts';

// Integrate a geodesic directly on WGS84 (geodetic latitude, longitude,
// azimuth) with RK4. This checks coverage independently of degree padding.
function destination(latitude, longitude, bearing, distance) {
  const rad = Math.PI / 180, a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f);
  const derivative = ([phi, , alpha]) => {
    const w = 1 - e2 * Math.sin(phi) ** 2, n = a / Math.sqrt(w), m = a * (1 - e2) / w ** 1.5;
    return [Math.cos(alpha) / m, Math.sin(alpha) / (n * Math.cos(phi)), Math.sin(alpha) * Math.tan(phi) / n];
  };
  let state = [latitude * rad, longitude * rad, bearing * rad];
  const steps = 200, h = distance / steps;
  const advance = (s, k, amount) => s.map((value, i) => value + amount * k[i]);
  for (let i = 0; i < steps; i++) {
    const k1 = derivative(state), k2 = derivative(advance(state, k1, h / 2));
    const k3 = derivative(advance(state, k2, h / 2)), k4 = derivative(advance(state, k3, h));
    state = state.map((value, j) => value + h / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
  }
  return { latitude: state[0] / rad, longitude: state[1] / rad };
}

test('padding covers WGS84 geodesics in both hemispheres and across the equator', () => {
  for (const [south, north, metres] of [[47, 49, 20500], [-49, -47, 20500], [-1, 1, 20500], [0.01, 0.02, 5000], [-0.02, -0.01, 5000], [88.5, 89, 20000]]) {
    const bounds = { south, north, west: 10, east: 11 }, expanded = expandBounds(bounds, metres);
    for (const latitude of [south, (south + north) / 2, north]) for (const longitude of [10, 11]) for (let bearing = 0; bearing < 360; bearing += 15) {
      const point = destination(latitude, longitude, bearing, metres);
      assert.ok(point.latitude >= expanded.south - 1e-10 && point.latitude <= expanded.north + 1e-10, JSON.stringify({ bounds, bearing, point, expanded }));
      assert.ok(point.longitude >= expanded.west - 1e-10 && point.longitude <= expanded.east + 1e-10, JSON.stringify({ bounds, bearing, point, expanded }));
    }
  }
});
test('reachable poles cover all longitudes and zero padding preserves bounds', () => {
  for (const bounds of [
    { south: 89.9, north: 89.95, west: 10, east: 11 },
    { south: -89.95, north: -89.9, west: -20, east: -19 },
    { south: 89.9, north: 89.95, west: 179.9, east: 180.1 },
    { south: -89.95, north: -89.9, west: -180.1, east: -179.9 },
    { south: 89.9, north: 89.95, west: 179, east: 541 },
  ]) {
    assert.deepEqual(expandBounds(bounds, 0), bounds);
    const expanded = expandBounds(bounds, 20000);
    assert.equal(expanded.east - expanded.west, Math.max(360, bounds.east - bounds.west));
    assert.ok(expanded.west <= bounds.west && expanded.east >= bounds.east);
    const grid = gridFromFunction(() => 100, { ...expanded, dLon: 1, dLat: 0.01 });
    for (const longitude of [bounds.west, bounds.east]) {
      assert.equal(sampleGrid(grid, (bounds.south + bounds.north) / 2, longitude), 100);
    }
    assert.ok(expanded.north <= 90 && expanded.south >= -90);
    assert.ok(expanded.north === 90 || expanded.south === -90);
  }
  const global = expandBounds({ south: -89, north: 89, west: -179, east: 179 }, 20000);
  assert.equal(global.west, -180); assert.equal(global.east, 180);
});
test('invalid extents and distances reject instead of producing invalid coverage', () => {
  const bounds = { south: 40, north: 41, west: 10, east: 11 };
  for (const distance of [-1, NaN, Infinity]) assert.throws(() => expandBounds(bounds, distance), RangeError);
  for (const change of [{ south: -91 }, { north: 91 }, { north: 39 }, { west: NaN }, { west: 12 }]) assert.throws(() => expandBounds({ ...bounds, ...change }, 100), RangeError);
});
test('an ordered raster crossing 180 degrees retains its unwrapped longitude extent', () => {
  const bounds = { south: 40, north: 41, west: 179.9, east: 180.1 };
  const expanded = expandBounds(bounds, 1000);
  assert.ok(expanded.west < bounds.west && expanded.east > bounds.east);
  assert.ok(expanded.east - expanded.west < 1);
});
