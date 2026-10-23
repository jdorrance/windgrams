import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nearestGridpoint, parseIdx } from '@azohra/meteo.grib';
import { parseSiteForecast } from '@azohra/meteo.briefing/contract';
import { DRY_ADIABATIC_LAPSE_C_PER_M } from '@azohra/meteo.briefing/derive';
import { capture, captureAsset, inspectField } from './capture.mjs';
import { replay, verifyCapture } from './replay.mjs';
import { readJson, json } from './common.mjs';
import { EXTENDED_HRRR_PRESSURE_LEVELS, fields, selectRecords } from './fields.mjs';
import { projection, regionalGrid, storageIndex, wind } from './grid.mjs';
import {
  SOARING_CONTRACT_VERSION,
  WXTOFLY_SINK_MPS,
  assertAgreement,
  cellSource,
  computeExperimentalTerrainAdjustment,
  computeNativeGridConvergence,
  deriveCell,
  differences,
  geometricWFromOmegaMps,
  metric,
  metrics,
  profileFor,
} from './science.mjs';
import {
  deriveEnsembleSoaringDiagnostics,
  postprocessPointForecast,
} from './point-postprocess.mjs';
import {
  DEFAULT_MAX_ROLLING_RUNS,
  evaluateRaobMatch,
} from '../verification/history.mjs';
import {
  FEED_AVAILABILITY_SPECS,
  evaluateRegionalFreshness,
  selectTargetCycles,
} from '../scripts/check-readiness.mjs';
import { fixtureTransport } from './fixture-helper.mjs';
const c = await readJson(new URL('./cases/north-sound-20261021-00z.json',import.meta.url));
const expandedCase = await readJson(new URL('./cases/north-sound-expanded-v2.json',import.meta.url));
const real = await readJson(new URL('./fixtures/blanchard-raw.json',import.meta.url));
const golden = await readJson(new URL('./fixtures/blanchard-published.json',import.meta.url));
const quiet = () => {};
async function temporary(t) { const root=await mkdtemp(join(tmpdir(),'soaring-test-')); t.after(()=>rm(root,{recursive:true,force:true})); return root; }

test('real archived Blanchard columns reproduce every published hour exactly and compute consistent v2.0.0 diagnostics', () => {
  const results = real.hours.map(h => deriveCell(c,real.terrain,cellSource(c,real.grid,real.cell,h.forecastHour,h.raw),golden.run.generatedAt));
  const profile = profileFor(c,results[0].site,results.map(r=>r.hour),golden.run.generatedAt);
  assert.deepEqual(differences(profile,golden),[]);
  assert.ok(parseSiteForecast(profile));
  assert.equal(profile.hours[0].derived.thermalVelocityMps,0);
  assert.equal(profile.hours[6].derived.thermalVelocityMps,1.06);
  assert.equal(profile.hours[6].derived.usableLiftTopM,724.5);

  // Feedback 1: Audit v2 at Blanchard f20 (index 6) and across all 14 hours
  assert.equal(results[0].v2.contractVersion, SOARING_CONTRACT_VERSION);
  assert.equal(results[0].v2.resolvedThermalTopM, null);
  assert.equal(results[6].v2.resolvedThermalTopM, 504.3); // 221.7 m terrain + 282.6 m HPBL instead of 778.9 m 925 hPa jump
  assert.equal(results[6].v2.thermalVelocityV2Mps, 0.85);
  assert.equal(results[6].v2.usableLiftTopV2M, 465.5);
  assert.equal(results[6].v2.hcritWxtoflyM, 446.8);
  assert.equal(results[6].v2.dryHcritM, 465.5);
  assert.ok(results[6].v2.hcritWxtoflyM <= results[6].v2.usableLiftTopV2M);
  assert.ok(results[6].v2.usableLiftTopV2M <= results[6].v2.dryHcritM);
  assert.ok(results[6].v2.dryHcritM <= results[6].v2.resolvedThermalTopM);
  assert.ok(results[6].v2.thermalTopPlus1CM > results[6].v2.resolvedThermalTopM);
  assert.ok(Math.abs(WXTOFLY_SINK_MPS - 1.143) < 0.001);
  assert.equal(results[6].v2.surfaceLclM, 1315.0);
  // Physical mixedLayerLclM without legacy 0.85 multiplier:
  assert.equal(results[6].v2.mixedLayerLclM, 1885.2);
  assert.ok(results[6].v2.cuPotentialM < 0);
  assert.ok(results[6].v2.blMeanWindSpeedMps > 0);
  assert.ok(results[6].v2.blWindShearMps >= 0);

  // Verify invariant across all 14 hours
  for (const r of results) {
    if (!r.v2) continue;
    assert.equal(r.v2.verticalResolution.synthesizedLevels, 0);
    assert.equal(r.v2.verticalResolution.isSparseProfile, true);
    if (r.v2.usableLiftTopV2M !== null) assert.ok(r.v2.usableLiftTopV2M <= r.v2.resolvedThermalTopM);
    if (r.v2.hcritWxtoflyM !== null) assert.ok(r.v2.hcritWxtoflyM <= r.v2.resolvedThermalTopM);
    if (r.v2.dryHcritM !== null) assert.ok(r.v2.dryHcritM <= r.v2.resolvedThermalTopM);
  }

  // Feedback 5: Isolated experimental terrain adjustment
  const expTerrain = results[6].v2.experimental?.terrainAdjustment;
  assert.ok(expTerrain);
  assert.equal(expTerrain.experimental, true);
  assert.equal(expTerrain.rawMslHeightsPreserved, true);
  assert.equal(expTerrain.bracketsLaunchAltitude, true);
  assert.equal(expTerrain.launchElevationM, 378.5);
  assert.equal(expTerrain.modelElevationM, 221.7);
  assert.equal(expTerrain.launchWindSpeedMps, 2.47);

  const wTest = geometricWFromOmegaMps(-1.0, 925, 14.46);
  assert.ok(wTest > 0.08 && wTest < 0.12);
  const hourly=profile.hours.map(h=>({validAt:h.validAt,...Object.fromEntries(metrics.map(k=>[k,[metric(h,k)]]))}));
  assert.equal(assertAgreement(profile,hourly,0).valuesChecked,70);
  hourly[6].thermalVelocityMps[0] += .01;
  assert.throws(()=>assertAgreement(profile,hourly,0),/mismatch/);
});

