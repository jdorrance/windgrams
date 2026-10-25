// Smoke test: acquire, derive, publish, read and render through installed packages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePublishedProfileJson } from '@windgrams/contracts/published-lift';
import { fieldDefinition, heightAboveGround } from '@windgrams/contracts/fields';
import type { AcquisitionAdapter, ModelDescriptor, ProcessedProfileResult, SelectedRun } from '@windgrams/providers';
import { postprocessPointForecast } from '@windgrams/soaring/compatibility';
import { deriveProduct, fileStore, publishImmutableFiles, packageBuildHashes, mergeRegionCatalogues } from '@windgrams/pipeline';
import { createForecastClient } from '@windgrams/data-client';
import { buildWindgramView, readWindgram, type WindgramView } from '@windgrams/windgram/scene';
import { renderWindgramSvg } from '@windgrams/windgram/svg';
import { coversPoint } from '@windgrams/geography';

const original = parsePublishedProfileJson(readFileSync(new URL('./profile.json', import.meta.url), 'utf8'));
assert.ok(original, 'the retained input fixture must satisfy the published profile contract');
assert.equal(fieldDefinition('usableLiftTopM').heightReference, 'MSL');
assert.equal(heightAboveGround(2500, 'EGM96', {
  kind: 'model', elevationM: 1600, verticalDatum: 'EGM96', source: 'fixture',
})?.heightM, 900);
const profileFixture = { ...original, model: 'portable-model' };
const schedule = profileFixture.hours.map(hour => (Date.parse(hour.validAt) - Date.parse(profileFixture.run.referenceTime)) / 3_600_000);
const pressureLevels = profileFixture.hours[0].levels.map(level => {
  assert.ok(typeof level.pressureHpa === 'number', 'this fixture adapter expects scalar pressure levels');
  return level.pressureHpa;
});
const model: ModelDescriptor = {
  id: profileFixture.model, provider: 'Fixture Service', producer: 'Fixture Service', deliverySource: 'Local fixture',
  sourceProducts: ['retained-profile'], sourceCapabilities: { verticalCoordinates: 'pressure-levels', ensemble: 'deterministic',
    fields: { levels: 'available', heatFluxes: 'available', verticalVelocity: 'available' } },
  product: 'processed-profile', jobGroup: 'fixture', coverage: 'global', nativeGrid: false, ensemble: false,
  forecastHours: schedule, cyclesUtc: [0, 6, 12, 18], horizonHours: schedule.at(-1)!, expectedLagMinutes: 60, terrainRequired: false,
  publication: { attribution: 'Retained fixture for integration testing', license: null, permission: 'operator-policy-required', termsUrl: null },
  catalogue: {
    slug: profileFixture.model, label: 'Portable fixture model', provider: 'Fixture Service', gridKm: 3, stepHours: 1,
    horizonHours: schedule.at(-1)!, runIntervalHours: 6, typicalPublicationLagHours: 1, kind: 'deterministic', experimental: true,
    capabilities: { levels: true, pressureLevels, verticalVelocity: 'omega',
      heatFluxes: true, gust: 'instant', precipitation: 'instantRate', cape: true, cin: true, pblHeight: true,
      cloudLayers: true, cloudProfile: false, smoke: 'radiativelyCoupled' },
  },
};
const run: SelectedRun = { provider: model.provider, product: model.sourceProducts[0], model: model.id, referenceTime: profileFixture.run.referenceTime };
const adapter: AcquisitionAdapter<ProcessedProfileResult> = {
  model,
  async acquire(request) {
    assert.deepEqual(request.run, run);
    assert.deepEqual(request.sites.map(site => site.slug), [profileFixture.site.id]);
    if (request.maxSteps !== undefined && (!Number.isInteger(request.maxSteps) || request.maxSteps < 1)) throw new Error('maxSteps must be a positive integer');
    const selectedHours = schedule.slice(0, request.maxSteps ?? schedule.length);
    const selectedProfile = { ...profileFixture, hours: profileFixture.hours.slice(0, selectedHours.length) };
    const manifest: ProcessedProfileResult['manifest'] = {
      schemaVersion: 1, model: model.id, referenceTime: run.referenceTime, generatedAt: profileFixture.run.generatedAt,
      firstForecastHour: selectedHours[0], lastForecastHour: selectedHours.at(-1)!, forecastHours: selectedHours.length,
      sites: [{ slug: profileFixture.site.id, name: profileFixture.site.name }],
      stats: { downloads: 0, downloadBytes: 0, retries: 0, durationMs: 0 },
    };
    return { kind: 'processed-profile', stage: 'upstream-derived', run: request.run,
      derivation: { package: '@example/fixture-provider', version: '1.0.0' }, profiles: [selectedProfile], manifest };
  },
};
const outputRoot = fileURLToPath(new URL('./dataset', import.meta.url));
const acquired = await adapter.acquire({ run, outputRoot, sites: [{ ...profileFixture.site, slug: profileFixture.site.id }] });
assert.equal(acquired.derivation.package, '@example/fixture-provider');
const result = await deriveProduct(acquired, { id: 'retained-v2', version: '2.1.0', derive(input) {
  assert.equal(input.kind, 'processed-profile');
  if (input.kind !== 'processed-profile') throw new Error('This diagnostic strategy requires processed profiles');
  return postprocessPointForecast(input.profiles[0]);
} });
const profile = result.value;
assert.equal(profile.run.referenceTime, original.run.referenceTime);
assert.deepEqual(profile.hours.map(hour => hour.surface), original.hours.map(hour => hour.surface));
assert.equal(result.derivation.inputStage, 'upstream-derived');
assert.equal(coversPoint({ kind: 'global' }, { latitude: -43.5, longitude: 172.6 }), true);
const regions = mergeRegionCatalogues({ regions: [{ id: 'portable-region', caseId: 'portable-case',
  nativeModels: [{ model: model.id, caseId: 'portable-case' }] }] }, [], caseId => caseId === 'portable-case');
