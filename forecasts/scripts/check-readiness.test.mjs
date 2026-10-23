import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeCycleReadiness, selectTargetCycles } from './check-readiness.mjs';
import { modelFeedEnvironment } from './lib/model-feeds.mjs';

test('RRFS targets both operational CONUS products and honors feed overrides', () => {
  const clock = Date.parse('2026-10-23T03:55:00Z');
  const primary = selectTargetCycles('rrfs', clock, {}).primaryCandidate;
  assert.equal(primary.referenceTime, '2026-10-23T00:00:00Z');
  assert.deepEqual(primary.probeUrls, ['prslev', '2dfld'].map(product =>
    `https://noaa-rrfs-ops-pds.s3.amazonaws.com/rrfs.20261023/00/rrfs.t00z.${product}.3km.f084.conus.grib2.idx`));
  assert.ok(selectTargetCycles('rrfs', clock, { METEO_RRFS_BASE: 'https://mirror.example/rrfs/' })
    .primaryCandidate.probeUrls.every(url => url.startsWith('https://mirror.example/rrfs/rrfs.')));
  assert.equal(modelFeedEnvironment({ METEO_RRFS_BASE: 'https://mirror.example/' }).METEO_RRFS_BASE, 'https://mirror.example');
  assert.equal(selectTargetCycles('rrfs', Date.parse('2026-10-23T01:55:00Z')).primaryCandidate.referenceTime, '2026-10-22T18:00:00Z');
});

test('RRFS never reports ready when the final surface product is absent', async () => {
  const urls = [];
  const result = await probeCycleReadiness('rrfs', {
    nowMs: Date.parse('2026-10-23T03:55:00Z'), maxAttempts: 2, retryDelayMs: 0,
    fetchImpl: async url => { urls.push(url); return { ok: url.includes('.prslev.') }; },
  });
  assert.equal(result.ready, false);
  assert.equal(result.selectedCycle, null);
  assert.equal(urls.filter(url => url.includes('.2dfld.')).length, 3);
});

test('RRFS waits before using a complete fallback and reports that choice', async () => {
  let sleeps = 0;
  const result = await probeCycleReadiness('rrfs', {
    nowMs: Date.parse('2026-10-23T03:55:00Z'), maxAttempts: 3, retryDelayMs: 5,
    sleep: async () => { sleeps++; },
    fetchImpl: async url => ({ ok: url.includes('rrfs.20261022/18/') }),
  });
  assert.equal(sleeps, 2);
  assert.equal(result.ready, true);
  assert.equal(result.fallback, true);
  assert.equal(result.selectedCycle.referenceTime, '2026-10-22T18:00:00Z');
});

test('readiness advances the target when the availability window opens during retries', async () => {
  let clock = Date.parse('2026-10-23T03:04:00Z');
  const result = await probeCycleReadiness('rrfs', {
    now: () => clock, maxAttempts: 2, retryDelayMs: 60_000,
    sleep: async delay => { clock += delay; },
    fetchImpl: async url => ({ ok: url.includes('rrfs.20261023/00/') }),
  });
  assert.equal(result.ready, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.selectedCycle.referenceTime, '2026-10-23T00:00:00Z');
});

test('readiness retries transport failures and rejects invalid wait settings', async () => {
  let requests = 0;
  const result = await probeCycleReadiness('rrfs', {
    nowMs: Date.parse('2026-10-23T03:55:00Z'), maxAttempts: 2, retryDelayMs: 0,
    fetchImpl: async () => { if (++requests <= 2) throw new Error('unavailable'); return { ok: true }; },
  });
  assert.equal(result.ready, true);
  assert.equal(result.attempts, 2);
  await assert.rejects(probeCycleReadiness('rrfs', { maxAttempts: 0 }), /positive integer/);
});
