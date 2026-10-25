import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { discoverRegionalDatasets, openRegionalDataset, openRegionalDatasetFromDocuments, reconstructRegionalCellProfile } from '@windgrams/data-client/dataset';

function fixture({ shard = false, count = 3 } = {}) {
  const model = shard ? 'icon-eu' : 'hrrr-conus';
  const referenceTime = '2026-10-25T12:00:00.000Z';
  const hours = Array.from({ length: count }, (_, forecastHour) => ({
    forecastHour, validAt: new Date(Date.parse(referenceTime) + forecastHour * 3_600_000).toISOString(),
    thermalVelocityMps: [1, 0], usableLiftTopM: [1600, null], boundaryLayerTopM: [1800, 100], cloudBaseM: [1700, 300], pblHeightM: [1700, 0],
    thermalVelocityV2Mps: [1.2, 0], usableLiftTopV2M: [1650, null], resolvedThermalTopM: [1900, null],
    wind10mSpeedMps: [3, 0], wind10mDirDeg: [270, 0], sensibleHeatFluxWm2: [180, 0], latentHeatFluxWm2: [50, 0],
    cloudCoverPercent: [20, 0], precipitationMmHr: [0, 0], sfcT: [18 + forecastHour, 12], sfcTd: [10, 5], mslp: [1013, 1012],
    levelsByPressure: {
      '900': { h: [1000, 1000], t: [10, 6], td: [5, 2], ws: [5, 2], wd: [270, 270], vv: [null, null] },
      '800': { h: [2000, 2000], t: [2, 0], td: [0, -3], ws: [8, 4], wd: [280, 280], vv: [null, null] },
    },
    status: ['valid', 'valid'], levelCount: [2, 2], ceilingReached: [false, false],
  }));
  const manifest = {
    schemaVersion: 1, model, capturedAt: referenceTime, cellCount: 2, siteCell: 0,
    semantics: { gust: 'instant', precipitation: 'instantRate' },
    case: { id: `${model}-test`, model, referenceTime, bbox: [0, 0, 2, 1], sinkMps: 1, pressureLevels: [900, 800],
      site: { name: 'Test', latitude: 0.5, longitude: 0.5, timeZone: 'UTC' }, launchElevation: { elevationM: 100 } },
    versions: { algorithm: 'test' },
    hours: hours.map(hour => ({ forecastHour: hour.forecastHour, validAt: hour.validAt, file: `f${hour.forecastHour}.json${shard ? '.gz' : ''}` })),
    ...(shard ? { cellProfiles: 'cell-{index}.json.gz' } : {}),
  };
  const grid = { type: 'FeatureCollection', features: [0, 1].map(i => ({
    type: 'Feature', id: `cell-${i}`, properties: { cellIndex: i, gridIndex: i + 10, id: `cell-${i}`, latitude: 0.5, longitude: i + 0.5, modelElevationM: 100 },
    geometry: { type: 'Polygon', coordinates: [[[i, 0], [i + 1, 0], [i + 1, 1], [i, 1], [i, 0]]] },
  })) };
  const documents = new Map([
    ['manifest.json', manifest], ['grid.geojson', grid],
    ...hours.map((hour, index) => [manifest.hours[index].file, hour]),
  ]);
  for (let i = 0; i < 2; i++) documents.set(`cell-${i}.json.gz`, { ...reconstructRegionalCellProfile(manifest, hours, i, grid.features[i].properties), source: { gridIndex: i + 10 } });
  const calls = [];
  const read = async url => {
    const filename = url.split('/').at(-1); calls.push(filename);
    assert.ok(documents.has(filename), `unexpected read ${url}`);
    return structuredClone(documents.get(filename));
  };
  return { manifest, grid, hours, documents, calls, read };
}
const request = (validAt, extra = {}) => ({ position: { latitude: 0.5, longitude: 0.5 }, validAt, fields: ['wind10mSpeedMps', 'usableLiftTopV2M'], ...extra });
const open = f => openRegionalDatasetFromDocuments({ bundleUrl: '/fixed', manifest: f.manifest, grid: f.grid, read: f.read });

