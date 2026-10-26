import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelDescriptor } from '@windgrams/providers/registry';
import { captureNoaaColumns } from './capture-noaa-columns.mjs';

function request(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'noaa-capture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { model: 'hrrr-conus', 'reference-time': '2026-10-21T00:00:00Z', hours: 'all',
    bounds: '-123,47,-122,48', output: join(root, 'capture.json'), ...extra };
}
const captured = hours => ({ verticalMode: 'legacy-pressure', completeness: 'partial', cells: [{ id: 'cell' }],
  assets: [{ size: 10 }], hours: hours.map(forecastHour => ({ forecastHour, columns: [null] })) });

test('all selects the registered horizon and offline capture blocks a cache miss', async t => {
  const values = request(t, { offline: true });
  const schedule = modelDescriptor(values.model).forecastHours;
  const result = await captureNoaaColumns(values, { acquire: async options => {
    assert.deepEqual(options.forecastHours, schedule);
    assert.throws(() => options.fetchImpl('https://example.invalid/'), /Offline cache miss/);
    return captured(options.forecastHours);
  } });
  assert.equal(result.fullHorizon, true);
  assert.equal(result.offline, true);
  assert.equal(result.missingColumns, schedule.length);
  assert.equal(JSON.parse(readFileSync(`${values.output}.metrics.json`)).fullHorizon, true);
  assert.equal(existsSync(`${values.output}.capture.lock`), false);
  await assert.rejects(captureNoaaColumns(values, { acquire: () => assert.fail('existing capture reached acquisition') }), /EEXIST/);
});

test('horizon metrics reflect returned hours and acquisition failures permit retry', async t => {
  const values = request(t);
  await assert.rejects(captureNoaaColumns(values, { acquire: async () => { throw new Error('source unavailable'); } }), /source unavailable/);
  assert.equal(existsSync(values.output), false);
  assert.equal(existsSync(`${values.output}.capture.lock`), false);
  const result = await captureNoaaColumns(values, { acquire: async () => captured([1, 2]) });
  assert.equal(result.fullHorizon, false, 'requesting all does not make a partial response complete');
  assert.equal(result.hours, 2);
});
