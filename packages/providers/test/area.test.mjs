import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIconAreaAdapter } from '@windgrams/providers/area';
import { acquireIcon, normalizeIconExtract } from '@windgrams/providers/icon';

const raw = JSON.parse(readFileSync(new URL('../../../forecasts/scripts/lib/icon-native-fixture.json', import.meta.url)));
const nativeFixture = () => normalizeIconExtract(structuredClone(raw));
const request = (extra = {}) => ({ run: { provider: 'DWD', model: 'icon-eu', product: 'icon-eu/native-model-levels', referenceTime: raw.referenceTime }, bounds: [44, 39, 47, 41], forecastHours: [7], cacheDir: '/unused', ...extra });

test('ICON area acquisition forwards explicit selection and preserves native values and provenance', async () => {
  const native = nativeFixture(), before = JSON.stringify(native), sites = [{ slug: 'hatis', latitude: 40.3, longitude: 44.7 }];
  const adapter = createIconAreaAdapter({ sites, acquire: async options => {
    assert.deepEqual(options.forecastHours, [7]); assert.deepEqual(options.bbox, [44, 39, 47, 41]);
    assert.equal(options.referenceTime, raw.referenceTime); assert.equal(options.cacheDir, '/unused'); assert.equal(options.sites, sites);
    return native;
  } });
  const result = await adapter.acquire(request({ fields: ['windSpeedMps', 'levels'] }));
  assert.equal(result.kind, 'normalized-area'); assert.equal(result.native, native);
  assert.equal(result.hours, result.hours, 'normalized hour records remain stable across reads');
  assert.equal(result.grid.id, native.grid.uuid); assert.equal(result.cells.length, 3);
  assert.deepEqual(result.cells.map(cell => cell.gridIndex), native.cells.map(cell => cell.index));
  for (let i = 0; i < 3; i++) {
    assert.equal(result.hours[0].columns[i].column, native.hours[0].sources[i]);
    assert.equal(result.hours[0].columns[i].provenance.gridCell.gridIndex, result.cells[i].gridIndex);
    assert.equal(result.hours[0].columns[i].provenance.sources[0].referenceTime, raw.referenceTime);
  }
  assert.equal(JSON.stringify(native), before);
});

test('area cells are reindexed within the requested bounds and missing columns keep their position', async () => {
  const native = nativeFixture(); native.hours[0].sources[1] = null;
  const adapter = createIconAreaAdapter({ acquire: async () => native });
  const result = await adapter.acquire(request({ bounds: [44.9, 40.4, 45.2, 40.7] }));
  assert.equal(result.cells.length, 1); assert.equal(result.cells[0].cellIndex, 0); assert.equal(result.cells[0].gridIndex, native.cells[1].index);
  assert.deepEqual(result.hours[0].columns, [null]);
  assert.equal(result.native.cells.length, 3, 'point-support cells stay available to the existing producer');
});

test('invalid area, run, source, fields and hours reject before acquisition starts', async () => {
  let calls = 0;
  const adapter = createIconAreaAdapter({ acquire: async () => { calls++; return nativeFixture(); } });
  const base = request();
  const invalid = [
    { run: { ...base.run, model: 'gfs' } }, { run: { ...base.run, provider: 'NOAA' } }, { run: { ...base.run, product: 'wrong-product' } },
    { run: { ...base.run, referenceTime: '2026-10-24T07:00:00Z' } }, { run: { ...base.run, referenceTime: 'bad' } },
    { bounds: [0, 0, 1, 1] }, { bounds: [45, 40, 44, 41] }, { bounds: [44, 40, 44, 41] }, { bounds: undefined },
    { forecastHours: [] }, { forecastHours: [7, 7] }, { forecastHours: [8, 7] }, { forecastHours: [0] }, { forecastHours: [79] }, { forecastHours: [1.5] },
    { fields: ['wind80mSpeedMps'] }, { fields: ['not-a-column-field'] }, { cacheDir: '' },
  ];
  for (const override of invalid) await assert.rejects(adapter.acquire(request(override)), /ICON|bounding box/);
  assert.equal(calls, 0);
});

test('returned source, time, dimensions and native geometry must match the area request', async () => {
  const mutations = [
    native => { native.provenance.accessProduct = 'https://wrong.example/'; },
    native => { native.model = 'wrong'; },
    native => { native.provenance.provider = 'wrong'; },
    native => { native.referenceTime = '2026-10-24T00:00:00Z'; },
    native => { native.hours[0].forecastHour = 8; native.hours[0].validAt = '2026-10-24T14:00:00Z'; for (const column of native.hours[0].sources) if (column) column.validAt = native.hours[0].validAt; },
    native => { native.hours[0].sources.pop(); },
    native => { native.cells[1].cellIndex = 0; },
    native => { native.cells[1].index = native.cells[0].index; },
    native => { native.cells[0].latitude = 95; },
    native => { native.cells[0].corners = []; },
    native => { native.grid.geometrySource.uuid = 'wrong'; },
  ];
  for (const mutate of mutations) {
    const native = nativeFixture(); mutate(native);
    await assert.rejects(createIconAreaAdapter({ acquire: async () => native }).acquire(request()), /ICON/);
  }
  await assert.rejects(createIconAreaAdapter({ acquire: async () => nativeFixture() }).acquire(request({ bounds: [20, 40, 21, 41] })), /contains no acquired ICON cells/);
});

test('area cancellation stops before IO or before returning a completed acquisition', async () => {
  const before = new AbortController(); before.abort(new Error('cancelled before acquisition'));
  await assert.rejects(createIconAreaAdapter({ acquire: async () => assert.fail('unexpected acquisition') }).acquire(request({ signal: before.signal })), /cancelled before/);
  const during = new AbortController();
  const adapter = createIconAreaAdapter({ acquire: async options => {
    assert.equal(options.signal, during.signal); during.abort(new Error('cancelled acquisition')); return nativeFixture();
  } });
  await assert.rejects(adapter.acquire(request({ signal: during.signal })), /cancelled acquisition/);
});

test('an acquisition retains the run identity selected before the asynchronous read', async () => {
  const selected = request();
  const adapter = createIconAreaAdapter({ acquire: async () => { selected.run.model = 'changed'; return nativeFixture(); } });
  assert.equal((await adapter.acquire(selected)).run.model, 'icon-eu');
});

test('cancelling native acquisition terminates its decoder before the request settles', async t => {
  const root = mkdtempSync(join(tmpdir(), 'icon-area-cancel-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const runner = join(root, 'decoder.mjs');
  writeFileSync(runner, `#!${process.execPath}\nconsole.log('decoder-pid:' + process.pid); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const controller = new AbortController(); let pid;
  await assert.rejects(acquireIcon({ referenceTime: raw.referenceTime, forecastHours: [7], bbox: [44, 39, 47, 41], cacheDir: join(root, 'cache'), python: runner, signal: controller.signal,
    log(line) { if (line.startsWith('decoder-pid:')) { pid = Number(line.slice(12)); controller.abort(new Error('cancel decoder')); } },
  }), /cancel decoder/);
  assert.ok(Number.isInteger(pid));
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});
