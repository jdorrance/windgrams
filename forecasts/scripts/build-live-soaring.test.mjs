import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { daytimeForecastHoursForCycle, buildLiveCaseSpec, buildLiveSoaring, loadRegionConfiguration, validateNativeRegions, enrichBundleWithSidecars, isRegionBundleCurrent, pruneSupersededBundles } from './build-live-soaring.mjs';
import { SOARING_CONTRACT_VERSION } from '../soaring/science.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');

test('ICON builds direct callers to the native builder before reading templates or downloading', async t => {
  const root = mkdtempSync(join(tmpdir(), 'icon-builder-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'unwritten');
  const dependencies = { captureImpl() { assert.fail('ICON must not use CONUS capture'); }, replayImpl() { assert.fail('ICON must not use CONUS replay'); } };
  for (const referenceTime of [undefined, '2026-10-24T06:00:00Z']) {
    await assert.rejects(buildLiveSoaring({ output, model: 'icon-eu', 'reference-time': referenceTime }, dependencies), /node scripts\/build-icon\.mjs/);
  }
  await assert.rejects(buildLiveSoaring({ output, model: 'icon-eu', 'validate-only': true }, dependencies), /No ICON-EU referenceTime/);
  assert.equal(existsSync(output), false);
});

test('live daylight follows region, DST, and remaining hours rather than skipping today', () => {
  assert.deepEqual(daytimeForecastHoursForCycle('2026-10-21T18:00:00Z'), [2,3,4,5,6,7,8,9]);
  assert.deepEqual(daytimeForecastHoursForCycle('2026-10-21T18:00:00Z','America/New_York'), [2,3,4,5,6]);
  assert.equal(daytimeForecastHoursForCycle('2026-12-21T06:00:00Z')[0],9);
  assert.equal(daytimeForecastHoursForCycle('2026-10-21T06:00:00Z')[0],8);
  assert.throws(()=>daytimeForecastHoursForCycle('bad'), /Invalid/);
  const template={id:'archive-case',site:{timeZone:'America/Los_Angeles'},referenceTime:'2026-10-21T00:00:00Z'};
  assert.equal(buildLiveCaseSpec(template,'2026-10-23T18:00:00Z').id,'archive-case-live');
  const rrfs = buildLiveCaseSpec(template, '2026-10-23T18:00:00Z', 'rrfs');
  assert.equal(rrfs.id, 'archive-case-rrfs-live');
  assert.equal(rrfs.model, 'rrfs');
  assert.throws(() => buildLiveCaseSpec(template, '2026-10-23T18:00:00Z', 'unknown'), /Unsupported/);
  assert.equal(template.id,'archive-case');
});

test('RRFS sidecars remap changed model terrain, preserve GEPS scalar windDirectionDeg and legacy separation, and join equivalent valid-time formats', t => {
  const root = mkdtempSync(join(tmpdir(), 'rrfs-sidecars-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const staging = join(root, 'new'), output = join(root, 'soaring'), id = 'case-rrfs-live';
  mkdirSync(staging, { recursive: true });
  const grid = { type: 'FeatureCollection', features: [
    { properties: { latitude: 48.6, longitude: -122.4, cellIndex: 0, gridIndex: 101, modelElevationM: 342 } },
    { properties: { latitude: 48.61, longitude: -122.39, cellIndex: 1, gridIndex: 102, modelElevationM: 456 } },
  ] };
  const files = {};
  for (const [file, value] of Object.entries({ 'grid.geojson': grid, 'profile.json': {}, 'audit.json': {}, 'f8.json': {} })) {
    const bytes = JSON.stringify(value); writeFileSync(join(staging, file), bytes); files[file] = sha(bytes);
  }
  const validAt = '2026-10-23T14:00:00Z';
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify({
    model: 'rrfs', case: { id, model: 'rrfs', referenceTime: '2026-10-23T06:00:00Z' },
    hours: [{ file: 'f8.json', validAt }], files,
  }));
  for (const [model, hours] of Object.entries({
    nws: [{ validAt: '2026-10-23T14:00:00.000Z', temperatureC: 18 }],
    rrfs: [{ validAt, surface: { temperatureC: 19 }, derived: { thermalVelocityMps: 0.9 } }],
    geps: [{
      validAt,
      surface: { temperatureC: { p10: 10, p50: 12, p90: 14 }, windSpeedMps: { p10: 2, p50: 4, p90: 7 }, windDirectionDeg: 209 },
      derived: { thermalVelocityMps: { p10: 0.2, p50: 0.6, p90: 1.1 }, usableLiftTopM: { p10: 300, p50: 500, p90: 700 }, boundaryLayerTopM: { p10: 400, p50: 600, p90: 800 }, cloudBaseM: { p10: 900, p50: 1100, p90: 1300 } },
    }],
    gfs: [{ validAt: '2026-10-22T14:00:00Z', surface: { temperatureC: 20 } }],
  })) {
    mkdirSync(join(root, model, 'sites'), { recursive: true });
    // Only the RRFS document declares semantics; the others predate the tag and must stay undeclared.
    const semantics = model === 'rrfs' ? { semantics: { gust: 'instant', precipitation: 'instantRate' } } : {};
    writeFileSync(join(root, model, 'sites', 'launch.json'), JSON.stringify({ ...semantics, hours }));
  }
  const result = enrichBundleWithSidecars(root, output, id, staging, {
    model: 'hrrr-conus', referenceTime: '2026-10-23T06:00:00Z', gridSha256: 'different-terrain', verification: { hrrrOnly: true },
    launches: { caseId: 'old-case', raob: { stale: true }, launches: [{ slug: 'launch', latitude: 48.6001, longitude: -122.4, modelElevationM: 210, gridIndex: 5, cellIndex: 9, launchElevationM: 500, models: { old: {} } }] },
    crossSection: { caseId: 'old-case', nodes: [{ latitude: 48.6101, longitude: -122.39, modelElevationM: 220, gridIndex: 7, cellIndex: 10, distanceKm: 72, waypointLabel: 'Ridge' }] },
  });
  const launches = JSON.parse(readFileSync(join(result, 'launches.json')));
  const publishedManifest = JSON.parse(readFileSync(join(result, 'manifest.json')));
  assert.deepEqual(Object.keys(publishedManifest.fileBytes).sort(), Object.keys(publishedManifest.files).sort());
  for (const [name, bytes] of Object.entries(publishedManifest.fileBytes)) assert.equal(readFileSync(join(result, name)).byteLength, bytes, name);
  const launch = launches.launches[0];
  assert.equal(launches.caseId, id); assert.equal(launches.model, 'rrfs'); assert.equal(launches.raob, undefined);
  assert.equal(launch.modelElevationM, 342); assert.equal(launch.gridIndex, 101); assert.equal(launch.cellIndex, 0);
  assert.equal(launch.launchElevationM, 500);
  assert.equal(launch.models.nws.hours[0].validAt, validAt);
  assert.equal(launch.models.nws.hours[0].tempC, 18);
  assert.equal(launch.models.rrfs.hours[0].tempC, 19);
  assert.deepEqual(launch.models.rrfs.semantics, { gust: 'instant', precipitation: 'instantRate' }, 'series echo the source document semantics');
  assert.equal(Object.hasOwn(launch.models.nws, 'semantics'), false, 'undeclared semantics are never defaulted');
  assert.equal(Object.hasOwn(launch.models.geps, 'semantics'), false);
  assert.equal(launch.models.geps.hours[0].windDirectionDeg, 209);
  assert.equal(launch.models.geps.hours[0].wstarMps, 0.6);
  assert.equal(launch.models.geps.hours[0].wstarV2Mps, null);
  assert.equal(launch.models.geps.hours[0].usableLiftTopV2M, null);
  assert.equal(launch.models.gfs, undefined);
  assert.equal(launch.models.old, undefined);
  const section = JSON.parse(readFileSync(join(result, 'cross-section.json')));
  assert.equal(section.caseId, id); assert.equal(section.nodes[0].gridIndex, 102);
  assert.equal(section.nodes[0].modelElevationM, 456); assert.equal(section.nodes[0].distanceKm, 72);
  assert.equal(section.nodes[0].waypointLabel, 'Ridge');
  assert.equal(existsSync(join(result, 'verification.json')), false);
});

test('publication validates before replacing a pointer, invalidates older contractVersion bundles, preserves old clients, and drops stale sidecars', t => {
  const root=mkdtempSync(join(tmpdir(),'live-soaring-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const out=join(root,'soaring'), id='case-live', ref='2026-10-23T00:00:00Z';
  const make=(name,run=ref,contractVersion=SOARING_CONTRACT_VERSION)=>{
    const dir=join(root,name);mkdirSync(dir,{recursive:true});
    const files={};
    for (const f of ['grid.geojson','profile.json','audit.json','f20.json']) {writeFileSync(join(dir,f),'{}\n');files[f]=sha('{}\n');}
    const m={soaringContractVersion:contractVersion,case:{id,referenceTime:run},hours:[{file:'f20.json',validAt:'2026-10-23T20:00:00Z'}],files};
    writeFileSync(join(dir,'manifest.json'),JSON.stringify(m));return dir;
  };
  enrichBundleWithSidecars(root,out,id,make('old-contract',ref,'2.1.0'),{});
  assert.equal(isRegionBundleCurrent(out,id,ref),false,'a previous-method bundle for the same run must be rebuilt');
  const first=enrichBundleWithSidecars(root,out,id,make('first'),{});
  const pointer=readFileSync(join(out,id,'index.json'),'utf8');
  assert.ok(isRegionBundleCurrent(out,id,ref));
  const damaged=make('bad');writeFileSync(join(damaged,'f20.json'),'broken');
  assert.throws(()=>enrichBundleWithSidecars(root,out,id,damaged,{}),/Corrupt/);
  assert.equal(readFileSync(join(out,id,'index.json'),'utf8'),pointer);
  const second=enrichBundleWithSidecars(root,out,id,make('second','2026-10-23T06:00:00Z'),{
    referenceTime:ref,gridSha256:sha('{}\n'),verification:{old:true},
    launches:{launches:[{slug:'wa-blanchard',models:{gfs:{hours:[{validAt:'old'}]}}}],raob:{old:true}},
  });
  assert.equal(existsSync(join(second,'verification.json')),false);
  const launches=JSON.parse(readFileSync(join(second,'launches.json')));
  assert.deepEqual(launches.launches[0].models,{});assert.equal(launches.raob,undefined);
  assert.equal(pruneSupersededBundles(out,id),0);assert.ok(existsSync(first));
  writeFileSync(join(second,'profile.json'),'bad');
  assert.equal(isRegionBundleCurrent(out,id,'2026-10-23T06:00:00Z'),false);
});

test('retired US grids do not acquire or replay while point forecasts remain intact', async t => {
  const root = mkdtempSync(join(tmpdir(), 'retired-us-grids-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const soaringRoot = join(root, 'soaring', 'v1');
  mkdirSync(soaringRoot, { recursive: true });
  writeFileSync(join(soaringRoot, 'regions.json'), JSON.stringify({ trialRegionId: 'north-sound', regions: [
    { id: 'north-sound', status: 'active-verified-trial', caseId: 'north-sound-20261021-00z-live' },
    { id: 'shenandoah-blue-ridge', status: 'active-verified-trial', caseId: 'shenandoah-blue-ridge-20261021-00z-rrfs-live' },
  ] }));
  const dependencies = {
    log() {},
    captureImpl() { assert.fail('retired regions must not download'); },
    replayImpl() { assert.fail('retired regions must not replay'); },
  };
  for (const model of ['hrrr-conus', 'rrfs']) {
    const pointDir = join(root, model, 'sites');
    mkdirSync(pointDir, { recursive: true });
    const point = join(pointDir, 'wa-blanchard.json'), bytes = '{"retained":"point forecast"}\n';
    writeFileSync(point, bytes);
    for (const validateOnly of [false, true]) {
      assert.deepEqual(await buildLiveSoaring({ output: root, model, 'validate-only': validateOnly }, dependencies), { model, regions: 0 });
      assert.equal(readFileSync(point, 'utf8'), bytes);
    }
    assert.deepEqual(validateNativeRegions(root, model, '2026-10-26T00:00:00Z'), { model, referenceTime: '2026-10-26T00:00:00Z', regions: 0 });
  }
});

test('tracked region configuration excludes retired published regions while preserving Armenian publication metadata', t => {
  const root = mkdtempSync(join(tmpdir(), 'region-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'regions.json'), JSON.stringify({ trialRegionId: 'north-sound', soaringContractVersion: '2.0.0', regions: [
    { id: 'north-sound', name: 'Retired NW map', caseId: 'north-sound-20261021-00z-rrfs-live' },
    { id: 'shenandoah-blue-ridge', name: 'Retired VA map', caseId: 'shenandoah-blue-ridge-20261021-00z-live' },
    { id: 'armenia', name: 'Preserved name', caseId: 'armenia-icon-eu-live', nativeModels: [{ model: 'icon-eu', caseId: 'armenia-icon-eu-live' }] },
  ] }));
  const loaded = loadRegionConfiguration(root);
  assert.equal(loaded.soaringContractVersion, SOARING_CONTRACT_VERSION);
  assert.equal(loaded.trialRegionId, 'armenia');
  assert.deepEqual(loaded.regions.map(region => region.id), ['armenia']);
  assert.equal(loaded.regions[0].name, 'Preserved name');
  assert.deepEqual(loaded.regions[0].regionalModels, ['icon-eu']);
  assert.deepEqual(loaded.regions[0].nativeModels, [{ model: 'icon-eu', caseId: 'armenia-icon-eu-live' }]);
});
