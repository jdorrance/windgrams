import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleWindAtHeight } from '@windgrams/meteorology';

const node = (heightM, windSpeedMps = 5, windDirectionDeg = 270) => ({ heightM, windSpeedMps, windDirectionDeg });

test('physical wind sampling preserves calm, sorts a copy and interpolates components across north', () => {
  const levels = [node(110, 5, 10), node(10, 5, 350)];
  const before = structuredClone(levels);
  const wind = sampleWindAtHeight(levels, 60);
  assert.equal(wind.status, 'available');
  assert.ok(Math.abs(wind.speedMps - 5 * Math.cos(Math.PI / 18)) < 1e-12);
  assert.ok(wind.directionDeg < 1e-9 || wind.directionDeg > 359.999999);
  assert.deepEqual(wind.bracketMslM, [10, 110]);
  assert.deepEqual(levels, before);
  assert.deepEqual(sampleWindAtHeight([node(10, 0, null)], 10), {
    status: 'available', speedMps: 0, directionDeg: null, bracketMslM: [10, 10],
  });
  assert.equal(sampleWindAtHeight([node(10, 0, NaN), node(110, 8)], 60).speedMps, 4);
});

test('physical wind sampling rejects extrapolation and cannot bridge missing or duplicate nodes', () => {
  const reason = (levels, height) => sampleWindAtHeight(levels, height).reason;
  for (const height of [0, 111, NaN]) assert.equal(reason([node(10), node(110)], height), 'outside-wind-support');
  assert.equal(reason([], 10), 'outside-wind-support');
  for (const invalid of [node(60, null), node(60, -1), node(60, 5, null)]) {
    for (const height of [40, 60, 80]) assert.equal(reason([node(10), invalid, node(110)], height), 'missing-bracket-wind');
  }
  for (const height of [40, 60, 80]) assert.equal(reason([node(10), node(60), node(60, 8), node(110)], height), 'duplicate-height');
});
