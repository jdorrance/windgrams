import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAvSnapshotRepository } from '@windgrams/data-client/av';
import { avFetch, point } from './av-fixture.mjs';
function store() {
  const objects = new Map();
  return {
    objects,
    get: async (key) => objects.get(key) ?? null,
    put: async (key, bytes) => objects.set(key, Uint8Array.from(bytes)),
    remove: async (key) => {
      objects.delete(key);
    },
    list: async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix)),
  };
}
test('AV snapshots verify every file, commit atomically and reopen the complete profile without a network', async () => {
  const transport = avFetch(),
    objects = store(),
    repo = createAvSnapshotRepository(objects, { apiBaseUrl: 'https://av.test', fetch: transport.fetch });
  const saved = await repo.save('day', {
    model: 'gfs',
    points: [point],
    frames: ['f001'],
    layers: ['thermal-velocity'],
  });
  assert.ok(saved.inventory.totalBytes > 0);
  const count = transport.calls.length;
  const offline = createAvSnapshotRepository(objects, {
    apiBaseUrl: 'https://unused.test',
    fetch: () => {
      throw new Error('network forbidden');
    },
  });
  const opened = await offline.open('day'),
    build = await opened.client.pin('gfs'),
    profile = await opened.client.profile(build, point);
  assert.equal(profile.frames.length, 24);
  assert.equal(transport.calls.length, count);
  assert.equal((await opened.client.samples(build, [point], ['f001'], ['thermal-velocity'])).length, 1);
  await assert.rejects(opened.client.profile(build, { ...point, lat: point.lat + 0.001 }), /unavailable/);
  const key = opened.inventory.files[1].sha256;
  objects.objects.get(`av/objects/${key}`)[0] ^= 1;
  await assert.rejects(offline.open('day'), /corrupt/);
});
test('failed snapshot replacement retains the previously committed forecast and prune releases abandoned blobs', async () => {
  const transport = avFetch(),
    objects = store(),
    repo = createAvSnapshotRepository(objects, { apiBaseUrl: 'https://av.test', fetch: transport.fetch });
  const saved = await repo.save('day', {
    model: 'gfs',
    points: [point],
    frames: ['f001'],
    layers: ['thermal-velocity'],
  });
  const bad = createAvSnapshotRepository(objects, {
    apiBaseUrl: 'https://av.test',
    fetch: async () => new Response('{}', { status: 400 }),
  });
  await assert.rejects(
    bad.save('day', { model: 'gfs', points: [point], frames: ['f001'], layers: ['thermal-velocity'] }),
  );
  assert.equal((await repo.open('day')).inventory.id, saved.inventory.id);
  await repo.remove('day');
  await repo.prune();
  assert.equal(objects.objects.size, 0);
});
test('saved selected launch and route retain exact per-cell profiles and project scoped subsets offline', async () => {
  const transport = avFetch(),
    objects = store(),
    repo = createAvSnapshotRepository(objects, { apiBaseUrl: 'https://av.test', fetch: transport.fetch });
  const a = { ...point },
    b = { lat: point.lat + 0.01, lon: point.lon + 0.01 },
    route = {
      title: 'Launch → ridge',
      totalDistanceKm: 2,
      nodes: [
        { point: a, distanceKm: 0, waypointLabel: 'Launch', launchElevationM: 1200 },
        { point: b, distanceKm: 2, waypointLabel: 'Ridge', launchElevationM: 1400 },
      ],
    };
  const { createAvClient } = await import('@windgrams/data-client/av'),
    client = createAvClient({ apiBaseUrl: 'https://av.test', fetch: transport.fetch }),
    build = await client.pin('gfs');
  const site = { ...a, slug: 'launch', name: 'Saved launch', timeZone: 'America/Los_Angeles' };
  await repo.save('route', {
    model: 'gfs',
    build,
    site,
    route,
    points: [a, b],
    frames: ['f001', 'f002'],
    layers: ['thermal-velocity', 'surface-lcl-msl'],
  });
  const offline = createAvSnapshotRepository(objects, {
      apiBaseUrl: 'https://unused.test',
      fetch: () => {
        throw new Error('no network');
      },
    }),
    opened = await offline.open('route'),
    pinned = await opened.client.pin('gfs');
  assert.deepEqual(opened.inventory.site, site);
  assert.deepEqual(opened.inventory.route, route);
  const profile = await opened.client.profile(pinned, b, ['f002']);
  assert.equal(profile.frames.length, 1);
  assert.equal(profile.frames[0].id, 'f002');
  assert.equal(profile.lat, b.lat);
  const row = await opened.client.samples(pinned, [b, a], ['f002'], ['surface-lcl-msl']);
  assert.equal(row[0].lat, b.lat);
  assert.equal(
    row[0].frames[0].layers['surface-lcl-msl'].value,
    transport.data.profile.frames[1].layers['surface-lcl-msl'].value,
  );
  await assert.rejects(opened.client.samples(pinned, [a], ['f003'], ['surface-lcl-msl']), /unavailable/);
});

