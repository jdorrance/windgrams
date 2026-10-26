import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseIdx, parseFields } from '@azohra/meteo.grib';
import { acquireNoaa, createNoaaAdapter, createNoaaAreaAdapter, fixedSurface, LEGACY_GFS_PRESSURE_LEVELS, EXTENDED_GFS_PRESSURE_LEVELS, fields, selectRecords, EXTENDED_HRRR_PRESSURE_LEVELS, cellSource } from '../dist/noaa.js';
import { trailingGfsValues } from '../dist/internal/noaa/intervals.js';
import { geographicProjection, selectGridCells } from '../dist/internal/noaa/grid.js';
import { specificHumidityDewpointC, nativeColumn, selectNativeRecords } from '../dist/internal/noaa/native.js';
import { inspectField } from '../dist/internal/noaa/transport.js';
import { fixtureTransport, rrfsFixtureTransport } from '../../../forecasts/soaring/fixture-helper.mjs';
import { captureNoaaColumns } from '../../../forecasts/scripts/capture-noaa-columns.mjs';
const fixtureRoot = new URL('../../../forecasts/soaring/', import.meta.url);
const json = async path => JSON.parse(await readFile(new URL(path, fixtureRoot), 'utf8'));
const c = { ...await json('cases/north-sound-20261021-00z.json'), forecastHours: [14, 20] };
const real = await json('fixtures/blanchard-raw.json');
const rrfs = await json('fixtures/rrfs-native-column.json');
const run = { model: 'hrrr-conus', provider: 'NOAA', product: 'hrrr/conus/wrfprs', referenceTime: c.referenceTime };
const temporary = async t => { const path = await mkdtemp(join(tmpdir(), 'noaa-columns-')); t.after(() => rm(path, { recursive: true, force: true })); return path; };

test('normalized NOAA capture samples points and region together, reproduces offline, and catches changed bytes', async t => {
  const cacheDir = await temporary(t), fetchImpl = await fixtureTransport(c);
  let requests = 0;
  const options = { model: 'hrrr-conus', referenceTime: c.referenceTime, forecastHours: c.forecastHours, sites: [c.site, { ...c.site, slug: 'same-cell' }], bounds: [-122.5, 48.5, -122.3, 48.7], cacheDir, fetchImpl: (...args) => { requests++; return fetchImpl(...args); } };
  const result = await acquireNoaa(options);
  assert.equal(result.verticalMode, 'legacy-pressure');
  assert.equal(result.siteCells[c.site.slug], result.siteCells['same-cell']);
  assert.equal(result.hours.length, 2);
  assert.equal(result.cells.length, 16);
  const record = result.hours[1].columns[result.siteCells[c.site.slug]];
  assert.equal(record.provenance.gridCell.gridIndex, result.cells[result.siteCells[c.site.slug]].index);
  assert.equal(record.column.levels.length, 9);
  assert.equal(record.column.surfacePressureHpa, undefined);
  assert.equal(record.provenance.fieldSemantics.precipitationMm.timeSupport.kind, 'instant');
  assert.equal(record.provenance.fieldSemantics.levels.sampling, 'interpolated');
  assert.ok(Math.abs(record.column.temperatureC - (real.hours.find(h => h.forecastHour === 20).raw.temperature - 273.15)) < 0.0001);
  assert.equal(requests, result.assets.length, 'adding a coincident launch does not redownload the grid');
  assert.deepEqual(await acquireNoaa({ ...options, fetchImpl: () => { throw new Error('offline'); } }), result);
  const asset = result.assets.find(source => source.range);
  await writeFile(join(cacheDir, 'noaa-columns-1', asset.file), Buffer.from('corrupted'));
  await assert.rejects(acquireNoaa({ ...options, fetchImpl: () => { throw new Error('offline'); } }), /Corrupt NOAA cached bytes/);
});

