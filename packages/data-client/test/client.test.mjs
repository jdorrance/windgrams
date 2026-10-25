import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createForecastClient, createReplayProfileCache, decodeRegionalJson } from '@windgrams/data-client';

const fixture = JSON.parse(gunzipSync(readFileSync(new URL('../../../web/test/fixtures/windgram-visual/dog-gfs.json.gz', import.meta.url))));

test('an injected dataset origin owns every read and never reaches global fetch', async () => {
  const calls = [];
  const client = createForecastClient({ baseUrl: 'https://other-app.example/custom/data/', fetch: async url => { calls.push(String(url)); return Response.json({ ready: true }); } });
  const valid = raw => raw?.ready === true ? raw : null;
  assert.deepEqual(await client.readJson('models.json', valid), { ready: true });
  assert.deepEqual(await client.readRegional('soaring/v1/product/index.json'), { ready: true });
  assert.deepEqual(calls, ['https://other-app.example/custom/data/models.json', 'https://other-app.example/custom/data/soaring/v1/product/index.json']);
  for (const path of ['../secret', '/root', 'nested/../secret', 'https://host/file', '%2e%2e/secret', 'file?query', 'file#hash', 'nested\\secret']) {
    await assert.rejects(client.readJson(path, valid), /Invalid dataset-relative path/);
  }
  assert.equal(calls.length, 2);
});

test('optional absence, invalid documents and request cancellation remain distinct', async () => {
  const absent = createForecastClient({ baseUrl: '/data', fetch: async () => new Response('', { status: 404 }) });
  assert.equal(await absent.readJson('missing.json', raw => raw), null);
  const malformed = createForecastClient({ baseUrl: '/data', fetch: async () => Response.json({ wrong: true }) });
  await assert.rejects(malformed.readJson('models.json', () => null), /Invalid forecast document/);
  const controller = new AbortController(); controller.abort(new Error('left page'));
  let called = false;
  const aborted = createForecastClient({ baseUrl: '/data', signal: controller.signal, fetch: async () => { called = true; return Response.json({}); } });
  await assert.rejects(aborted.readJson('models.json', raw => raw), /left page/);
  assert.equal(called, false);
});

test('profile transport retains upstream missing-product semantics and identity paths', async () => {
  const calls = [];
  const client = createForecastClient({ baseUrl: '/custom/data', fetch: async url => { calls.push(String(url)); return new Response('', { status: 404 }); } });
  const result = await client.loadProfile('gfs', 'nz-example');
  assert.equal(result.miss, 'absent');
  assert.ok(calls.length > 0 && calls.every(path => path.startsWith('/custom/data/gfs/')));
  assert.throws(() => client.loadProfile('../gfs', 'nz-example'), /Invalid forecast identity/);
});

test('regional profile caching rejects wrong identities, retries failures and evicts old cells', async () => {
  const manifest = { model: fixture.model, cellProfiles: 'cell-{index}.json.gz', cellCount: 3, case: { referenceTime: fixture.run.referenceTime }, hours: fixture.hours.map(hour => ({ validAt: hour.validAt })) };
  let count = 0, invalid = true;
  const cache = createReplayProfileCache('/custom/bundle', manifest, async url => {
    count += 1;
    const index = Number(/cell-(\d+)/.exec(url)[1]);
    return { ...fixture, model: invalid ? 'wrong-model' : fixture.model, source: { gridIndex: index + 10 } };
  }, 1);
  await assert.rejects(cache.load(0, 10), /differs from its map/);
  invalid = false;
  const [a, b] = await Promise.all([cache.load(0, 10), cache.load(0, 10)]);
  assert.equal(a, b);
  assert.equal(count, 2);
  await cache.load(1, 11);
  assert.equal(cache.cached(0), undefined);
  await cache.load(0, 10);
  assert.equal(count, 4);
});

test('regional decoding accepts gzip files and transparently decoded responses', async () => {
  const data = { hours: [1, 3, 6] };
  assert.deepEqual(await decodeRegionalJson(new Response(gzipSync(JSON.stringify(data)))), data);
  assert.deepEqual(await decodeRegionalJson(Response.json(data)), data);
});

test('cached and in-flight profiles retain their requested grid identity', async () => {
  const manifest = { model: fixture.model, cellProfiles: 'cell-{index}.json.gz', cellCount: 1, case: { referenceTime: fixture.run.referenceTime }, hours: fixture.hours.map(hour => ({ validAt: hour.validAt })) };
  let release, count = 0;
  const cache = createReplayProfileCache('/custom/bundle', manifest, () => {
    count += 1;
    return new Promise(resolve => { release = resolve; });
  });
  const first = cache.load(0, 10);
  await assert.rejects(cache.load(0, 11), /differs from its map/);
  assert.equal(count, 1, 'mismatched in-flight identities never start or join another read');
  release({ ...fixture, source: { gridIndex: 10 } });
  const profile = await first;
  assert.equal(cache.cached(0), profile);
  assert.equal(await cache.load(0, 10), profile);
  await assert.rejects(cache.load(0, 11), /differs from its map/);
  assert.equal(count, 1, 'cache hits retain the identity established during validation');
});

test('profile cache rejects unbounded capacity and invalid cell identities before IO', async () => {
  const manifest = { model: fixture.model, cellProfiles: 'cell-{index}.json.gz', cellCount: 1, case: { referenceTime: fixture.run.referenceTime }, hours: [] };
  let calls = 0;
  const read = async () => { calls++; return {}; };
  for (const capacity of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => createReplayProfileCache('/bundle', manifest, read, capacity), /positive integer/);
  }
  const cache = createReplayProfileCache('/bundle', manifest, read, 1);
  for (const gridIndex of [-1, NaN, Infinity, 0.5]) await assert.rejects(cache.load(0, gridIndex), /Invalid regional cell/);
  assert.equal(calls, 0);
});

test('regional profile readers require explicit model identity', () => {
  const manifest = { cellProfiles: 'cell-{index}.json.gz', cellCount: 1, case: { id: 'north-sound-20261021-00z', referenceTime: fixture.run.referenceTime }, hours: [] };
  assert.throws(() => createReplayProfileCache('/data', manifest), /missing its model identity/);
  assert.doesNotThrow(() => createReplayProfileCache('/data', { ...manifest, case: { ...manifest.case, model: fixture.model } }));
});

test('synchronous reader failures reject through the cache promise and allow retry', async () => {
  const manifest = { model: fixture.model, cellProfiles: 'cell-{index}.json.gz', cellCount: 1, case: { referenceTime: fixture.run.referenceTime }, hours: fixture.hours.map(hour => ({ validAt: hour.validAt })) };
  let attempts = 0;
  const cache = createReplayProfileCache('/bundle', manifest, () => {
    if (++attempts === 1) throw new Error('credentials unavailable');
    return Promise.resolve({ ...fixture, source: { gridIndex: 10 } });
  });
  const failed = cache.load(0, 10);
  assert.ok(failed instanceof Promise);
  await assert.rejects(failed, /credentials unavailable/);
  assert.equal(cache.cached(0), undefined);
  const [a, b] = await Promise.all([cache.load(0, 10), cache.load(0, 10)]);
  assert.equal(a, b);
  assert.equal(attempts, 2);
});
