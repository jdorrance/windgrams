import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { mergeArtifacts } from './merge-artifacts.mjs';
import { regionalProduct } from './lib/artifact-products.mjs';
import { preparePublication } from './prepare-publication.mjs';
import { seedPublishedGroup } from './seed-published.mjs';
import { packRefresh } from './pack-refresh.mjs';
import { modelDescriptor } from '@windgrams/providers/registry';
import { terrainPolicyId } from './lib/terrain-policy.mjs';
import { postprocessPointForecast } from '@windgrams/soaring/compatibility';
import { SOARING_CONTRACT_VERSION } from '@windgrams/soaring';

const issuedProfile = JSON.parse(readFileSync(new URL('../soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
const sourceProfile = postprocessPointForecast(issuedProfile, { launchElevationM: issuedProfile.soaringMeta.launchElevationM });
const site = { slug: sourceProfile.site.id, name: sourceProfile.site.name, latitude: sourceProfile.site.latitude, longitude: sourceProfile.site.longitude, timeZone: sourceProfile.site.timeZone };
const sites = [site], referenceTime = sourceProfile.run.referenceTime;
const generatedAt = '2026-10-24T12:00:00Z';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = document => JSON.stringify(document) + '\n';
const encodedFile = (name, document) => name.endsWith('.gz') ? gzipSync(bytes(document)) : Buffer.from(bytes(document));
function write(path, document) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, encodedFile(path, document)); }
function workspace(t) { const root = mkdtempSync(join(tmpdir(), 'merge-products-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function labelMethod(profile, method) {
  profile.soaringMeta.contractVersion = method;
  for (const hour of profile.hours) if (hour.soaring) {
    hour.soaring.contractVersion = method;
    if (method === '2.2.0') { delete hour.soaring.diagnosticSupport; delete hour.soaring.verticalResolution.sampling; }
  }
}
function point(root, { run = referenceTime, generated = generatedAt, method = SOARING_CONTRACT_VERSION, model = 'rrfs' } = {}) {
  const profile = structuredClone(sourceProfile); profile.run.referenceTime = run; profile.model = model;
  const hours = modelDescriptor(model).forecastHours;
  profile.hours = hours.map((lead, i) => ({ ...profile.hours[i], validAt: new Date(Date.parse(run) + lead * 3600000).toISOString() }));
  labelMethod(profile, method);
  write(join(root, model, 'sites', `${site.slug}.json`), profile);
  write(join(root, model, 'manifest.json'), { model, referenceTime: run, generatedAt: generated, forecastHours: hours.length, firstForecastHour: hours[0], lastForecastHour: hours.at(-1), diagnosticMethod: { id: 'windgrams-soaring', version: method }, sites: [{ slug: site.slug, name: site.name }] });
  return profile;
}
function regional(root, caseId = 'test-rrfs-live', { run = referenceTime, generated = generatedAt, method = SOARING_CONTRACT_VERSION, edit = () => {} } = {}) {
  const profile = structuredClone(sourceProfile); profile.run.referenceTime = run;
  profile.hours = profile.hours.slice(0, 2).map((hour, i) => ({ ...hour, validAt: new Date(Date.parse(run) + (i + 1) * 3600000).toISOString() }));
  labelMethod(profile, method);
  const cell = { cellIndex: 0, id: 'test:0', gridIndex: 0, latitude: site.latitude, longitude: site.longitude, modelElevationM: profile.site.modelElevationM };
  const node = { nodeIndex: 0, distanceKm: 0, latitude: site.latitude, longitude: site.longitude, cellIndex: 0, gridIndex: 0,
    modelElevationM: profile.site.modelElevationM, waypointLabel: null, launchElevationM: 378.5 };
  const files = {
    'grid.geojson': { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'test:0', properties: cell,
      geometry: { type: 'Polygon', coordinates: [[[site.longitude, site.latitude], [site.longitude + .01, site.latitude], [site.longitude, site.latitude + .01], [site.longitude, site.latitude]]] } }] },
    'profile.json': profile,
    'audit.json': { sampledCell: { distanceKm: 0 }, terrain: { modelElevationM: profile.site.modelElevationM, launch: { elevationM: 378.5 } }, mapProfileAgreement: { exact: true, hours: 2, valuesChecked: 10 }, limitations: ['Synthetic publication fixture'] },
    'launches.json': { caseId, model: 'rrfs', launches: [{ ...site, cellIndex: 0, gridIndex: 0, distanceKm: 0, launchElevationM: 378.5,
      modelElevationM: profile.site.modelElevationM, models: { rrfs: { referenceTime: run, hours: profile.hours.map(hour => ({ validAt: hour.validAt })) } } }] },
    'cross-section.json': { caseId, model: 'rrfs', title: 'Test', totalDistanceKm: 1, nodes: [node, { ...node, nodeIndex: 1, distanceKm: 1 }] },
  };
  for (const [i, hour] of profile.hours.entries()) files[`f${i + 1}.json`] = { forecastHour: i + 1, validAt: hour.validAt, soaringContractVersion: method,
    thermalVelocityMps: [hour.derived.thermalVelocityMps], usableLiftTopM: [hour.derived.usableLiftTopM], boundaryLayerTopM: [hour.derived.boundaryLayerTopM],
    cloudBaseM: [hour.derived.cloudBaseM], pblHeightM: [hour.surface.pblHeightM], status: ['valid'], levelCount: [hour.levels.length], ceilingReached: [false] };
  const manifest = { schemaVersion: 1, model: 'rrfs', soaringContractVersion: method, capturedAt: generated, versions: { algorithm: 'synthetic-publication-fixture' },
    case: { id: caseId, model: 'rrfs', referenceTime: run, forecastHours: [1, 2], bbox: [-123, 48, -122, 49], sinkMps: 1, site, launchElevation: { elevationM: 378.5 } },
    cellCount: 1, siteCell: 0, hours: profile.hours.map((hour, i) => ({ forecastHour: i + 1, validAt: hour.validAt, file: `f${i + 1}.json` })) };
  edit({ manifest, files });
  manifest.files = Object.fromEntries(Object.entries(files).map(([name, document]) => [name, hash(encodedFile(name, document))]));
  const manifestBytes = bytes(manifest), id = hash(manifestBytes), bundle = `bundles/${id}`, directory = join(root, 'soaring/v1', caseId, bundle);
  for (const [name, document] of Object.entries(files)) write(join(directory, name), document);
  write(join(directory, 'manifest.json'), manifest);
  write(join(root, 'soaring/v1', caseId, 'index.json'), { bundle, manifestSha256: hash(manifestBytes) });
  return { caseId, bundle, directory };
}
function catalogue(root, caseIds, generated = generatedAt, method = SOARING_CONTRACT_VERSION) {
  write(join(root, 'soaring/v1/regions-rrfs.json'), { schemaVersion: 1, soaringContractVersion: method, generatedAt: generated, trialRegionId: 'test',
    regions: caseIds.map((caseId, i) => ({ id: `test-${i}`, name: 'Test', status: 'active-verified-trial', caseId, nativeModels: [{ model: 'rrfs', caseId }],
      timeZone: site.timeZone, morningBriefingLocalHour: 8, bbox: [-123, 48, -122, 49], primarySite: site.slug, launches: [site.slug], deterministicModels: ['rrfs'], ensembleModels: [], sparseAdapters: [] })) });
}
function terrain(root) {
  const elevationM = sourceProfile.soaringMeta.launchElevationM;
  write(join(root, 'site-context.json'), { schemaVersion: 3, generatedAt,
    sources: ['glo30', 'worldcover2021'].map(id => ({ id, product: id, kind: id === 'worldcover2021' ? 'landCover' : 'surfaceModel', resolutionM: 30, licence: 'test', attribution: 'synthetic fixture', url: 'https://example.invalid/terrain' })),
    measurementPolicies: { [site.slug]: terrainPolicyId(site) }, measurementTimes: { [site.slug]: generatedAt },
    sites: { [site.slug]: { point: { latitude: site.latitude, longitude: site.longitude }, elevation: { source: 'glo30', elevationM },
      terrain: { source: 'glo30', elevationM, slopeDeg: 10, aspectDeg: 180, relief: [{ radiusKm: 1, minM: 100, maxM: 500, percentile: 50 }] },
      landCover: { source: 'worldcover2021', atLaunch: 'grassland', fractions: [{ radiusKm: 1, byClass: { grassland: 1 } }] } } } });
}

test('regional profile inventory declares availability and validates every supplied cell identity', t => {
  for (const include of [false, true]) {
    const root = workspace(t);
    const built = regional(root, 'test-rrfs-live', { edit: ({ manifest, files }) => {
      manifest.cellProfiles = 'cell-{index}.json.gz';
      if (include) files['cell-0.json.gz'] = { ...files['profile.json'], source: { gridIndex: 0 } };
    } });
    assert.doesNotThrow(() => regionalProduct(join(root, 'soaring/v1'), built.caseId, ['rrfs']));
  }
  const root = workspace(t);
  const built = regional(root, 'test-rrfs-live', { edit: ({ manifest, files }) => {
    manifest.cellProfiles = 'cell-{index}.json.gz';
    files['cell-0.json.gz'] = { ...files['profile.json'], source: { gridIndex: 999 } };
  } });
  assert.throws(() => regionalProduct(join(root, 'soaring/v1'), built.caseId, ['rrfs']), /profile differs from manifest/);
});

test('regional publication rejects an incorrect download byte inventory', t => {
  const root = workspace(t);
  const built = regional(root, 'test-rrfs-live', { edit: ({ manifest, files }) => {
    manifest.fileBytes = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, encodedFile(name, value).byteLength]));
    manifest.fileBytes['profile.json']++;
  } });
  assert.throws(() => regionalProduct(join(root, 'soaring/v1'), built.caseId, ['rrfs']), /byte inventory/);
});

