import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginProviderAttempt, finishProviderAttempt, finishProviderStages, parseProviderHealth, mergeProviderHealth } from './lib/provider-health.mjs';
import { runProvider } from './run-provider.mjs';

const at = hour => `2026-10-25T${String(hour).padStart(2, '0')}:00:00Z`;
const entry = (hour, outcome = 'updated') => ({ attemptedAt: at(hour), completedAt: outcome === 'running' ? null : at(hour), lastSuccessfulRefreshAt: outcome === 'updated' ? at(hour) : null, outcome, reason: null });
const doc = (model, value) => ({ schemaVersion: 1, group: 'noaa-cloud', models: { [model]: value } });
function directory(t) { const output = mkdtempSync(join(tmpdir(), 'windgrams-health-')); t.after(() => rmSync(output, { recursive: true, force: true })); return output; }

test('provider health validates ownership and lifecycle boundaries', () => {
  assert.ok(parseProviderHealth(doc('gfs', entry(1)), 'noaa-cloud'));
  assert.equal(parseProviderHealth(doc('gfs', entry(1)), '__proto__'), null);
  for (const value of [doc('rrfs', entry(1)), doc('gfs', { ...entry(1), attemptedAt: 'bad' }), doc('gfs', { ...entry(1), completedAt: at(0) }), doc('gfs', { ...entry(1), outcome: 'running' }), doc('gfs', { ...entry(1), lastSuccessfulRefreshAt: at(2) })]) {
    assert.equal(parseProviderHealth(value, 'noaa-cloud'), null);
  }
  assert.throws(() => mergeProviderHealth(null, doc('rrfs', entry(1)), 'noaa-cloud'), /Invalid provider health/);
});

test('health merge preserves newer attempts, sibling models and the last successful refresh', () => {
  const current = { ...doc('gfs', entry(4)), models: { gfs: entry(4), 'hrrr-conus': entry(5) } };
  assert.deepEqual(mergeProviderHealth(current, doc('gfs', entry(3, 'retained')), 'noaa-cloud'), current);
  const next = mergeProviderHealth(current, doc('gfs', entry(6, 'retained')), 'noaa-cloud');
  assert.equal(next.models.gfs.outcome, 'retained');
  assert.equal(next.models.gfs.lastSuccessfulRefreshAt, at(4));
  assert.deepEqual(next.models['hrrr-conus'], current.models['hrrr-conus']);
  assert.equal(mergeProviderHealth(current, doc('gfs', entry(4, 'running')), 'noaa-cloud').models.gfs.outcome, 'updated');
});

test('an interrupted attempt remains observable and retained output keeps the previous success time', t => {
  const output = directory(t);
  beginProviderAttempt(output, 'noaa-cloud', 'gfs', at(1));
  finishProviderAttempt(output, 'noaa-cloud', 'gfs', at(1), at(2), 'updated');
  beginProviderAttempt(output, 'noaa-cloud', 'gfs', at(3));
  let health = JSON.parse(readFileSync(join(output, 'health/noaa-cloud.json')));
  assert.equal(health.models.gfs.outcome, 'running');
  assert.equal(health.models.gfs.lastSuccessfulRefreshAt, at(2));
  finishProviderAttempt(output, 'noaa-cloud', 'gfs', at(3), at(4), 'retained', 'upstream timeout');
  health = JSON.parse(readFileSync(join(output, 'health/noaa-cloud.json')));
  assert.equal(health.models.gfs.lastSuccessfulRefreshAt, at(2));
  assert.equal(health.models.gfs.reason, 'upstream timeout');
});

test('one failed model still publishes another model and records both outcomes', async t => {
  const output = directory(t);
  const results = await runProvider('noaa-cloud', { output }, {
    now: () => at(3),
    build: async ({ model }) => { if (model === 'hrrr-conus') throw new Error('provider down'); return { healthy: true }; },
    validate: async () => ({ retained: true }),
  });
  assert.deepEqual(results.map(result => result.status), ['retained', 'updated']);
  const health = JSON.parse(readFileSync(join(output, 'health/noaa-cloud.json')));
  assert.equal(health.models['hrrr-conus'].reason, 'provider down');
  assert.equal(health.models['hrrr-conus'].lastSuccessfulRefreshAt, null);
  assert.equal(health.models.gfs.lastSuccessfulRefreshAt, at(3));
});

test('native ICON runs through the same lifecycle and records an unavailable first run', async t => {
  const output = directory(t);
  const results = await runProvider('dwd', { output }, { now: () => at(3), build: async () => { throw new Error('decoder failed'); }, validate: async () => { throw new Error('no prior run'); } });
  assert.equal(results[0].status, 'unavailable');
  const health = JSON.parse(readFileSync(join(output, 'health/dwd.json')));
  assert.equal(health.models['icon-eu'].outcome, 'unavailable');
  assert.equal(health.models['icon-eu'].lastSuccessfulRefreshAt, null);
});

test('regional failure after successful points remains observable without degrading its healthy sibling', async t => {
  const output = directory(t);
  await runProvider('noaa-cloud', { output }, { now: () => at(3), build: async () => ({ healthy: true }) });
  const updated = finishProviderStages(output, 'noaa-cloud', [{ stage: 'regional', ok: false, reason: 'same-run map validation failed' }], { now: () => at(4) });
  assert.deepEqual(updated, ['hrrr-conus']);
  const health = JSON.parse(readFileSync(join(output, 'health/noaa-cloud.json')));
  assert.equal(health.models['hrrr-conus'].attemptedAt, at(3));
  assert.equal(health.models['hrrr-conus'].lastSuccessfulRefreshAt, at(3));
  assert.equal(health.models['hrrr-conus'].outcome, 'retained');
  assert.match(health.models['hrrr-conus'].reason, /regional: same-run map validation failed/);
  assert.equal(health.models.gfs.outcome, 'updated');
  assert.equal(health.models.gfs.completedAt, at(3));
});

test('a downstream validation failure does not invent availability or a prior successful run', async t => {
  const output = directory(t);
  await runProvider('rrfs', { output }, { now: () => at(3), build: async () => { throw new Error('no source'); }, validate: async () => null });
  finishProviderStages(output, 'rrfs', [{ stage: 'validate', ok: false, reason: 'no output' }], { now: () => at(4) });
  const health = JSON.parse(readFileSync(join(output, 'health/rrfs.json')));
  assert.equal(health.models.rrfs.outcome, 'unavailable');
  assert.equal(health.models.rrfs.lastSuccessfulRefreshAt, null);
  assert.match(health.models.rrfs.reason, /no source; validate: no output/);
});
