import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeThermalVelocityMps, deriveDiagnosticsV2, SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { resolvedParcelDepthM, postprocessPointForecast, sourceFromPublishedDeterministicHour,
  deriveEnsembleSoaringDiagnostics } from '@windgrams/soaring/compatibility';

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const environment = [
  { heightM: 1000, temperatureC: 10 },
  { heightM: 2000, temperatureC: 0 },
  { heightM: 3000, temperatureC: -10 },
];

test('first-layer heat closure reaches its cap at the exact neutral limit without an epsilon cliff', () => {
  for (const surfaceC of [19.7, 19.79, 19.795, 19.799, 19.799999]) {
    assert.equal(resolvedParcelDepthM(surfaceC, 100, 0, null, 0, environment), 1000);
    assert.equal(resolvedParcelDepthM(surfaceC, 100, 0, 650, 0, environment), 650);
  }
  // Construct exact floating-point neutrality using the same dry-adiabatic
  // temperature, rather than assuming decimal 19.8 - 9.8 is exactly 10.
  const neutral = [{ heightM: 1000, temperatureC: 20 - 1000 * 0.0098 }, ...environment.slice(1)];
  assert.equal(resolvedParcelDepthM(20, 100, 0, null, 0, neutral), 1000);
  // The closure remains capped at the first observation. An unboosted parcel
  // clearing that observation can reach the upper column; this is a separate policy.
  assert.equal(resolvedParcelDepthM(19.805, 100, 0, null, 0, environment), 3000);
  // D(z1)=1.2 C and imposed sensible excess=0.6 C: the exact linear root is z1/2.
  close(resolvedParcelDepthM(18.6, 50, 0, null, 0, environment), 500);
  assert.equal(resolvedParcelDepthM(19.795, 0, 0, null, 0, environment), 0);
  assert.equal(resolvedParcelDepthM(19.795, -100, 0, 650, 0, environment), 0);
  assert.equal(resolvedParcelDepthM(19.795, 0, 100, null, 0, environment), 0);
  assert.equal(resolvedParcelDepthM(19.795, 0, 100, 650, 0, environment), 650);
  close(resolvedParcelDepthM(18.7, 0, 0, null, 0, environment, 1), 1000 / 1.1);
  assert.equal(resolvedParcelDepthM(18.7, 0, 0, 650, 0, environment, 1), 900);
});

test('upper-layer near-neutral crossing follows signed buoyancy and is invariant to resampling and datum', () => {
  // Parcel excess is +0.001 C at 1000 m and -0.001 C at 2000 m.
  const levels = [{ heightM: 1000, temperatureC: 10.199 }, { heightM: 2000, temperatureC: 0.401 },
    { heightM: 3000, temperatureC: -5 }];
  const depth = resolvedParcelDepthM(20, 100, 0, null, 0, levels);
  close(depth, 1500);
  close(resolvedParcelDepthM(20, 100, 0, null, 0,
    [levels[0], { heightM: 1400, temperatureC: 6.2798 }, ...levels.slice(1)]), depth);
  close(resolvedParcelDepthM(20, 100, 0, null, 2000,
    levels.map(level => ({ ...level, heightM: level.heightM + 2000 }))), depth);
  for (const surfaceC of [19.9995, 20, 20.0005]) {
    const expected = 1000 + (surfaceC - 19.999) / 0.000002;
    close(resolvedParcelDepthM(surfaceC, 100, 0, null, 0, levels), expected);
  }
});

const velocityInput = { surfaceTemperatureC: 20, surfaceDewPointC: 10,
  sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 80, boundaryLayerDepthM: 1000, surfacePressureHpa: 950 };
test('W* distinguishes missing inputs, measured zero and non-convective conditions', () => {
  assert.ok(computeThermalVelocityMps(velocityInput) > 0);
  for (const field of ['sensibleHeatFluxWm2', 'latentHeatFluxWm2', 'boundaryLayerDepthM', 'surfacePressureHpa']) {
    for (const absent of [null, undefined, NaN]) assert.equal(computeThermalVelocityMps({ ...velocityInput, [field]: absent }), null, field);
  }
  assert.equal(computeThermalVelocityMps({ ...velocityInput, sensibleHeatFluxWm2: 0, latentHeatFluxWm2: 0 }), 0);
  assert.equal(computeThermalVelocityMps({ ...velocityInput, sensibleHeatFluxWm2: -100, latentHeatFluxWm2: 0 }), 0);
  assert.equal(computeThermalVelocityMps({ ...velocityInput, boundaryLayerDepthM: 0 }), 0);
  assert.equal(computeThermalVelocityMps({ ...velocityInput, boundaryLayerDepthM: -1 }), null);
  assert.equal(computeThermalVelocityMps({ ...velocityInput, surfacePressureHpa: null, terrainM: 2000, firstLevel: {} }), null);
  assert.ok(computeThermalVelocityMps({ ...velocityInput, surfacePressureHpa: null, terrainM: 2000,
    firstLevel: { heightM: 2200, pressureHpa: 780, temperatureC: 18 } }) > 0);
  // The existing public dry-air approximation remains available when dew point is omitted.
  assert.ok(computeThermalVelocityMps({ ...velocityInput, surfaceDewPointC: undefined }) > 0);
});