test('complete point candidates replace by initialization, repair invalid equal runs and retain newer valid issues', t => {
  const root = workspace(t), incoming = join(root, 'incoming'), source = join(incoming, 'data-rrfs'), output = join(root, 'data');
  point(source); point(output, { generated: '2026-10-25T12:00:00Z' });
  assert.ok(mergeArtifacts(incoming, output, { sites }).retained.includes('rrfs'));
  const destination = join(output, 'rrfs/sites', `${site.slug}.json`), broken = JSON.parse(readFileSync(destination)); delete broken.hours[0].soaring; write(destination, broken);
  assert.ok(mergeArtifacts(incoming, output, { sites }).accepted.includes('rrfs'));
  assert.deepEqual(readFileSync(destination), readFileSync(join(source, 'rrfs/sites', `${site.slug}.json`)));
  point(source, { run: '2026-10-21T12:00:00Z', generated: '2026-10-26T12:00:00Z' });
  const invalidManifest = JSON.parse(readFileSync(join(output, 'rrfs/manifest.json'))); delete invalidManifest.generatedAt; write(join(output, 'rrfs/manifest.json'), invalidManifest);
  assert.ok(mergeArtifacts(incoming, output, { sites }).retained.includes('rrfs'));
  assert.equal(JSON.parse(readFileSync(join(output, 'rrfs/manifest.json'))).referenceTime, referenceTime);
});

