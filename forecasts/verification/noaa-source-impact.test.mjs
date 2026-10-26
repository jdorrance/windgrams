import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluateNoaaSources, readNoaaCapture } from './noaa-source-impact.mjs';

const frozen = JSON.parse(readFileSync(new URL('../soaring/fixtures/blanchard-raw.json', import.meta.url)));
function input(mode, extra = {}) {
  const column = { ...frozen.hours[0].source, ...extra };
  return { path: `${mode}.json`, sha256: mode, capture: {
    model: 'hrrr-conus', verticalMode: mode, referenceTime: '2026-10-21T00:00:00Z', capturedAt: '2026-10-21T14:00:00Z',
    cells: [{ id: 'cell', latitude: 48, longitude: -122, modelElevationM: frozen.terrain }],
    assets: [{ url: 'fixture', range: '0-999', size: 1000 }],
    hours: [{ forecastHour: 14, validAt: column.validAt, columns: [{ column, modelElevationM: frozen.terrain,
      provenance: { sources: [{ gridId: 'same-grid' }] } }] }],
  } };
}

function captureFile(t) {
  const root = mkdtempSync(join(tmpdir(), 'noaa-impact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const capture = input('legacy-pressure').capture;
  Object.assign(capture, { schemaVersion: 1, grid: { gridKey: 'same-grid' } });
  capture.assets[0].sha256 = 'a'.repeat(64);
  const source = { id: 'source', provider: 'NOAA', product: 'hrrr/conus/wrfprs', model: capture.model,
    referenceTime: capture.referenceTime, acquiredAt: capture.capturedAt, gridId: capture.grid.gridKey };
  Object.assign(capture.hours[0].columns[0], { schemaVersion: 1, provenance: {
    sources: [source], fieldSemantics: {}, gridCell: { id: 'cell', latitude: 48, longitude: -122 },
    capabilities: { verticalCoordinates: 'pressure-levels', ensemble: 'deterministic', fields: {} },
  } });
  const path = join(root, 'capture.json');
  const write = (value = capture) => writeFileSync(path, JSON.stringify(value));
  write();
  return { path, capture, write };
}

test('source report matches columns and records field effects and horizon coverage', () => {
  const baseline = input('legacy-pressure'), candidate = input('expanded-pressure', {
    surfacePressureHpa: 800, wind80mSpeedMps: 9, wind80mDirectionDeg: 270,
    nativeCloudBaseM: 1200, nativeCloudCeilingM: 1400, convectiveParcel: 'surface',
  });
  const { report, profiles } = evaluateNoaaSources([baseline, candidate]);
  assert.equal(report.comparisons.length, 1);
  assert.equal(report.captures[0].fullHorizon, false);
  assert.ok(report.captures[0].missingHorizonHours.includes(1));
  assert.equal(report.captures[0].estimatedFullHorizonSourceBytes, report.captures[0].expectedHours.length * 1000);
  assert.equal(report.rows[1].nativeFields.nativeCloudBaseM, 1200);
  assert.equal(profiles[1].profile.hours[0].surface.nativeCloudCeilingM, 1400);
  assert.equal(profiles[1].profile.hours[0].surface.convectiveParcel, 'surface');
  assert.deepEqual(Object.keys(report.comparisons[0].outputs), ['pressureOnly', 'levelsOnly', 'wind80mOnly', 'candidate']);
  assert.equal(report.productionDefault, 'legacy-pressure');
  assert.equal(report.publicationReady, false);
  candidate.capture.cells[0].modelElevationM += 1;
  const mismatched = evaluateNoaaSources([baseline, candidate]).report;
  assert.equal(mismatched.comparisons.length, 0);
  assert.equal(mismatched.unmatched.length, 1);
});

test('duplicate sources fail and missing columns are counted', () => {
  assert.throws(() => evaluateNoaaSources([input('legacy-pressure'), input('legacy-pressure')]), /Duplicate/);
  const missing = input('expanded-pressure');
  missing.capture.hours[0].columns[0] = null;
  missing.capture.hours[0].missingReasons = ['missing native field'];
  const { report } = evaluateNoaaSources([missing]);
  assert.equal(report.rows.length, 0);
  assert.equal(report.captures[0].missingColumns[0].reason, 'missing native field');
});

test('candidate profiles group and order hours by source mode and cell', () => {
  const baseline = input('legacy-pressure'), candidate = input('expanded-pressure', { surfacePressureHpa: 980 });
  for (const captured of [baseline, candidate]) {
    const later = structuredClone(captured.capture.hours[0]);
    later.forecastHour = 15;
    later.validAt = '2026-10-21T15:00:00Z';
    later.columns[0].column.validAt = later.validAt;
    // Exercise sorting with reversed source hours.
    captured.capture.hours.unshift(later);
  }
  const { report, profiles } = evaluateNoaaSources([baseline, candidate]);
  assert.equal(report.rows.length, 4);
  assert.equal(report.comparisons.length, 2);
  assert.equal(profiles.length, 2, 'one profile per model/mode/run/cell');
  for (const row of profiles) {
    assert.equal(row.model, 'hrrr-conus');
    assert.equal(row.cellId, 'cell');
    assert.equal(row.referenceTime, baseline.capture.referenceTime);
    assert.deepEqual(row.profile.hours.map(hour => hour.validAt), ['2026-10-21T14:00:00Z', '2026-10-21T15:00:00Z']);
    assert.ok(row.profile.hours.every(hour => hour.soaring));
  }
  assert.deepEqual(profiles.map(row => row.mode), ['legacy-pressure', 'expanded-pressure']);
  assert.ok(profiles[1].profile.hours.every(hour => hour.surface.surfacePressureHpa === 980));
});

test('capture reader rejects mismatched native identities and malformed coverage', async t => {
  const { path, capture, write } = captureFile(t);
  assert.equal((await readNoaaCapture(path)).capture.hours.length, 1);
  const changes = [
    value => { value.cells[0].latitude += 1; },
    value => { value.grid.gridKey = 'another-grid'; },
    value => { value.hours[0].columns[0].provenance.sources[0].referenceTime = '2026-10-21T06:00:00Z'; },
    value => { value.hours[0].validAt = '2026-10-21T15:00:00Z'; },
    value => { value.hours.push(structuredClone(value.hours[0])); },
    value => { value.capturedAt = 'unknown'; },
    value => { value.assets[0].size = -1; },
    value => { value.model = 'gfs'; value.verticalMode = 'hrrr-native'; },
  ];
  for (const change of changes) {
    const invalid = structuredClone(capture); change(invalid); write(invalid);
    await assert.rejects(readNoaaCapture(path), /capture/i);
  }
  const missing = structuredClone(capture);
  missing.hours[0].columns[0] = null;
  write(missing);
  assert.equal((await readNoaaCapture(path)).capture.hours[0].columns[0], null);
});

test('receipt content cannot replace its measured file identity', async t => {
  const { path } = captureFile(t);
  const receipt = JSON.stringify({ elapsedMs: 10, file: 'wrong-file', sha256: 'wrong-hash' });
  writeFileSync(`${path}.metrics.json`, receipt);
  const { acquisitionMetrics } = await readNoaaCapture(path);
  assert.equal(acquisitionMetrics.file, `${path}.metrics.json`);
  assert.equal(acquisitionMetrics.sha256, createHash('sha256').update(receipt).digest('hex'));
  assert.equal(acquisitionMetrics.elapsedMs, 10);
});