test('Feedback 2: expanded 18-level HRRR field selection and 80 m wind match captured .idx inventory without synthetic levels', async () => {
  assert.equal(EXTENDED_HRRR_PRESSURE_LEVELS.length, 18);
  const idxBytes = await readFile(new URL('../.soaring-cache/north-sound-20261021-00z/f20.idx', import.meta.url));
  const selected = selectRecords(parseIdx(idxBytes.toString()), expandedCase, 20);
  const byKey = Object.fromEntries(selected.map(s => [s.key, s]));
  assert.ok(byKey['u80m']?.record);
  assert.ok(byKey['v80m']?.record);
  assert.ok(byKey['1000.TMP']?.record);
  assert.ok(byKey['975.TMP']?.record);
  assert.ok(byKey['950.TMP']?.record);
  assert.ok(byKey['500.HGT']?.record);
  assert.ok(byKey['400.HGT']?.record);
  assert.ok(byKey['nativeCloudBaseM']?.record);
  assert.ok(byKey['nativeAdiabaticLclM']?.record);
});

test('Feedback 3 & 4: model-aware post-processing handles deterministic, GEPS ensemble, and sparse ECMWF/NWS adapters', () => {
  // Deterministic model preserves v1 derived and adds v2 soaring
  const detDoc = postprocessPointForecast(structuredClone(golden), { modelSlug: 'hrrr-conus', launchElevationM: 378.5 });
  assert.equal(detDoc.soaringMeta.contractVersion, '2.0.0');
  assert.equal(detDoc.soaringMeta.synthesizedLevels, 0);
  assert.equal(detDoc.hours[6].derived.usableLiftTopM, 724.5); // v1 untouched
  assert.equal(detDoc.hours[6].soaring.usableLiftTopV2M, 465.5); // v2 bounded by 504.3m resolved top

  // GEPS ensemble percentile document refuses nonlinear median post-processing
  const gepsDoc = {
    schemaVersion: 2,
    model: 'geps',
    run: { referenceTime: '2026-10-21T00:00:00Z', generatedAt: '2026-10-21T07:00:00Z', members: 21 },
    site: { id: 'wa-blanchard', name: 'Blanchard', latitude: 48.6, longitude: -122.4, modelElevationM: 94.3 },
    hours: [{ validAt: '2026-10-21T20:00:00Z', surface: { temperatureC: { members: 21, p10: 12, p25: 13, p50: 14, p75: 15, p90: 16 } }, levels: [], derived: {} }],
  };
  const gepsOut = postprocessPointForecast(gepsDoc, { modelSlug: 'geps' });
  assert.equal(gepsOut.soaringMeta.modelKind, 'ensemble-percentiles');
  assert.equal(gepsOut.soaringMeta.nonlinearMedianPostprocessRefused, true);
  assert.equal(gepsOut.hours[0].soaring, undefined);

  // Per-member ensemble derivation computes nonlinear diagnostics per member before percentiles
  const memberCols = [0, 1, 2].map(offset => {
    const src = structuredClone(real.hours[6].source);
    src.temperatureC += offset * 0.5;
    src.sensibleHeatFluxWm2 += offset * 20;
    return { source: src, v1Hour: golden.hours[6] };
  });
  const ensAgg = deriveEnsembleSoaringDiagnostics(memberCols, real.terrain, { launchElevationM: 378.5 });
  assert.equal(ensAgg.derivationRule, 'per-member-before-percentiles');
  assert.equal(ensAgg.memberCount, 3);
  assert.ok(ensAgg.thermalVelocityV2Mps.p50 >= ensAgg.thermalVelocityV2Mps.p10);
  assert.ok(ensAgg.usableLiftTopV2M.p90 <= ensAgg.resolvedThermalTopM.p90);

  // Feedback 4: ECMWF and NWS keep unsupported W* and usableLiftTopM null
  const ecmwfDoc = postprocessPointForecast({
    models: { surface: { id: 'ecmwf_ifs', run: '2026-10-21T00:00:00Z' } },
    site: { slug: 'wa-blanchard', gridElevationM: 386 },
    hours: [{ validAt: '2026-10-21T20:00:00Z', temperatureC: 15, dewPointC: 7, boundaryLayerHeightM: 450, windSpeedMps: 3 }],
  }, { modelSlug: 'ecmwf' });
  assert.equal(ecmwfDoc.hours[0].soaring.thermalVelocityV2Mps, null);
  assert.equal(ecmwfDoc.hours[0].soaring.usableLiftTopV2M, null);
  assert.ok(ecmwfDoc.hours[0].soaring.surfaceLclM > 386);

  const nwsDoc = postprocessPointForecast({
    grid: { office: 'SEW', elevationM: 300 },
    site: { slug: 'wa-blanchard' },
    hours: [{ validAt: '2026-10-21T20:00:00Z', temperatureC: 14, dewpointC: 8, mixingHeightM: 500, transportWindSpeedMps: 4.2, transportWindDirectionDeg: 185 }],
  }, { modelSlug: 'nws' });
  assert.equal(nwsDoc.hours[0].soaring.thermalVelocityV2Mps, null);
  assert.equal(nwsDoc.hours[0].soaring.usableLiftTopV2M, null);
  assert.equal(nwsDoc.hours[0].soaring.blMeanWindSpeedMps, 4.2);
  assert.ok(nwsDoc.hours[0].soaring.surfaceLclM > 300);

  // Feedback 5: Unbracketed launch altitude returns null launchWindSpeedMps
  const unbracketed = computeExperimentalTerrainAdjustment(500, 180, real.hours[6].source, real.hours[6].source.levels);
  assert.equal(unbracketed.bracketsLaunchAltitude, false);
  assert.equal(unbracketed.launchWindSpeedMps, null);
});

