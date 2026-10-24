import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { armeniaTerrainFragment, mergeArmeniaTerrain, mergeArmeniaTerrainFile } from './merge-armenia-terrain.mjs';
import { GLO90_SOURCE } from './terrain.mjs';

const sites = [
  { slug: 'am-hatis', latitude: 40.3, longitude: 44.7, timeZone: 'Asia/Yerevan' },
  { slug: 'va-woodstock', latitude: 38.9, longitude: -78.4, timeZone: 'America/New_York' },
];
const entry = (site, elevationM) => ({ point: { latitude: site.latitude, longitude: site.longitude }, elevation: { source: 'glo90', elevationM },
  terrain: { source: 'glo90', elevationM, slopeDeg: 12, aspectDeg: 180, relief: [{ radiusKm: 1, minM: elevationM - 100, maxM: elevationM + 100, percentile: 50 }] },
  landCover: { source: 'glo90', atLaunch: 'grassland', fractions: [{ radiusKm: 1, byClass: { grassland: 1 } }] } });
const context = { schemaVersion: 3, generatedAt: '2026-10-24T00:00:00Z', sources: [GLO90_SOURCE], sites: { 'am-hatis': entry(sites[0], 2100), 'va-woodstock': entry(sites[1], 565) } };

test('DWD exports only Armenian terrain and preserves independently refreshed US terrain', () => {
  const fragment = armeniaTerrainFragment(context, sites);
  assert.deepEqual(Object.keys(fragment.sites), ['am-hatis']);
  const fresh = structuredClone(context);
  fresh.generatedAt = '2026-10-24T01:00:00Z';
  fresh.sites['va-woodstock'].elevation.elevationM = 566;
  fresh.sites['am-hatis'].elevation.elevationM = 2101;
  const merged = mergeArmeniaTerrain(fresh, fragment, sites);
  assert.deepEqual(merged, fresh, 'newer complete terrain wins regardless artifact copy order');
  const first = mergeArmeniaTerrain(null, fragment, sites);
  assert.deepEqual(first, fragment);
});

test('fragment replaces stale Armenian coordinates and rejects foreign or mismatched entries', () => {
  const fragment = armeniaTerrainFragment(context, sites);
  const stale = structuredClone(context);
  stale.sites['am-hatis'].point.latitude = 40;
  stale.generatedAt = '2026-10-24T02:00:00Z';
  assert.deepEqual(mergeArmeniaTerrain(stale, fragment, sites).sites['am-hatis'], context.sites['am-hatis']);
  assert.throws(() => mergeArmeniaTerrain(context, context, sites), /Unexpected/);
  assert.throws(() => armeniaTerrainFragment(stale, sites), /Missing current Armenian/);
});

test('publication merges the fragment once then removes it from the deployed dataset', t => {
  const root = mkdtempSync(join(tmpdir(), 'armenia-terrain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fragment = armeniaTerrainFragment(context, sites);
  writeFileSync(join(root, 'site-context.json'), JSON.stringify(context));
  writeFileSync(join(root, 'site-context-armenia.json'), JSON.stringify(fragment));
  assert.equal(mergeArmeniaTerrainFile(root, sites), true);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'site-context.json'), 'utf8')), context);
  assert.equal(existsSync(join(root, 'site-context-armenia.json')), false);
  assert.equal(mergeArmeniaTerrainFile(root, sites), false);
});
