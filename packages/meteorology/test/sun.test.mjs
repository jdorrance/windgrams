import test from 'node:test';
import assert from 'node:assert/strict';
import { sunPosition, sunriseSunset } from '@windgrams/meteorology/sun';

const day = 86_400_000;
const ms = value => Date.parse(value);
function crossings(start, end, latitude, longitude) {
  // Independent one-second enumeration of a short interval is the reference
  // for grazing events; production uses extrema and bisection instead.
  const result = [];
  let previous = sunPosition(start, latitude, longitude).trueElevationDeg > -0.833;
  for (let time = start + 1000; time <= end; time += 1000) {
    const current = sunPosition(time, latitude, longitude).trueElevationDeg > -0.833;
    if (current !== previous) result.push({ time, rising: current });
    previous = current;
  }
  return result;
}
test('resolves polar daylight shorter than the ten-minute sampling interval', () => {
  const start = ms('2026-12-21T00:00:00Z'), latitude = 67.39559891057908, longitude = 0.5;
  const reference = crossings(start + 11 * 3600000, start + 13 * 3600000, latitude, longitude);
  assert.deepEqual(reference.map(x => x.rising), [true, false]);
  assert.ok(reference[1].time - reference[0].time < 90000);
  for (const [a, b] of [[start, start + day], [start + 11 * 3600000 + 53 * 60000, start + 12 * 3600000 + 3 * 60000]]) {
    const actual = sunriseSunset(a, b, latitude, longitude);
    assert.ok(actual);
    assert.ok(Math.abs(actual.sunrise - reference[0].time) < 1000);
    assert.ok(Math.abs(actual.sunset - reference[1].time) < 1000);
  }
});
test('polar day and night, incomplete windows and invalid intervals return null', () => {
  for (const start of [ms('2026-06-21T00:00:00Z'), ms('2026-12-21T00:00:00Z')]) {
    assert.equal(sunriseSunset(start, start + day, 80, 0), null);
    assert.equal(sunriseSunset(start, start + day, -80, 0), null);
  }
  const start = ms('2026-03-20T00:00:00Z');
  assert.equal(sunriseSunset(start, start + day, 0, 180), null, 'sunset before sunrise in this UTC window');
  assert.equal(sunriseSunset(start, start + 12 * 3600000, 0, 0), null, 'sunrise alone');
  for (const end of [start, start - 1, NaN, Infinity]) assert.equal(sunriseSunset(start, end, 0, 0), null);
  assert.equal(sunriseSunset(start, start + day, 91, 0), null);
  assert.equal(sunriseSunset(9e15, 9e15 + day, 0, 0), null);
  assert.equal(sunriseSunset(-9e15, -9e15 + day, 0, 0), null);
});
test('a short polar night is found around the minimum, preserving first-rise/last-set semantics', () => {
  const midnight = ms('2026-06-21T00:00:00Z'), latitude = 65.72918455844521, longitude = 0.5;
  const reference = crossings(midnight - 3600000, midnight + 3600000, latitude, longitude);
  assert.deepEqual(reference.map(x => x.rising), [false, true]);
  assert.ok(reference[1].time - reference[0].time < 90000);
  assert.equal(sunriseSunset(midnight - 3600000, midnight + 3600000, latitude, longitude), null);
  const windowEnd = midnight + 2 * day - 3 * 3600000;
  const actual = sunriseSunset(midnight - 3 * 3600000, windowEnd, latitude, longitude);
  assert.ok(actual);
  assert.ok(Math.abs(actual.sunrise - reference[1].time) < 1000);
  const nextNight = crossings(midnight + day - 3600000, midnight + day + 3600000, latitude, longitude);
  assert.ok(Math.abs(actual.sunset - nextNight.find(event => !event.rising).time) < 1000);
});
test('arbitrary windows include their final partial step and can span UTC midnight', () => {
  const start = ms('2026-03-20T00:00:00Z');
  const all = sunriseSunset(start, start + day, 0, 0);
  assert.ok(all);
  const partial = sunriseSunset(all.sunrise - 61000, all.sunset + 5000, 0, 0);
  assert.ok(partial);
  assert.ok(Math.abs(partial.sunset - all.sunset) < 1000);
  const shifted = sunriseSunset(start - 12 * 3600000, start + 12 * 3600000, 0, 180);
  assert.ok(shifted && shifted.sunrise < start && shifted.sunset > start);
});