test('partial horizons and wrong provider ownership cannot replace cached points', t => {
  const root = workspace(t), incoming = join(root, 'incoming'), source = join(incoming, 'data-rrfs'), output = join(root, 'data');
  point(source); point(output);
  const path = join(source, 'rrfs/sites', `${site.slug}.json`), profile = JSON.parse(readFileSync(path)); profile.hours.pop(); write(path, profile);
  const original = readFileSync(join(output, 'rrfs/sites', `${site.slug}.json`));
  assert.ok(mergeArtifacts(incoming, output, { sites }).rejected.some(item => item.product === 'rrfs' && /incomplete profile/.test(item.reason)));
  assert.deepEqual(readFileSync(join(output, 'rrfs/sites', `${site.slug}.json`)), original);
  rmSync(source, { recursive: true }); point(join(incoming, 'data-eccc'));
  assert.ok(mergeArtifacts(incoming, output, { sites }).rejected.some(item => item.product === 'rrfs' && /ownership/.test(item.reason)));
});

test('regional publication rejects missing UI files, wrong ownership and inconsistent manifest/hour/profile times', t => {
  for (const edit of [
    ({ files }) => { delete files['profile.json']; }, ({ files }) => { delete files['audit.json']; },
    ({ manifest }) => { manifest.model = manifest.case.model = 'hrrr-conus'; },
    ({ manifest }) => { manifest.hours[0].validAt = '2020-01-01T00:00:00Z'; },
    ({ files }) => { files['f1.json'].validAt = '2020-01-01T00:00:00Z'; },
    ({ files }) => { files['profile.json'].hours[0].validAt = '2020-01-01T00:00:00Z'; },
  ]) {
    const root = workspace(t), source = join(root, 'incoming/data-rrfs'), output = join(root, 'data');
    regional(source, 'test-rrfs-live', { edit });
    const report = mergeArtifacts(join(root, 'incoming'), output, { sites });
    assert.equal(report.rejected.length, 1, JSON.stringify(report));
    assert.equal(existsSync(join(output, 'soaring/v1/test-rrfs-live/index.json')), false);
  }
});