test('opening resolves one pointer, then loads only requested hours within that bundle', async () => {
  const f = fixture({ shard: true }), calls = [], hash = 'a'.repeat(64);
  const base = `/custom/soaring/v1/${f.manifest.case.id}`;
  const dataset = await openRegionalDataset({ baseUrl: '/custom', caseId: f.manifest.case.id, fetch: async url => {
    calls.push(String(url));
    if (url === `${base}/index.json`) return Response.json({ schemaVersion: 1, caseId: f.manifest.case.id, bundle: `bundles/${hash}`, manifestSha256: hash });
    assert.ok(url.startsWith(`${base}/bundles/${hash}/`));
    const filename = url.split('/').at(-1), doc = f.documents.get(filename);
    return filename.endsWith('.gz') ? new Response(gzipSync(JSON.stringify(doc))) : Response.json(doc);
  } });
  assert.equal(calls.length, 3);
  assert.equal(dataset.identity.bundleUrl, `${base}/bundles/${hash}`);
  assert.ok(Object.isFrozen(dataset.manifest.hours) && Object.isFrozen(dataset.grid.features[0].geometry.coordinates));
  await Promise.all([dataset.loadHour(f.hours[1].validAt), dataset.loadHour(f.hours[1].validAt)]);
  assert.equal(calls.length, 4);
  assert.equal(calls.filter(url => url.endsWith('index.json')).length, 1);
  assert.equal((await dataset.loadCellProfile(1)).source.gridIndex, 11);
  assert.equal(calls.length, 5, 'a sharded profile needs no hourly arrays');
});

test('native coordinate and exact time sampling preserve gaps, zeroes and null field states', async () => {
  const f = fixture(), dataset = open(f), validAt = f.hours[1].validAt;
  const sampled = await dataset.sample(request(validAt, { position: { latitude: 0.5, longitude: 1.5 }, fields: ['wind10mSpeedMps', 'usableLiftTopV2M', 'w925Mps'] }));
  assert.deepEqual(sampled.selected.cell, { cellIndex: 1, gridIndex: 11, latitude: 0.5, longitude: 1.5, modelElevationM: 100, distanceKm: 0 });
  assert.deepEqual(sampled.values, { wind10mSpeedMps: { status: 'valid', value: 0 }, usableLiftTopV2M: { status: 'missing', value: null }, w925Mps: { status: 'unsupported', value: null } });
  const outside = await dataset.sample(request(validAt, { position: { latitude: 20, longitude: 20 } }));
  assert.equal(outside.gap, 'outside-coverage'); assert.equal(outside.selected.cell, null); assert.equal(outside.selected.time.validAt, validAt);
  const missingTime = await dataset.sample(request('2026-10-25T13:30:00Z'));
  assert.equal(missingTime.gap, 'time-unavailable'); assert.equal(missingTime.selected.cell.gridIndex, 10); assert.equal(missingTime.selected.time, null);
  const nearest = await dataset.sample(request('2026-10-25T13:30:00Z', { timeToleranceMinutes: 30 }));
  assert.equal(nearest.selected.time.validAt, f.hours[1].validAt, 'ties choose earlier');
  assert.equal((await dataset.sample(request('2026-10-25T15:00:00Z', { timeToleranceMinutes: 30 }))).gap, 'time-unavailable');
  assert.equal((await dataset.loadHour('2026-10-25T08:00:00-04:00')).validAt, f.hours[0].validAt);
  assert.equal(await dataset.loadHour('2026-10-25T13:30:00Z'), null);
  assert.deepEqual(f.calls, ['f1.json', 'f0.json']);
});

test('array and sharded profiles preserve the same published values and incomplete columns stay absent', async () => {
  const array = fixture(), sharded = fixture({ shard: true });
  const a = await open(array).loadCellProfile(0), b = await open(sharded).loadCellProfile(0);
  assert.deepEqual(a.hours, b.hours);
  assert.equal(a.site.modelElevationM, 100);
  assert.equal(a.hours[0].derived.usableLiftTopM, 1600);
  assert.equal(b.hours[0].soaring.usableLiftTopV2M, 1650);
  assert.deepEqual(sharded.calls, ['cell-0.json.gz']);
  const absent = fixture({ shard: true }); absent.manifest.files = { 'cell-0.json.gz': 'retained' };
  assert.equal(await open(absent).loadCellProfile(1), null);
  assert.deepEqual(absent.calls, [], 'manifest inventory identifies an unavailable cell profile before IO');
  const incomplete = fixture(); incomplete.hours[0].status[0] = 'insufficient-levels';
  assert.equal(await open(incomplete).loadCellProfile(0), null);
  const fields = await open(incomplete).sample(request(incomplete.hours[0].validAt));
  assert.equal(fields.values.usableLiftTopV2M.status, 'insufficient-profile');
  assert.equal(fields.values.wind10mSpeedMps.value, 3);
});

