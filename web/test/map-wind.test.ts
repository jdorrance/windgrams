import test from 'node:test';
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
  assert.deepEqual(features.map(f => f.properties.icon), expected.map(k => `wind-barb-${k}`));
});
test('calm winds remain visible without direction; missing winds stay missing', () => {
  const speeds = [null, 0, -1, NaN, Infinity, 5, 5, 5];
  const directions = [90, null, 90, 90, 90, null, NaN, Infinity];
  const result = windBarbs(cells(speeds.length), speeds, directions);
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.icon, 'wind-barb-0');
});
