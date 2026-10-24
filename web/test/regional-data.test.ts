import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createReplayProfileCache, decodeRegionalJson } from '../src/lib/regional-data.ts';
import { publishedLift } from '../src/lib/published-lift.ts';
import type { ReplayManifest } from '../src/lib/soaring.ts';

const raw = JSON.parse(readFileSync(new URL('../../forecasts/soaring/fixtures/blanchard-published.json', import.meta.url), 'utf8'));
const manifest = {
  model: raw.model, case: { referenceTime: raw.run.referenceTime }, cellCount: 4, cellProfiles: 'cell-{index}.json.gz',
  hours: raw.hours.map((hour: { validAt: string }, i: number) => ({ forecastHour: i, validAt: hour.validAt, file: `f${i}.json.gz` })),
} as ReplayManifest;
function profile(index: number) {
  const doc = structuredClone(raw);
  doc.source = { gridIndex: 100 + index };
  doc.hours[0].soaring = { thermalVelocityV2Mps: 0.5, resolvedThermalTopM: 1000, usableLiftTopV2M: 500, surfaceLclM: 900 };
  return doc;
}

test('regional JSON accepts static gzip bytes and HTTP-decoded JSON', async () => {
  const doc = { forecastHour: 5, thermalVelocityV2Mps: [1.2, null, 0] };
  assert.deepEqual(await decodeRegionalJson(new Response(gzipSync(JSON.stringify(doc)))), doc);
  assert.deepEqual(await decodeRegionalJson(new Response(JSON.stringify(doc), { headers: { 'content-encoding': 'gzip' } })), doc);
  await assert.rejects(decodeRegionalJson(new Response('unavailable')));
});

test('native cell profiles load only on selection, deduplicate requests and use a bounded cache', async () => {
  const calls: string[] = [];
  const cache = createReplayProfileCache('/bundle', manifest, async url => {
    calls.push(url);
    return profile(Number(url.match(/cell-(\d+)/)![1]));
  }, 2);
  assert.deepEqual(calls, []);
  const [first, again] = await Promise.all([cache.load(0, 100), cache.load(0, 100)]);
  assert.equal(first, again);
  assert.equal(calls.length, 1);
  assert.equal(publishedLift(first.hours[0]).thermalVelocityMps, 0.5, 'published v2 diagnostics survive parsing');
  await cache.load(1, 101);
  assert.equal(cache.cached(0), first, 'a viewed profile becomes most recently used');
  await cache.load(2, 102);
  assert.equal(cache.cached(1), undefined);
  assert.equal(cache.cached(0), first);
  assert.deepEqual(calls, ['/bundle/cell-0.json.gz', '/bundle/cell-1.json.gz', '/bundle/cell-2.json.gz']);
});

test('cell profile validation rejects mismatched model, run, hour and grid before caching', async () => {
  for (const mutate of [
    (doc: typeof raw) => { doc.model = 'gdps'; },
    (doc: typeof raw) => { doc.run.referenceTime = '2026-10-22T00:00:00Z'; },
    (doc: typeof raw) => { doc.hours[0].validAt = '2026-10-22T00:00:00Z'; },
    (doc: typeof raw) => { doc.source.gridIndex = 999; },
  ]) {
    const doc = profile(0); mutate(doc);
    const cache = createReplayProfileCache('/bundle', manifest, async () => doc);
    await assert.rejects(cache.load(0, 100), /differs from its map/);
    assert.equal(cache.cached(0), undefined);
  }
  const cache = createReplayProfileCache('/bundle', manifest, async () => profile(0));
  await assert.rejects(cache.load(4, 104), /Invalid regional cell/);
  assert.throws(() => createReplayProfileCache('/bundle', { ...manifest, cellProfiles: '../cell-{index}.json.gz' }), /Unsupported/);
});
