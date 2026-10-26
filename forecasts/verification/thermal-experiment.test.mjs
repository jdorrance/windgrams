import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateThermalColumns, frozenThermalColumns } from './thermal-experiment.mjs';

test('frozen raw weather independently reproduces current thermal diagnostics deterministically offline', () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Reference experiment must stay offline');
  };
  try {
    const records = frozenThermalColumns(),
      original = JSON.stringify(records);
    const report = evaluateThermalColumns(records);
    assert.equal(report.columns, 18);
    assert.equal(report.checks, 126);
    assert.equal(report.failures, 0);
    assert.equal(JSON.stringify(records), original, 'source columns are not mutated');
    assert.equal(JSON.stringify(evaluateThermalColumns(records)), JSON.stringify(report));
    assert.ok(report.results.every((item) => item.evidence.sha256.length === 64));
    assert.ok(report.branchSweep.records.some((item) => item.branch === 'native-pbl-shallow-closure'));
    assert.ok(report.branchSweep.records.some((item) => item.topLimited));
    const native = report.results.filter((item) => item.model === 'icon-eu');
    assert.equal(native.length, 3);
    assert.ok(
      native.every((item) => item.downsampling.nativeLevelCount === 30 && item.downsampling.retainedLevelCount === 9),
    );
    assert.ok(
      native.every((item) => item.downsampling.retainedLevels.every((level) => Number.isInteger(level.modelLevel))),
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('supplied surface pressure is an independent input, with an explicit impact on W*', () => {
  const records = frozenThermalColumns(),
    source = records.find((record) => record.column.sensibleHeatFluxWm2 > 0);
  const before = evaluateThermalColumns([source]);
  const after = evaluateThermalColumns([{ ...source, column: { ...source.column, surfacePressureHpa: 700 } }]);
  assert.equal(after.failures, 0);
  assert.equal(after.results[0].reference.support.pressure.source, 'supplied-surface-pressure');
  assert.ok(after.results[0].reference.thermalVelocityV2Mps > before.results[0].reference.thermalVelocityV2Mps);
});
