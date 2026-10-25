import test from 'node:test';
import assert from 'node:assert/strict';
import { containsPoint, coversPoint, distanceKm, validBounds, validPosition } from '../dist/index.js';

test('coverage crosses the date line and includes both longitude representations', () => {
  const area = [170, -50, -170, -30];
  for (const longitude of [175, -175, 180, -180]) assert.equal(containsPoint(area, { latitude: -40, longitude }), true);
  assert.equal(containsPoint(area, { latitude: -40, longitude: 0 }), false);
  assert.ok(distanceKm({ latitude: 0, longitude: 179 }, { latitude: 0, longitude: -179 }) < 223);
});
test('global and regional coverage validate coordinates', () => {
  assert.equal(coversPoint({ kind: 'global' }, { latitude: -90, longitude: 180 }), true);
  assert.equal(coversPoint({ kind: 'global' }, { latitude: 100, longitude: 0 }), false);
  assert.equal(validBounds([0, 20, 10, -20]), false);
  assert.equal(coversPoint({ kind: 'union', areas: [{ kind: 'bounds', bounds: [160, -50, 180, -30] }] }, { latitude: -43, longitude: 172 }), true);
});
test('geographic type guards handle unknown JSON shapes', () => {
  for (const value of [null, undefined, [], 1, '1,2', { latitude: '1', longitude: 2 }]) assert.equal(validPosition(value), false);
  for (const value of [null, {}, [0, 0, 1], [0, 0, 1, 1, 2], ['0', 0, 1, 1]]) assert.equal(validBounds(value), false);
  assert.equal(validPosition({ latitude: 0, longitude: 180 }), true);
  assert.equal(validBounds([-180, -90, 180, 90]), true);
});
