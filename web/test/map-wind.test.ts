import test, { afterEach } from 'node:test';
import { setUnitSystem } from '../src/lib/units.ts';
import { barbPaths } from '../src/lib/wind-barb.ts';
afterEach(() => setUnitSystem('imperial'));
import assert from 'node:assert/strict';
import { windBarbs } from '../src/lib/map-wind.ts';

const cells = (n: number) => Array.from({ length: n }, () => ({ latitude: 48.6, longitude: -122.4 }));
test('map barbs point toward the wind source, including wrapped bearings', () => {
  const result = windBarbs(cells(6), Array(6).fill(4), [0, 90, 180, 270, 360, -90]);
  assert.deepEqual(result.features.map(f => f.properties.bearing), [0, 90, 180, 270, 0, 270]);
  assert.deepEqual(result.features[0].geometry.coordinates, [-122.4, 48.6]);
});
test('map speeds convert from m/s to knots and use the correct feather sprite', () => {
  const knots = [0, 2.49, 2.51, 7.49, 7.51, 47.49, 47.51, 75, 100];
  const features = windBarbs(cells(knots.length), knots.map(k => k * 1852 / 3600), knots.map(() => 90)).features;
  const expected = [0, 0, 5, 5, 10, 45, 50, 75, 100];
  assert.deepEqual(features.map(f => f.properties.speedKt), expected);
  assert.deepEqual(features.map(f => f.properties.icon), expected.map(k => `wind-barb-imperial-${k}`));
});
test('calm winds remain visible without direction; missing winds stay missing', () => {
  const speeds = [null, 0, -1, NaN, Infinity, 5, 5, 5];
  const directions = [90, null, 90, 90, 90, null, NaN, Infinity];
  const result = windBarbs(cells(speeds.length), speeds, directions);
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.icon, 'wind-barb-imperial-0');
});


test('metric map feathers round to 2.5 m/s increments and retain true wind bearings', () => {
  setUnitSystem('metric');
  const speeds = [0, 1.24, 1.25, 3.74, 3.75, 23.74, 23.75, 25, 37.5, 50];
  const expected = [0, 0, 5, 5, 10, 45, 50, 50, 75, 100];
  const features = windBarbs(cells(speeds.length), speeds, speeds.map(() => -90)).features;
  assert.deepEqual(features.map(f => f.properties.barbSpeed), expected);
  assert.deepEqual(features.map(f => f.properties.icon), expected.map(speed => `wind-barb-metric-${speed}`));
  assert.deepEqual(features.map(f => f.properties.speedMps), speeds);
  assert.deepEqual(features.map(f => f.properties.bearing), expected.map(speed => speed ? 270 : 0));
  assert.equal(windBarbs(cells(2), [1.24, 1.25], [null, null]).features.length, 1, 'direction is required once the rounded wind has a feather');
});

test('unit-specific map sprites preserve physical wind and use the correct pennant threshold', () => {
  const speeds = [2.5, 5, 24];
  const imperial = windBarbs(cells(3), speeds, [90, 90, 90]).features;
  setUnitSystem('metric');
  const metric = windBarbs(cells(3), speeds, [90, 90, 90]).features;
  assert.deepEqual(metric.map(f => f.properties.speedMps), imperial.map(f => f.properties.speedMps));
  assert.deepEqual(metric.map(f => f.properties.speedKt), imperial.map(f => f.properties.speedKt));
  assert.deepEqual(metric.map(f => f.geometry), imperial.map(f => f.geometry));
  assert.deepEqual(metric.map(f => f.properties.bearing), imperial.map(f => f.properties.bearing));
  assert.ok(metric.every((f, i) => f.properties.icon !== imperial[i].properties.icon), 'sprites cannot reuse a different unit convention');
  assert.equal(metric[0].properties.barbSpeed, 5, '2.5 m/s half feather');
  assert.equal(metric[1].properties.barbSpeed, 10, '5 m/s full feather');
  assert.equal(barbPaths(metric[2].properties.barbSpeed, 0).flags.filter(path => path.endsWith('Z')).length, 1, '24 m/s rounds to one 25 m/s pennant');
  assert.equal(barbPaths(imperial[2].properties.barbSpeed, 0).flags.filter(path => path.endsWith('Z')).length, 0, '46.7 kt rounds to 45 kt, below a 50 kt pennant');
});