test('missing above-ground pressure nodes stay unavailable; below-ground missing nodes are masked', async t => {
  const base = await fixtureTransport(c);
  const altered = terrain => async (...args) => {
    const response = await base(...args);
    if (response.status !== 206) return response;
    const bytes = Buffer.from(await response.arrayBuffer()), field = parseFields(bytes)[0];
    const section = field.section4;
    // Original forecast sections are retained: corrupt only a known simple-packed source value.
    if (section[9] === 0 && section[10] === 0 && section[22] === 100 && section.readUInt32BE(24) === 92500) field.section5.writeFloatBE(NaN, 11);
    if (terrain !== undefined && section[9] === 3 && section[10] === 5 && section[22] === 1) field.section5.writeFloatBE(terrain, 11);
    return new Response(bytes, { status: 206, headers: response.headers });
  };
  const options = { model: 'hrrr-conus', referenceTime: c.referenceTime, forecastHours: [14], sites: [c.site] };
  const partial = await acquireNoaa({ ...options, cacheDir: await temporary(t), fetchImpl: altered() });
  assert.equal(partial.completeness, 'partial');
  assert.equal(partial.hours[0].columns[0], null);
  assert.match(partial.hours[0].missingReasons[0], /925 hPa.*gap interpolation prohibited/);
  const masked = await acquireNoaa({ ...options, cacheDir: await temporary(t), fetchImpl: altered(3000) });
  assert.equal(masked.completeness, 'complete');
  assert.ok(masked.hours[0].columns[0].column.levels.every(level => level.heightM > 3000));
});

test('NOAA point and area APIs expose the same frozen columns and reject incompatible required fields', async t => {
  const cacheDir = await temporary(t), fetchImpl = await fixtureTransport(c);
  const point = createNoaaAdapter('hrrr-conus', { forecastHours: c.forecastHours, fetchImpl });
  const acquired = await point.acquire({ run, sites: [c.site], outputRoot: cacheDir, cacheDir });
  assert.equal(acquired.kind, 'normalized-columns'); assert.equal(acquired.columns.length, 2);
  const area = createNoaaAreaAdapter('hrrr-conus', { fetchImpl });
  const regional = await area.acquire({ run, cacheDir, bounds: [-122.5, 48.5, -122.3, 48.7], forecastHours: c.forecastHours });
  const pointCell = regional.cells.findIndex(cell => cell.gridIndex === acquired.native.cells[0].index);
  assert.deepEqual(regional.hours[0].columns[pointCell].column, acquired.columns[0].column);
  await assert.rejects(area.acquire({ run, cacheDir, bounds: [-123, 48, -122, 49], forecastHours: [14], fields: ['nativeCloudBaseM'] }), /Unsupported NOAA area required capability/);
});

test('GRIB fixed surface references distinguish LFC from tropopause', () => {
  assert.deepEqual(fixedSurface('level of free convection'), [14, 0]);
  assert.deepEqual(fixedSurface('equilibrium level'), [247, 0]);
});

test('expanded selection adds real pressure, 80m and lower levels without changing legacy fields', async () => {
  const index = parseIdx(await readFile(new URL('fixtures/hrrr-20261021-00z-f20.idx', fixtureRoot), 'utf8'));
  const legacy = selectRecords(index, c, 20), expanded = selectRecords(index, { ...c, pressureLevels: EXTENDED_HRRR_PRESSURE_LEVELS, includeExtendedFields: true }, 20);
  assert.equal(legacy.some(field => field.key === 'surfacePressureHpa'), false);
  for (const key of ['950.HGT', '975.TMP', '1000.DPT', 'surfacePressureHpa', 'u80m', 'v80m']) assert.ok(expanded.find(field => field.key === key)?.record, key);
  for (const item of legacy) assert.deepEqual(expanded.find(field => field.key === item.key), item);
  const raw = { ...real.hours[0].raw, surfacePressureHpa: 99000, u80m: 0, v80m: 0 };
  const column = cellSource(c, real.grid, real.cell, 14, raw);
  assert.equal(column.surfacePressureHpa, 990); assert.equal(column.wind80mSpeedMps, 0);
});

test('RRFS preserves preceding-hour rain support and vertical velocity normalization', async t => {
  const cacheDir = await temporary(t);
  const result = await acquireNoaa({ model: 'rrfs', referenceTime: rrfs.case.referenceTime, forecastHours: rrfs.case.forecastHours, sites: [rrfs.case.site], cacheDir, fetchImpl: await rrfsFixtureTransport(rrfs.case) });
  const record = result.hours[0].columns[0];
  assert.equal(record.column.precipitationMm, Math.fround(rrfs.raw.precipitationMm));
  assert.equal(record.provenance.fieldSemantics.precipitationMm.timeSupport.kind, 'mean');
  assert.equal(record.provenance.fieldSemantics.precipitationMm.unit, 'mm/h');
  assert.equal(Date.parse(record.provenance.fieldSemantics.precipitationMm.timeSupport.end) - Date.parse(record.provenance.fieldSemantics.precipitationMm.timeSupport.start), 3600000);
  assert.ok(record.column.levels.every(level => level.heightM > record.modelElevationM));
});

