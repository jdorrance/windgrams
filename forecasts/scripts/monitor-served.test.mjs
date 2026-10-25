import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { modelDescriptor } from '@windgrams/providers/registry';
import { monitorServed } from './monitor-served.mjs';

const fixture = JSON.parse(gunzipSync(readFileSync(new URL('../../web/test/fixtures/windgram-visual/dog-gfs.json.gz', import.meta.url))));
const encode = value => JSON.stringify(value);
const hash = text => createHash('sha256').update(text).digest('hex');
function dataset() {
  const profile = structuredClone(fixture);
  const reference = Date.parse(profile.run.referenceTime);
  const now = new Date(reference + 7 * 3_600_000).toISOString();
  const model = { ...modelDescriptor('gfs'), forecastHours: profile.hours.map(hour => (Date.parse(hour.validAt) - reference) / 3_600_000) };
  const pointManifest = { schemaVersion: 1, model: 'gfs', ...profile.run, forecastHours: profile.hours.length, firstForecastHour: model.forecastHours[0], lastForecastHour: model.forecastHours.at(-1), sites: [{ slug: profile.site.id, name: profile.site.name }], stats: { downloadBytes: 0, downloads: 0, durationMs: 0, retries: 0 } };
  const documents = new Map([
    ['gfs/manifest.json', encode(pointManifest)],
    [`gfs/sites/${profile.site.id}.json`, encode(profile)],
    ['health/noaa-cloud.json', encode({ schemaVersion: 1, group: 'noaa-cloud', models: { gfs: { attemptedAt: now, completedAt: now, lastSuccessfulRefreshAt: now, outcome: 'updated', reason: null } } })],
  ]);
  const caseId = 'test-gfs-live';
  const hours = profile.hours.map((hour, i) => ({ forecastHour: model.forecastHours[i], validAt: hour.validAt, file: `hours/${i}.json` }));
  const bundleFiles = new Map([['profile.json', encode(profile)]]);
  for (const hour of hours) bundleFiles.set(hour.file, encode({ forecastHour: hour.forecastHour, validAt: hour.validAt, thermalVelocityMps: [null], usableLiftTopM: [null], boundaryLayerTopM: [null], cloudBaseM: [null], pblHeightM: [null], status: ['valid'], levelCount: [0], ceilingReached: [false] }));
  const manifest = { schemaVersion: 1, model: 'gfs', capturedAt: profile.run.generatedAt, cellCount: 1, siteCell: 0, case: { id: caseId, model: 'gfs', referenceTime: profile.run.referenceTime, bbox: [-123, 46, -121, 48], sinkMps: 1, site: { name: 'Test', latitude: 47, longitude: -122, timeZone: 'America/Los_Angeles' }, launchElevation: { elevationM: 100 } }, versions: { algorithm: 'test' }, hours, files: Object.fromEntries([...bundleFiles].map(([path, text]) => [path, hash(text)])) };
  const manifestBytes = encode(manifest), manifestSha256 = hash(manifestBytes);
  const path = `soaring/v1/${caseId}`, bundle = `bundles/${manifestSha256}`;
  documents.set(`${path}/index.json`, encode({ schemaVersion: 1, bundle, manifestSha256 }));
  documents.set(`${path}/${bundle}/manifest.json`, manifestBytes);
  for (const [file, text] of bundleFiles) documents.set(`${path}/${bundle}/${file}`, text);
  documents.set('soaring/v1/regions.json', encode({ schemaVersion: 1, soaringContractVersion: '2.1.0', generatedAt: now, trialRegionId: 'test', regions: [{ id: 'test', name: 'Test', status: 'active-verified-trial', caseId, nativeModels: [{ model: 'gfs', caseId }], timeZone: 'America/Los_Angeles', morningBriefingLocalHour: 8, bbox: [-123, 46, -121, 48], primarySite: profile.site.id, launches: [profile.site.id], deterministicModels: ['gfs'], ensembleModels: [], sparseAdapters: [] }] }));
  const fetchImpl = async url => { const key = String(url).replace('https://forecast.example/data/', ''); return documents.has(key) ? new Response(documents.get(key), { headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 }); };
  return { documents, model, now, profile, bundlePath: `${path}/${bundle}`, options: { from: 'https://forecast.example/data', models: [model], now, fetchImpl } };
}

test('served monitor verifies representative point, refresh health and immutable regional boundary hours', async () => {
  const data = dataset();
  const report = await monitorServed(data.options);
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.deepEqual(report.checks.map(check => [check.kind, check.status]), [['point', 'current'], ['refresh', 'updated'], ['regional', 'current']]);
});
test('missing representative profile and mismatched point run fail publication checks', async () => {
  for (const missing of [true, false]) {
    const data = dataset(), path = `gfs/sites/${data.profile.site.id}.json`;
    if (missing) data.documents.delete(path);
    else data.documents.set(path, encode({ ...data.profile, run: { ...data.profile.run, referenceTime: '2026-10-24T00:00:00Z' } }));
    const report = await monitorServed(data.options);
    assert.equal(report.ok, false);
    assert.equal(report.checks[0].status, missing ? 'unavailable' : 'inconsistent');
  }
});
test('expired horizons and stale-but-valid products use the same reader cadence assessment', async () => {
  const data = dataset();
  const expired = await monitorServed({ ...data.options, now: '2026-10-25T07:00:00Z' });
  assert.equal(expired.checks.find(check => check.kind === 'point').status, 'expired');
  const stale = await monitorServed({ ...data.options, models: [{ ...data.model, catalogue: { ...data.model.catalogue, runIntervalHours: 1, typicalPublicationLagHours: 0 } }] });
  assert.equal(stale.checks.find(check => check.kind === 'point').status, 'stale');
});
test('retained refresh failure is unhealthy even when the served forecast remains current', async () => {
  const data = dataset(), health = JSON.parse(data.documents.get('health/noaa-cloud.json'));
  Object.assign(health.models.gfs, { outcome: 'retained', reason: 'source unavailable' });
  data.documents.set('health/noaa-cloud.json', encode(health));
  const report = await monitorServed(data.options);
  assert.equal(report.checks.find(check => check.kind === 'point').ok, true);
  assert.deepEqual(report.checks.find(check => check.kind === 'refresh'), { product: 'gfs', kind: 'refresh', status: 'retained', ok: false, reason: 'source unavailable' });
  assert.equal(report.ok, false);
});
test('corrupt regional content and missing health are caught at the served origin', async () => {
  const data = dataset();
  data.documents.set(`${data.bundlePath}/hours/0.json`, '{}');
  data.documents.delete('health/noaa-cloud.json');
  const report = await monitorServed(data.options);
  assert.equal(report.ok, false);
  assert.match(report.checks.find(check => check.kind === 'regional').reason, /content hash differs/);
  assert.equal(report.checks.find(check => check.kind === 'refresh').ok, false);
});
test('model cadence bounds unfinished and abandoned refresh attempts', async () => {
  const data = dataset(), health = JSON.parse(data.documents.get('health/noaa-cloud.json'));
  Object.assign(health.models.gfs, { outcome: 'running', completedAt: null });
  data.documents.set('health/noaa-cloud.json', encode(health));
  assert.equal((await monitorServed(data.options)).checks.find(check => check.kind === 'refresh').ok, true);
  const late = await monitorServed({ ...data.options, now: new Date(Date.parse(data.now) + 7 * 3_600_000).toISOString() });
  assert.equal(late.checks.find(check => check.kind === 'refresh').ok, false);
});
