import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessForecastFreshness } from '../src/freshness.ts';

const input = { referenceTime: '2026-10-25T00:00:00Z', validUntil: '2026-10-27T00:00:00Z', policy: { runIntervalHours: 6, typicalPublicationLagHours: 2 } };
const assess = now => assessForecastFreshness({ ...input, now });
test('cadence boundaries retain the existing one/three interval policy and schedule the next transition', () => {
  assert.equal(assess('2026-10-25T08:00:00Z').status, 'current');
  assert.equal(assess('2026-10-25T08:00:00Z').nextCheckAt, '2026-10-25T08:00:00.001Z');
  assert.equal(assess('2026-10-25T08:00:00.001Z').status, 'delayed');
  assert.equal(assess('2026-10-25T20:00:00Z').status, 'delayed');
  assert.equal(assess('2026-10-25T20:00:00.001Z').status, 'stale');
  assert.equal(assess('2026-10-27T00:00:00.001Z').status, 'expired');
});
test('actual horizon takes precedence over model age and remains checked without catalogue metadata', () => {
  const short = { ...input, now: '2026-10-25T05:00:00Z', validUntil: '2026-10-25T04:00:00Z' };
  assert.equal(assessForecastFreshness(short).status, 'expired');
  assert.equal(assessForecastFreshness({ ...short, policy: null }).status, 'expired');
  assert.equal(assessForecastFreshness({ ...input, now: short.now, policy: null }).status, 'unknown');
});
test('historical replay avoids age warnings; mismatched identities remain visible even in replay', () => {
  const historical = { ...input, now: '2027-01-01T00:00:00Z', historical: true };
  assert.equal(assessForecastFreshness(historical).status, 'historical');
  assert.equal(assessForecastFreshness({ ...historical, consistent: false }).status, 'inconsistent');
});
test('missing, invalid, future, or reversed timestamps and invalid cadence do not claim current', () => {
  for (const patch of [{ now: 'bad' }, { referenceTime: null }, { referenceTime: '2026-10-26T00:00:00Z' }, { validUntil: null }, { validUntil: '2026-10-24T00:00:00Z' }, { policy: { runIntervalHours: 0, typicalPublicationLagHours: 2 } }]) {
    assert.equal(assessForecastFreshness({ ...input, now: '2026-10-25T02:00:00Z', ...patch }).status, 'unknown');
  }
});
