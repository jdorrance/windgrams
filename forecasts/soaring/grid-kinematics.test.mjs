import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projection, storageIndex } from './grid.mjs';
import { computeNativeGridConvergence } from './grid-kinematics.mjs';

const archived = JSON.parse(readFileSync(new URL('./fixtures/blanchard-raw.json', import.meta.url)));
const grid = { ...archived.grid, ni: 7, nj: 7, latitudeOfFirstGridPoint: 48.5, longitudeOfFirstGridPoint: -122.5 };
const p = projection(grid);
const cells = Array.from({ length: 49 }, (_, index) => ({ index }));
const points = cells.map((_, index) => p.point(index % 7, Math.floor(index / 7)));

test('Lambert scale is one on standard parallels and includes the North Sound distortion', () => {
  assert.ok(Math.abs(p.scaleAt(38.5) - 1) < 1e-12);
  assert.ok(Math.abs(p.scaleAt(48.6) - 1.016581351875602) < 1e-12);
  const secant = projection({ ...grid, latin1: 30, latin2: 60 });
  for (const lat of [30, 60]) assert.ok(Math.abs(secant.scaleAt(lat) - 1) < 1e-12);
});

test('constant conformal flux has zero divergence, including one-sided regional edges', () => {
  const u = points.map(([, lat]) => 10 * p.scaleAt(lat)), v = points.map(([, lat]) => 4 * p.scaleAt(lat));
  assert.deepEqual(computeNativeGridConvergence(grid, cells, u, v), Array(49).fill(0));
  // Constant physical grid winds are not constant metric flux. A scale-only
  // correction would incorrectly preserve the old zero result here.
  assert.notEqual(computeNativeGridConvergence(grid, cells, Array(49).fill(0), Array(49).fill(10))[24], 0);
});

test('Earth-relative zonal solid-body rotation is nondivergent on the sphere', () => {
  const u = points.map(([, latitude]) => 30 * Math.cos(latitude * Math.PI / 180));
  const result = computeNativeGridConvergence({ ...grid, uvRelativeToGrid: false }, cells, u, Array(49).fill(0));
  assert.deepEqual(result, Array(49).fill(0));
});

test('uniform true-north wind matches spherical convergence and equivalent grid winds', () => {
  const u = Array(49).fill(0), v = Array(49).fill(10);
  const rotated = points.map(([lon], i) => p.gridWind(lon, u[i], v[i]));
  const earth = computeNativeGridConvergence({ ...grid, uvRelativeToGrid: false }, cells, u, v);
  const native = computeNativeGridConvergence(grid, cells, rotated.map(w => w[0]), rotated.map(w => w[1]));
  assert.deepEqual(earth, native);
  for (let i = 0; i < points.length; i++) {
    const analytic = 10 * Math.tan(points[i][1] * Math.PI / 180) / grid.earthRadiusM * 1e5;
    assert.ok(Math.abs(earth[i] - analytic) < 0.006, `${i}: ${earth[i]} vs ${analytic}`);
  }
});

test('missing winds and absent axes remain unavailable', () => {
  const u = Array(49).fill(10), v = Array(49).fill(0);
  u[storageIndex(grid, 4, 3)] = null;
  assert.equal(computeNativeGridConvergence(grid, cells, u, v)[storageIndex(grid, 3, 3)], null);
  assert.deepEqual(computeNativeGridConvergence(grid, [{ index: 0 }], [10], [0]), [null]);
  assert.throws(() => computeNativeGridConvergence({ ...grid, kind: 'regular-latlon' }, cells, u, v), /Lambert/);
});

test('wind values follow the selected cell order rather than native storage offsets', () => {
  const u = cells.map((_, i) => i / 3), v = cells.map((_, i) => i ** 2 / 7);
  const expected = computeNativeGridConvergence(grid, cells, u, v);
  assert.deepEqual(computeNativeGridConvergence(grid, cells.toReversed(), u.toReversed(), v.toReversed()), expected.toReversed());
});

test('saved native HRRR/RRFS winds retain the measured projection correction', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/convergence-native.json', import.meta.url)));
  const expected = { hrrr: [-86.83, 4.25], rrfs: [39.98, -6.29] };
  for (const fixture of fixtures) {
    for (const [level, [u, v]] of [['u', 'v'], ['925.UGRD', '925.VGRD']].entries()) {
      const result = computeNativeGridConvergence(fixture.grid, fixture.cells, fixture.winds[u], fixture.winds[v]);
      // Centre of the saved 3×3 stencil: both derivatives use original native
      // neighbours. The surrounding cells intentionally exercise edge stencils.
      const centre = fixture.cells.findIndex(cell => cell.index === fixture.centreIndex);
      assert.ok(centre >= 0);
      assert.equal(result[centre], expected[fixture.model][level], `${fixture.model} ${u}`);
    }
  }
});
