import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRrfsProfile } from './validate-rrfs.mjs';

const profile = JSON.parse(readFileSync(new URL('../soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
const validate = document => validateRrfsProfile(document, profile.run.referenceTime, profile.site.id);

test('the captured NOAA RRFS run has a complete hourly 84-hour column and bounded v2 diagnostics', () => {
  assert.deepEqual(validate(profile), {
    site: 'wa-blanchard', hours: 84,
    firstValidAt: '2026-10-23T07:00:00Z', lastValidAt: '2026-10-26T18:00:00Z',
  });
  assert.equal(profile.hours[60].validAt, '2026-10-25T19:00:00Z');
  assert.equal(profile.hours[61].validAt, '2026-10-25T20:00:00Z');
});

test('truncated runs, wrong valid times, and run-total precipitation cannot be promoted', () => {
  for (const mutate of [
    d => d.hours.pop(),
    d => { d.hours[61].validAt = d.hours[60].validAt; },
    d => { d.semantics.precipitation = 'instantRate'; },
    d => { d.hours[60].surface.precipitationMmHr = -1; },
  ]) {
    const broken = structuredClone(profile); mutate(broken);
    assert.throws(() => validate(broken));
  }
});

test('missing upper-air data, absent postprocessing, and lift above the resolved top fail validation', () => {
  for (const mutate of [
    d => { d.hours[0].levels = d.hours[0].levels.slice(0, 2); },
    d => { d.hours[0].levels[1].pressureHpa = d.hours[0].levels[0].pressureHpa; },
    d => { d.hours[0].levels[0].windSpeedMps = null; },
    d => { delete d.hours[0].soaring; },
    d => { d.hours[0].soaring.usableLiftTopV2M = 1200; d.hours[0].soaring.resolvedThermalTopM = 1000; },
  ]) {
    const broken = structuredClone(profile); mutate(broken);
    assert.throws(() => validate(broken));
  }
});