test('Feedback 6 & 7: matched observation verification rules, 120-run (30-day) retention, and availability-aware readiness', () => {
  assert.equal(DEFAULT_MAX_ROLLING_RUNS, 120); // 30 days at 4 runs/day

  // Rejects legacy KUIL 00Z vs Blyn f14 (14h time mismatch + 113 km spatial separation)
  const badKuil = evaluateRaobMatch({
    distanceKm: 113,
    soundingValidAt: '2026-10-21T00:00:00Z',
    forecastValidAt: '2026-10-21T14:00:00Z',
    referenceTime: '2026-10-21T00:00:00Z',
  });
  assert.equal(badKuil.matched, false);
  assert.equal(badKuil.matchStatus, 'rejected-time-and-spatial-mismatch');

  // Accepts KMFR vs Woodrat Mountain (18 km, matched 00Z / f01 initialization window)
  const goodKmfr = evaluateRaobMatch({
    distanceKm: 18,
    soundingValidAt: '2026-10-21T00:00:00Z',
    forecastValidAt: '2026-10-21T01:00:00Z',
    referenceTime: '2026-10-21T00:00:00Z',
  });
  assert.equal(goodKmfr.matched, true);
  assert.equal(goodKmfr.leadTimeBucket, 'f00-f06');

  // Feedback 7: Complete-run availability (107 min for HRRR)
  assert.equal(FEED_AVAILABILITY_SPECS['hrrr-conus'].completeRunAvailabilityMinutes, 107);
  // At 00:15 UTC (15 min after 00Z init), 00Z HRRR is NOT yet available; primary candidate is 18Z from previous day
  const at0015 = selectTargetCycles('hrrr-conus', Date.parse('2026-10-21T00:15:00Z'));
  assert.equal(at0015.primaryCandidate.referenceTime, '2026-10-20T18:00:00Z');
  // At 01:55 UTC (115 min after 00Z init), 00Z HRRR complete run IS available
  const at0155 = selectTargetCycles('hrrr-conus', Date.parse('2026-10-21T01:55:00Z'));
  assert.equal(at0155.primaryCandidate.referenceTime, '2026-10-21T00:00:00Z');
  const freshness = evaluateRegionalFreshness('2026-10-21T12:00:00Z', Date.parse('2026-10-21T15:00:00Z'));
  assert.ok(freshness.every(r => r.meetsFreshnessDeadline));
});