test('route requests retain order and all hourly IO stays bounded and deduplicated', async () => {
  const f = fixture({ count: 12 }); let active = 0, peak = 0;
  const dataset = openRegionalDatasetFromDocuments({ bundleUrl: '/fixed', manifest: f.manifest, grid: f.grid, read: async url => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    try { return await f.read(url); } finally { active--; }
  } });
  const requests = f.hours.map(hour => request(hour.validAt)).reverse();
  const results = await dataset.sampleRoute(requests, { concurrency: 12 });
  assert.deepEqual(results.map(result => result.selected.time.validAt), requests.map(request => request.validAt));
  assert.ok(peak > 1 && peak <= 4);
  assert.equal(f.calls.length, 12);
  await assert.rejects(dataset.sampleRoute([], { concurrency: 0 }), /concurrency/);
  const cached = await Promise.all([dataset.loadHour(f.hours[0].validAt), dataset.loadHour(f.hours[0].validAt)]);
  assert.equal(cached[0], cached[1]);
});

test('legacy primary profiles avoid downloading every map hour and retain identity checks', async () => {
  const f = fixture({ count: 12 });
  f.manifest.files = { 'profile.json': 'retained' };
  const profile = reconstructRegionalCellProfile(f.manifest, f.hours, 0, f.grid.features[0].properties);
  f.documents.set('profile.json', profile);
  assert.deepEqual((await open(f).loadCellProfile(0)).hours, profile.hours);
  assert.deepEqual(f.calls, ['profile.json']);
  const wrong = structuredClone(profile); wrong.site.longitude = 1.5;
  f.documents.set('profile.json', wrong);
  await assert.rejects(open(f).loadCellProfile(0), /primary profile differs/);
  const subset = openRegionalDatasetFromDocuments({ bundleUrl: '/fixed', manifest: f.manifest, grid: f.grid, read: f.read, availableValidTimes: [f.hours[0].validAt] });
  assert.equal(await subset.loadCellProfile(0), null, 'unsaved legacy primary profiles stay outside the offline scope');
  assert.equal(f.calls.length, 2);
  const saved = openRegionalDatasetFromDocuments({ bundleUrl: '/fixed', manifest: f.manifest, grid: f.grid, read: f.read,
    availableValidTimes: f.hours.map(hour => hour.validAt), availableCellIndices: [0] });
  assert.deepEqual((await saved.loadCellProfile(0)).hours, profile.hours);
  assert.equal(f.calls.filter(path => path === 'profile.json').length, 2, 'complete snapshots use their saved legacy arrays');
});

test('malformed bundle identities, hour records and profiles fail rather than become gaps', async () => {
  const f = fixture();
  const mismatched = open(f);
  f.hours[1].validAt = f.hours[0].validAt;
  await assert.rejects(mismatched.loadHour(f.manifest.hours[1].validAt), /differs from its manifest/);
  f.hours[1].validAt = f.manifest.hours[1].validAt;
  assert.equal((await mismatched.loadHour(f.manifest.hours[1].validAt)).forecastHour, 1, 'failed reads can retry');
  const wrongModel = fixture({ shard: true }); wrongModel.documents.get('cell-0.json.gz').model = 'wrong';
  await assert.rejects(open(wrongModel).loadCellProfile(0), /differs from its map/);
  const duplicate = fixture(); duplicate.manifest.hours[1] = duplicate.manifest.hours[0];
  assert.throws(() => open(duplicate), /inconsistent forecast hours/);
  const reordered = fixture(); reordered.manifest.hours.reverse();
  assert.throws(() => open(reordered), /inconsistent forecast hours/);
  const wrongLead = fixture(); wrongLead.manifest.hours[1].forecastHour = 9;
  assert.throws(() => open(wrongLead), /inconsistent forecast hours/);
  const missingModel = fixture(); delete missingModel.manifest.model; delete missingModel.manifest.case.model;
  assert.throws(() => open(missingModel), /missing its model identity/);
  assert.equal(openRegionalDatasetFromDocuments({ bundleUrl: '/fixed', manifest: missingModel.manifest, grid: missingModel.grid, model: 'explicit-archive-model' }).identity.model, 'explicit-archive-model');
  assert.equal(missingModel.manifest.model, undefined, 'archive identity normalization leaves the caller document intact');
  assert.throws(() => openRegionalDatasetFromDocuments({ bundleUrl: '/fixed', manifest: f.manifest, grid: f.grid, model: 'wrong-model' }), /expected model/);
  const wrongGrid = fixture(); wrongGrid.grid.features[1].properties.cellIndex = 9;
  assert.throws(() => open(wrongGrid), /Invalid regional grid/);
  await assert.rejects(openRegionalDataset({ baseUrl: '/data', caseId: f.manifest.case.id, fetch: async () => Response.json({ schemaVersion: 1, caseId: 'wrong', bundle: `bundles/${'a'.repeat(64)}` }) }), /Invalid regional bundle pointer/);
});