test('range, variable, time and run mismatches fail before a column is returned', async t => {
  const base = await fixtureTransport(c), cacheDir = await temporary(t);
  const options = { model: 'hrrr-conus', referenceTime: c.referenceTime, forecastHours: [14], sites: [c.site], cacheDir };
  await assert.rejects(acquireNoaa({ ...options, fetchImpl: async (...args) => { const r = await base(...args); return r.status === 206 ? new Response(await r.arrayBuffer(), { status: 200 }) : r; } }), /expected 206 range/);
  const selection = fields(c, 14).find(field => field.key === 'temperature');
  const idx = parseIdx(await (await base(`https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20261021/conus/hrrr.t00z.wrfprsf14.grib2.idx`, { headers: {} })).text());
  const record = idx.find(row => row.variable === 'TMP' && row.level === '2 m above ground');
  const response = await base('https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20261021/conus/hrrr.t00z.wrfprsf14.grib2', { headers: { Range: `bytes=${record.offset}-${record.offset + record.length - 1}` } });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.throws(() => inspectField(bytes, c, 15, undefined, selection), /forecast time/);
  assert.throws(() => inspectField(bytes, { ...c, referenceTime: '2026-10-21T06:00:00Z' }, 14, undefined, selection), /Wrong NOAA run/);
  parseFields(bytes)[0].section4[10] = 6;
  assert.throws(() => inspectField(bytes, c, 14, undefined, selection), /variable\/level/);
});

test('native source gate requires complete contiguous hybrid fields and uses specific humidity correctly', () => {
  const records = Array.from({ length: 50 }, (_, i) => i + 1).flatMap(level => ['PRES', 'HGT', 'TMP', 'SPFH', 'UGRD', 'VGRD'].map((variable, i) => ({ variable, level: `${level} hybrid level`, forecast: '2 hour fcst', offset: level * 100 + i * 10, length: 10 })));
  const selections = selectNativeRecords(records, 2);
  assert.equal(selections.length, 350);
  assert.throws(() => selectNativeRecords(records.filter(record => ['1 hybrid level', '2 hybrid level'].includes(record.level)), 2), /all 50/);
  assert.throws(() => selectNativeRecords(records.filter(record => !(record.variable === 'SPFH' && record.level === '2 hybrid level')), 2), /Incomplete/);
  assert.throws(() => selectNativeRecords(records.filter(record => record.level !== '1 hybrid level'), 2), /contiguous/);
  // Solve q analytically from vapor pressure 12.2717 hPa at 10 C and 1000 hPa.
  const e = 6.112 * Math.exp(17.67 * 10 / (10 + 243.5)), q = 0.622 * e / (1000 - 0.378 * e);
  assert.ok(Math.abs(specificHumidityDewpointC(q, 100000) - 10) < 1e-10);
  assert.equal(specificHumidityDewpointC(0, 100000), null);
  const surface = cellSource(c, real.grid, real.cell, 14, real.hours[0].raw);
  const raw = Object.fromEntries([1, 2].flatMap(level => Object.entries({ PRES: 100000 - level * 1000, HGT: 100 + level * 100, TMP: 280, SPFH: q, UGRD: 1, VGRD: 2 }).map(([key, value]) => [`native.${level}.${key}`, value])));
  const native = nativeColumn(surface, real.grid, real.cell.longitude, 100, raw, selections.filter(selection => /^(1|2) hybrid level$/.test(selection.level)));
  assert.deepEqual(native.levels.map(level => level.modelLevel), [1, 2]);
  assert.equal(native.levels[0].pressureHpa, 990);
  assert.equal(nativeColumn(surface, real.grid, real.cell.longitude, 100, { ...raw, 'native.2.SPFH': null }, selections.filter(selection => /^(1|2) hybrid level$/.test(selection.level))), null, 'a missing native interior level invalidates the column');
});

test('invalid NOAA source requests do not perform network I/O', async () => {
  const base = { model: 'hrrr-conus', referenceTime: c.referenceTime, forecastHours: [14], sites: [c.site], cacheDir: '/unused', fetchImpl: () => assert.fail('no network expected') };
  for (const change of [{ model: 'rrfs', verticalMode: 'hrrr-native' }, { forecastHours: [14, 14] }, { forecastHours: [0] }, { referenceTime: '2026-10-21T00:00:00-07:00' }, { referenceTime: '2026-02-31T00:00:00Z' }, { referenceTime: '2026-10-21T01:00:00Z' }, { bounds: [0, 1, 0, 2] }, { sites: [{ ...c.site, latitude: -45 }] }]) await assert.rejects(acquireNoaa({ ...base, ...change }));
});