test('independent dry-column numerical reference, zero flux, and column ceiling', () => {
  const source=structuredClone(real.hours[6].source);
  Object.assign(source,{temperatureC:20,dewPointDepressionC:20,sensibleHeatFluxWm2:100,latentHeatFluxWm2:0});
  source.levels=[500,1000,1500].map((z,i)=>({heightM:z,pressureHpa:[950,900,850][i],temperatureC:16-.006*z,dewPointDepressionC:20,windSpeedMps:2,windDirectionDeg:180}));
  const depth=4/(DRY_ADIABATIC_LAPSE_C_PER_M-.006);
  const w=Math.cbrt(.0075516/(293.15*(1015/950)**.28482)*100*depth);
  const hour=deriveCell(c,0,source,'2026-10-22T00:00:00Z').hour;
  assert.equal(hour.derived.boundaryLayerTopM,Math.round(depth*10)/10);
  assert.equal(hour.derived.thermalVelocityMps,Math.round(w*100)/100);
  source.sensibleHeatFluxWm2=-10;
  assert.equal(deriveCell(c,0,source,golden.run.generatedAt).hour.derived.thermalVelocityMps,0);
  assert.equal(deriveCell(c,0,source,golden.run.generatedAt).hour.derived.usableLiftTopM,null);
  source.temperatureC=50;
  assert.equal(deriveCell(c,0,source,golden.run.generatedAt).ceilingReached,true);
});

test('terrain masks inadequate coverage; missing inputs never become zero lift', () => {
  const source=structuredClone(real.hours[6].source);
  const heights=source.levels.map(l=>l.heightM).sort((a,b)=>a-b);
  const result=deriveCell(c,heights.at(-3),source,golden.run.generatedAt);
  assert.equal(result.status,'insufficient-levels'); assert.equal(result.hour,null);
  assert.equal(deriveCell(c,null,source,golden.run.generatedAt).status,'missing');
  const raw={...real.hours[6].raw,temperature:null};
  assert.equal(cellSource(c,real.grid,real.cell,20,raw),null);
  const optional={...real.hours[6].raw,'smoke.aot':null,pblHeightM:null};
  const without=cellSource(c,real.grid,real.cell,20,optional);
  assert.equal(without.smoke,undefined); assert.equal(without.pblHeightM,undefined);
});

