import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCellSiteForecast, type ReplayManifest, type ReplayHour } from '../src/lib/soaring.ts';
import {
  publishedEffectiveCloudLimit,
  publishedLift,
  publishedMixedLayerLcl,
  publishedSurfaceLcl,
  publishedWxtoflyLiftTop,
  parsePublishedProfileJson,
} from '../src/lib/published-lift.ts';
import { buildWindgramView } from '../src/lib/windgram-view.ts';
import { buildSounding, readSounding } from '../src/lib/skewt.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../forecasts/soaring/${name}`, import.meta.url), 'utf8'));
const c = read('cases/north-sound-20261021-00z.json');
const raw = read('fixtures/blanchard-raw.json');
const golden = read('fixtures/blanchard-published.json');
const hours = JSON.parse(readFileSync(new URL('./fixtures/blanchard-map-hours.json', import.meta.url), 'utf8')).hours as ReplayHour[];
const manifest = { case: c, capturedAt: golden.run.generatedAt, siteCell: 0, hours } as ReplayManifest;
const cell = { ...raw.cell, id: 'test-cell', gridIndex: 1, modelElevationM: raw.terrain };

test('every archived map hour agrees with the cell windgram and sounding, including zero lift', () => {
  const profile = buildCellSiteForecast(manifest, hours, 0, cell)!;
  assert.ok(profile);
  const view = buildWindgramView(profile, { timeZone: c.site.timeZone });
  for (const [i, h] of hours.entries()) {
    const lift = publishedLift(profile.hours[i]);
    assert.equal(lift.thermalVelocityMps, h.thermalVelocityV2Mps![0]);
    assert.equal(lift.usableLiftTopM, h.usableLiftTopV2M![0]);
    assert.equal(publishedWxtoflyLiftTop(profile.hours[i]), h.hcritWxtoflyM?.[0] ?? null);
    assert.equal(view.hours[i].thermalVelocityMps, h.thermalVelocityV2Mps![0]);
    const sounding = buildSounding(profile, profile.hours[i])!;
    assert.equal(sounding.thermalVelocityMps, h.thermalVelocityV2Mps![0]);
    assert.equal(sounding.usableLiftTopM, h.usableLiftTopV2M![0]);
  }
  assert.equal(view.hours[6].thermalVelocityMps, 0.88);
  assert.equal(publishedLift(profile.hours[6]).usableLiftTopM, 470.2);
  assert.doesNotMatch(readSounding(buildSounding(profile, profile.hours[6])!, 378.5).headline, /too weak to climb/);
});

test('P0-4: surface LCL, effective cloud limit, and mixed-layer LCL stay distinct when near-saturation caps usable lift', () => {
  const rawProfile = structuredClone(golden);
  rawProfile.hours[6].derived.cloudBaseM = 981;
  rawProfile.hours[6].soaring = {
    thermalVelocityV2Mps: 1.5,
    usableLiftTopV2M: 981,
    resolvedThermalTopM: 1800,
    surfaceLclM: 2458,
    effectiveCloudLimitM: 981,
    mixedLayerLclM: 2150,
  };
  const parsed = parsePublishedProfileJson(JSON.stringify(rawProfile))!;
  const h6 = parsed.hours[6];
  assert.equal(publishedSurfaceLcl(h6), 2458, 'potential LCL retains surface LCL');
  assert.equal(publishedLift(h6).cloudBaseM, 2458, 'publishedLift cloudBaseM preserves potential LCL marker');
  assert.equal(publishedEffectiveCloudLimit(h6), 981, 'effectiveCloudLimitM exposes near-saturation ceiling proxy');
  assert.equal(publishedMixedLayerLcl(h6), 2150);
  const view = buildWindgramView(parsed, { timeZone: c.site.timeZone });
  const potentialCloud = view.clouds.find(cloud => cloud.hourIndex === 6 && cloud.kind === 'potential');
  assert.equal(potentialCloud?.baseM, 2458);
  assert.equal(view.sampling[6].cloudCapped, true);
});

test('the WxToFly ceiling retains published scalar and ensemble values at the 225 ft/min threshold', () => {
  const rawProfile = structuredClone(golden);
  const height = { members: 21, p10: 250, p25: 300, p50: 400, p75: 500, p90: 600 };
  rawProfile.hours[0].soaring = { thermalVelocityV2Mps: 1, usableLiftTopV2M: 500, hcritWxtoflyM: 446.8 };
  rawProfile.hours[1].soaring = { thermalVelocityV2Mps: 1, usableLiftTopV2M: 500, hcritWxtoflyM: height };
  const parsed = parsePublishedProfileJson(JSON.stringify(rawProfile))!;
  assert.equal(publishedWxtoflyLiftTop(parsed.hours[0]), 446.8);
  assert.deepEqual(publishedWxtoflyLiftTop(parsed.hours[1]), height);
  assert.equal(publishedLift(parsed.hours[0]).usableLiftTopM, 500, 'the 1 m/s ceiling remains distinct');
});