test('operator capture is separate from publication and refuses to replace earlier experiments', async t => {
  const root = await temporary(t), sites = join(root, 'sites.json'), output = join(root, 'experiment.json');
  await writeFile(sites, JSON.stringify({ sites: [c.site] }));
  const values = { model: 'hrrr-conus', 'reference-time': c.referenceTime, hours: '14,20', sites, output, cache: root };
  const acquire = options => acquireNoaa({ ...options, fetchImpl: fetchFixture });
  const fetchFixture = await fixtureTransport(c);
  const result = await captureNoaaColumns(values, { acquire });
  assert.equal(result.hours, 2); assert.equal(result.missingColumns, 0);
  await assert.rejects(captureNoaaColumns(values, { acquire: () => assert.fail('existing experiment must fail before acquisition') }), /EEXIST/);
  const retry = { ...values, output: join(root, 'retry.json') };
  await assert.rejects(captureNoaaColumns(retry, { acquire: () => { throw new Error('source unavailable'); } }), /source unavailable/);
  assert.equal((await captureNoaaColumns(retry, { acquire })).hours, 2, 'a failed acquisition releases its output reservation');
});


test('GFS three-hour recovery preserves support, missing versus zero and mass/mean semantics', () => {
  assert.deepEqual(trailingGfsValues([2, -1, 1], [3, 0, -1], true), [null, null, null]);
  assert.deepEqual(trailingGfsValues([3, 0, null], null, true), [1, 0, null]);
  assert.deepEqual(trailingGfsValues([9, 0, 1, null], [3, 0, null, 1], true), [2, 0, null, null]);
  assert.deepEqual(trailingGfsValues([30, 0, 1, null], [10, 0, null, 1], false), [50, 0, null, null]);
  assert.throws(() => trailingGfsValues([1, 2], [1], true), /different selected cells/);
  const legacy = fields({ model: 'gfs', referenceTime: c.referenceTime, terrainForecastHour: 3, pressureLevels: LEGACY_GFS_PRESSURE_LEVELS }, 24);
  assert.equal(legacy.find(field => field.key === 'precipitationMm').forecast, '18-24 hour acc fcst');
  assert.equal(legacy.find(field => field.key === 'sensibleHeatFluxWm2').forecast, '18-24 hour ave fcst');
  assert.equal(legacy.find(field => field.key === '925.DPT').variable, 'RH');
  assert.equal(legacy.filter(field => field.variable === 'TMP' && field.level.endsWith(' mb')).length, 8);
  assert.equal(EXTENDED_GFS_PRESSURE_LEVELS.length, 15);
  assert.deepEqual(fields({ model: 'gfs', referenceTime: c.referenceTime, terrainForecastHour: 3 }, 24), legacy, 'direct readers share the adapter’s model-specific default inventory');
});

test('GFS latitude/longitude geometry and RH normalization stay separate from Lambert/DPT', () => {
  const grid = { ...real.grid, kind: 'latlon', gridKey: 'global', ni: 1440, nj: 721, latitudeOfFirstGridPoint: 90, longitudeOfFirstGridPoint: 0, iDirectionIncrement: 0.25, jDirectionIncrement: 0.25, iScansNegatively: false, jScansPositively: false, uvRelativeToGrid: false };
  const p = geographicProjection(grid);
  assert.deepEqual(p.point(950, 166), [-122.5, 48.5]);
  assert.deepEqual(p.fractional(-122.5, 48.5), [950, 166]);
  assert.deepEqual(p.point(0, 360), [0, 0]);
  assert.deepEqual(p.fractional(-0.25, 0), [1439, 360]);
  const seamCells = selectGridCells(grid, { bounds: [-0.25, -0.1, 0.25, 0.1] });
  assert.deepEqual(seamCells.map(cell => cell.longitude).sort((a, b) => a - b), [-0.25, 0, 0.25]);
  assert.throws(() => selectGridCells(grid, { bounds: [-0.25, -0.1, 0.25, 0.1], maxCells: 2 }), /exceeds 2 cells/);
  const raw = { ...real.hours[0].raw, '925.TMP': 283.15, '925.DPT': 60, '925.TCDC': 42, precipitationMm: 1, u: 3, v: 4 };
  const column = cellSource({ ...c, model: 'gfs', pressureLevels: [925] }, grid, real.cell, 21, raw);
  const gamma = Math.log(0.6) + 17.625 * 10 / (243.04 + 10);
  const expectedDewpoint = 243.04 * gamma / (17.625 - gamma);
  assert.ok(Math.abs(column.levels[0].dewPointDepressionC - (10 - expectedDewpoint)) < 1e-10);
  assert.equal(column.levels[0].cloudFractionPercent, 42);
  assert.equal(column.windSpeedMps, 5); assert.equal(column.precipitationMm, 1);
});

