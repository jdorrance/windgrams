import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshHealthReader } from '../src/lib/refresh-health.ts';

const attempt = { attemptedAt: '2026-10-25T12:00:00Z', completedAt: '2026-10-25T12:30:00Z',
  lastSuccessfulRefreshAt: null, outcome: 'retained', reason: 'operator-only failure' };

test('sibling models share one validated provider health request', async () => {
  const urls: string[] = [];
  const read = createRefreshHealthReader({ baseUrl: 'https://forecast.invalid/data', fetch: async input => {
    urls.push(String(input));
    return Response.json({ schemaVersion: 1, group: 'noaa-cloud', models: { gfs: attempt, 'hrrr-conus': attempt } });
  } });
  assert.deepEqual(await Promise.all([read('gfs'), read('hrrr-conus'), read('gfs')]), [attempt, attempt, attempt]);
  assert.deepEqual(urls, ['https://forecast.invalid/data/health/noaa-cloud.json']);
  assert.equal(await read('unknown-model'), null);
  assert.equal(urls.length, 1);
});

test('a failed health read is retried and a successful read is reused only within the TTL', async () => {
  let calls = 0, clock = 1_000_000;
  const read = createRefreshHealthReader({ baseUrl: 'https://forecast.invalid/data', now: () => clock, fetch: async () => {
    calls += 1;
    return calls === 1 ? new Response('', { status: 404 })
      : Response.json({ schemaVersion: 1, group: 'noaa-cloud', models: { gfs: attempt } });
  } });
  assert.equal(await read('gfs'), null);
  assert.deepEqual(await read('gfs'), attempt, 'failure is not cached for the page lifetime');
  assert.equal(calls, 2);
  assert.deepEqual(await read('gfs'), attempt);
  assert.equal(calls, 2, 'success is shared within the TTL');
  clock += 5 * 60_000;
  assert.deepEqual(await read('gfs'), attempt);
  assert.equal(calls, 3, 'a long-lived tab re-reads health after the TTL');
});

test('missing and malformed health remain unknown instead of inventing a refresh result', async () => {
  for (const response of [new Response('', { status: 404 }), Response.json({ schemaVersion: 1, group: 'noaa-cloud', models: { rrfs: attempt } }),
    Response.json({ schemaVersion: 1, group: 'noaa-cloud', models: { gfs: { ...attempt, completedAt: null } } })]) {
    const read = createRefreshHealthReader({ baseUrl: '/data', fetch: async () => response });
    assert.equal(await read('gfs'), null);
  }
  const controller = new AbortController(); controller.abort();
  let requested = false;
  const read = createRefreshHealthReader({ baseUrl: '/data', signal: controller.signal, fetch: async () => { requested = true; return new Response('', { status: 404 }); } });
  assert.equal(await read('gfs'), null);
  assert.equal(requested, false, 'page disposal stops health requests');
});
