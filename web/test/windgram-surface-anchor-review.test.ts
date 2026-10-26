import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertParsedSourceParity, surfaceAnchorPhysics, surfaceAnchorView, recordAnchorDelta } from '../scripts/windgram-surface-anchor-review.mjs';

const nodes = (values: number[]) => values.map((value, i) => ({ altitudeM: [100, 200, 400][i], value }));
const physics = () => [{ validAt: '2026-10-26T12:00:00Z', lift: { usableLiftTopM: 300 },
  sampling: { temperatureC: nodes([20, 15, 10]), dewPointC: nodes([15, 10, 5]), relativeHumidityPercent: nodes([96, 98, 40]),
    windU: nodes([0, 4, 8]), windV: nodes([2, 3, 4]), lapseCPer1000Ft: [], cloudCapped: false }, lapseClasses: [] }];
const classify = (value: number) => value < 0 ? 'cooling' : 'warming';

test('anchor review changes only known source heights and the gradients they define', () => {
  const old = physics(), original = structuredClone(old), expected = surfaceAnchorPhysics(old, 100, classify);
  assert.deepEqual(old, original);
  const sampling = expected[0].sampling;
  assert.equal(sampling.temperatureC[0].altitudeM, 102);
  assert.equal(sampling.dewPointC[0].altitudeM, 102);
  assert.equal(sampling.relativeHumidityPercent[0].altitudeM, 102);
  assert.equal(sampling.windU[0].altitudeM, 110);
  assert.equal(sampling.windV[0].altitudeM, 110);
  for (const key of ['temperatureC', 'dewPointC', 'relativeHumidityPercent', 'windU', 'windV']) {
    assert.equal(sampling[key][0].value, old[0].sampling[key][0].value);
    assert.deepEqual(sampling[key].slice(1), old[0].sampling[key].slice(1));
  }
  assert.ok(Math.abs(sampling.lapseCPer1000Ft[0].value - (-5 / 98 * 304.8)) < 1e-12);
  assert.equal(sampling.lapseCPer1000Ft[1].altitudeM, 199.99);
  assert.deepEqual(expected[0].lift, old[0].lift);
  assert.equal(sampling.cloudCapped, false);
  assert.throws(() => surfaceAnchorPhysics(old, 99, classify), /surface anchor/);
});

test('reader additions must match frozen source and cannot hide changed scalar values', () => {
  const old = { hours: [{ surface: { temperatureC: 20 }, soaring: { usableLiftTopV2M: 300 } }] };
  const current = { soaringMeta: { contractVersion: '2.1.0' }, hours: [{ ...structuredClone(old.hours[0]),
    soaring: { ...old.hours[0].soaring, verticalResolution: { nativeLevelCount: 3 } } }] };
  const source = structuredClone(current);
  assertParsedSourceParity(old, current, source);
  current.hours[0].soaring.verticalResolution.nativeLevelCount = 4;
  assert.throws(() => assertParsedSourceParity(old, current, source), /frozen source/);
  current.hours[0].soaring.verticalResolution.nativeLevelCount = 3;
  current.hours[0].surface.temperatureC = 21;
  assert.throws(() => assertParsedSourceParity(old, current, source), /Shared parsed source records/);
  current.hours[0].surface.temperatureC = 20;
  Object.assign(current.hours[0].soaring, { invented: undefined });
  assert.throws(() => assertParsedSourceParity(old, current, source), /must exist in frozen source/);
});

test('expected cloud changes derive only from shifted humidity nodes', () => {
  const expected = surfaceAnchorPhysics(physics(), 100, classify);
  const model = { hourIndex: 0, kind: 'model', baseM: 200, topM: 400 };
  const potential = { hourIndex: 0, kind: 'potential', baseM: 300, topM: 300 };
  const view = { hours: [{ validAt: expected[0].validAt }], floorM: 100, topM: 500,
    clouds: [model, { hourIndex: 0, kind: 'humidity', baseM: 100, topM: 200 }, potential] };
  const corrected = surfaceAnchorView(view, expected, (rh: unknown, threshold: number) => {
    assert.deepEqual(rh, expected[0].sampling.relativeHumidityPercent);
    assert.equal(threshold, 94.00001);
    return [{ baseM: 102, topM: 200 }];
  });
  assert.deepEqual(corrected.clouds, [model, { hourIndex: 0, kind: 'humidity', baseM: 102, topM: 200, coverPercent: null }, potential]);
  assert.equal(view.clouds[1].baseM, 100);
});

test('measured changes preserve unavailable readings and use vector distance across north', () => {
  const summary = { checkedReadings: 0, changedFields: {}, maxTemperatureDifferenceC: 0, maxWindVectorDifferenceMps: 0 };
  recordAnchorDelta(summary, { temperatureF: null, speedKt: 10, directionDeg: 359 }, { temperatureF: 50, speedKt: 10, directionDeg: 1 });
  assert.equal(summary.maxTemperatureDifferenceC, 0);
  assert.equal(summary.changedFields.temperatureF, 1);
  assert.ok(summary.maxWindVectorDifferenceMps > 0.17 && summary.maxWindVectorDifferenceMps < 0.19);
});

test('a failed QA invocation cannot leave an old passing receipt or silently ignore an unknown fixture', () => {
  const output = mkdtempSync(join(tmpdir(), 'windgram-qa-receipt-'));
  try {
    writeFileSync(join(output, 'report.json'), JSON.stringify({ status: 'passed' }));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/windgram-visual-qa.mjs', import.meta.url)),
      '--out', output, '--fixtures', 'dog-rrfs,unknown-fixture'], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Every selected fixture must be known/);
    assert.equal(JSON.parse(readFileSync(join(output, 'report.json'), 'utf8')).status, 'incomplete');
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