test('real GFS headers reproduce paired-window capture offline and preserve 3-hour means', async t => {
  const { gfsFixtureTransport } = await import('./noaa-fixture-helper.mjs');
  const { fixture, fetchImpl } = await gfsFixtureTransport();
  const options = { model: 'gfs', referenceTime: fixture.referenceTime, forecastHours: [21, 24], sites: [fixture.site], cacheDir: await temporary(t), fetchImpl };
  const acquired = await acquireNoaa(options);
  assert.equal(acquired.completeness, 'complete');
  assert.equal(acquired.grid.kind, 'latlon');
  const [a, b] = acquired.hours.map(hour => hour.columns[0]);
  const raw21 = fixture.sources[21], raw24 = fixture.sources[24];
  const rounded = (source, key) => Math.fround(source[key].value);
  assert.equal(a.column.precipitationMm, rounded(raw21, 'precipitationMm') / 3);
  assert.equal(b.column.precipitationMm, (rounded(raw24, 'precipitationMm') - rounded(raw21, 'precipitationMm')) / 3);
  assert.equal(b.column.sensibleHeatFluxWm2, 2 * rounded(raw24, 'sensibleHeatFluxWm2') - rounded(raw21, 'sensibleHeatFluxWm2'));
  assert.equal(b.provenance.fieldSemantics.sensibleHeatFluxWm2.timeSupport.start, '2026-10-26T21:00:00.000Z');
  assert.equal(b.provenance.fieldSemantics.precipitationMm.unit, 'mm/h');
  assert.equal(b.provenance.fieldSemantics.precipitationMm.timeSupport.kind, 'mean');
  assert.equal(b.column.pblHeightM, rounded(raw24, 'pblHeightM'), 'GFS local HPBL3/196 retained');
  assert.deepEqual(await acquireNoaa({ ...options, fetchImpl: () => { throw new Error('network unavailable'); } }), acquired);
  const companionOnly = await acquireNoaa({ ...options, forecastHours: [24], cacheDir: await temporary(t), fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!url.endsWith('f021.idx')) return response;
    return new Response((await response.text()).split('\n').filter(line => !line.includes(':TMP:')).join('\n'));
  } });
  assert.deepEqual(companionOnly.hours[0].columns[0].column, b.column, 'interval recovery needs only the companion interval fields');
});

test('statistical GRIB fields reject missing samples and cross-run time increments', async () => {
  const { fileUrl } = await import('../dist/internal/noaa/transport.js');
  const options = { ...rrfs.case, model: 'rrfs' }, hour = 8;
  const selection = fields(options, hour).find(field => field.key === 'precipitationMm');
  const fetchImpl = await rrfsFixtureTransport(rrfs.case), url = fileUrl(options, hour, selection.product);
  const records = parseIdx(await (await fetchImpl(`${url}.idx`, { headers: {} })).text());
  const record = records.find(item => item.variable === selection.variable && item.level === selection.level && item.forecast === selection.forecast);
  assert.ok(record, 'real RRFS preceding-hour precipitation header is present');
  const response = await fetchImpl(url, { headers: { Range: `bytes=${record.offset}-${record.offset + record.length - 1}` } });
  const original = Buffer.from(await response.arrayBuffer());
  assert.doesNotThrow(() => inspectField(original, options, hour, undefined, selection));
  for (const missingSamples of [1, 0xffffffff]) {
    const bytes = Buffer.from(original);
    parseFields(bytes)[0].section4.writeUInt32BE(missingSamples, 42);
    assert.throws(() => inspectField(bytes, options, hour, undefined, selection), /interval or statistical process/, `missing sample count ${missingSamples}`);
  }
  for (const incrementType of [1, 3, 4, 5, 255]) {
    const bytes = Buffer.from(original);
    parseFields(bytes)[0].section4[47] = incrementType;
    assert.throws(() => inspectField(bytes, options, hour, undefined, selection), /interval or statistical process/, `time increment type ${incrementType}`);
  }
});