test('cached offline samples remain pinned to the saved build identity', async () => {
  const transport = avFetch(), objects = store();
  const repo = createAvSnapshotRepository(objects, { apiBaseUrl: 'https://av.test', fetch: transport.fetch });
  const saved = await repo.save('day', { model: 'gfs', points: [point], frames: ['f001'], layers: ['thermal-velocity'] });
  const build = await saved.client.pin('gfs');
  await saved.client.samples(build, [point], ['f001'], ['thermal-velocity']);
  for (const change of [{ buildId: 'other' }, { model: 'icon-eu' }, { cycle: '2026-01-01T00:00:00Z' }, { expiresAt: '2098-01-01T00:00:00Z' }]) {
    const wrong = { ...build, manifest: { ...build.manifest, ...change } };
    await assert.rejects(saved.client.samples(wrong, [point], ['f001'], ['thermal-velocity']), /saved build differs/);
    await assert.rejects(saved.client.profile(wrong, point), /saved build differs/);
  }
  await assert.rejects(saved.client.pin('icon-eu'), /saved build differs/);
});

test('cancellation at final inventory hashing preserves the committed slot', async () => {
  const transport = avFetch(), objects = store(), selection = { model: 'gfs', points: [point], frames: ['f001'], layers: ['thermal-velocity'] };
  const repo = createAvSnapshotRepository(objects, { apiBaseUrl: 'https://av.test', fetch: transport.fetch });
  const old = await repo.save('day', selection), stopped = new AbortController();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'), original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async (algorithm, bytes) => {
    const value = await original.subtle.digest(algorithm, bytes);
    if (new TextDecoder().decode(bytes).includes('"savedAt"')) stopped.abort(new Error('cancel at commit'));
    return value;
  } } } });
  try {
    const cancelled = createAvSnapshotRepository(objects, { apiBaseUrl: 'https://av.test', fetch: transport.fetch, signal: stopped.signal });
    await assert.rejects(cancelled.save('day', selection), /cancel at commit/);
    assert.equal(stopped.signal.aborted, true);
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.equal((await repo.open('day')).inventory.id, old.inventory.id);
});

test('interrupted immutable responses resume without downloading again; latest remains fresh', async () => {
  const transport = avFetch(), objects = store(), calls = [], selection = { model: 'gfs', points: [point], frames: ['f001'], layers: ['thermal-velocity'] };
  let fail = true;
  const fetch = async (url, init) => {
    calls.push(String(url));
    if (fail && new URL(url).pathname.endsWith('/profile') && new URL(url).searchParams.get('frame').includes('f017')) return new Response('{}', { status: 400 });
    return transport.fetch(url, init);
  };
  const repo = () => createAvSnapshotRepository(objects, { apiBaseUrl: 'https://av.test', fetch });
  await assert.rejects(repo().save('day', selection));
  assert.equal(objects.objects.has('av/slots/day.json'), false);
  assert.equal(objects.objects.has('av/resume.json'), true);
  fail = false;
  const saved = await repo().save('day', selection);
  assert.equal(calls.filter(url => new URL(url).pathname.endsWith('/profile') && new URL(url).searchParams.get('frame').includes('f001')).length, 1);
  assert.equal(calls.filter(url => new URL(url).pathname.endsWith('/latest')).length, 2);
  assert.equal((await saved.client.profile(await saved.client.pin('gfs'), point)).frames.length, 24);
});

