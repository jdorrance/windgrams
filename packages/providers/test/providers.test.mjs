import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MODELS, PROVIDER_GROUPS, PACKAGED_MODEL_CATALOGUE, modelCoversSite, diagnosticCapability } from '../dist/registry.js';
import { createLegacyAdapterWithLoader as createLegacyAdapter, loadLegacyBuilder } from '../dist/legacy.js';
import { configureModelFeeds, selectTargetCycles } from '../dist/readiness.js';
import { normalizeIconExtract, iconColumnRecord, createIconAdapter } from '../dist/icon.js';
import { terrainPolicyId, terrainSourcesMatchPolicy } from '../dist/terrain-policy.js';
import { parseNormalizedColumnRecord } from '@windgrams/contracts';
const profile = JSON.parse(readFileSync(new URL('../../../forecasts/soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
const raw = JSON.parse(readFileSync(new URL('../../../forecasts/scripts/lib/icon-native-fixture.json', import.meta.url)));

test('registered models have explicit ownership, source identity and supported fields', () => {
  assert.equal(new Set(MODELS.map(model => model.id)).size, MODELS.length);
  for (const model of MODELS) {
    assert.ok(model.producer && model.deliverySource && model.sourceProducts.length && model.publication.attribution);
    assert.equal(model.catalogue.slug, model.id);
  }
  assert.equal(modelCoversSite('gfs', { latitude: -45, longitude: 170 }), true);
  assert.equal(modelCoversSite('hrrr-conus', { latitude: -45, longitude: 170 }), false);
  assert.throws(() => modelCoversSite('unknown', { latitude: 0, longitude: 0 }), /Unknown model/);
  assert.equal(diagnosticCapability('icon-eu', ['verticalVelocity']), 'unsupported');
});
test('shared registry descriptors and all nested inventories are immutable', () => {
  const model = MODELS[0];
  for (const value of [MODELS, model, model.cyclesUtc, model.forecastHours, model.sourceProducts, model.sourceCapabilities.fields, model.catalogue.capabilities.pressureLevels, model.publication,
    PACKAGED_MODEL_CATALOGUE.models, PROVIDER_GROUPS['noaa-cloud']]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { model.id = 'changed'; }, TypeError);
  assert.throws(() => { model.sourceCapabilities.fields.wind = 'unsupported'; }, TypeError);
  assert.throws(() => PROVIDER_GROUPS['noaa-cloud'].push('unknown'), TypeError);
});
test('all installed processed-profile bridges expose the exact pinned runtime contract', async () => {
  for (const model of MODELS.filter(model => model.product === 'processed-profile')) { const installed = await loadLegacyBuilder(model.id); assert.equal(typeof installed.build, 'function'); assert.deepEqual(model.forecastHours, installed.model.forecastHours); }
});
test('installed RRFS bridge and readiness agree on both final products and horizon', async () => {
  configureModelFeeds();
  const { model } = await loadLegacyBuilder('rrfs');
  assert.deepEqual(model.completionUrls('20261023', '00'), selectTargetCycles('rrfs', Date.parse('2026-10-23T03:55:00Z')).primaryCandidate.probeUrls);
  assert.equal(model.pressureToken, 'prslev'); assert.equal(model.surfaceToken, '2dfld');
});
test('legacy acquisition forwards the selected run and deliberately permits a same-run backfill', async t => {
  const root = mkdtempSync(join(tmpdir(), 'provider-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = { provider: 'NOAA', model: 'rrfs', product: 'rrfs', referenceTime: profile.run.referenceTime };
  let called = 0;
  const adapter = createLegacyAdapter('rrfs', { load: async () => ({ model: {}, build: async options => {
    called++;
    assert.equal(options.referenceTime, run.referenceTime); assert.equal(options.history, false);
    assert.equal((await options.dataset.fetch('https://published.example/rrfs/manifest.json')).status, 404);
    const { sites } = JSON.parse(readFileSync(options.sitesPath));
    const document = structuredClone(profile); document.site.id = sites[0].slug; document.site.latitude = sites[0].latitude; document.site.longitude = sites[0].longitude;
    mkdirSync(join(options.outputRoot, 'rrfs/sites'), { recursive: true });
    writeFileSync(join(options.outputRoot, 'rrfs/sites', `${sites[0].slug}.json`), JSON.stringify(document));
    writeFileSync(join(options.outputRoot, 'rrfs/manifest.json'), JSON.stringify({ schemaVersion: 1, model: 'rrfs', referenceTime: run.referenceTime, generatedAt: profile.run.generatedAt,
      firstForecastHour: 1, lastForecastHour: document.hours.length, forecastHours: document.hours.length,
      sites: [{ slug: sites[0].slug, name: 'Test' }], stats: { downloads: 0, downloadBytes: 0, durationMs: 0, retries: 0 } }));
  } }) });
  const request = { run, outputRoot: root, sites: [{ slug: 'test', name: 'Test', latitude: 48, longitude: -122, timeZone: 'America/Los_Angeles' }] };
  const acquired = await adapter.acquire(request);
  assert.equal(acquired.stage, 'upstream-derived');
  assert.deepEqual(acquired.derivation, { package: '@azohra/meteo.forecast', version: '0.6.0' });
  assert.equal((await adapter.acquire(request)).kind, 'processed-profile');
  assert.equal(called, 2);
});
test('ICON normalization adds explicit provenance without modifying native numeric columns', async () => {
  const native = normalizeIconExtract(raw), snapshot = JSON.stringify(native.hours);
  const record = iconColumnRecord(native, 0, 0);
  assert.ok(parseNormalizedColumnRecord(record));
  assert.equal(record.column, native.hours[0].sources[0]);
  assert.equal(record.provenance.fieldSemantics.sensibleHeatFluxWm2.positiveDirection, 'upward');
  assert.equal(JSON.stringify(native.hours), snapshot);
  const site = Object.keys(native.siteCells)[0];
  const adapter = createIconAdapter({ forecastHours: native.hours.map(hour => hour.forecastHour), acquire: async () => native });
  native.hours[0].sources[native.siteCells[site]] = null;
  await assert.rejects(adapter.acquire({ run: { provider: 'DWD', model: 'icon-eu', product: 'native', referenceTime: native.referenceTime }, cacheDir: '/unused', outputRoot: '/unused', sites: [{ slug: site, latitude: 40, longitude: 44 }] }), /missing selected column/);
});
test('adapter requests reject invalid step limits before acquisition', async () => {
  const native = normalizeIconExtract(raw), site = Object.keys(native.siteCells)[0];
  const unused = async () => { assert.fail('invalid requests must not start acquisition'); };
  const adapters = [createLegacyAdapter('rrfs', { load: unused }), createIconAdapter({ acquire: unused })];
  for (const adapter of adapters) for (const maxSteps of [0, -1, 1.5, Infinity, NaN]) {
    await assert.rejects(adapter.acquire({
      run: { provider: adapter.model.provider, model: adapter.model.id, product: adapter.model.product, referenceTime: native.referenceTime },
      outputRoot: '/unused', cacheDir: '/unused', sites: [{ slug: site, latitude: 40, longitude: 44 }], maxSteps,
    }), /maxSteps must be a positive integer/);
  }
});
test('ICON honors the request limit on its configured schedule and rejects a changed horizon', async () => {
  const native = normalizeIconExtract(raw), site = Object.keys(native.siteCells)[0];
  const hourAt = forecastHour => {
    const hour = structuredClone(native.hours[0]);
    hour.forecastHour = forecastHour;
    hour.validAt = new Date(Date.parse(native.referenceTime) + forecastHour * 3_600_000).toISOString();
    hour.sources = hour.sources.map(column => column && { ...column, validAt: hour.validAt });
    return hour;
  };
  const request = { run: { provider: 'DWD', model: 'icon-eu', product: 'native', referenceTime: native.referenceTime },
    outputRoot: '/unused', cacheDir: '/unused', sites: [{ slug: site, latitude: 40, longitude: 44 }], maxSteps: 2 };
  const calls = [];
  const adapter = createIconAdapter({ forecastHours: [2, 4, 6], acquire: async options => {
    calls.push(options.forecastHours);
    return { ...native, hours: options.forecastHours.map(hourAt) };
  } });
  const acquired = await adapter.acquire(request);
  assert.deepEqual(calls, [[2, 4]]);
  assert.deepEqual(acquired.native.hours.map(hour => hour.forecastHour), [2, 4]);
  assert.equal(acquired.columns.length, 2);
  const defaultAdapter = createIconAdapter({ acquire: async options => {
    assert.deepEqual(options.forecastHours, [1, 2]);
    return { ...native, hours: options.forecastHours.map(hourAt) };
  } });
  await defaultAdapter.acquire(request);
  for (const hours of [[], [hourAt(2)], [hourAt(2), hourAt(4), hourAt(6)], [hourAt(2), hourAt(6)],
    [hourAt(2), { ...hourAt(4), validAt: hourAt(6).validAt }]]) {
    const incomplete = createIconAdapter({ forecastHours: [2, 4, 6], acquire: async () => ({ ...native, hours }) });
    await assert.rejects(incomplete.acquire(request), /different forecast horizon/);
  }
});
test('terrain source verification uses only the operator-supplied policy', () => {
  const policy = { id: 'selected-dem', elevationSources: ['fine-dem', 'fallback-dem'], terrainSource: 'horizon-dem', landCoverSource: 'cover' };
  const measurement = { elevation: { source: 'fine-dem' }, terrain: { source: 'horizon-dem' }, landCover: { source: 'cover' } };
  assert.equal(terrainPolicyId(policy), 'terrain-v1:selected-dem');
  assert.equal(terrainSourcesMatchPolicy(measurement, policy), true);
  assert.equal(terrainSourcesMatchPolicy({ ...measurement, elevation: { source: 'unrequested-dem' } }, policy), false);
});
