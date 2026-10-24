import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SiteForecast } from '@azohra/meteo.briefing/contract';
import { createReplayProfileCache } from '../src/lib/regional-data.ts';
import type { ReplayManifest } from '../src/lib/soaring.ts';
import { createKeyedAsyncLoader } from '../src/scripts/windgram-controller.ts';
import { createPageLifecycle } from '../src/scripts/page-lifecycle.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('A → B → A deduplicates pending requests and only completes the active selection', async () => {
  const pending = new Map<string, ReturnType<typeof deferred<string | null>>>();
  const completed: { key: string; value: string | null }[] = [];
  const loader = createKeyedAsyncLoader<string, string>({
    load: key => {
      assert.equal(pending.has(key), false, 'one shared request per pending key');
      const request = deferred<string | null>();
      pending.set(key, request);
      return request.promise;
    },
    onActiveComplete: (key, value) => { completed.push({ key, value }); },
  });
  const firstA = loader.select('A'), b = loader.select('B'), lastA = loader.select('A');
  await Promise.resolve();
  pending.get('B')!.resolve('profile-B');
  await b;
  assert.deepEqual(completed, []);
  pending.get('A')!.resolve('profile-A');
  await Promise.all([firstA, lastA]);
  assert.deepEqual(completed, [{ key: 'A', value: 'profile-A' }]);
  assert.equal(loader.isPending('A'), false);
  assert.equal(loader.getActiveKey(), 'A');
});

test('failed and null profile loads retry on explicit re-selection', async () => {
  for (const initialFailure of ['throw', 'null'] as const) {
    let attempts = 0;
    const loader = createKeyedAsyncLoader<number, string>({
      load: async key => {
        if (++attempts === 1) {
          if (initialFailure === 'throw') throw new Error('Transient failure');
          return null;
        }
        return `profile-${key}`;
      },
    });
    assert.equal(await loader.select(42), null);
    assert.equal(loader.hasFailed(42), true);
    assert.equal(loader.isPending(42), false);
    assert.equal(await loader.select(42), 'profile-42');
    assert.equal(attempts, 2);
    assert.equal(loader.hasFailed(42), false);
  }
});

test('synchronous loader errors also release pending state for retry', async () => {
  let attempts = 0;
  const loader = createKeyedAsyncLoader({ load: () => {
    if (++attempts === 1) throw new Error('Synchronous failure');
    return Promise.resolve('ready');
  } });
  assert.equal(await loader.select('cell'), null);
  assert.equal(loader.isPending('cell'), false);
  assert.equal(await loader.select('cell'), 'ready');
});

test('a rendering error is reported once and does not masquerade as a resource failure', async () => {
  let completions = 0;
  const loader = createKeyedAsyncLoader({
    load: async () => 'ready',
    onActiveComplete() { completions++; throw new Error('Render failure'); },
  });
  await assert.rejects(loader.select('A'), /Render failure/);
  assert.equal(completions, 1);
  assert.equal(loader.hasFailed('A'), false);
  assert.equal(loader.isPending('A'), false);
});

const raw = JSON.parse(readFileSync(new URL('../../forecasts/soaring/fixtures/blanchard-published.json', import.meta.url), 'utf8'));
const manifest = {
  model: raw.model, case: { referenceTime: raw.run.referenceTime }, cellCount: 12, cellProfiles: 'cell-{index}.json.gz',
  hours: raw.hours.map((hour: { validAt: string }, i: number) => ({ forecastHour: i, validAt: hour.validAt, file: `f${i}.json.gz` })),
} as ReplayManifest;
const profile = (index: number) => ({ ...structuredClone(raw), source: { gridIndex: 100 + index } });

test('returning to the ninth-evicted native profile reloads once through the single bounded cache', async () => {
  const reads: number[] = [];
  const resources = createReplayProfileCache('/bundle', manifest, async url => {
    const index = Number(url.match(/cell-(\d+)/)![1]);
    reads.push(index);
    return profile(index);
  });
  let selected = 0, completions = 0;
  const loader = createKeyedAsyncLoader<number, SiteForecast>({
    load: index => resources.load(index, 100 + index),
    onActiveComplete: index => {
      completions++;
      assert.equal(index, selected);
      assert.ok(resources.cached(selected), 'the cache used by the page is populated before update');
      assert.ok(completions <= 10, 'a cache miss must not recurse through stale coordinator values');
    },
  });
  for (selected = 0; selected < 9; selected++) await loader.select(selected);
  assert.equal(resources.cached(0), undefined, 'the native cache still holds only eight profiles');
  selected = 0;
  await loader.select(selected);
  assert.equal(completions, 10);
  assert.deepEqual(reads, [0, 1, 2, 3, 4, 5, 6, 7, 8, 0]);
  assert.ok(resources.cached(0));
  assert.equal(resources.cached(1), undefined);
});

test('real native cache releases a failed request before re-selection', async () => {
  let reads = 0;
  const resources = createReplayProfileCache('/bundle', manifest, async () => {
    if (++reads === 1) throw new Error('Temporary HTTP failure');
    return profile(0);
  });
  const loader = createKeyedAsyncLoader({ load: (index: number) => resources.load(index, 100 + index) });
  assert.equal(await loader.select(0), null);
  assert.equal(resources.cached(0), undefined);
  assert.equal(loader.hasFailed(0), true);
  assert.ok(await loader.select(0));
  assert.equal(reads, 2);
  assert.ok(resources.cached(0));
});

test('disposal suppresses pending completions and future requests', async () => {
  const pending = deferred<string | null>();
  const completed: string[] = [];
  let requests = 0;
  const loader = createKeyedAsyncLoader<string, string>({
    load: () => { requests++; return pending.promise; },
    onActiveComplete: key => { completed.push(key); },
  });
  const result = loader.select('A');
  await Promise.resolve();
  loader.dispose();
  pending.resolve('too late');
  assert.equal(await result, null);
  assert.equal(await loader.select('B'), null);
  assert.equal(requests, 1);
  assert.deepEqual(completed, []);
});

function transition(type: string, persisted: boolean) {
  return Object.assign(new Event(type), { persisted });
}

test('bfcache suspends playback while retaining resources and listeners until final departure', () => {
  const target = new EventTarget();
  let pauses = 0, restores = 0, releases = 0, interactions = 0;
  const lifetime = createPageLifecycle({
    onSuspend: () => { pauses++; },
    onRestore: () => { restores++; },
  }, target);
  lifetime.onDispose(() => { releases++; });
  target.addEventListener('click', () => { interactions++; }, { signal: lifetime.signal });
  target.dispatchEvent(transition('pagehide', true));
  assert.equal(pauses, 1);
  assert.equal(lifetime.disposed, false);
  assert.equal(releases, 0);
  target.dispatchEvent(transition('pageshow', true));
  target.dispatchEvent(new Event('click'));
  assert.equal(restores, 1);
  assert.equal(interactions, 1);
  target.dispatchEvent(transition('pagehide', false));
  target.dispatchEvent(new Event('click'));
  assert.equal(pauses, 2);
  assert.equal(lifetime.disposed, true);
  assert.equal(releases, 1);
  assert.equal(interactions, 1, 'page-owned listeners are removed');
  lifetime.dispose();
  assert.equal(releases, 1, 'cleanup is idempotent');
  lifetime.onDispose(() => { releases++; });
  assert.equal(releases, 2, 'late-created resources are released immediately');
});