test('verified same-run bundle bytes repair corrupt immutable destination before pointer publication', t => {
  const root = workspace(t), source = join(root, 'incoming/data-rrfs'), output = join(root, 'data');
  const built = regional(source); cpSync(source, output, { recursive: true });
  const destination = join(output, 'soaring/v1', built.caseId, built.bundle, 'f1.json'); writeFileSync(destination, 'broken');
  const report = mergeArtifacts(join(root, 'incoming'), output, { sites });
  assert.ok(report.accepted.includes(`soaring/${built.caseId}`), JSON.stringify(report));
  assert.deepEqual(readFileSync(destination), readFileSync(join(built.directory, 'f1.json')));
  regionalProduct(join(output, 'soaring/v1'), built.caseId, ['rrfs']);
});

test('dry-run validates the same merged catalogue candidate while leaving cached bytes untouched', t => {
  const root = workspace(t), source = join(root, 'incoming/data-rrfs'), output = join(root, 'data');
  regional(output, 'retained-rrfs-live'); regional(source, 'new-rrfs-live'); catalogue(source, ['retained-rrfs-live', 'new-rrfs-live']);
  const pointer = join(output, 'soaring/v1/retained-rrfs-live/index.json'), before = readFileSync(pointer);
  const dry = mergeArtifacts(join(root, 'incoming'), output, { sites, dryRun: true });
  assert.deepEqual(readFileSync(pointer), before);
  assert.equal(existsSync(join(output, 'soaring/v1/new-rrfs-live/index.json')), false);
  const applied = mergeArtifacts(join(root, 'incoming'), output, { sites });
  assert.deepEqual(dry, applied);
  assert.ok(applied.accepted.includes('soaring/v1/regions-rrfs.json'), JSON.stringify(applied));
});

test('legacy sidecars may omit optional identity; inactive and other-model catalogue templates do not require RRFS files', t => {
  const root = workspace(t), source = join(root, 'incoming/data-rrfs'), output = join(root, 'data');
  regional(source, 'old-rrfs-case', { edit: ({ files }) => { for (const name of ['launches.json', 'cross-section.json']) { delete files[name].caseId; delete files[name].model; } } });
  catalogue(source, ['old-rrfs-case']);
  const path = join(source, 'soaring/v1/regions-rrfs.json'), index = JSON.parse(readFileSync(path));
  index.regions.push({ ...index.regions[0], id: 'inactive', caseId: 'no-files-template', status: 'point-postprocessed-ready-for-grid', nativeModels: [] });
  index.regions.push({ ...index.regions[0], id: 'other-model', caseId: 'icon-case', nativeModels: [{ model: 'icon-eu', caseId: 'icon-case' }] });
  write(path, index);
  const report = mergeArtifacts(join(root, 'incoming'), output, { sites });
  assert.deepEqual(report.rejected, []); assert.ok(report.accepted.includes('soaring/v1/regions-rrfs.json'));
});

