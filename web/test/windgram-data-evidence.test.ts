import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWindgramView, readWindgram, renderWindgramSvg, renderWindgramDiagnosticsSvg } from './helpers/windgram.ts';

const profile = () => JSON.parse(readFileSync(new URL('../dev-data-src/convective-cycle.profile.json', import.meta.url), 'utf8'));
const viewOf = (p: ReturnType<typeof profile>, extra = {}) => buildWindgramView(p, { timeZone: 'Etc/UTC', unitSystem: 'metric', heightRange: 'full', ...extra });

test('native 80 m reversal controls wind sampling; missing and duplicate measurements break interpolation', () => {
  const p = profile(), ground = p.site.modelElevationM;
  for (const hour of p.hours) {
    Object.assign(hour.surface, { windSpeedMps: 2, windDirectionDeg: 0, wind80mSpeedMps: 10, wind80mDirectionDeg: 180 });
    hour.levels = hour.levels.filter((level: { heightM: number }) => level.heightM > ground + 100);
    for (const level of hour.levels) Object.assign(level, { windSpeedMps: 2, windDirectionDeg: 0 });
  }
  const reading = readWindgram(viewOf(p), 0, ground + 80);
  assert.equal(reading.windSource, 'surface-80m');
  assert.ok(Math.abs(reading.speedKt! / 1.9438444924406 - 10) < 1e-8);
  assert.equal(reading.directionDeg, 180);
  p.hours[0].surface.wind80mDirectionDeg = null;
  for (const height of [ground + 60, ground + 80, ground + 90]) assert.equal(readWindgram(viewOf(p), 0, height).speedKt, null);
  p.hours[0].surface.wind80mDirectionDeg = 180;
  p.hours[0].levels.unshift({ ...p.hours[0].levels[0], heightM: ground + 80 });
  assert.equal(readWindgram(viewOf(p), 0, ground + 80).speedKt, null);
});

test('cloud labels distinguish legacy effective limits from V2 surface LCL', () => {
  const p = profile();
  for (const hour of p.hours) hour.derived.cloudBaseM = 1600;
  let view = viewOf(p);
  assert.equal(readWindgram(view, 0, 1600).cloudBaseKind, 'effective');
  assert.match(renderWindgramSvg(view), /Effective cloud limit \(v1\)/);
  assert.doesNotMatch(renderWindgramSvg(view), /data-cloud-kind="potential"/);
  for (const hour of p.hours) hour.soaring = { thermalVelocityV2Mps: 2, resolvedThermalTopM: 2800,
    usableLiftTopV2M: 1600, surfaceLclM: 2200, effectiveCloudLimitM: 1600 };
  view = viewOf(p);
  const reading = readWindgram(view, 0, 1600);
  assert.equal(reading.cloudBaseKind, 'potential');
  assert.equal(reading.cloudBaseM, 2200);
  assert.equal(reading.effectiveCloudLimitM, 1600);
  assert.equal(reading.cloudCapped, true);
  assert.ok(view.series.find(series => series.key === 'effectiveCloudLimitM')?.path);
  assert.match(renderWindgramSvg(view), /data-cloud-kind="potential"/);
  for (const hour of p.hours) hour.soaring.surfaceLclM = null;
  view = viewOf(p);
  assert.equal(readWindgram(view, 0, 1600).cloudBaseM, null);
  assert.ok(view.series.find(series => series.key === 'effectiveCloudLimitM')?.path, 'a published effective limit remains visible without a surface LCL');
  for (const hour of p.hours) hour.soaring.effectiveCloudLimitM = null;
  view = viewOf(p);
  assert.equal(readWindgram(view, 0, 1600).effectiveCloudLimitM, null, 'V2 cap nulls stay unavailable');
  assert.equal(readWindgram(view, 0, 1600).cloudCapped, null);
  assert.equal(view.series.find(series => series.key === 'effectiveCloudLimitM')?.path, '');
});

test('moisture and omega keep physical units, native source, and capability limitations', () => {
  const p = profile();
  for (const hour of p.hours) for (const level of hour.levels) level.verticalVelocityPaS = -.25;
  const native = p.hours[0].levels[1], declared = p.hours[0].levels.slice(0, 3).map((l: { pressureHpa: number }) => l.pressureHpa);
  const capabilities = { verticalVelocity: 'pressureLevels', verticalVelocityLevels: declared };
  let reading = readWindgram(viewOf(p, { capabilities }), 0, native.heightM);
  assert.equal(reading.dewPointC, native.dewPointC);
  assert.ok(reading.relativeHumidityPercent! > 0);
  assert.equal(reading.verticalVelocityPaS, -.25);
  assert.equal(reading.verticalVelocitySource, 'model-level');
  const imperial = readWindgram(viewOf(p, { capabilities, unitSystem: 'imperial' }), 0, native.heightM);
  assert.equal(imperial.verticalVelocityPaS, reading.verticalVelocityPaS);
  assert.equal(imperial.dewPointC, reading.dewPointC);
  reading = readWindgram(viewOf(p, { capabilities: { ...capabilities, verticalVelocityLevels: declared.slice(0, 2) } }), 0, native.heightM);
  assert.equal(reading.verticalVelocityPaS, null);
  assert.match(reading.verticalVelocityUnavailableReason!, /minimum 3/);
  reading = readWindgram(viewOf(p, { capabilities: { verticalVelocity: false } }), 0, native.heightM);
  assert.equal(reading.verticalVelocityPaS, null);
});