test('corrupt resume blobs fall back to validated network responses and prune releases checkpoints', async () => {
  const transport = avFetch(), objects = store(), selection = { model: 'gfs', points: [point], frames: ['f001'], layers: ['thermal-velocity'] };
  const repo = createAvSnapshotRepository(objects, { apiBaseUrl: 'https://av.test', fetch: transport.fetch });
  await repo.save('day', selection);
  const journal = JSON.parse(new TextDecoder().decode(objects.objects.get('av/resume.json')));
  const entry = journal.entries.find(entry => new URL(entry.url).pathname.endsWith('/profile'));
  objects.objects.get(`av/objects/${entry.sha256}`)[0] ^= 1;
  const before = transport.calls.length;
  await repo.save('day', selection);
  assert.equal(transport.calls.slice(before).filter(url => new URL(url).pathname.endsWith('/profile')).length, 1);
  await repo.prune();
  assert.equal(objects.objects.has('av/resume.json'), false);
  assert.ok(await repo.open('day'));
  await repo.remove('day'); await repo.prune();
  assert.equal(objects.objects.size, 0);
});

test('resume metadata corruption falls back to network and invalid identities never enter checkpoints', async () => {
  const transport = avFetch(), objects = store(), selection = { model: 'gfs', points: [point], frames: ['f001'], layers: ['thermal-velocity'] };
  const repo = createAvSnapshotRepository(objects, { apiBaseUrl: 'https://av.test', fetch: transport.fetch });
  await repo.save('day', selection);
  const index = JSON.parse(new TextDecoder().decode(objects.objects.get('av/resume.json')));
  index.entries[0].url += '&corrupt=1';
  objects.objects.set('av/resume.json', new TextEncoder().encode(JSON.stringify(index)));
  const before = transport.calls.length;
  await repo.save('day', selection);
  assert.equal(transport.calls.slice(before).filter(url => new URL(url).pathname.endsWith('/profile')).length, 2);
  const bad = avFetch(undefined, value => { if (value.cell) value.lat += 1; return value; }), fresh = store();
  await assert.rejects(createAvSnapshotRepository(fresh, { apiBaseUrl: 'https://av.test', fetch: bad.fetch }).save('bad', selection), /pinned build or point/);
  assert.equal(fresh.objects.has('av/resume.json'), false);
});

test('resume checkpoints enforce entry and staged-byte limits', async () => {
  const { createAvResumeJournal } = await import('../dist/av-offline-resume.js');
  for (const [count, size, expected] of [[1025, 1, 1024], [33, 1024 * 1024, 32]]) {
    const objects = store(), journal = createAvResumeJournal(objects, Date.now);
    for (let index = 0; index < count; index++) await journal.remember({
      url: `https://av.test/v1/models/gfs/runs/build/profile?lat=${index}`,
      sha256: 'a'.repeat(64), bytes: size, expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await journal.flush();
    const checkpoint = JSON.parse(new TextDecoder().decode(objects.objects.get('av/resume.json')));
    assert.equal(checkpoint.entries.length, expected);
    assert.equal(checkpoint.entries.reduce((sum, entry) => sum + entry.bytes, 0) <= 32 * 1024 * 1024, true);
    assert.equal(checkpoint.entries.some(entry => entry.url.endsWith('lat=0')), false);
  }
});
