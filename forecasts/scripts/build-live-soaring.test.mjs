import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { daytimeForecastHoursForCycle, buildLiveCaseSpec, buildLiveSoaring, initialRegionSidecars, loadRegionConfiguration, validateNativeRegions, enrichBundleWithSidecars, isRegionBundleCurrent, pruneSupersededBundles } from './build-live-soaring.mjs';
import { mergeSoaringRegionFiles } from './merge-soaring-regions.mjs';
import { collectGroup } from './seed-published.mjs';
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
    writeFileSync(join(root, model, 'sites', 'launch.json'), JSON.stringify({ hours }));
  }
  const result = enrichBundleWithSidecars(root, output, id, staging, {
    model: 'hrrr-conus', referenceTime: '2026-10-23T06:00:00Z', gridSha256: 'different-terrain', verification: { hrrrOnly: true },
    launches: { caseId: 'old-case', raob: { stale: true }, launches: [{ slug: 'launch', latitude: 48.6001, longitude: -122.4, modelElevationM: 210, gridIndex: 5, cellIndex: 9, launchElevationM: 500, models: { old: {} } }] },
    crossSection: { caseId: 'old-case', nodes: [{ latitude: 48.6101, longitude: -122.39, modelElevationM: 220, gridIndex: 7, cellIndex: 10, distanceKm: 72, waypointLabel: 'Ridge' }] },
  });
  const launches = JSON.parse(readFileSync(join(result, 'launches.json')));
  const launch = launches.launches[0];
  assert.equal(launches.caseId, id); assert.equal(launches.model, 'rrfs'); assert.equal(launches.raob, undefined);
  assert.equal(launch.modelElevationM, 342); assert.equal(launch.gridIndex, 101); assert.equal(launch.cellIndex, 0);
  assert.equal(launch.launchElevationM, 500);
  assert.equal(launch.models.nws.hours[0].validAt, validAt);
  assert.equal(launch.models.nws.hours[0].tempC, 18);
  assert.equal(launch.models.rrfs.hours[0].tempC, 19);
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
  enrichBundleWithSidecars(root,out,id,make('old-contract',ref,'2.0.0'),{});
  assert.equal(isRegionBundleCurrent(out,id,ref),false,'a 2.0.0 bundle for the same run must be invalidated when contractVersion is 2.1.0');
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

