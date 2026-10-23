import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { daytimeForecastHoursForCycle, buildLiveCaseSpec, enrichBundleWithSidecars, isRegionBundleCurrent, pruneSupersededBundles } from './build-live-soaring.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');

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

test('RRFS sidecars remap changed model terrain and join equivalent valid-time formats', t => {
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
  assert.equal(launch.models.gfs, undefined);
  assert.equal(launch.models.old, undefined);
  const section = JSON.parse(readFileSync(join(result, 'cross-section.json')));
  assert.equal(section.caseId, id); assert.equal(section.nodes[0].gridIndex, 102);
  assert.equal(section.nodes[0].modelElevationM, 456); assert.equal(section.nodes[0].distanceKm, 72);
  assert.equal(section.nodes[0].waypointLabel, 'Ridge');
  assert.equal(existsSync(join(result, 'verification.json')), false);
});

test('publication validates before replacing a pointer, preserves old clients, and drops stale sidecars', t => {
  const root=mkdtempSync(join(tmpdir(),'live-soaring-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const out=join(root,'soaring'), id='case-live', ref='2026-10-23T00:00:00Z';
  const make=(name,run=ref)=>{
    const dir=join(root,name);mkdirSync(dir,{recursive:true});
    const files={};
    for (const f of ['grid.geojson','profile.json','audit.json','f20.json']) {writeFileSync(join(dir,f),'{}\n');files[f]=sha('{}\n');}
    const m={case:{id,referenceTime:run},hours:[{file:'f20.json',validAt:'2026-10-23T20:00:00Z'}],files};
    writeFileSync(join(dir,'manifest.json'),JSON.stringify(m));return dir;
  };
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
