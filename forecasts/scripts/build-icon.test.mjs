import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildIconDataset, ensureArmeniaTerrain, validateIconDataset } from './build-icon.mjs';
import { buildLiveSoaring } from './build-live-soaring.mjs';
import { normalizeIconExtract } from './lib/icon-eu.mjs';
import { engineTerrain as T, GLO90_SOURCE } from './terrain.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value) + '\n');
const sites = read(new URL('../sites.json', import.meta.url)).sites.filter(site => site.timeZone === 'Asia/Yerevan');
const sidecars = read(new URL('../soaring/regions/armenia.json', import.meta.url));
const raw = read(new URL('./lib/icon-native-fixture.json', import.meta.url));
const terrainEntry = (site, elevationM) => ({
  point: { latitude: site.latitude, longitude: site.longitude }, elevation: { source: 'glo90', elevationM },
  terrain: { source: 'glo90', elevationM, slopeDeg: 12, aspectDeg: 180, relief: [{ radiusKm: 1, minM: elevationM - 100, maxM: elevationM + 100, percentile: 50 }] },
  landCover: { source: 'worldcover2021', atLaunch: 'grassland', fractions: [{ radiusKm: 1, byClass: { grassland: 1 } }] },
});
const context = {
  schemaVersion: 3, generatedAt: '2026-10-24T12:00:00Z', sources: [GLO90_SOURCE, T.SOURCES.worldcover2021],
  sites: Object.fromEntries(sites.map(site => [site.slug, terrainEntry(site, sidecars.launches.launches.find(launch => launch.slug === site.slug).launchElevationM)])),
};

// Captured DWD atmospheric values with synthetic geometry at catalogue and
// transect coordinates. This fixture tests publication, not geographical skill.
function acquisitionFixture() {
  const source = normalizeIconExtract(raw), points = [...sites, ...sidecars.crossSection.nodes];
  const cells = points.map((point, index) => ({ ...source.cells[0], index, id: `synthetic-publication-cell-${index}`,
    latitude: point.latitude, longitude: point.longitude,
    corners: [[point.longitude - 0.002, point.latitude - 0.002], [point.longitude + 0.002, point.latitude - 0.002], [point.longitude, point.latitude + 0.002]],
  }));
  return { ...source, cells, siteCells: Object.fromEntries(sites.map((site, index) => [site.slug, index])),
    grid: { ...source.grid, uuid: 'synthetic-publication-geometry', pointCount: cells.length },
    provenance: { ...source.provenance, fixtureDescription: 'Real captured Hatis column repeated at synthetic publication test cells' },
    hours: source.hours.map(hour => ({ ...hour, sources: cells.map(() => structuredClone(hour.sources[0])) })),
  };
}
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'build-icon-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function digests(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? digests(root, path) : [[path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]];
  }).sort(([a], [b]) => a.localeCompare(b));
}
const build = (output, acquired = acquisitionFixture(), terrain = context) => buildIconDataset({ output, sites, acquired, context: terrain, expectedHours: [7], log() {} });

test('all Armenian launches publish together with native agreement and complete region sidecars', async t => {
  const output = temporary(t), result = await build(output);
  assert.equal(sites.length, 40);
  assert.equal(result.sites, sites.length);
  assert.deepEqual(validateIconDataset(output, sites, { expectedHours: [7] }), result);
  assert.deepEqual(await buildLiveSoaring({ output, model: 'icon-eu', 'validate-only': true }), {
    model: 'icon-eu', referenceTime: result.referenceTime, regions: 1,
  });
  const pointer = read(join(output, 'soaring/v1/armenia-icon-eu-live/index.json'));
  const bundle = join(output, 'soaring/v1/armenia-icon-eu-live', pointer.bundle);
  const launches = read(join(bundle, 'launches.json')).launches;
  assert.deepEqual(launches.map(launch => launch.slug).sort(), sites.map(site => site.slug).sort());
  assert.equal(launches.every(launch => launch.distanceKm === 0 && launch.models['icon-eu'].hours.length === 1), true);
  assert.equal(read(join(bundle, 'cross-section.json')).nodes.length, sidecars.crossSection.nodes.length);
  const regions = read(join(output, 'soaring/v1/regions.json'));
  assert.ok(regions.regions.find(region => region.id === 'armenia').nativeModels.some(model => model.model === 'icon-eu'));
});

test('partial source, terrain, horizon and older-run failures preserve the published dataset', async t => {
  const output = temporary(t);
  await build(output);
  const before = digests(output);
  const incomplete = acquisitionFixture();
  incomplete.hours[0].sources[sites.length - 1] = null;
  await assert.rejects(build(output, incomplete), /incomplete native profile/);
  assert.deepEqual(digests(output), before);
  const noTerrain = structuredClone(context);
  delete noTerrain.sites['am-hatis-500'];
  await assert.rejects(build(output, acquisitionFixture(), noTerrain), /Missing measured primary launch elevation/);
  assert.deepEqual(digests(output), before);
  const old = acquisitionFixture();
  old.referenceTime = '2026-10-23T06:00:00Z';
  await assert.rejects(build(output, old), /Refusing an older ICON run/);
  const incompleteHorizon = acquisitionFixture();
  incompleteHorizon.hours = [];
  await assert.rejects(build(output, incompleteHorizon), /horizon differs/);
  assert.deepEqual(digests(output), before);
  assert.ok(readdirSync(output).every(name => !name.startsWith('.build-icon-')));
});

