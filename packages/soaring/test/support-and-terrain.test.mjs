import test from 'node:test';
import assert from 'node:assert/strict';
import { computeExperimentalTerrainAdjustment as estimate, deriveDiagnosticsV2, computeThermalVelocityMps } from '@windgrams/soaring';
import { sourceFromPublishedDeterministicHour } from '@windgrams/soaring/compatibility';
const surface = { windSpeedMps: 2, windDirectionDeg: 270 };
const level = (heightM, windSpeedMps = 8, windDirectionDeg = 270) => ({ heightM, windSpeedMps, windDirectionDeg });

test('launch wind uses the physical 10 m node and never extrapolates', () => {
  const result = estimate(100, 150, surface, [level(210)]);
  assert.equal(result.launchWindSpeedMps, 4.4);
  assert.deepEqual(result.bracketMslM, [110, 210]);
  assert.equal(result.targetHeightMslM, 150);
  assert.equal(result.targetReference, 'launch-elevation');
  for (const target of [99, 100, 109, 211]) {
    const absent = estimate(100, target, surface, [level(210)]);
    assert.equal(absent.launchWindSpeedMps, null);
    assert.equal(absent.bracketsLaunchAltitude, false);
  }
  assert.equal(estimate(100, 110, surface, []).launchWindSpeedMps, 2);
});

test('missing, duplicate and calm wind nodes retain their meaning', () => {
  for (const target of [140, 160]) {
    const missing = estimate(100, target, surface, [level(150, null), level(210)]);
    assert.equal(missing.launchWindSpeedMps, null);
    assert.equal(missing.unavailableReason, 'missing-bracket-wind');
  }
  assert.equal(estimate(100, 160, surface, [level(150), level(150, 3), level(210)]).unavailableReason, 'duplicate-height');
  const upperOnly = estimate(100, 200, { windSpeedMps: null }, [level(150, 4), level(250, 8)]);
  assert.equal(upperOnly.launchWindSpeedMps, 6);
  const calm = estimate(100, 110, { windSpeedMps: 0, windDirectionDeg: null }, []);
  assert.equal(calm.launchWindSpeedMps, 0);
  assert.equal(calm.launchWindDirectionDeg, null);
  assert.equal(calm.bracketsLaunchAltitude, true);
  const wrapped = estimate(0, 60, { windSpeedMps: 5, windDirectionDeg: 350 }, [level(110, 5, 10)]);
  assert.ok(wrapped.launchWindDirectionDeg === 0 || wrapped.launchWindDirectionDeg === 360);
  assert.equal(wrapped.launchWindSpeedMps, 4.92);
});

const column = {
  validAt: '2026-10-25T12:00:00Z', temperatureC: 20, dewPointC: 10, ...surface,
  sensibleHeatFluxWm2: 150, latentHeatFluxWm2: 50, pblHeightM: 400,
  levels: [600, 900, 1500].map((heightM, i) => ({ ...level(heightM), temperatureC: 15 - i * 5,
    dewPointC: 5 - i * 5, pressureHpa: 950 - i * 100 })),
};
test('launch wind retains native near-ground nodes excluded from parcel calculations', () => {
  const nearGround = { ...column.levels[0], ...level(115, 20) };
  const result = deriveDiagnosticsV2(100, { ...column, levels: [nearGround, ...column.levels] }, {}, { launchElevationM: 115 });
  assert.equal(result.verticalResolution.aboveGroundLevelCount, column.levels.length);
  assert.equal(result.experimental.terrainAdjustment.launchWindSpeedMps, 20);
  assert.deepEqual(result.experimental.terrainAdjustment.bracketMslM, [115, 115]);
});
test('surface pressure is preserved and used, sea-level pressure is never substituted', () => {
  const source = { ...column, surfacePressureHpa: 800, seaLevelPressureHpa: 1013 };
  const result = deriveDiagnosticsV2(100, source, {});
  assert.deepEqual(result.diagnosticSupport.surfacePressure, { source: 'model', valueHpa: 800 });
  const expected = computeThermalVelocityMps({ surfaceTemperatureC: 20, surfaceDewPointC: 10,
    sensibleHeatFluxWm2: 150, latentHeatFluxWm2: 50, surfacePressureHpa: 800,
    boundaryLayerDepthM: result.resolvedThermalTopM - 100 });
  assert.equal(result.thermalVelocityV2Mps, Math.round(expected * 100) / 100);
  const fallback = deriveDiagnosticsV2(100, { ...source, surfacePressureHpa: null }, {});
  assert.equal(fallback.diagnosticSupport.surfacePressure.source, 'hypsometric');
  assert.notEqual(fallback.diagnosticSupport.surfacePressure.valueHpa, 1013);
  assert.equal(sourceFromPublishedDeterministicHour({ validAt: source.validAt, surface: source, levels: source.levels }).surfacePressureHpa, 800);
});

test('sampling describes native geometry and reports fallback versus profile-top limits', () => {
  const result = deriveDiagnosticsV2(100, { ...column, temperatureC: 19 }, { derived: { cloudBaseM: 1000 } });
  assert.deepEqual(result.verticalResolution.sampling.temperature, {
    firstLevelAglM: 500, levelsInLowest1000M: 2, maxGapInLowest1000M: 600,
  });
  assert.equal(result.diagnosticSupport.thermalDepth.branch, 'model-pbl-fallback');
  assert.deepEqual(result.diagnosticSupport.thermalDepth.bracketMslM, [100, 600]);
  assert.equal(result.diagnosticSupport.cloudLimit.source, 'baseline-cloud-base');
  const top = deriveDiagnosticsV2(100, { ...column, temperatureC: 40 }, {});
  assert.equal(top.diagnosticSupport.thermalDepth.topLimited, true);
  assert.equal(top.diagnosticSupport.cloudLimit.source, 'surface-lcl');
  const invalidCap = deriveDiagnosticsV2(100, column, { derived: { cloudBaseM: NaN } });
  assert.equal(invalidCap.effectiveCloudLimitM, invalidCap.surfaceLclM);
  assert.equal(invalidCap.diagnosticSupport.cloudLimit.source, 'surface-lcl');
});