test('publication quarantines invalid cached products while retaining valid points and immutable regional evidence', t => {
  const root = workspace(t), output = join(root, 'data'); point(output); terrain(output);
  write(join(output, 'hrrr-conus/manifest.json'), { model: 'hrrr-conus', referenceTime });
  write(join(output, 'gfs/sites/stranded.json'), { invalid: true });
  write(join(output, 'history/hrrr-conus/retained.json'), { evidence: true });
  const built = regional(output); catalogue(output, [built.caseId]);
  writeFileSync(join(built.directory, 'f1.json'), 'corrupt');
  const report = preparePublication(join(root, 'absent-incoming'), output, { sites });
  assert.deepEqual(report.validated, ['rrfs']); assert.equal(report.unavailable[0].model, 'hrrr-conus');
  assert.equal(report.unavailable.some(item => item.model === 'gfs'), true); assert.equal(existsSync(join(output, 'gfs')), false);
  assert.equal(existsSync(join(output, 'hrrr-conus')), false); assert.equal(existsSync(join(output, 'history/hrrr-conus/retained.json')), true);
  assert.equal(report.unavailableRegions[0].caseId, built.caseId);
  assert.equal(existsSync(join(output, 'soaring/v1', built.caseId, 'index.json')), false);
  assert.equal(existsSync(join(built.directory, 'manifest.json')), true);
  assert.equal(JSON.parse(readFileSync(join(output, 'soaring/v1/regions.json'))).regions.some(region => region.nativeModels?.some(model => model.caseId === built.caseId)), false);
});

test('publication dry-run validates the entire candidate and leaves accepted and quarantined products untouched', t => {
  const root = workspace(t), output = join(root, 'data'), incoming = join(root, 'incoming'); point(output); terrain(output);
  const manifest = join(output, 'rrfs/manifest.json'), original = readFileSync(manifest);
  write(join(output, 'hrrr-conus/manifest.json'), { broken: true });
  point(join(incoming, 'data-rrfs'), { generated: '2026-10-26T12:00:00Z' });
  const report = preparePublication(incoming, output, { sites }, { dryRun: true });
  assert.ok(report.merged.accepted.includes('rrfs')); assert.equal(report.terrain.profilesChecked, 1);
  assert.equal(report.unavailable[0].model, 'hrrr-conus');
  assert.deepEqual(readFileSync(manifest), original); assert.equal(existsSync(join(output, 'hrrr-conus')), true);
  rmSync(join(output, 'site-context.json'));
  assert.throws(() => preparePublication(incoming, output, { sites }, { dryRun: true }), /Missing current launch terrain/);
  assert.deepEqual(readFileSync(manifest), original);
});

test('retained expanded regional pointers require the current method even without a native model entry', t => {
  const root = workspace(t), output = join(root, 'data'); point(output); terrain(output);
  const current = regional(output), old = regional(output, 'expanded-old', { edit: ({ manifest }) => { manifest.soaringContractVersion = '2.0.0'; } });
  catalogue(output, [current.caseId]);
  const path = join(output, 'soaring/v1/regions-rrfs.json'), index = JSON.parse(readFileSync(path)); index.regions[0].expandedCaseId = old.caseId; write(path, index);
  const report = preparePublication(join(root, 'absent'), output, { sites });
  assert.ok(report.unavailableRegions.some(item => item.caseId === old.caseId && /outdated/.test(item.reason)));
  assert.equal(existsSync(join(output, 'soaring/v1', current.caseId, 'index.json')), true);
  assert.equal(existsSync(join(output, 'soaring/v1', old.caseId, 'index.json')), false);
  assert.equal(JSON.parse(readFileSync(join(output, 'soaring/v1/regions.json'))).regions[0].expandedCaseId, undefined);
});

