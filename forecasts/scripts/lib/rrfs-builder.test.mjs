import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRrfsBuilder } from './rrfs-builder.mjs';
import { configureModelFeeds } from './model-feeds.mjs';
import { selectTargetCycles } from '../check-readiness.mjs';

test('installed RRFS adapter and readiness agree on both final products and horizon', async () => {
  configureModelFeeds();
  const { build, model } = await loadRrfsBuilder();
  assert.equal(typeof build, 'function');
  assert.deepEqual(model.forecastHours, Array.from({ length: 84 }, (_, i) => i + 1));
  assert.deepEqual(model.completionUrls('20261023', '00'),
    selectTargetCycles('rrfs', Date.parse('2026-10-23T03:55:00Z')).primaryCandidate.probeUrls);
  assert.equal(model.pressureToken, 'prslev');
  assert.equal(model.surfaceToken, '2dfld');
});