test('omega permission follows source pressure when levels share a height', () => {
  const p = profile(), hour = p.hours[0];
  const declaredLevels = hour.levels.slice(0, 3).map((level: { verticalVelocityPaS: number }) => ({ ...level, verticalVelocityPaS: -.25 }));
  hour.levels = [{ ...declaredLevels[0], pressureHpa: 975, verticalVelocityPaS: -99 }, ...declaredLevels];
  const capabilities = { verticalVelocity: 'pressureLevels', verticalVelocityLevels: declaredLevels.map((level: { pressureHpa: number }) => level.pressureHpa) };
  const view = viewOf(p, { capabilities });
  assert.ok(Number.isNaN(view.sampling[0].verticalVelocityPaS[0].value), 'an undeclared pressure remains unavailable at a shared height');
  assert.equal(readWindgram(view, 0, declaredLevels[0].heightM).verticalVelocityPaS, -.25);
});

test('omega support counts only levels retained above model terrain', () => {
  const p = profile(), hour = p.hours[0];
  hour.levels = hour.levels.slice(0, 3);
  for (const level of hour.levels) level.verticalVelocityPaS = -.25;
  hour.levels[0].heightM = p.site.modelElevationM;
  const capabilities = { verticalVelocity: 'pressureLevels', verticalVelocityLevels: hour.levels.map((level: { pressureHpa: number }) => level.pressureHpa) };
  const reading = readWindgram(viewOf(p, { capabilities }), 0, hour.levels[1].heightM);
  assert.equal(reading.verticalVelocityPaS, null);
  assert.match(reading.verticalVelocityUnavailableReason!, /2 levels in view/);
});

test('published layer winds retain source values, nulls and units regardless of cursor height', () => {
  const p = profile();
  assert.equal(readWindgram(viewOf(p), 0, 1600).publishedLayerWind, null, 'layer winds require published V2 diagnostics');
  p.hours[0].soaring = { thermalVelocityV2Mps: null, blMeanWindSpeedMps: 4.25, blMeanWindDirDeg: 359,
    blTopWindSpeedMps: 8.5, blTopWindDirDeg: 2, blWindShearMps: 3.5, buoyancyShearRatio: null };
  const view = viewOf(p);
  const expected = { meanSpeedMps: 4.25, meanDirectionDeg: 359, topSpeedMps: 8.5, topDirectionDeg: 2, surfaceToTopShearMps: 3.5, buoyancyShearRatio: null };
  for (const height of [view.floorM + 80, 1600, 2400]) assert.deepEqual(readWindgram(view, 0, height).publishedLayerWind, expected);
  assert.deepEqual(readWindgram(viewOf(p, { unitSystem: 'imperial' }), 0, 1600).publishedLayerWind, expected);
  p.hours[0].soaring.blTopWindSpeedMps = null;
  assert.equal(readWindgram(viewOf(p), 0, 1600).publishedLayerWind?.topSpeedMps, null);
});

test('layer shear reports native bounds and missing or duplicate wind gaps', () => {
  const p = profile(), ground = p.site.modelElevationM, hour = p.hours[0];
  hour.levels = [100, 500, 1000].map((offset, i) => ({ ...hour.levels[i], heightM: ground + offset, windSpeedMps: 2 + 4 * i, windDirectionDeg: 0 }));
  const expected = { lowerM: ground + 100, upperM: ground + 500, vectorChangeMps: 4, perKmMps: 10 };
  assert.deepEqual(readWindgram(viewOf(p), 0, ground + 300).windShear, expected);
  assert.deepEqual(readWindgram(viewOf(p, { unitSystem: 'imperial' }), 0, ground + 300).windShear, expected);
  hour.levels[1].windSpeedMps = null;
  assert.equal(readWindgram(viewOf(p), 0, ground + 300).windShear, null);
  hour.levels[1].windSpeedMps = 6;
  hour.levels.splice(1, 0, { ...hour.levels[0] });
  assert.equal(readWindgram(viewOf(p), 0, ground + 300).windShear, null);
});

test('rain rate labels identify sample and interval-mean rates', () => {
  const p = profile();
  for (const [semantics, label] of [['instantRate', 'Rain sample'], ['windowMeanRate', 'Rain mean']] as const) {
    p.semantics.precipitation = semantics;
    const view = viewOf(p);
    assert.equal(view.diagnostics.find(strip => strip.key === 'precipitation')?.label, label);
    assert.match(renderWindgramDiagnosticsSvg(view), /mm\/h/);
  }
});

test('native PBL and cloud heights retain their separate datums and nulls', () => {
  const p = profile();
  Object.assign(p.hours[0].surface, { pblHeightM: 500, nativeCloudBaseM: 1800, nativeCloudCeilingM: null, nativeCloudTopM: 2400,
    nativeAdiabaticLclM: 1850, nativeLfcM: 1900, nativeEquilibriumLevelM: 4000, convectiveParcel: 'mixed-layer' });
  const reading = readWindgram(viewOf(p), 0, 1800);
  assert.equal(reading.modelPblTopM, p.site.modelElevationM + 500);
  assert.equal(reading.nativeCloudBaseM, 1800);
  assert.equal(reading.nativeCloudCeilingM, null);
  assert.equal(reading.nativeCloudTopM, 2400);
  assert.equal(reading.nativeAdiabaticLclM, 1850);
  assert.equal(reading.nativeLfcM, 1900);
  assert.equal(reading.nativeEquilibriumLevelM, 4000);
  assert.equal(reading.convectiveParcel, 'mixed-layer');
});
