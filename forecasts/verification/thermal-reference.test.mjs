import test from 'node:test';
import assert from 'node:assert/strict';
import {
  referenceParcelDepth,
  referenceCloudCap,
  referenceDiagnostics,
  compareDownsampling,
} from './thermal-reference.mjs';
const close = (actual, expected, tolerance = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const column = {
  validAt: '2026-10-21T20:00:00Z',
  temperatureC: 20,
  dewPointC: 10,
  sensibleHeatFluxWm2: 100,
  latentHeatFluxWm2: 20,
  surfacePressureHpa: 1000,
  pblHeightM: null,
  windSpeedMps: 3,
  windDirectionDeg: 240,
  levels: [
    { heightM: 1000, temperatureC: 10.199, pressureHpa: 900, dewPointC: 2 },
    { heightM: 2000, temperatureC: 0.401, pressureHpa: 800, dewPointC: -4 },
    { heightM: 3000, temperatureC: -5, pressureHpa: 700, dewPointC: -10 },
  ],
};

test('independent thermal root solves analytic crossing, preserves datum and exposes column-top limits', () => {
  close(referenceParcelDepth(column, 0).depthM, 1500);
  assert.equal(referenceParcelDepth(column, 0).branch, 'bracketed-parcel-crossing');
  close(
    referenceParcelDepth(
      { ...column, levels: column.levels.map((level) => ({ ...level, heightM: level.heightM + 2000 })) },
      2000,
    ).depthM,
    1500,
  );
  const topLimited = referenceParcelDepth({ ...column, temperatureC: 40 }, 0);
  assert.equal(topLimited.topLimited, true);
  assert.equal(topLimited.depthM, 3000);
  assert.equal(referenceParcelDepth({ ...column, levels: [{ heightM: 1000, temperatureC: null }] }, 0).depthM, null);
});

test('independent shallow closure distinguishes missing and zero heat and remains bounded near neutrality', () => {
  const shallow = {
    ...column,
    temperatureC: 18.6,
    sensibleHeatFluxWm2: 50,
    latentHeatFluxWm2: 0,
    levels: [
      { heightM: 1000, temperatureC: 10 },
      { heightM: 2000, temperatureC: 0 },
      { heightM: 3000, temperatureC: -10 },
    ],
  };
  close(referenceParcelDepth(shallow, 0).depthM, 500);
  assert.equal(referenceParcelDepth({ ...shallow, pblHeightM: 650 }, 0).depthM, 650);
  assert.equal(referenceParcelDepth({ ...shallow, sensibleHeatFluxWm2: null }, 0).depthM, null);
  assert.equal(referenceParcelDepth({ ...shallow, sensibleHeatFluxWm2: 0 }, 0).depthM, 0);
  for (const temperatureC of [19.79, 19.799, 19.799999])
    assert.equal(referenceParcelDepth({ ...shallow, temperatureC }, 0).depthM, 1000);
});

test('cloud cap independently locates saturation crossing and refuses missing-moisture interpolation', () => {
  const wet = {
    ...column,
    levels: [
      { heightM: 500, temperatureC: 18, dewPointC: 16 },
      { heightM: 1000, temperatureC: 15, dewPointC: 15 },
    ],
  };
  const cloud = referenceCloudCap(wet, 0);
  close(cloud.saturationHeightM, 875);
  close(cloud.effectiveCloudLimitM, 875);
  assert.ok(cloud.surfaceLclM > 875);
  assert.deepEqual(cloud.saturationBracketM, [500, 1000]);
  assert.equal(
    referenceCloudCap({ ...wet, levels: [{ ...wet.levels[0], dewPointC: null }, wet.levels[1]] }, 0)
      .effectiveCloudLimitM,
    null,
  );
  assert.equal(referenceCloudCap({ ...wet, dewPointC: 20 }, 0).effectiveCloudLimitM, 0);
});

test('raw-column references ignore all published derived values and prefer actual surface pressure', () => {
  const expected = referenceDiagnostics(column, 0);
  assert.deepEqual(
    referenceDiagnostics(
      { ...column, soaring: { resolvedThermalTopM: 99999, effectiveCloudLimitM: 1 }, derived: { cloudBaseM: 1 } },
      0,
    ),
    expected,
  );
  assert.equal(expected.support.pressure.source, 'supplied-surface-pressure');
  assert.equal(
    referenceDiagnostics({ ...column, surfacePressureHpa: null }, 0).support.pressure.source,
    'hypsometric-first-level',
  );
  assert.equal(referenceDiagnostics({ ...column, sensibleHeatFluxWm2: null }, 0).thermalVelocityV2Mps, null);
  assert.ok(expected.hcritWxtoflyM <= expected.usableLiftTopV2M);
});

test('dense-to-sparse experiment reveals a removed low inversion and cloud layer without creating weather', () => {
  const dense = {
    ...column,
    pblHeightM: 120,
    levels: [
      { heightM: 100, temperatureC: 19.5, dewPointC: 14.5, pressureHpa: 990 },
      { heightM: 200, temperatureC: 18, dewPointC: 17.8, pressureHpa: 980 },
      { heightM: 500, temperatureC: 14, dewPointC: 6, pressureHpa: 950 },
      { heightM: 1000, temperatureC: 10, dewPointC: 2, pressureHpa: 900 },
      { heightM: 1500, temperatureC: 8, dewPointC: 0, pressureHpa: 850 },
    ],
  };
  const experiment = compareDownsampling(dense, 0, [2, 3, 4]);
  assert.equal(experiment.dense.resolvedThermalTopM, 100);
  assert.ok(experiment.differences.resolvedThermalTopM > 900);
  assert.ok(experiment.differences.effectiveCloudLimitM > 900);
  assert.deepEqual(
    compareDownsampling(dense, 0, [0, 1, 2, 3, 4]).differences,
    Object.fromEntries(Object.keys(experiment.differences).map((key) => [key, 0])),
  );
  assert.throws(() => compareDownsampling(dense, 0, [0, 0]), /unique/);
});
