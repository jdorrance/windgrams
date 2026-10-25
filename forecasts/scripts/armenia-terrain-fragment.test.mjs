import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armeniaTerrainFragment } from './armenia-terrain-fragment.mjs';
import { GLO90_SOURCE } from './terrain.mjs';

const sites = [
  { slug: 'am-hatis', latitude: 40.3, longitude: 44.7, timeZone: 'Asia/Yerevan' },
  { slug: 'va-woodstock', latitude: 38.9, longitude: -78.4, timeZone: 'America/New_York' },
];
const entry = (site, elevationM) => ({ point: { latitude: site.latitude, longitude: site.longitude }, elevation: { source: 'glo90', elevationM },
  terrain: { source: 'glo90', elevationM, slopeDeg: 12, aspectDeg: 180, relief: [{ radiusKm: 1, minM: elevationM - 100, maxM: elevationM + 100, percentile: 50 }] },
  landCover: { source: 'glo90', atLaunch: 'grassland', fractions: [{ radiusKm: 1, byClass: { grassland: 1 } }] } });
const context = { schemaVersion: 3, generatedAt: '2026-10-24T00:00:00Z', sources: [GLO90_SOURCE], sites: { 'am-hatis': entry(sites[0], 2100), 'va-woodstock': entry(sites[1], 565) } };

test('DWD exports only Armenian terrain with its measured values and source credits', () => {
  const fragment = armeniaTerrainFragment(context, sites);
  assert.deepEqual(Object.keys(fragment.sites), ['am-hatis']);
  assert.equal(fragment.sites['am-hatis'], context.sites['am-hatis']);
  assert.deepEqual(fragment.sources, context.sources);
  assert.equal(fragment.generatedAt, context.generatedAt);
});

test('fragment rejects terrain measured at stale Armenian coordinates', () => {
  const stale = structuredClone(context);
  stale.sites['am-hatis'].point.latitude = 40;
  assert.throws(() => armeniaTerrainFragment(stale, sites), /Missing current Armenian/);
});