test('retained complete points remain usable after catalogue growth; incoming inventory stays strict', t => {
  const root = workspace(t), output = join(root, 'data'); point(output); terrain(output);
  write(join(output, 'solar/large-cache.json'), { cache: true }); write(join(output, '.scratch/retained.json'), { retained: true });
  const solarInode = statSync(join(output, 'solar/large-cache.json')).ino, scratchInode = statSync(join(output, '.scratch/retained.json')).ino;
  const expanded = [...sites, { ...site, slug: `${site.slug}-new` }];
  assert.deepEqual(preparePublication(join(root, 'absent-incoming'), output, { sites: expanded }).validated, ['rrfs']);
  assert.equal(statSync(join(output, 'solar/large-cache.json')).ino, solarInode);
  assert.equal(statSync(join(output, '.scratch/retained.json')).ino, scratchInode);
  point(join(root, 'incoming/data-rrfs'), { generated: '2026-10-26T12:00:00Z' });
  assert.ok(mergeArtifacts(join(root, 'incoming'), output, { sites: expanded }).rejected.some(item => item.product === 'rrfs' && /inventory/.test(item.reason)));
});

test('all-invalid first publication or failed terrain gate leaves the original dataset unchanged', t => {
  const root = workspace(t), incoming = join(root, 'incoming'), output = join(root, 'data');
  write(join(incoming, 'data-observations/nws/manifest.json'), { generatedAt, sites: [] });
  assert.throws(() => preparePublication(incoming, output, { sites }), /at least one complete model/);
  assert.equal(existsSync(output), false);
  write(join(output, 'hrrr-conus/manifest.json'), { broken: true });
  const original = readFileSync(join(output, 'hrrr-conus/manifest.json'));
  assert.throws(() => preparePublication(incoming, output, { sites }), /at least one complete model/);
  assert.deepEqual(readFileSync(join(output, 'hrrr-conus/manifest.json')), original);
  assert.equal(existsSync(join(output, 'nws')), false);
  point(join(incoming, 'data-rrfs'));
  assert.throws(() => preparePublication(incoming, output, { sites }), /Missing current launch terrain/);
  assert.deepEqual(readFileSync(join(output, 'hrrr-conus/manifest.json')), original);
  assert.equal(existsSync(join(output, 'rrfs')), false);
});


