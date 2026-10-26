import test from 'node:test';
import assert from 'node:assert/strict';
import { compareWindAnchors, defaultWindColumns, evaluateWindAnchors } from './boundary-layer-wind-impact.mjs';

const column = { windSpeedMps: 2, windDirectionDeg: 270,
  levels: [{ heightM: 100, windSpeedMps: 10, windDirectionDeg: 270 }] };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('shallow-column means match the analytic boundary calculation', () => {
  const result = compareWindAnchors(0, column, 50, 1);
  close(result.baseline.blMeanWindSpeedMps, 4);
  close(result.candidate.blMeanWindSpeedMps, 2 + 8 * 40 / 90 / 2);
  assert.ok(result.deltas.blWindShearMps < 0);
  assert.equal(compareWindAnchors(0, column, 5, 1).candidate, null);
});

test('80 m wind retains its height and calm remains zero', () => {
  const result = compareWindAnchors(0, { ...column, levels: [{ ...column.levels[0], heightM: 1000 }],
    wind80mSpeedMps: 10, wind80mDirectionDeg: 270 }, 50, 1);
  close(result.candidate.blMeanWindSpeedMps, 2 + 8 * 40 / 70 / 2);
  const calm = compareWindAnchors(0, { ...column, windSpeedMps: 0,
    levels: column.levels.map(level => ({ ...level, windSpeedMps: 0 })) }, 50, 0);
  assert.equal(calm.candidate.blMeanWindSpeedMps, 0);
  assert.equal(calm.candidate.blWindShearMps, 0);
  assert.equal(calm.candidate.buoyancyShearRatio, 0);
});

test('frozen columns reproduce production and synthetic cases form separate groups', () => {
  const report = evaluateWindAnchors(defaultWindColumns());
  assert.equal(report.productionParityFailures, 0);
  assert.equal(report.columns, 21);
  assert.ok(report.groups.some(group => group.key.includes('synthetic')));
  assert.ok(report.results.some(row => row.productionParity === true));
  assert.equal(report.results.find(row => row.id === 'synthetic-5m').candidate, null);
});

test('unknown tops and missing wind support have distinct absence reasons', () => {
  const unknown = compareWindAnchors(0, column, null, 1);
  assert.equal(unknown.baseline, null);
  assert.equal(unknown.candidate, null);
  assert.equal(unknown.unavailableReason, 'Layer top is unavailable');
  assert.ok(Object.values(unknown.deltas).every(value => value === null));
  const missing = compareWindAnchors(0, { ...column, levels: [] }, 50, 1);
  assert.equal(missing.candidate, null);
  assert.equal(missing.unavailableReason, 'Wind samples are unavailable for integration');
  const missingSurface = compareWindAnchors(0, { ...column, windSpeedMps: null }, 50, 1);
  assert.equal(missingSurface.unavailableReason, missing.unavailableReason);
});

test('layer overrides are synthetic and unsupported production columns skip parity', () => {
  const record = defaultWindColumns()[0];
  const override = evaluateWindAnchors([{ ...record, layerTopM: record.terrainM + 50 }]);
  assert.equal(override.results[0].synthetic, true);
  assert.equal(override.results[0].productionParity, null);
  assert.ok(override.groups[0].key.endsWith('|synthetic'));
  const sparse = evaluateWindAnchors([{ ...record, column: { ...record.column, levels: record.column.levels.slice(0, 1), pblHeightM: 50 } }]);
  assert.equal(sparse.results[0].productionParity, null);
  assert.equal(sparse.productionParityFailures, 0);
  for (const layerTopM of [NaN, Infinity, record.terrainM - 1]) {
    assert.throws(() => evaluateWindAnchors([{ ...record, layerTopM }]), /Invalid column or layer top/);
  }
});
