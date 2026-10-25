import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planModelBuild, executeModelTasks, validateModelDirectory, stageModel, fileStore, publishImmutableFiles, providerArtifactPaths, packProvider, packageBuildHashes, mergeRegionCatalogues } from '../dist/index.js';
import { modelDescriptor } from '@windgrams/providers/registry';
const profile = JSON.parse(readFileSync(new URL('../../../forecasts/soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
const run = { provider: 'NOAA', model: 'rrfs', product: 'rrfs', referenceTime: profile.run.referenceTime };
const temporary = t => { const root = mkdtempSync(join(tmpdir(), 'pipeline-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
function writeModel(root, doc = profile) {
  mkdirSync(join(root, 'rrfs/sites'), { recursive: true });
  writeFileSync(join(root, 'rrfs/sites', `${doc.site.id}.json`), JSON.stringify(doc));
  writeFileSync(join(root, 'rrfs/manifest.json'), JSON.stringify({ model: 'rrfs', referenceTime: run.referenceTime, forecastHours: doc.hours.length, sites: [{ slug: doc.site.id }] }));
}
test('planner distinguishes same-cycle backfill, corruption repair, current and older work', () => {
  const input = { run, publishedRun: run.referenceTime, complete: true, inventoryMatches: true };
  assert.equal(planModelBuild(input), null);
  assert.equal(planModelBuild({ ...input, inventoryMatches: false }).reason, 'backfill');
  assert.equal(planModelBuild({ ...input, complete: false }).reason, 'repair');
  assert.equal(planModelBuild({ ...input, publishedRun: '2099-01-01T00:00:00Z' }), null);
  assert.equal(planModelBuild({ ...input, run: null }), null);
});
test('completeness rejects wrong model, repeated timestamps and missing catalogue sites', t => {
  const root = temporary(t); writeModel(root);
  const options = { model: 'rrfs', expectedSites: [profile.site.id] };
  assert.equal(validateModelDirectory(root, options).referenceTime, run.referenceTime);
  assert.throws(() => validateModelDirectory(root, { ...options, expectedSites: [...options.expectedSites, 'new'] }), /inventory/);
  for (const mutate of [doc => { doc.model = 'gfs'; }, doc => { doc.hours[1].validAt = doc.hours[0].validAt; }, doc => { doc.hours[1].validAt = '2099-01-01T01:30:00Z'; }]) {
    const doc = structuredClone(profile); mutate(doc); writeModel(root, doc);
    assert.throws(() => validateModelDirectory(root, options), /invalid profile|valid times/);
  }
});
test('production completeness rejects a self-consistent shortened horizon and an interior gap', t => {
  const root = temporary(t), expectedForecastHours = modelDescriptor('rrfs').forecastHours;
  const options = { model: 'rrfs', expectedForecastHours };
  writeModel(root);
  assert.equal(validateModelDirectory(root, options).referenceTime, run.referenceTime);
  const truncated = structuredClone(profile); truncated.hours = truncated.hours.slice(0, 1); writeModel(root, truncated);
  assert.throws(() => validateModelDirectory(root, options), /requested forecast hours/);
  const gap = structuredClone(profile); gap.hours.splice(20, 1); writeModel(root, gap);
  assert.throws(() => validateModelDirectory(root, options), /requested forecast hours/);
  assert.equal(validateModelDirectory(root, { model: 'rrfs', expectedForecastHours: expectedForecastHours.filter(hour => hour !== 21) }).referenceTime, run.referenceTime);
});
test('failed staged diagnostics preserve complete last-good bytes', async t => {
  const root = temporary(t); writeModel(root);
  const before = readFileSync(join(root, 'rrfs/manifest.json'));
  await assert.rejects(stageModel({ outputRoot: root, model: 'rrfs', build: async staging => writeModel(staging), finish: () => { throw new Error('diagnostics failed'); } }), /diagnostics failed/);
  assert.deepEqual(readFileSync(join(root, 'rrfs/manifest.json')), before);
});
test('models recover independently and empty work performs no operation', async () => {
  let good = 0;
  const results = await executeModelTasks([
    { model: 'one', build: async () => { throw new Error('offline'); }, lastGood: async () => 'retained-data' },
    { model: 'two', build: async () => ++good, lastGood: async () => null },
    { model: 'three', build: async () => { throw new Error('first run'); }, lastGood: async () => null },
  ], 2);
  assert.deepEqual(results.map(result => result.status), ['retained', 'updated', 'unavailable']);
  assert.equal(good, 1); assert.deepEqual(await executeModelTasks([]), []);
});
test('publication writes immutable files before pointers and refuses traversal', async t => {
  const root = temporary(t), store = fileStore(root), calls = [];
  const recording = { ...store, put: async (key, value) => { calls.push(key); await store.put(key, value); } };
  await publishImmutableFiles(recording, new Map([['bundles/hash/data.json', '{}']]), new Map([['index.json', '{}']]));
  assert.deepEqual(calls, ['bundles/hash/data.json', 'index.json']);
  assert.equal(Buffer.from(await store.get('index.json')).toString(), '{}');
  await assert.rejects(store.put('../outside', 'bad'), /invalid dataset key/);
});
test('unknown regional directories cannot be claimed by the NOAA artifact', t => {
  const root = temporary(t); mkdirSync(join(root, 'soaring/v1/unknown-live'), { recursive: true });
  writeFileSync(join(root, 'soaring/v1/unknown-live/index.json'), '{}');
  assert.deepEqual(providerArtifactPaths(root, 'noaa-cloud'), []);
});
test('provider repacking replaces stale files and keeps output intact when selection fails', t => {
  const root = temporary(t), source = join(root, 'data'), output = join(root, 'slice');
  mkdirSync(join(source, 'gfs'), { recursive: true });
  writeFileSync(join(source, 'gfs/manifest.json'), 'current');
  assert.deepEqual(packProvider(source, output, 'rrfs'), []);
  assert.deepEqual(readdirSync(output), ['EMPTY']);
  mkdirSync(join(output, 'old-model'));
  writeFileSync(join(output, 'old-model/stale.json'), 'stale');
  assert.deepEqual(packProvider(source, output, 'noaa-cloud'), ['gfs']);
  assert.deepEqual(readdirSync(output), ['gfs']);
  assert.equal(readFileSync(join(output, 'gfs/manifest.json'), 'utf8'), 'current');
  assert.throws(() => packProvider(source, output, 'noaa-cloud', { extraPaths: ['../outside'] }), /invalid dataset key/);
  assert.equal(readFileSync(join(output, 'gfs/manifest.json'), 'utf8'), 'current');
  rmSync(join(source, 'gfs'), { recursive: true });
  packProvider(source, output, 'noaa-cloud');
  assert.deepEqual(readdirSync(output), ['EMPTY']);
});
test('provider packing rejects direct and symlink source/output overlap before removing data', t => {
  const root = temporary(t), source = join(root, 'data'), alias = join(root, 'alias'), ancestor = join(root, 'ancestor');
  mkdirSync(join(source, 'gfs'), { recursive: true });
  writeFileSync(join(source, 'gfs/manifest.json'), 'retained');
  symlinkSync(source, alias, 'dir');
  symlinkSync(root, ancestor, 'dir');
  for (const [input, output] of [[source, source], [source, join(source, 'new/slice')], [source, root],
    [source, alias], [source, join(alias, 'new/slice')], [alias, source], [source, ancestor]]) {
    assert.throws(() => packProvider(input, output, 'noaa-cloud'), /separate directories/);
    assert.equal(readFileSync(join(source, 'gfs/manifest.json'), 'utf8'), 'retained');
  }
  const output = join(root, 'selected-target');
  mkdirSync(output);
  writeFileSync(join(output, 'manifest.json'), 'selected data');
  symlinkSync(output, join(source, 'rrfs'), 'dir');
  assert.throws(() => packProvider(source, output, 'rrfs'), /separate directories/);
  assert.equal(readFileSync(join(output, 'manifest.json'), 'utf8'), 'selected data');
});
test('corrupt foreign and unowned regional metadata cannot block a healthy provider artifact', t => {
  const root = temporary(t), regions = join(root, 'soaring/v1');
  mkdirSync(join(root, 'gfs'), { recursive: true }); writeFileSync(join(root, 'gfs/manifest.json'), '{}');
  for (const name of ['armenia-icon-eu-live', 'unknown-live']) {
    mkdirSync(join(regions, name), { recursive: true }); writeFileSync(join(regions, name, 'index.json'), 'broken JSON');
  }
  writeFileSync(join(regions, 'regions-icon-eu.json'), 'broken foreign catalogue');
  const options = { regionIndexes: [{ model: 'hrrr-conus', file: 'regions.json' }, { model: 'icon-eu', file: 'regions-icon-eu.json' }],
    resolveLegacyCase: id => id === 'armenia-icon-eu-live' ? 'icon-eu' : undefined };
  assert.deepEqual(providerArtifactPaths(root, 'noaa-cloud', options), ['gfs']);
  assert.throws(() => providerArtifactPaths(root, 'dwd', options), SyntaxError, 'an owned corrupt catalogue still fails');
  rmSync(join(regions, 'regions-icon-eu.json'));
  assert.throws(() => providerArtifactPaths(root, 'dwd', options), SyntaxError, 'an owned corrupt pointer still fails');
  writeFileSync(join(regions, 'regions.json'), JSON.stringify({ regions: [{ caseId: 'unknown-live', nativeModels: [{ model: 'hrrr-conus', caseId: 'unknown-live' }] }] }));
  assert.throws(() => providerArtifactPaths(root, 'noaa-cloud', options), SyntaxError, 'an explicitly owned corrupt pointer still fails');
});
test('package provenance reads shipped inventories and includes transitive runtime packages', () => {
  const hashes = packageBuildHashes(['@windgrams/providers']);
  assert.ok(Object.keys(hashes).some(key => key.startsWith('@windgrams/contracts@')));
  assert.ok(Object.keys(hashes).some(key => key.endsWith('internal/icon-decode.py')));
});
test('regional merging accepts caller-owned models and preserves overlay ownership', () => {
  const primary = { regions: [{ id: 'custom-region', caseId: 'custom-old', nativeModels: [
    { model: 'custom-model', caseId: 'custom-old' }, { model: 'gfs', caseId: 'global-run' },
  ] }] };
  const merged = mergeRegionCatalogues(primary, [{ model: 'custom-model', index: { regions: [{ id: 'custom-region', nativeModels: [
    { model: 'custom-model', caseId: 'custom-new' }, { model: 'gfs', caseId: 'foreign-old' },
  ] }] } }], () => true, { preferredModels: ['custom-model'] });
  assert.equal(merged.regions[0].caseId, 'custom-new');
  assert.deepEqual(merged.regions[0].nativeModels, [
    { model: 'custom-model', caseId: 'custom-new' }, { model: 'gfs', caseId: 'global-run' },
  ]);
  assert.equal(primary.regions[0].caseId, 'custom-old');
  assert.deepEqual(mergeRegionCatalogues({ regions: [{ id: 'custom-region', caseId: 'custom-new' }] }, [], () => true,
    { primaryModel: 'custom-model' }).regions[0].nativeModels, [{ model: 'custom-model', caseId: 'custom-new' }]);
});