test('Lambert geometry, native nearest cell, scanning orders, wind rotation, and native convergence', () => {
  const p=projection(real.grid), region=regionalGrid(real.grid,c);
  assert.equal(region.cells.length,2259); assert.equal(region.nearest.index,1779497);
  assert.equal(region.siteCell,1478);
  for (const cell of region.cells.filter((_,i)=>i%100===0)) {
    const [i,j]=p.fractional(cell.longitude,cell.latitude);
    assert.ok(Math.abs(i-Math.round(i))<1e-7); assert.ok(Math.abs(j-Math.round(j))<1e-7);
    assert.equal(storageIndex(real.grid,Math.round(i),Math.round(j)),cell.index);
    assert.equal(nearestGridpoint(real.grid,cell.latitude,cell.longitude).index,cell.index);
  }
  for (const jPointsAreConsecutive of [true,false]) for (const alternativeRowScanning of [true,false]) {
    const grid={...real.grid,ni:4,nj:3,jPointsAreConsecutive,alternativeRowScanning};
    const indices=[];for(let j=0;j<3;j++)for(let i=0;i<4;i++)indices.push(storageIndex(grid,i,j));
    assert.deepEqual(indices.sort((a,b)=>a-b),Array.from({length:12},(_,i)=>i));
    assert.equal(storageIndex(grid,1,1),jPointsAreConsecutive?4:(alternativeRowScanning?6:5));
  }
  const rotated=wind(real.grid,real.grid.loV-20,0,10);
  const angle=20*Math.sin(38.5*Math.PI/180);
  assert.ok(Math.abs(rotated.windSpeedMps-10)<1e-12);
  assert.ok(Math.abs(rotated.windDirectionDeg-(180-angle))<1e-9);
  assert.equal(wind(real.grid,0,null,1),null);
  const zeroConv = computeNativeGridConvergence(real.grid, region.cells, new Array(region.cells.length).fill(5), new Array(region.cells.length).fill(3));
  assert.equal(zeroConv[region.siteCell], 0);
});

test('capture/replay is offline, deterministic, atomic, and rejects damaged inputs', async t => {
  const root=await temporary(t), cache=join(root,'cache'), output=join(root,'output');
  const small={...c,forecastHours:[14,20]};
  const transport=await fixtureTransport(small);
  const captured=await capture(small,cache,{fetchImpl:transport,log:quiet});
  const noNetwork=()=>{throw new Error('NETWORK DISABLED');};
  const resumed=await capture(small,cache,{fetchImpl:noNetwork,log:quiet});
  assert.deepEqual(captured,resumed);
  const oldFetch=globalThis.fetch;globalThis.fetch=noNetwork;t.after(()=>{globalThis.fetch=oldFetch;});
  const first=await replay(small,cache,output,{log:quiet});
  const second=await replay(small,cache,output,{log:quiet});
  assert.deepEqual(first.hashes,second.hashes);assert.equal(first.path,second.path);
  assert.equal(first.audit.mapProfileAgreement.exact,true);
  assert.equal((await readdir(output)).some(n=>n.startsWith('.staging')),false);
  const pointer=await readFile(join(output,c.id,'index.json'),'utf8');
  const manifestPath=join(cache,'capture.json'), original=await readFile(manifestPath);
  const broken=structuredClone(captured);broken.sources[1].records.splice(0,1);
  await writeFile(manifestPath,json(broken));await assert.rejects(verifyCapture(small,cache),/inventory/);
  await writeFile(manifestPath,original);
  await assert.rejects(verifyCapture({...small,referenceTime:'2026-10-20T00:00:00Z'},cache),/case\/run/);
  const record=captured.sources[1].records[0], path=join(cache,record.file), bytes=await readFile(path);
  const wrong=Buffer.from(bytes);wrong[16+16]=20;
  assert.throws(()=>inspectField(wrong,small,14),/Wrong run/);
  assert.throws(()=>inspectField(bytes,small,20),/forecast time/);
  assert.throws(()=>inspectField(bytes,small,14,'wrong-grid'),/grid/);
  assert.throws(()=>inspectField(bytes,small,14,undefined,fields(small,14)[1]),/variable\/level/);
  await writeFile(path,bytes.subarray(0,bytes.length-1));
  await assert.rejects(replay(small,cache,output,{log:quiet}),/Corrupt cache/);
  assert.equal(await readFile(join(output,c.id,'index.json'),'utf8'),pointer);
  await rm(path);await assert.rejects(verifyCapture(small,cache),/ENOENT/);
});

test('ignored ranges, wrong content ranges, partial responses leave no reusable asset', async t => {
  const root=await temporary(t), record={offset:10,length:4};
  for(const [name,status,body,range] of [['ignored',200,'1234','bytes 10-13/99'],['partial',206,'12','bytes 10-13/99'],['wrong',206,'1234','bytes 0-3/99']]) {
    await assert.rejects(captureAsset(root,name,'https://example.invalid',record,()=>{},async()=>new Response(body,{status,headers:{'content-range':range}})));
    assert.equal((await readdir(root)).includes(`${name}.json`),false);
  }
  assert.deepEqual(await readdir(root),[]);
});
