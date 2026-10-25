import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSolarTerrain, domainFor, expandBounds, gridFromFunction, metresPerDegree, startSolarTerrain, indexIsFresh } from '../src/solar.ts';

// Recorded from the retained JS builder before the TypeScript module split.
// The fixed timestamp and reversed source-key order also protect generation IDs.
const cases = [
  { site: { slug: 'north', latitude: 43.62332, longitude: -115.98076 }, hash: 'b880c7e2953e06d7ea02b354e5dd09217c402cf3c5ba209e55760019cd593d91' },
  { site: { slug: 'south', latitude: -44.12, longitude: 169.4 }, hash: '49d78865abb4a65ee3828f4e679cc947232496eacda088555b91785bf9516018' },
];
const source = { id: 'fixture', name: 'Synthetic ridge', resolutionM: 10, licence: 'Test', url: 'https://example.invalid/dem' };
function withRecordedGzipPlatform(body) {
  // gzip's OS byte varies by host (Unix = 3, macOS = 19); the retained
  // snapshots used macOS. Preserve every other byte, including the checksum.
  const bytes = Buffer.from(body);
  bytes[9] = 19;
  return bytes;
}
function fixture(site, missing = false) {
  const bounds = expandBounds(domainFor(site.latitude, site.longitude, 0.1).bounds, 1000), scale = metresPerDegree(site.latitude);
  const elevation = (lat, lon) => missing ? NaN : 500 + (lat - site.latitude) * scale.lat * 0.1 + Math.max(0, 300 - Math.abs((lon - site.longitude) * scale.lon - 300));
  const fine = gridFromFunction(elevation, { ...bounds, dLat: 0.0001, dLon: 0.0001 });
  return { fine, coarse: fine, sources: { horizon: source, surface: source }, radiusKm: 0.1, maxDistanceKm: 0.5, generatedAt: '2026-10-25T00:00:00Z' };
}
for (const { site, hash } of cases) test(`${site.slug}: strict TS preserves terrain values, generation ID and encoded bytes`, () => {
  const result = buildSolarTerrain(site, fixture(site));
  const digest = createHash('sha256').update(JSON.stringify(result.index)).update(withRecordedGzipPlatform(result.relief.body))
    .update(Buffer.concat(result.tiles.flatMap(tile => [Buffer.from(`${tile.z}/${tile.x}/${tile.y}\n`), withRecordedGzipPlatform(tile.body)]))).digest('hex');
  assert.equal(digest, hash);
});
test('missing ground remains missing through normals, tiles, relief and launch summary', () => {
  const site = cases[0].site, result = buildSolarTerrain(site, fixture(site, true));
  assert.deepEqual(result.tiles, []);
  assert.equal(result.index.referenceElevationM, null);
  assert.equal(result.index.launch.elevationM, null);
  assert.equal(result.index.launch.slopeDeg, null);
  assert.equal(result.relief.meta.minM, null);
  assert.equal(result.relief.meta.maxM, null);
});
test('incomplete block builds cannot publish and unknown cached metadata is not fresh', () => {
  const site = cases[0].site, options = fixture(site), build = startSolarTerrain(site, options);
  assert.throws(() => build.finish(), /block\(s\) not built/);
  for (const cached of [undefined, null, [], {}, { schemaVersion: 1, inputs: [] }]) assert.equal(indexIsFresh(cached, site, options), false);
  const block = build.blocks[0];
  assert.throws(() => build.addBlock({ ...block, x1: block.x1 + 256 }, options.fine), /outside this build/);
  build.addBlock(block, options.fine);
  assert.throws(() => build.addBlock(structuredClone(block), options.fine), /already completed/);
  for (const remaining of build.blocks.slice(1)) build.addBlock(remaining, options.fine);
  assert.ok(build.finish().index.tiles.count > 0);
});