test('cold seeding and staggered 2.3 rollout retain original 2.2 bytes, upgrade equal runs and prevent downgrades', async t => {
  const root = workspace(t), live = join(root, 'live'), output = join(root, 'data'), incoming = join(root, 'incoming');
  point(live, { method: '2.2.0' }); point(live, { method: '2.2.0', model: 'hrrr-conus' }); terrain(live);
  const oldRegion = regional(live, 'test-rrfs-live', { method: '2.2.0' });
  catalogue(live, [oldRegion.caseId], generatedAt, '2.2.0');
  const getBytes = async key => existsSync(join(live, key)) ? readFileSync(join(live, key)) : null;
  for (const group of ['noaa-cloud', 'rrfs', 'soaring', 'terrain']) await seedPublishedGroup(output, group, { getBytes, sites });
  const pointPath = join('rrfs/sites', `${site.slug}.json`), pointerPath = join('soaring/v1', oldRegion.caseId, 'index.json');
  const originalPoint = readFileSync(join(live, pointPath)), originalPointer = readFileSync(join(live, pointerPath));
  const initial = preparePublication(incoming, output, { sites });
  assert.deepEqual(initial.validated, ['hrrr-conus', 'rrfs']);
  assert.deepEqual(initial.retainedMethods.map(item => item.methodVersion), ['2.2.0', '2.2.0']);
  assert.deepEqual(readFileSync(join(output, pointPath)), originalPoint);
  assert.deepEqual(readFileSync(join(output, pointerPath)), originalPointer);
  assert.throws(() => regionalProduct(join(output, 'soaring/v1'), oldRegion.caseId, ['rrfs']), /outdated/);
  const oldBundle = regionalProduct(join(output, 'soaring/v1'), oldRegion.caseId, ['rrfs'], { retained: true });
  assert.equal(oldBundle.manifest.soaringContractVersion, '2.2.0');

  // Same run and upstream generation time: the method upgrade still takes precedence.
  point(join(incoming, 'data-noaa-cloud'), { model: 'hrrr-conus' });
  const partial = preparePublication(incoming, output, { sites });
  assert.ok(partial.merged.accepted.includes('hrrr-conus'));
  assert.deepEqual(partial.retainedMethods, [{ product: 'rrfs', methodVersion: '2.2.0' }]);
  assert.deepEqual(readFileSync(join(output, pointPath)), originalPoint);
  assert.deepEqual(readFileSync(join(output, pointerPath)), originalPointer);

  point(join(incoming, 'data-rrfs'));
  const next = regional(join(incoming, 'data-rrfs')); catalogue(join(incoming, 'data-rrfs'), [next.caseId]);
  const complete = preparePublication(incoming, output, { sites });
  assert.deepEqual(complete.retainedMethods, []);
  assert.equal(JSON.parse(readFileSync(join(output, pointPath))).soaringMeta.contractVersion, SOARING_CONTRACT_VERSION);
  assert.equal(regionalProduct(join(output, 'soaring/v1'), next.caseId, ['rrfs']).manifest.soaringContractVersion, SOARING_CONTRACT_VERSION);
  assert.deepEqual(readFileSync(join(output, 'soaring/v1', oldRegion.caseId, oldRegion.bundle, 'manifest.json')), readFileSync(join(oldRegion.directory, 'manifest.json')), 'retained immutable evidence is never relabeled');

  const currentPoint = readFileSync(join(output, pointPath)), currentPointer = readFileSync(join(output, pointerPath));
  for (const group of ['noaa-cloud', 'rrfs', 'soaring']) await seedPublishedGroup(output, group, { getBytes, sites });
  assert.deepEqual(readFileSync(join(output, pointPath)), currentPoint, 'lagging CDN cannot downgrade a current point');
  assert.deepEqual(readFileSync(join(output, pointerPath)), currentPointer, 'lagging CDN cannot downgrade a current regional bundle');

  const fallback = join(root, 'fallback/data-rrfs');
  packRefresh('rrfs', fallback, live, 'a'.repeat(40));
  const metadata = JSON.parse(readFileSync(join(fallback, '.artifact.json')));
  assert.equal(metadata.soaringContractVersion, SOARING_CONTRACT_VERSION, 'producer and retained payload methods are distinct');
  assert.equal(metadata.retainedProducts.rrfs, '2.2.0');
  assert.equal(metadata.retainedProducts[`soaring/${oldRegion.caseId}`], '2.2.0');
  mergeArtifacts(join(root, 'fallback'), output, { sites });
  assert.deepEqual(readFileSync(join(output, pointPath)), currentPoint);
  assert.deepEqual(readFileSync(join(output, pointerPath)), currentPointer);
  const recovered = join(root, 'recovered');
  assert.ok(mergeArtifacts(join(root, 'fallback'), recovered, { sites }).accepted.includes('rrfs'));
  assert.deepEqual(readFileSync(join(recovered, pointPath)), originalPoint, 'a verified retained artifact can seed an empty cache');
  assert.deepEqual(readFileSync(join(recovered, pointerPath)), originalPointer);
  delete metadata.retainedProducts; write(join(fallback, '.artifact.json'), metadata);
  assert.ok(mergeArtifacts(join(root, 'fallback'), join(root, 'unmarked'), { sites }).rejected.some(item => /outdated/.test(item.reason)), 'an unmarked new candidate must pass current-method validation');
  writeFileSync(join(oldRegion.directory, 'f1.json'), 'corrupt');
  const damaged = join(root, 'damaged/data-rrfs');
  packRefresh('rrfs', damaged, live, 'a'.repeat(40));
  const damagedMetadata = JSON.parse(readFileSync(join(damaged, '.artifact.json')));
  assert.equal(damagedMetadata.retainedProducts.rrfs, '2.2.0');
  assert.equal(damagedMetadata.retainedProducts[`soaring/${oldRegion.caseId}`], undefined, 'invalid retained sibling is not attested');
  assert.ok(mergeArtifacts(join(root, 'damaged'), join(root, 'partial-recovery'), { sites }).accepted.includes('rrfs'), 'a malformed retained bundle cannot discard a healthy point product');
});