const profile = JSON.parse(readFileSync(new URL('../../../forecasts/soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
test('point reconstruction preserves absence through W*, ceilings and ratios while retaining independent readings', () => {
  for (const missing of ['sensibleHeatFluxWm2', 'latentHeatFluxWm2']) {
    const hour = structuredClone(profile.hours[0]);
    Object.assign(hour.surface, { [missing]: null, precipitationMmHr: null, cloudCoverPercent: null, seaLevelPressureHpa: null });
    const source = sourceFromPublishedDeterministicHour(hour);
    for (const field of [missing, 'precipitationMm', 'cloudCoverPercent', 'seaLevelPressureHpa']) assert.equal(source[field], null, field);
    const output = postprocessPointForecast({ ...profile, hours: [hour] }).hours[0];
    assert.equal(output.surface, hour.surface);
    assert.equal(output.derived, hour.derived);
    assert.equal(output.soaring.contractVersion, SOARING_CONTRACT_VERSION);
    for (const field of ['thermalVelocityV2Mps', 'usableLiftTopV2M', 'hcritWxtoflyM', 'dryHcritM', 'buoyancyShearRatio', missing, 'precipitationMmHr', 'cloudCoverPercent']) {
      assert.equal(output.soaring[field], null, field);
    }
    assert.ok(Number.isFinite(output.soaring.surfaceLclM));
    assert.equal(output.soaring.wind10mSpeedMps, hour.surface.windSpeedMps);
  }
  const hour = structuredClone(profile.hours[0]);
  Object.assign(hour.surface, { sensibleHeatFluxWm2: 0, latentHeatFluxWm2: 0, precipitationMmHr: 0, cloudCoverPercent: 0 });
  const output = postprocessPointForecast({ ...profile, hours: [hour] }).hours[0].soaring;
  for (const field of ['thermalVelocityV2Mps', 'sensibleHeatFluxWm2', 'latentHeatFluxWm2', 'precipitationMmHr', 'cloudCoverPercent']) assert.equal(output[field], 0, field);
});

test('unknown shallow depth cannot manufacture a surface-only mixed layer; known PBL remains usable', () => {
  const source = sourceFromPublishedDeterministicHour(profile.hours[0]);
  Object.assign(source, { temperatureC: -10, sensibleHeatFluxWm2: null, pblHeightM: null });
  const result = deriveDiagnosticsV2(profile.site.modelElevationM, source, {});
  for (const field of ['resolvedThermalTopM', 'mixedLayerLclM', 'blMeanWindSpeedMps', 'blWindShearMps']) assert.equal(result[field], null, field);
  const pbl = deriveDiagnosticsV2(profile.site.modelElevationM, { ...source, pblHeightM: 500 }, {});
  assert.ok(Number.isFinite(pbl.mixedLayerLclM));
  assert.ok(Number.isFinite(pbl.blMeanWindSpeedMps));
  assert.equal(pbl.buoyancyShearRatio, null);
});

test('ensemble W* counts supported members while preserving measured-zero members', () => {
  const source = sourceFromPublishedDeterministicHour(profile.hours[0]);
  const member = patch => ({ source: { ...source, ...patch }, v1Hour: profile.hours[0] });
  const ensemble = deriveEnsembleSoaringDiagnostics([
    member({ sensibleHeatFluxWm2: 0, latentHeatFluxWm2: 0 }),
    member({ sensibleHeatFluxWm2: null }),
  ], profile.site.modelElevationM);
  assert.equal(ensemble.memberCount, 2);
  assert.equal(ensemble.thermalVelocityV2Mps.members, 1);
  assert.equal(ensemble.thermalVelocityV2Mps.p50, 0);
  const missing = deriveEnsembleSoaringDiagnostics([member({ sensibleHeatFluxWm2: null })], profile.site.modelElevationM);
  assert.equal(missing.thermalVelocityV2Mps.members, 0);
  assert.equal(missing.thermalVelocityV2Mps.p50, null);
  assert.equal(missing.hcritWxtoflyM.p50, null);
});