test('ICON retains current and previous bundles after refreshes and additive publication overlays', async t => {
  const output = temporary(t), overlay = temporary(t), pointers = [], acquired = acquisitionFixture();
  const caseDir = join(output, 'soaring/v1/armenia-icon-eu-live');
  const advance = value => new Date(Date.parse(value) + 6 * 3600000).toISOString();
  for (let run = 0; run < 3; run++) {
    if (run) {
      acquired.referenceTime = advance(acquired.referenceTime);
      acquired.provenance.capturedAt = advance(acquired.provenance.capturedAt);
      for (const hour of acquired.hours) {
        hour.validAt = advance(hour.validAt);
        for (const source of hour.sources) source.validAt = hour.validAt;
      }
    }
    await build(output, acquired);
    pointers.push(read(join(caseDir, 'index.json')).bundle.replace('bundles/', ''));
    cpSync(join(caseDir, 'bundles', pointers.at(-1)), join(overlay, pointers.at(-1)), { recursive: true });
  }
  assert.equal(new Set(pointers).size, 3);
  assert.deepEqual(readdirSync(join(caseDir, 'bundles')).sort(), pointers.slice(1).sort());
  assert.equal(validateIconDataset(output, sites, { expectedHours: [7] }).referenceTime, acquired.referenceTime);
  // Pages overlays provider artifacts onto its own cache. That additive copy
  // can restore deleted bundles, so publication must enforce retention again.
  cpSync(overlay, join(caseDir, 'bundles'), { recursive: true });
  assert.equal(readdirSync(join(caseDir, 'bundles')).length, 3);
  const script = fileURLToPath(new URL('./build-icon.mjs', import.meta.url));
  const prune = root => spawnSync(process.execPath, [script, '--output', root, '--prune-only'], { cwd: tmpdir(), encoding: 'utf8' });
  const result = prune(output);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(join(caseDir, 'bundles')).sort(), pointers.slice(1).sort());
  assert.equal(validateIconDataset(output, sites, { expectedHours: [7] }).referenceTime, acquired.referenceTime);
  assert.equal(prune(temporary(t)).status, 0, 'first publication without ICON remains a no-op');
});

test('validation rejects incorrect launch identity, semantics and horizon even when counts match', async t => {
  const output = temporary(t);
  await build(output);
  const file = join(output, 'icon-eu/sites', `${sites[0].slug}.json`), profile = read(file);
  for (const mutate of [
    doc => { doc.site.latitude += 0.01; },
    doc => { doc.site.id = sites[1].slug; },
    doc => { doc.model = 'gfs'; },
    doc => { doc.semantics.gust = 'instant'; },
    doc => { doc.hours[0].validAt = '2026-10-24T14:00:00Z'; },
  ]) {
    const invalid = structuredClone(profile); mutate(invalid); write(file, invalid);
    assert.throws(() => validateIconDataset(output, sites, { expectedHours: [7] }), /Invalid ICON profile|Incomplete ICON hour/);
  }
  write(file, profile);
  const manifestPath = join(output, 'icon-eu/manifest.json'), manifest = read(manifestPath);
  write(manifestPath, { ...manifest, firstForecastHour: 6 });
  assert.throws(() => validateIconDataset(output, sites, { expectedHours: [7] }), /Incomplete ICON point manifest/);
  write(manifestPath, manifest);
  for (const expectedHours of [[], [0], [79], [7, 7], [8, 7], [NaN]]) {
    assert.throws(() => validateIconDataset(output, sites, { expectedHours }), /Invalid ICON expected horizon/);
  }
});

test('terrain refresh measures only missing, moved or non-GLO90 Armenian entries and preserves US data', async t => {
  const output = temporary(t), old = structuredClone(context), us = { slug: 'va-woodstock', latitude: 38.9, longitude: -78.4 };
  old.sites[us.slug] = terrainEntry(us, 565);
  delete old.sites[sites[0].slug];
  old.sites[sites[1].slug].point.latitude -= 0.01;
  old.sites[sites[2].slug].elevation.source = 'glo30';
  write(join(output, 'site-context.json'), old);
  let measured;
  const result = await ensureArmeniaTerrain(output, sites, async pending => {
    measured = pending;
    return { ...context, sites: Object.fromEntries(pending.map(site => [site.slug, context.sites[site.slug]])) };
  });
  assert.deepEqual(measured.map(site => site.slug), sites.slice(0, 3).map(site => site.slug));
  assert.deepEqual(result.sites[us.slug], old.sites[us.slug]);
  assert.deepEqual(result.sites[sites[3].slug], old.sites[sites[3].slug]);
  assert.equal(read(join(output, 'site-context-armenia.json')).sites[us.slug], undefined);
  await ensureArmeniaTerrain(output, sites, () => { throw new Error('Fresh terrain must be reused'); });
  const moved = sites.map((site, i) => i === 0 ? { ...site, latitude: site.latitude + 0.01 } : site);
  const before = digests(output);
  await assert.rejects(ensureArmeniaTerrain(output, moved, async () => ({ ...context, sites: {} })), /Missing current Armenian terrain/);
  assert.deepEqual(digests(output), before, 'incomplete measurement must leave last-good terrain untouched');
});
