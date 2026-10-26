import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseForecastManifest, parseSiteForecast } from '@azohra/meteo.briefing/contract';
import { postprocessPointForecast } from '../../soaring/point-postprocess.mjs';
import { SOARING_CONTRACT_VERSION } from '../../soaring/science.mjs';
import { discoverIconRun, normalizeIconExtract, deriveIconProfile, buildIconPointProfiles, writeIconAcquisition, readIconAcquisition, ICON_MODEL_LEVELS } from './icon-eu.mjs';
import { iconBounds, iconReferenceTime, iconFieldUrl, iconHourlyFlux, iconHourlyPrecipitation, iconSource } from '../../../packages/providers/src/internal/icon-native.ts';
import { specificHumidityDewpointC } from '../../../packages/providers/src/internal/thermodynamics.ts';
import { iconColumnRecord } from '../../../packages/providers/src/icon.ts';

const fixture = JSON.parse(readFileSync(new URL('./icon-native-fixture.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(fixture);
const record = (value, endHour, stepType = 'avg', units = 'W m**-2') => ({ values: [value], metadata: { startHour: 0, endHour, stepType, units } });
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test('region array bounds and explicit bounds select the same native cells', () => {
  assert.deepEqual(iconBounds([43.3, 38.7, 46.8, 41.5]), { west: 43.3, south: 38.7, east: 46.8, north: 41.5 });
  assert.equal(iconBounds(undefined), undefined);
  assert.throws(() => iconBounds([45, 40, 43, 41]));
});

test('ICON uses pinned main runs and new native model-level field paths', () => {
  assert.equal(iconReferenceTime('2026-10-24T06:00:00Z'), '2026-10-24T06:00:00Z');
  for (const value of ['2026-10-24T09:00:00Z', '2026-10-24T06:01:00Z', 'invalid']) assert.throws(() => iconReferenceTime(value));
  assert.equal(iconFieldUrl('T', '2026-10-24T06:00:00Z', 7, 74),
    'https://opendata.dwd.de/weather/nwp/v1/m/icon-eu/p/T/lvt1/150/lv1/74/r/2026-10-24T06%3A00/s/PT007H00M.grib2');
});

test('run discovery ignores short cycles and waits for the complete requested horizon', async () => {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push(url);
    if (!options.method) return { ok: true, text: async () => '<a href="2026-10-24T09%3A00/">9</a><a href="2026-10-24T06%3A00/">6</a><a href="2026-10-24T00%3A00/">0</a>' };
    return { ok: !url.includes('06%3A00') };
  };
  const result = await discoverIconRun({ now: new Date('2026-10-24T13:00Z'), fetchFn });
  assert.equal(result.referenceTime, '2026-10-24T00:00:00Z');
  assert.equal(calls.length, 11);
  assert.ok(calls.slice(1).every(url => url.includes('PT078H00M')));
});

test('heat flux deaverages elapsed run means before reversing DWD downward sign', () => {
  // The first six hours averaged -50, all seven averaged -60: final hour is -120 downward.
  assert.equal(iconHourlyFlux(record(-60, 7), record(-50, 6), 0), 120);
  assert.equal(iconHourlyFlux(record(30, 2), record(10, 1), 0), -50);
  assert.equal(iconHourlyFlux(record(-40, 1), record(null, 0), 0), 40);
  assert.equal(iconHourlyFlux(record(null, 7), record(-50, 6), 0), null);
  assert.throws(() => iconHourlyFlux(record(-60, 7, 'instant'), record(-50, 6), 0));
  assert.throws(() => iconHourlyFlux(record(-60, 7), record(-50, 5), 0));
});

test('rain is the previous hour, with packing tolerance and no counter-reset spikes', () => {
  const r = (v, h) => record(v, h, 'accum', 'kg m**-2');
  close(iconHourlyPrecipitation(r(8.2, 7), r(6.5, 6), 0), 1.7);
  assert.equal(iconHourlyPrecipitation(r(1.999, 7), r(2, 6), 0), 0);
  assert.equal(iconHourlyPrecipitation(r(null, 7), r(2, 6), 0), null);
  assert.throws(() => iconHourlyPrecipitation(r(0, 7), r(2, 6), 0));
});

test('specific humidity uses moist-air denominator and reconstructs a known vapor pressure', () => {
  const e = 611.2, p = 80000;
  const q = 0.622 * e / (p - 0.378 * e);
  close(specificHumidityDewpointC(q, p), 0);
  assert.equal(specificHumidityDewpointC(null, p), null);
  assert.equal(specificHumidityDewpointC(0, p), null);
});

test('real native geometry and columns retain 30 terrain-following levels and actual pressure', () => {
  assert.equal(fixture.grid.uuid, '832c1507fbc73eb384139890094d2c60');
  assert.equal(fixture.grid.pointCount, 768608);
  assert.deepEqual(fixture.levels, ICON_MODEL_LEVELS);
  const source = iconSource(fixture, 7, fixture.siteCells.hatis);
  assert.equal(source.levels.length, 30);
  assert.deepEqual(source.levels.map(l => l.modelLevel), [...ICON_MODEL_LEVELS].reverse());
  assert.ok(source.levels.every((l, i, levels) => l.heightM > fixture.cells[0].terrainM && (!i || l.heightM > levels[i-1].heightM)));
  assert.ok(source.levels.every((l, i, levels) => !i || l.pressureHpa < levels[i-1].pressureHpa));
  const lower = fixture.records['HHL:0:74'].values[0], upper = fixture.records['HHL:0:75'].values[0];
  close(source.levels[0].heightM, (lower + upper) / 2);
  close(source.sensibleHeatFluxWm2, 41.24163818359375);
  close(source.latentHeatFluxWm2, 66.5986328125);
  close(iconSource(fixture, 7, fixture.siteCells.tatev).precipitationMm, 0.3388671875);
  assert.ok(source.windDirectionDeg > 220 && source.windDirectionDeg < 225);
  assert.equal(fixture.cells[0].corners.length, 3);
});

test('missing required source stays unavailable; bad units and reversed half levels fail', () => {
  const missing = copy(); missing.records['ASHFL_S:7:None'].values[0] = null;
  assert.equal(iconSource(missing, 7, 0), null);
  const missingLevel = copy(); missingLevel.records['T:7:60'].values[0] = null;
  assert.equal(iconSource(missingLevel, 7, 0), null);
  const wrong = copy(); wrong.records['P:7:60'].metadata.units = 'hPa';
  assert.throws(() => iconSource(wrong, 7, 0), /unexpected units/);
  const reversed = copy(); reversed.records['HHL:0:60'].values[0] = 0;
  assert.throws(() => iconSource(reversed, 7, 0), /inverted/);
});

test('native surface pressure survives normalization and publication with field provenance', () => {
  const acquired = normalizeIconExtract(fixture);
  for (const [slug, i] of Object.entries(acquired.siteCells)) {
    const expected = fixture.records['PS:7:None'].values[i] / 100;
    const record = iconColumnRecord(acquired, 0, i);
    assert.equal(record.column.surfacePressureHpa, expected);
    assert.equal(record.provenance.fieldSemantics.surfacePressureHpa.sourceField, 'PS');
    assert.equal(record.provenance.fieldSemantics.surfacePressureHpa.unit, 'hPa');
    const cell = acquired.cells[i];
    const profile = deriveIconProfile(acquired, i, { slug, name: slug, latitude: cell.latitude, longitude: cell.longitude });
    const hour = profile.hours[0];
    assert.equal(hour.surface.surfacePressureHpa, expected);
    assert.deepEqual(hour.soaring.diagnosticSupport.surfacePressure, { source: 'model', valueHpa: expected });
    assert.equal(hour.surface.convectiveParcel, 'mixed-layer');
  }
  const missing = copy(); delete missing.records['PS:7:None'];
  assert.equal(iconSource(missing, 7, 0).surfacePressureHpa, undefined);
  const wrong = copy(); wrong.records['PS:7:None'].metadata.units = 'hPa';
  assert.throws(() => iconSource(wrong, 7, 0), /unexpected units/);
  const invalid = copy(); invalid.records['PS:7:None'].values[0] = 0;
  assert.throws(() => iconSource(invalid, 7, 0), /must be positive/);
});

test('all three real samples pass public profile contract and existing V2 physics idempotently', () => {
  const acquired = normalizeIconExtract(fixture);
  for (const [slug, i] of Object.entries(acquired.siteCells)) {
    const cell = acquired.cells[i];
    const profile = deriveIconProfile(acquired, i, { slug, name: slug, latitude: cell.latitude, longitude: cell.longitude, timeZone: 'Asia/Yerevan' });
    assert.ok(parseSiteForecast(profile), slug);
    assert.equal(profile.hours[0].levels.length, 29); // Existing pipeline filters the native level within 20 m of terrain.
    assert.equal(profile.hours[0].soaring.contractVersion, SOARING_CONTRACT_VERSION);
    assert.deepEqual(postprocessPointForecast(profile, { modelSlug: 'icon-eu' }), profile);
    assert.equal(profile.hours[0].validAt, '2026-10-24T13:00:00Z');
    assert.ok(profile.hours[0].soaring.thermalVelocityV2Mps > 0);
    assert.ok(profile.hours[0].soaring.usableLiftTopV2M >= cell.terrainM);
  }
});


test('segmented acquisition round-trips and rejects altered hour files', t => {
  const root = mkdtempSync(join(tmpdir(), 'icon-acquisition-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const acquired = normalizeIconExtract(fixture), path = join(root, 'acquired.json');
  writeIconAcquisition(path, acquired);
  assert.deepEqual(readIconAcquisition(path), acquired);
  const manifest = JSON.parse(readFileSync(path));
  writeFileSync(join(root, manifest.hourFiles[0].file), '{}');
  assert.throws(() => readIconAcquisition(path), /checksum/);
});

test('point builder writes the public forecast manifest including transfer statistics', async t => {
  const root = mkdtempSync(join(tmpdir(), 'icon-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const acquired = normalizeIconExtract(fixture);
  const sites = acquired.cells.map((cell, i) => ({ slug: `am-sample-${i}`, name: `Sample ${i}`, latitude: cell.latitude, longitude: cell.longitude, timeZone: 'Asia/Yerevan' }));
  acquired.siteCells = Object.fromEntries(sites.map((site, i) => [site.slug, i]));
  const result = await buildIconPointProfiles({ sites, outputRoot: root, acquisition: acquired });
  assert.ok(parseForecastManifest(result.manifest));
  assert.equal(result.manifest.forecastHours, 1);
  assert.equal(result.manifest.stats.downloadBytes, fixture.provenance.downloadedBytes);
  assert.equal(result.manifest.stats.durationMs, fixture.provenance.elapsedSeconds * 1000);
});