test('a clean CI output builds both native RRFS regions from tracked geography and publishes a reusable catalogue', async t => {
  const root = mkdtempSync(join(tmpdir(), 'rrfs-clean-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'data'), soaringRoot = join(output, 'soaring', 'v1');
  const regions = loadRegionConfiguration(soaringRoot).regions.filter(region => region.status === 'active-verified-trial' && (!region.regionalModels || region.regionalModels.includes('rrfs')));
  assert.deepEqual(regions.map(region => region.id), ['north-sound', 'shenandoah-blue-ridge']);
  assert.equal(existsSync(soaringRoot), false);
  const captured = [], replayed = [], ref = '2026-10-23T06:00:00Z';
  const dependencies = {
    log() {},
    async captureImpl(c) { captured.push(c.id); },
    async replayImpl(c, cache, staging) {
      replayed.push(c.id);
      const region = regions.find(region => c.id === `${region.templateCaseId}-rrfs-live`);
      assert.ok(region);
      const geography = initialRegionSidecars(region);
      assert.equal(geography.verification, null);
      const points = [...geography.launches.launches, ...geography.crossSection.nodes];
      const grid = { type: 'FeatureCollection', features: points.map((point, i) => ({ properties: {
        latitude: point.latitude, longitude: point.longitude, cellIndex: i, gridIndex: i + 100, modelElevationM: 350,
      } })) };
      const files = {};
      const hours = c.forecastHours.map(forecastHour => ({ forecastHour, file: `f${forecastHour}.json`, validAt: new Date(Date.parse(c.referenceTime) + forecastHour * 3600000).toISOString().replace('.000Z', 'Z') }));
      for (const [name, value] of Object.entries({ 'grid.geojson': grid, 'profile.json': {}, 'audit.json': {}, ...Object.fromEntries(hours.map(hour => [hour.file, {}])) })) {
        const bytes = JSON.stringify(value); writeFileSync(join(staging, name), bytes); files[name] = sha(bytes);
      }
      writeFileSync(join(staging, 'manifest.json'), JSON.stringify({ model: 'rrfs', case: c, files, hours }));
      return { path: staging };
    },
  };
  await assert.rejects(() => buildLiveSoaring({ output, model: 'rrfs' }, dependencies), /No RRFS referenceTime/);
  await buildLiveSoaring({ output, model: 'rrfs', 'reference-time': ref, 'cache-root': join(root, 'cache') }, dependencies);
  assert.equal(captured.length, 2); assert.equal(replayed.length, 2);
  assert.equal(existsSync(join(soaringRoot, 'regions.json')), false);
  const overlay = JSON.parse(readFileSync(join(soaringRoot, 'regions-rrfs.json')));
  for (const region of overlay.regions.filter(region => region.status === 'active-verified-trial')) {
    assert.ok(region.caseId.endsWith('-rrfs-live'));
    assert.deepEqual(region.nativeModels, [{ model: 'rrfs', caseId: region.caseId }]);
    assert.equal(region.expandedCaseId, undefined);
    const pointer = JSON.parse(readFileSync(join(soaringRoot, region.caseId, 'index.json')));
    const launches = JSON.parse(readFileSync(join(soaringRoot, region.caseId, pointer.bundle, 'launches.json')));
    assert.equal(launches.launches.length, 6);
    assert.ok(launches.launches.every(launch => launch.modelElevationM === 350 && launch.cellIndex >= 0));
    assert.equal(launches.raob, undefined);
  }
  assert.deepEqual(validateNativeRegions(output, 'rrfs', ref), { model: 'rrfs', referenceTime: ref, regions: 2 });
  mergeSoaringRegionFiles(output);
  const primary = JSON.parse(readFileSync(join(soaringRoot, 'regions.json')));
  assert.equal(primary.regions.filter(region => region.status === 'active-verified-trial').length, 2);
  const seeded = await collectGroup('soaring', { getBytes: async key => {
    const file = join(output, key); return existsSync(file) ? readFileSync(file) : null;
  } });
  assert.equal([...seeded.keys()].filter(key => key.endsWith('/index.json')).length, 2, 'next-run seeding accepts RRFS-only publication without archived HRRR');
  await buildLiveSoaring({ output, model: 'rrfs', 'reference-time': ref }, dependencies);
  assert.equal(replayed.length, 2, 'a second run reuses both complete bundles and original template ids');
  await assert.rejects(() => buildLiveSoaring({ output, model: 'rrfs', 'reference-time': '2026-10-23T12:00:00Z', 'validate-only': true }, dependencies), /Incomplete native rrfs/);
});

test('tracked region defaults fill a missing region and enforce current soaringContractVersion without overwriting published customizations', t => {
  const root = mkdtempSync(join(tmpdir(), 'rrfs-region-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'regions.json'), JSON.stringify({ soaringContractVersion: '2.0.0', regions: [{ id: 'north-sound', name: 'Preserved name', caseId: 'north-sound-20261021-00z-rrfs-live' }] }));
  const loaded = loadRegionConfiguration(root);
  assert.equal(loaded.soaringContractVersion, SOARING_CONTRACT_VERSION);
  assert.equal(loaded.regions.find(region => region.id === 'north-sound').name, 'Preserved name');
  assert.equal(loaded.regions.find(region => region.id === 'north-sound').templateCaseId, 'north-sound-20261021-00z');
  assert.ok(loaded.regions.some(region => region.id === 'shenandoah-blue-ridge'));
});
