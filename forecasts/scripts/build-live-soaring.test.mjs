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
  assert.equal(template.id,'archive-case');
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
