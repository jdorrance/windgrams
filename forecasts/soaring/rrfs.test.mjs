import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseFields, parseIdx } from '@azohra/meteo.grib';
import { capture, inspectField } from './capture.mjs';
import { replay, verifyCapture } from './replay.mjs';
import { fileUrl, readJson, semanticsFor } from './common.mjs';
import { fields, selectRecords } from './fields.mjs';
import { rrfsFixtureTransport } from './fixture-helper.mjs';
import { cellSource, geometricWFromOmegaMps } from './science.mjs';

const fixture = await readJson(new URL('./fixtures/rrfs-native-column.json', import.meta.url));
const c = fixture.case;
const quiet = () => {};

test('RRFS inventories select split products, one-hour rain, and native geometric vertical motion', async () => {
  const at20 = { ...c, referenceTime: '2026-10-22T12:00:00Z', forecastHours: [20] };
  const selections = (await Promise.all(['2dfld', 'prslev'].map(async product => {
    const index = await readFile(new URL(`./fixtures/rrfs-20261022-12z-f20-${product}.idx`, import.meta.url), 'utf8');
    return selectRecords(parseIdx(index), at20, 20, product);
  }))).flat();
  const selected = Object.fromEntries(selections.map(s => [s.key, s]));
  assert.ok(selections.filter(s => s.required).every(s => s.record));
  assert.equal(selected.precipitationMm.record.forecast, '19-20 hour acc fcst');
  assert.equal(selected.precipitationMm.record.offset, 100482737);
  assert.equal(selected['925.VVEL'].variable, 'DZDT');
  assert.equal(selected['925.VVEL'].product, 'prslev');
  assert.equal(selected.cloudCoverPercent.level, 'entire atmosphere (considered as a single layer)');
  assert.equal(selected.seaLevelPressureHpa.variable, 'MSLET');
  assert.equal(fields(at20, 20).some(f => f.key.startsWith('smoke.')), false);
  assert.equal(semanticsFor(c).precipitation, 'windowMeanRate');
  assert.ok(fileUrl(c, 84, 'prslev').endsWith('/rrfs.20261023/06/rrfs.t06z.prslev.3km.f084.conus.grib2'));
});

test('RRFS capture uses the shared feed mirror override', () => {
  const previous = process.env.METEO_RRFS_BASE;
  try {
    process.env.METEO_RRFS_BASE = 'https://mirror.example/rrfs/';
    assert.equal(fileUrl(c, 8, '2dfld'), 'https://mirror.example/rrfs/rrfs.20261023/06/rrfs.t06z.2dfld.3km.f008.conus.grib2');
    assert.ok(fileUrl({ ...c, model: 'hrrr-conus' }, 8).startsWith('https://noaa-hrrr-bdp-pds'));
  } finally {
    if (previous === undefined) delete process.env.METEO_RRFS_BASE;
    else process.env.METEO_RRFS_BASE = previous;
  }
});

test('RRFS rain keeps its one-hour amount and DZDT round-trips through hydrostatic omega', () => {
  const raw = { ...fixture.raw, precipitationMm: 2.4, '925.VVEL': 0.75 };
  const converted = cellSource(c, fixture.grid, fixture.cell, 8, raw);
  assert.equal(converted.precipitationMm, 2.4);
  const level = converted.levels.find(l => l.pressureHpa === 925);
  assert.ok(level.verticalVelocityPaS < 0);
  assert.ok(Math.abs(geometricWFromOmegaMps(level.verticalVelocityPaS, 925, level.temperatureC) - 0.75) < 0.00001);
});

test('RRFS real-header fixture captures and replays offline, rejects rain time errors and model-mixed caches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rrfs-soaring-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, 'cache');
  const captured = await capture(c, cache, { fetchImpl: await rrfsFixtureTransport(c), log: quiet });
  assert.deepEqual(Object.keys(captured.sources[0].indices), ['2dfld']);
  assert.deepEqual(Object.keys(captured.sources[1].indices), ['2dfld', 'prslev']);
  const rainRecord = captured.sources[1].records.find(r => r.key === 'precipitationMm');
  const rain = await readFile(join(cache, rainRecord.file));
  const selection = fields(c, 8).find(f => f.key === 'precipitationMm');
  assert.equal(inspectField(rain, c, 8, captured.gridKey, selection).product.intervalHours, 1);
  for (const corrupt of [bytes => parseFields(bytes)[0].section4.writeUInt32BE(8, 49), bytes => parseFields(bytes)[0].section4.writeUInt32BE(0, 18), bytes => { parseFields(bytes)[0].section4[38] = 15; }]) {
    const bad = Buffer.from(rain); corrupt(bad);
    assert.throws(() => inspectField(bad, c, 8, captured.gridKey, selection), /interval|forecast time/);
  }
  await assert.rejects(() => verifyCapture({ ...c, model: 'hrrr-conus' }, cache), /case\/run/);
  const out = await replay(c, cache, join(root, 'output'), { log: quiet });
  const manifest = await readJson(join(out.path, 'manifest.json'));
  const profile = await readJson(join(out.path, 'profile.json'));
  const hour = JSON.parse(gunzipSync(await readFile(join(out.path, manifest.hours[0].file))));
  assert.equal(manifest.model, 'rrfs');
  assert.equal(profile.model, 'rrfs');
  assert.equal(profile.semantics.precipitation, 'windowMeanRate');
  assert.equal(manifest.inputs.filter(i => i.file.endsWith('.idx')).length, 3);
  assert.equal(out.audit.mapProfileAgreement.exact, true);
  assert.equal(out.audit.publishedProfileComparison.applicable, false);
  assert.equal(hour.precipitationMmHr[manifest.siteCell], profile.hours[0].surface.precipitationMmHr);
  assert.equal(hour.levelsByPressure, undefined);
  const cell = JSON.parse(gunzipSync(await readFile(join(out.path, `cell-${manifest.siteCell}.json.gz`))));
  assert.deepEqual(cell.hours, profile.hours, 'cell shard preserves the already-derived profile exactly');
  assert.equal(cell.source.gridIndex, out.audit.sampledCell.index);
  for (const [name, bytes] of Object.entries(manifest.fileBytes)) assert.equal((await readFile(join(out.path, name))).byteLength, bytes, name);
});
