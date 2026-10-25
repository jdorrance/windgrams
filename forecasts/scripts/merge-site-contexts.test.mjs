import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { terrainPolicyId } from './lib/terrain-policy.mjs';
import { mergeSiteContextDocuments, mergeSiteContextFiles, validatePublishedTerrain } from './merge-site-contexts.mjs';

const profile = JSON.parse(readFileSync(new URL('../soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
const launch = { slug: profile.site.id, latitude: profile.site.latitude, longitude: profile.site.longitude, country: 'US' };
const armenia = { slug: 'am-example', latitude: 40, longitude: 44, country: 'AM' };
const sources = ['glo30', 'glo90', 'worldcover2021'].map(id => ({ id, product: id, kind: id === 'worldcover2021' ? 'landCover' : 'surfaceModel',
  resolutionM: 30, licence: 'test fixture', attribution: 'synthetic test fixture', url: 'https://example.invalid/terrain' }));
function entry(site, elevationM) {
  const source = site.country === 'AM' ? 'glo90' : 'glo30';
  return { point: { latitude: site.latitude, longitude: site.longitude }, elevation: { source, elevationM },
    terrain: { source, elevationM, slopeDeg: 12, aspectDeg: 180, relief: [{ radiusKm: 1, minM: elevationM - 100, maxM: elevationM + 100, percentile: 50 }] },
    landCover: { source: 'worldcover2021', atLaunch: 'grassland', fractions: [{ radiusKm: 1, byClass: { grassland: 1 } }] } };
}
function context(site, elevationM, time = '2026-10-24T00:00:00Z') {
  return { schemaVersion: 3, generatedAt: time, sources, sites: { [site.slug]: entry(site, elevationM) },
    measurementPolicies: { [site.slug]: terrainPolicyId(site) }, measurementTimes: { [site.slug]: time } };
}
function temporary(t) { const output = mkdtempSync(join(tmpdir(), 'merge-terrain-')); t.after(() => rmSync(output, { recursive: true, force: true })); return output; }
function publish(output, document = profile) {
  mkdirSync(join(output, 'rrfs/sites'), { recursive: true });
  writeFileSync(join(output, 'rrfs/sites', `${launch.slug}.json`), JSON.stringify(document));
  writeFileSync(join(output, 'rrfs/manifest.json'), JSON.stringify({ model: 'rrfs', referenceTime: document.run.referenceTime, sites: [{ slug: launch.slug }] }));
}

test('per-launch measurement times prevent a fresh unrelated measurement aging an old cached launch', () => {
  const base = context(launch, 500, '2026-10-24T02:00:00Z');
  const stale = context(launch, 400, '2026-10-24T01:00:00Z');
  const measured = context(armenia, 2400, '2026-10-24T03:00:00Z');
  const fragment = { ...measured, sites: { ...stale.sites, ...measured.sites },
    measurementPolicies: { ...stale.measurementPolicies, ...measured.measurementPolicies },
    measurementTimes: { ...stale.measurementTimes, ...measured.measurementTimes } };
  const merged = mergeSiteContextDocuments(base, [fragment], [launch, armenia]);
  assert.equal(merged.sites[launch.slug].elevation.elevationM, 500);
  assert.equal(merged.sites[armenia.slug].elevation.elevationM, 2400);
  assert.equal(merged.measurementTimes[launch.slug], base.generatedAt);
  assert.deepEqual(new Set(merged.sources.map(source => source.id)), new Set(['glo30', 'glo90', 'worldcover2021']));
});

test('stale coordinates and changed terrain policies cannot overwrite a current measurement', () => {
  const base = context(launch, 500), stale = context(launch, 400, '2026-10-25T00:00:00Z');
  stale.sites[launch.slug].point.latitude += 0.01;
  assert.equal(mergeSiteContextDocuments(base, [stale], [launch]).sites[launch.slug].elevation.elevationM, 500);
  stale.sites[launch.slug].point.latitude = launch.latitude;
  stale.measurementPolicies[launch.slug] = 'terrain-v0:other';
  assert.equal(mergeSiteContextDocuments(base, [stale], [launch]).sites[launch.slug].elevation.elevationM, 500);
});

test('legacy context receives metadata only for known unchanged source policies', () => {
  const legacy = context(launch, 500); delete legacy.measurementPolicies; delete legacy.measurementTimes;
  const merged = mergeSiteContextDocuments(legacy, [], [launch]);
  assert.deepEqual(merged.sites, legacy.sites);
  assert.equal(merged.measurementPolicies[launch.slug], terrainPolicyId(launch));
  assert.equal(merged.measurementTimes[launch.slug], legacy.generatedAt);
  const wrong = context(armenia, 2000); delete wrong.measurementPolicies;
  wrong.sites[armenia.slug].elevation.source = 'glo30';
  assert.deepEqual(mergeSiteContextDocuments(wrong, [], [armenia]).sites, {});
});

test('provider fragments require explicit policy and credited sources', () => {
  const fragment = context(launch, 500); delete fragment.measurementPolicies;
  assert.deepEqual(mergeSiteContextDocuments(null, [fragment], [launch]).sites, {});
  fragment.measurementPolicies = { [launch.slug]: terrainPolicyId(launch) };
  fragment.sources = fragment.sources.filter(source => source.id !== 'worldcover2021');
  assert.deepEqual(mergeSiteContextDocuments(null, [fragment], [launch]).sites, {});
});

test('publication requires current terrain and the elevation used by diagnostics', t => {
  const output = temporary(t); publish(output);
  const elevation = profile.soaringMeta.launchElevationM;
  assert.equal(validatePublishedTerrain(output, [launch], context(launch, elevation)), 1);
  assert.throws(() => validatePublishedTerrain(output, [launch], null), /Missing current launch terrain/);
  assert.throws(() => validatePublishedTerrain(output, [launch], context(launch, elevation + 1)), /different launch terrain/);
  assert.throws(() => validatePublishedTerrain(output, [{ ...launch, latitude: launch.latitude + 0.1 }], context(launch, elevation)), /differs from current launch/);
});

test('failed final gate preserves base bytes and fragments; success commits then removes fragments', t => {
  const output = temporary(t); publish(output);
  const elevation = profile.soaringMeta.launchElevationM;
  const base = context(launch, elevation - 10), fragment = context(launch, elevation, '2026-10-24T01:00:00Z');
  writeFileSync(join(output, 'site-context.json'), JSON.stringify(base));
  writeFileSync(join(output, 'site-context-noaa-cloud.json'), JSON.stringify(fragment));
  const before = readFileSync(join(output, 'site-context.json'));
  const changed = structuredClone(profile); changed.site.latitude += 0.01; publish(output, changed);
  assert.throws(() => mergeSiteContextFiles(output, [launch]), /differs from current launch/);
  assert.deepEqual(readFileSync(join(output, 'site-context.json')), before);
  assert.equal(existsSync(join(output, 'site-context-noaa-cloud.json')), true);
  publish(output);
  assert.deepEqual(mergeSiteContextFiles(output, [launch]), { fragments: 1, profilesChecked: 1 });
  assert.equal(readFileSync(join(output, 'site-context.json'), 'utf8').includes('measurementPolicies'), true);
  assert.equal(existsSync(join(output, 'site-context-noaa-cloud.json')), false);
});