test('saved file scope preserves the exact primary profile and validates selected files', async () => {
  const f = fixture();
  f.manifest.files = { 'profile.json': 'retained' };
  const profile = reconstructRegionalCellProfile(f.manifest, f.hours, 0, f.grid.features[0].properties);
  profile.site.id = 'primary-launch';
  profile.hours[0].surface.temperatureC = 18.1234;
  f.documents.set('profile.json', profile);
  const scope = { bundleUrl: '/saved', manifest: f.manifest, grid: f.grid, read: f.read,
    availableValidTimes: f.hours.map(hour => hour.validAt), availableCellIndices: [0],
    availableFiles: [...f.manifest.hours.map(hour => hour.file), 'profile.json'],
  };
  const online = await open(f).loadCellProfile(0);
  const saved = await openRegionalDatasetFromDocuments(scope).loadCellProfile(0);
  assert.deepEqual(saved, online);
  assert.equal(saved.site.id, 'primary-launch');
  assert.equal(saved.hours[0].surface.temperatureC, 18.1234);
  assert.deepEqual(f.calls, ['profile.json', 'profile.json']);
  const arraysOnly = openRegionalDatasetFromDocuments({ ...scope, availableFiles: scope.availableFiles.filter(path => path !== 'profile.json') });
  assert.equal((await arraysOnly.loadCellProfile(0)).hours[0].surface.temperatureC, 18);
  assert.throws(() => openRegionalDatasetFromDocuments({ ...scope, availableFiles: ['profile.json'] }), /missing f0.json/);
  const partial = openRegionalDatasetFromDocuments({ ...scope, availableValidTimes: [f.hours[0].validAt], availableFiles: ['f0.json', 'profile.json'] });
  assert.equal(await partial.loadCellProfile(0), null, 'legacy profiles still require every map hour');

  const sharded = fixture({ shard: true });
  sharded.manifest.files = { 'cell-0.json.gz': 'retained' };
  const savedShard = { bundleUrl: '/saved', manifest: sharded.manifest, grid: sharded.grid, read: sharded.read,
    availableValidTimes: [sharded.hours[0].validAt], availableCellIndices: [0, 1], availableFiles: ['f0.json.gz'],
  };
  assert.throws(() => openRegionalDatasetFromDocuments(savedShard), /missing cell-0.json.gz/);
  const retained = openRegionalDatasetFromDocuments({ ...savedShard, availableFiles: ['f0.json.gz', 'cell-0.json.gz'] });
  assert.equal(await retained.loadCellProfile(1), null, 'an unpublished shard does not need a saved file');
  assert.ok(await retained.loadCellProfile(0));
});

test('offline scopes expose only saved times and profiles while retaining original manifest identity', async () => {
  const f = fixture({ shard: true });
  const dataset = openRegionalDatasetFromDocuments({ bundleUrl: '/fixed', manifest: f.manifest, grid: f.grid, read: f.read, availableValidTimes: [f.hours[1].validAt], availableCellIndices: [0] });
  assert.equal(dataset.manifest.hours.length, 3);
  assert.equal(await dataset.loadHour(f.hours[0].validAt), null);
  assert.equal(await dataset.loadCellProfile(1), null);
  assert.equal((await dataset.sample(request(f.hours[0].validAt))).gap, 'time-unavailable');
  assert.equal((await dataset.loadCellProfile(0)).hours.length, 3);
  assert.deepEqual(f.calls, ['cell-0.json.gz']);
  assert.throws(() => openRegionalDatasetFromDocuments({ bundleUrl: '/fixed', manifest: f.manifest, grid: f.grid, availableValidTimes: ['2020-01-01'] }), /outside the manifest/);
  const old = fixture();
  const subset = openRegionalDatasetFromDocuments({ bundleUrl: '/fixed', manifest: old.manifest, grid: old.grid, read: old.read, availableValidTimes: [old.hours[0].validAt] });
  assert.equal(await subset.loadCellProfile(0), null, 'a partial hourly cache cannot reconstruct a complete legacy profile');
});

