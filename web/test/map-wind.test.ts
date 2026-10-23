import test from 'node:test';
import assert from 'node:assert/strict';
import { windArrows } from '../src/lib/map-wind.ts';

test('north, east, south and west winds point downwind on the map', () => {
  const cells = Array.from({ length: 5 }, () => ({ latitude: 48.6, longitude: -122.4 }));
  const result = windArrows(cells, [4, 4, 4, 4, 4], [0, 90, 180, 270, 360]);
  assert.deepEqual(result.features.map(f => f.properties.bearing), [180, 270, 0, 90, 180]);
  assert.deepEqual(result.features[0].geometry, { type: 'Point', coordinates: [-122.4, 48.6] });
});

test('missing, nonfinite and calm winds do not acquire an invented direction', () => {
  const speeds = [null, 0, 0.09, -1, NaN, Infinity, 5, 5, 5, 0.1];
  const directions = [90, 90, 90, 90, 90, 90, null, NaN, Infinity, 45];
  const cells = speeds.map(() => ({ latitude: 48, longitude: -123 }));
  const result = windArrows(cells, speeds, directions);
  assert.equal(result.features.length, 1);
  assert.deepEqual(result.features[0].properties, { speedMps: 0.1, bearing: 225 });
  assert.deepEqual(windArrows([], speeds, directions).features, []);
});