test('a missing, null or invalid 225 ft/min ceiling never falls back to the 1 m/s value', () => {
  const rawProfile = structuredClone(golden);
  for (const [index, value] of [null, undefined, '500', { p50: 500 }, { members: 21, p10: 250, p25: 300, p50: '400', p75: 500, p90: 600 }].entries()) {
    rawProfile.hours[index].soaring = { thermalVelocityV2Mps: 1, usableLiftTopV2M: 500, hcritWxtoflyM: value };
  }
  const parsed = parsePublishedProfileJson(JSON.stringify(rawProfile))!;
  for (const hour of parsed.hours.slice(0, 5)) {
    assert.equal(publishedWxtoflyLiftTop(hour), null);
    assert.equal(publishedLift(hour).usableLiftTopM, 500);
  }
  assert.equal(publishedWxtoflyLiftTop(parsed.hours[5]), null, 'legacy profiles do not publish the WxToFly diagnostic');
});
test('a missing surface or incomplete column never invents a valid profile', () => {
  const broken = structuredClone(hours); broken[3].sfcT = [null];
  assert.equal(buildCellSiteForecast(manifest, broken, 0, cell), null);
  broken[3] = { ...hours[3], status: ['insufficient-levels'] };
  assert.equal(buildCellSiteForecast(manifest, broken, 0, cell), null);
});
test('cell profiles retain the source model and precipitation semantics', () => {
  const legacy = buildCellSiteForecast(manifest, hours, 0, cell)!;
  assert.equal(legacy.model, 'hrrr-conus');
  assert.equal(legacy.semantics.precipitation, 'instantRate');
  const rrfsManifest: ReplayManifest = { ...manifest, model: 'rrfs', semantics: { gust: 'instant', precipitation: 'windowMeanRate' } };
  const rrfs = buildCellSiteForecast(rrfsManifest, hours, 0, cell)!;
  assert.equal(rrfs.model, 'rrfs');
  assert.equal(rrfs.semantics.precipitation, 'windowMeanRate');
  assert.deepEqual(rrfs.hours, legacy.hours);
  const caseModel = buildCellSiteForecast({ ...manifest, case: { ...manifest.case, model: 'rrfs' } }, hours, 0, cell)!;
  assert.equal(caseModel.model, 'rrfs');
  assert.equal(caseModel.semantics.precipitation, 'windowMeanRate');
});
test('point loading retains published diagnostics and nulls without resurrecting baseline lift', () => {
  const rawProfile = structuredClone(golden);
  rawProfile.hours[6].soaring = { thermalVelocityV2Mps: 0.88, usableLiftTopV2M: null, resolvedThermalTopM: 504.3, surfaceLclM: 1315 };
  const parsed = parsePublishedProfileJson(JSON.stringify(rawProfile))!;
  assert.equal(publishedLift(parsed.hours[6]).usableLiftTopM, null);
  assert.equal(buildSounding(parsed, parsed.hours[6])!.usableLiftTopM, null);
  assert.deepEqual(publishedLift(parsed.hours[0]), golden.hours[0].derived);
  rawProfile.hours[6].soaring.thermalVelocityV2Mps = null;
  const missing = parsePublishedProfileJson(JSON.stringify(rawProfile))!;
  const sounding = buildSounding(missing, missing.hours[6])!;
  assert.equal(sounding.thermalVelocityMps, null);
  assert.match(readSounding(sounding, 378.5).headline, /Unavailable/);
});

test('native model-level soundings retain pressure at the selected cell and ignore pressure-level substitutes', () => {
  const native = structuredClone(hours);
  for (const hour of native) {
    hour.levelsByModel = Object.fromEntries(Object.entries(hour.levelsByPressure!).map(([pressure, arrays], i) => [String(45 + i), {
      ...arrays, p: arrays.h.map((_, cell) => Number(pressure) - 1.25 - cell / 10),
    }]));
  }
  const iconManifest = { ...manifest, model: 'icon-eu', case: { ...manifest.case, model: 'icon-eu', site: { ...manifest.case.site, timeZone: 'Asia/Yerevan' } } };
  const profile = buildCellSiteForecast(iconManifest, native, 0, cell)!;
  assert.ok(profile);
  assert.equal(profile.model, 'icon-eu');
  assert.equal(profile.site.timeZone, 'Asia/Yerevan');
  assert.equal(profile.semantics.precipitation, 'windowMeanRate');
  const original = buildCellSiteForecast(manifest, hours, 0, cell)!;
  for (let i = 0; i < profile.hours.length; i++) {
    assert.deepEqual(profile.hours[i].levels.map(level => level.pressureHpa), original.hours[i].levels.map(level => Number(level.pressureHpa) - 1.25));
    assert.deepEqual(profile.hours[i].levels.map(level => level.heightM), original.hours[i].levels.map(level => level.heightM));
    assert.deepEqual(publishedLift(profile.hours[i]), publishedLift(original.hours[i]));
  }
  const missing = structuredClone(native);
  for (const levels of Object.values(missing[0].levelsByModel!)) levels.p[0] = null;
  assert.equal(buildCellSiteForecast(iconManifest, missing, 0, cell), null, 'missing native pressure cannot fall back to unrelated pressure levels');
});

test('native ICON pressure changes keep one stable isobar axis and preserve source pressures', () => {
  const source = parsePublishedProfileJson(JSON.stringify(golden))!;
  source.model = 'icon-eu';
  for (const [index, hour] of source.hours.entries()) {
    for (const level of hour.levels) level.pressureHpa = Number(level.pressureHpa) + index * .17;
  }
  assert.ok(parsePublishedProfileJson(JSON.stringify(source)), "published contract accepts native floating pressures");
  const before = structuredClone(source);
  const view = buildWindgramView(source, { timeZone: source.site.timeZone });
  const pressures = view.anchors.map(anchor => anchor.pressureHpa).filter(value => value !== null);
  assert.equal(new Set(pressures).size, pressures.length);
  assert.ok(pressures.length > 2 && pressures.length <= 22);
  assert.ok(pressures.every(p => p % 25 === 0));
  assert.ok(view.anchors.every((anchor, i, all) => i === 0 || anchor.heightM > all[i - 1].heightM));
  const sounding = buildSounding(source, source.hours[2])!;
  assert.ok(sounding.points.some(point => Math.abs(point.pressureHpa % 1) > .01));
  assert.deepEqual(source, before);
});