test('invalid arguments and cancellation stop reads; returned documents cannot mutate the opened snapshot', async () => {
  const f = fixture(), controller = new AbortController();
  const dataset = openRegionalDatasetFromDocuments({ bundleUrl: '/fixed', manifest: f.manifest, grid: f.grid, read: f.read, signal: controller.signal });
  f.grid.features[0].properties.latitude = 50;
  assert.equal(dataset.grid.features[0].properties.latitude, 0.5);
  assert.throws(() => { dataset.manifest.hours.push({}); }, TypeError);
  await assert.rejects(dataset.loadCellProfile(3), /Invalid regional cell/);
  await assert.rejects(dataset.sample(request(f.hours[0].validAt, { position: { latitude: NaN, longitude: 0 } })), /Invalid regional sample position/);
  await assert.rejects(dataset.sample(request('bad')), /Invalid regional forecast time/);
  await assert.rejects(dataset.sample(request(f.hours[0].validAt, { timeToleranceMinutes: -1 })), /Time tolerance/);
  await assert.rejects(dataset.sample(request(f.hours[0].validAt, { fields: ['toString'] })), /Unknown regional field/);
  controller.abort(new Error('view removed'));
  await assert.rejects(dataset.loadHour(f.hours[0].validAt), /view removed/);
  await assert.rejects(dataset.sample(request(f.hours[0].validAt)), /view removed/);
  assert.deepEqual(f.calls, []);
});

test('discovery returns neutral, deduplicated published case descriptors', async () => {
  const region = { id: 'test', name: 'Test region', status: 'active-verified-trial', caseId: 'test-live', nativeModels: [{ model: 'custom', caseId: 'test-live' }, { model: 'custom', caseId: 'test-live' }], timeZone: 'UTC', morningBriefingLocalHour: 7, bbox: [0, 0, 2, 1], primarySite: 'test', launches: [], deterministicModels: [], ensembleModels: [], sparseAdapters: [] };
  const catalogue = { schemaVersion: 1, soaringContractVersion: 'test', generatedAt: '2026-10-25T12:00:00Z', trialRegionId: 'test', regions: [region, { ...region, id: 'planned', status: 'planned', nativeModels: [{ model: 'future', caseId: 'future' }] }] };
  const datasets = await discoverRegionalDatasets({ baseUrl: '/data', fetch: async url => { assert.equal(url, '/data/soaring/v1/regions.json'); return Response.json(catalogue); } });
  assert.deepEqual(datasets, [{ id: 'test-live', name: 'Test region', model: 'custom', bounds: [0, 0, 2, 1], timeZone: 'UTC' }]);
  await assert.rejects(discoverRegionalDatasets({ baseUrl: '/data', fetch: async () => Response.json({}) }), /Invalid regional catalogue/);
});

test('a late injected read and a queued cache hit reject after cancellation', async () => {
  const f = fixture(), controller = new AbortController(); let release, started;
  const reading = new Promise(resolve => { started = resolve; });
  const dataset = openRegionalDatasetFromDocuments({ bundleUrl: '/fixed', manifest: f.manifest, grid: f.grid, signal: controller.signal,
    read: () => { started(); return new Promise(resolve => { release = resolve; }); },
  });
  const pending = dataset.loadHour(f.hours[0].validAt);
  await reading;
  controller.abort(new Error('request cancelled'));
  release(structuredClone(f.hours[0]));
  await assert.rejects(pending, /request cancelled/);

  const cachedController = new AbortController();
  const cached = openRegionalDatasetFromDocuments({ bundleUrl: '/fixed', manifest: f.manifest, grid: f.grid, read: f.read, signal: cachedController.signal });
  await cached.loadHour(f.hours[0].validAt);
  const hit = cached.loadHour(f.hours[0].validAt);
  cachedController.abort(new Error('cached request cancelled'));
  await assert.rejects(hit, /cached request cancelled/);
  assert.deepEqual(f.calls, ['f0.json']);
});