assert.deepEqual(regions.regions[0].nativeModels, [{ model: model.id, caseId: 'portable-case' }]);

const store = fileStore(outputRoot);
const profileKey = `${model.id}/sites/${profile.site.id}.json`, manifestKey = `${model.id}/manifest.json`;
await publishImmutableFiles(store, new Map([[profileKey, JSON.stringify(profile)]]), new Map([[manifestKey, JSON.stringify(acquired.manifest)]]));
const requests: string[] = [];
const client = createForecastClient({ baseUrl: 'https://data.example/weather', fetch: async input => {
  const url = input instanceof Request ? input.url : String(input);
  requests.push(url);
  const path = new URL(url).pathname.replace('/weather/', '');
  const bytes = await store.get(path);
  return new Response(bytes ? new TextDecoder().decode(bytes) : null, { status: bytes ? 200 : 404,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
} });
const loaded = await client.loadProfile(model.id, profile.site.id);
assert.ok('document' in loaded, 'the custom provider must publish a valid manifest/profile pair');
assert.equal(loaded.stale, false);
assert.equal(loaded.manifest.referenceTime, loaded.document.run.referenceTime);
assert.equal(loaded.document.model, model.id);
assert.deepEqual(requests.sort(), [`https://data.example/weather/${manifestKey}`, `https://data.example/weather/${profileKey}`].sort());
const views = (['imperial', 'metric'] as const).map(unitSystem => buildWindgramView(loaded.document, {
  timeZone: 'America/Los_Angeles', unitSystem, widthPx: 356, compact: true,
  launch: { name: 'Portable chart', elevationM: 350 },
}));
for (const [index, view] of views.entries()) {
  const svg = renderWindgramSvg(view, { idPrefix: `consumer-${index}` });
  assert.ok(svg.includes(`consumer-${index}-plot`));
  assert.ok(svg.includes('<svg'));
  const height = view.hours[0].usableLiftTopM;
  if (typeof height === 'number') {
    const inspected = readWindgram(view, 0, height);
    assert.equal(inspected.heightAglM, inspected.heightM - 350);
  }
  await store.put(`chart-${index}.svg`, svg);
}
const forecastHours = (view: WindgramView) => view.hours.map(({ validAt, usableLiftTopM, thermalVelocityMps }) => ({ validAt, usableLiftTopM, thermalVelocityMps }));
assert.deepEqual(forecastHours(views[0]), forecastHours(views[1]));
assert.deepEqual(readWindgram(views[0], 0, 1000), readWindgram(views[1], 0, 1000));
assert.ok(Object.keys(packageBuildHashes(['@windgrams/soaring', '@windgrams/providers'])).length > 20);
console.log('Independent typed consumer: custom acquisition → diagnostics → publication → paired reader → two charts passed.');
