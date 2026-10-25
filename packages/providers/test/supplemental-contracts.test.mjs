import { test } from 'node:test';
import assert from 'node:assert/strict';
// Node 24 strips types; tests exercise the strict TypeScript implementations.
import * as nws from '../src/nws.ts';
import * as ecmwf from '../src/ecmwf.ts';
import * as solar from '../src/solar.ts';

const site = { slug: 'test', name: 'Test', latitude: 43.6, longitude: -116, timeZone: 'America/Boise' };
const now = Date.parse('2026-10-24T12:00:00Z');
const layer = (uom, value) => ({ uom, values: [{ validTime: '2026-10-24T12:00:00Z/PT1H', value }] });
test('NWS public document has all declared nullable fields and explicit sparse diagnostics', () => {
  const doc = nws.buildSiteDocument({ site, now, point: { properties: { gridId: 'BOI', gridX: 1, gridY: 2 } },
    grid: { properties: { temperature: layer('wmoUnit:degC', 15), windSpeed: layer('wmoUnit:km_h-1', 18) } }, hourly: null, forecast: null });
  assert.equal(doc.schemaVersion, 1);
  assert.deepEqual(doc.site, site);
  for (const field of Object.keys(doc.units)) assert.ok(Object.hasOwn(doc.hours[0], field), field);
  assert.equal(doc.hours[0].temperatureC, 15); assert.equal(doc.hours[0].windSpeedMps, 5);
  assert.equal(doc.hours[0].windGustMps, null); assert.equal(doc.grid.elevationM, null);
  assert.equal(doc.hours[0].soaring.thermalVelocityV2Mps, null);
  assert.deepEqual(doc.periods, []); assert.equal(doc.updateTime, null);
});
test('ECMWF public field specifications and output agree for available and missing aloft data', () => {
  const hourly = { time: [now / 1000] }, hourly_units = { time: 'unixtime' };
  for (const [field, [source, accepted]] of Object.entries(ecmwf.SURFACE_FIELDS)) {
    hourly[source] = [field === 'temperatureC' ? 15 : field === 'dewPointC' ? 10 : 1]; hourly_units[source] = accepted[0];
  }
  const doc = ecmwf.buildSiteDocument({ site, now, surface: { hourly, hourly_units, latitude: 43.5, longitude: -116.1, elevation: 500 }, aloft: null });
  assert.equal(doc.schemaVersion, 1); assert.equal(doc.models.surface.id, 'ecmwf_ifs');
  assert.equal(doc.models.surface.run, null); assert.equal(doc.site.gridElevationM, 500);
  assert.deepEqual(Object.keys(doc.units).sort(), [...Object.keys(ecmwf.SURFACE_FIELDS), ...Object.keys(ecmwf.ALOFT_FIELDS)].sort());
  for (const field of Object.keys(doc.units)) assert.ok(Object.hasOwn(doc.hours[0], field), field);
  for (const field of Object.keys(ecmwf.ALOFT_FIELDS)) assert.equal(doc.hours[0][field], null);
  assert.equal(typeof doc.hours[0].soaring.surfaceLclM, 'number');
  assert.equal(doc.hours[0].soaring.usableLiftTopV2M, null);
});
test('solar public build returns typed raster, tile and nullable metadata shapes', () => {
  const domain = solar.domainFor(site.latitude, site.longitude, 0.1);
  const bounds = solar.expandBounds(domain.bounds, 1000);
  const fine = solar.gridFromFunction(() => 500, { ...bounds, dLat: 0.0001, dLon: 0.0001 });
  const source = { id: 'synthetic', name: 'Synthetic plane', resolutionM: 10, licence: 'Test fixture', url: 'https://example.invalid/dem' };
  const result = solar.buildSolarTerrain(site, { fine, coarse: fine, sources: { surface: source, horizon: source }, radiusKm: 0.1, maxDistanceKm: 0, generatedAt: new Date(now).toISOString() });
  assert.equal(result.index.schemaVersion, 1); assert.equal(result.index.referenceElevationM, 500);
  assert.equal(result.index.launch.elevationM, 500); assert.ok(result.tiles.length > 0);
  assert.ok(result.tiles.every(tile => tile.body instanceof Uint8Array));
  assert.ok(result.relief.body instanceof Uint8Array); assert.equal(typeof result.relief.meta.encoding, 'string');
  assert.equal(result.index.inputs.sources.surface, 'synthetic');
  assert.ok(Object.values(result.index.tiles.ranges).every(range => range.length === 4));
  assert.equal(solar.indexIsFresh(result.index, site, { sources: { surface: source, horizon: source }, radiusKm: 0.1, maxDistanceKm: 0 }), true);
});

test('NWS unknown JSON rejects malformed required layers and tolerates malformed optional forecasts', async () => {
  const urls = { gridId: 'BOI', gridX: 1, gridY: 2, forecastGridData: 'grid', forecastHourly: 'hourly', forecast: 'periods' };
  const warnings = [];
  const getJson = async url => url.includes('/points/') ? { properties: urls } : url === 'grid'
    ? { properties: { updateTime: null, temperature: layer('wmoUnit:degC', 15), windSpeed: layer('wmoUnit:km_h-1', 18), probabilityOfThunder: layer(null, 10) } }
    : { properties: { periods: 'invalid' } };
  const doc = await nws.fetchSiteDocument(site, getJson, { now, warn: message => warnings.push(message) });
  assert.equal(doc.hours[0].temperatureC, 15);
  assert.equal(doc.hours[0].thunderProbabilityPct, 10);
  assert.equal(doc.hours[0].shortForecast, null);
  assert.deepEqual(doc.periods, []);
  assert.equal(warnings.filter(message => message.includes('unavailable')).length, 2);
  await assert.rejects(nws.fetchSiteDocument(site, async url => url.includes('/points/') ? { properties: urls }
    : { properties: { temperature: { values: [{ validTime: '2026-10-24T12:00:00Z/PT1H', value: 'warm' }] } } }, { now }), /Invalid NWS temperature layer/);
});
