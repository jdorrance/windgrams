import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { prepareRegionalSnapshot, createSnapshotRepository } from '@windgrams/data-client/offline';
import { assessForecastFreshness } from '@windgrams/data-client';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value)}\n`);
function store() {
  const objects = new Map();
  return {
    objects,
    async get(key) { return objects.has(key) ? Uint8Array.from(objects.get(key)) : null; },
    async put(key, bytes) { objects.set(key, Uint8Array.from(bytes)); },
    async remove(key) { objects.delete(key); },
    async list(prefix) { return [...objects.keys()].filter(key => key.startsWith(prefix)); },
  };
}
function published(referenceTime = '2026-01-01T00:00:00Z', { legacy = false, primary = true } = {}) {
  const valid = hour => new Date(Date.parse(referenceTime) + hour * 3600000).toISOString();
  const files = new Map(Object.entries({
    'grid.geojson': encode({ type: 'FeatureCollection', features: [] }),
    'profile.json': encode({ run: { referenceTime }, site: { id: 'original-site' }, levels: [{ temperatureC: 12.3456789 }] }), 'audit.json': encode({ model: 'icon-eu' }),
    'f1.json.gz': gzipSync(encode({ forecastHour: 1, validAt: valid(1), values: [1, 2] })),
    'f2.json.gz': gzipSync(encode({ forecastHour: 2, validAt: valid(2), values: [3, 4] })),
    'cell-0.json.gz': gzipSync(encode({ source: { gridIndex: 5 } })),
    'cell-1.json.gz': gzipSync(encode({ source: { gridIndex: 6 } })),
  }));
  if (!primary) files.delete('profile.json');
  const manifest = {
    schemaVersion: 1, model: 'icon-eu', soaringContractVersion: '2.1.0', capturedAt: referenceTime, cellCount: 2, siteCell: 0,
    ...(legacy ? {} : { cellProfiles: 'cell-{index}.json.gz' }), case: { id: 'sample-live', model: 'icon-eu', referenceTime,
      bbox: [44, 39, 45, 40], sinkMps: 1, site: { name: 'Sample', latitude: 39.5, longitude: 44.5, timeZone: 'Asia/Yerevan' }, launchElevation: { elevationM: 500 } },
    versions: { algorithm: 'fixture' }, hours: [1, 2].map(hour => ({ forecastHour: hour, validAt: valid(hour), file: `f${hour}.json.gz` })),
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])),
    fileBytes: Object.fromEntries([...files].map(([name, bytes]) => [name, bytes.length])),
  };
  const manifestBytes = encode(manifest), bundle = hash(manifestBytes);
  files.set('manifest.json', manifestBytes);
  const baseUrl = 'https://forecast.example/data', casePath = 'soaring/v1/sample-live', root = `${baseUrl}/${casePath}`;
  const network = new Map([...files].map(([name, bytes]) => [`${root}/bundles/${bundle}/${name}`, bytes]));
  network.set(`${root}/index.json`, encode({ schemaVersion: 1, caseId: 'sample-live', bundle: `bundles/${bundle}`, manifestSha256: bundle }));
  const calls = [];
  const read = async (url, signal) => {
    signal?.throwIfAborted(); calls.push(url);
    if (!network.has(url)) throw new Error('404');
    return Uint8Array.from(network.get(url));
  };
  return { baseUrl, casePath, manifest, network, read, calls, files };
}

test('offline planning authenticates one run and bounds hours/cells without changing timestamps', async () => {
  const source = published();
  const inventory = await prepareRegionalSnapshot({ ...source, forecastHours: [2], cellIndices: [1] });
  assert.deepEqual(inventory.hours.map(hour => hour.forecastHour), [2]);
  assert.deepEqual(inventory.cellIndices, [1]);
  assert.equal(inventory.referenceTime, source.manifest.case.referenceTime);
  assert.equal(inventory.manifest.hours.length, 2);
  assert.equal(inventory.validUntil, source.manifest.hours[1].validAt);
  assert.equal(inventory.files.some(file => file.path === 'f1.json.gz' || file.path === 'cell-0.json.gz'), false);
  assert.equal(inventory.files.some(file => ['profile.json', 'audit.json'].includes(file.path)), false);
  assert.equal(inventory.totalBytes, inventory.files.reduce((total, file) => total + file.bytes, 0));
  assert.equal(source.calls.length, 2, 'planning reads only pointer and authenticated manifest');
  await assert.rejects(prepareRegionalSnapshot({ ...source, forecastHours: [3] }), /hours are unavailable/);
  await assert.rejects(prepareRegionalSnapshot({ ...source, cellIndices: [2] }), /cells are unavailable/);
  await assert.rejects(prepareRegionalSnapshot({ ...source, casePath: '../elsewhere' }), /Invalid regional case path/);
  const manifestUrl = [...source.network.keys()].find(url => url.endsWith('/manifest.json'));
  source.network.set(manifestUrl, encode({ ...source.manifest, capturedAt: '2026-02-01T00:00:00Z' }));
  await assert.rejects(prepareRegionalSnapshot(source), /manifest checksum mismatch/);
});

test('complete legacy primary saves retain exact authenticated profile bytes', async () => {
  const source = published(undefined, { legacy: true }), storage = store();
  const inventory = await prepareRegionalSnapshot({ ...source, cellIndices: [0] });
  const original = source.files.get('profile.json');
  assert.deepEqual(inventory.files.find(file => file.path === 'profile.json'), {
    path: 'profile.json', bytes: original.length, sha256: hash(original),
  });
  assert.equal(inventory.files.some(file => file.path === 'audit.json'), false);
  const repository = createSnapshotRepository({ store: storage, read: source.read });
  await repository.save('trip', inventory);
  const offline = createSnapshotRepository({ store: storage, read: () => { throw new Error('NETWORK DISABLED'); } });
  const saved = await offline.open('trip');
  assert.deepEqual(Buffer.from(await offline.read(saved, 'profile.json')), original);
  await assert.rejects(prepareRegionalSnapshot({ ...source, forecastHours: [1], cellIndices: [0] }), /complete forecast horizon/);
  for (const cellIndices of [[], [1]]) {
    const other = await prepareRegionalSnapshot({ ...source, cellIndices });
    assert.equal(other.files.some(file => file.path === 'profile.json'), false);
  }
  for (const candidate of [published(), published(undefined, { legacy: true, primary: false })]) {
    const other = await prepareRegionalSnapshot({ ...candidate, cellIndices: [0] });
    assert.equal(other.files.some(file => file.path === 'profile.json'), false, 'shards and absent primary files need no primary sidecar');
  }
  const corrupt = createSnapshotRepository({ store: store(), read: async url => url.endsWith('/profile.json')
    ? encode({ run: { referenceTime: '2026-02-01T00:00:00Z' } }) : source.read(url) });
  await assert.rejects(corrupt.save('trip', inventory), /checksum or size mismatch: profile.json/);
  assert.equal(await corrupt.open('trip'), null);
});

test('a committed snapshot survives a new repository with network disabled and remains expired', async () => {
  const source = published(), storage = store();
  const inventory = await prepareRegionalSnapshot(source);
  const repository = createSnapshotRepository({ store: storage, read: source.read, now: () => '2026-02-01T00:00:00Z' });
  await repository.save('trip', inventory);
  const offline = createSnapshotRepository({ store: storage, read: () => { throw new Error('NETWORK DISABLED'); } });
  const saved = await offline.open('trip');
  assert.equal(saved.savedAt, '2026-02-01T00:00:00Z');
  assert.equal(saved.inventory.referenceTime, '2026-01-01T00:00:00Z');
  assert.deepEqual(JSON.parse(gunzipSync(await offline.read(saved, 'f1.json.gz'))), { forecastHour: 1, validAt: '2026-01-01T01:00:00.000Z', values: [1, 2] });
  assert.equal(await offline.read(saved, 'cell-1.json.gz'), null, 'unsaved cells remain explicitly unavailable');
  assert.equal(assessForecastFreshness({ now: saved.savedAt, referenceTime: saved.inventory.referenceTime, validUntil: saved.inventory.validUntil }).status, 'expired');
  assert.equal((await offline.list()).length, 1);
});

test('interruption retains the complete previous run and restart resumes only missing files', async () => {
  const storage = store(), old = published(), next = published('2026-01-02T00:00:00Z');
  const previous = await createSnapshotRepository({ store: storage, read: old.read }).save('trip', await prepareRegionalSnapshot(old));
  const inventory = await prepareRegionalSnapshot(next), controller = new AbortController();
  const interrupted = createSnapshotRepository({ store: storage, read: next.read });
  await assert.rejects(interrupted.save('trip', inventory, { signal: controller.signal, concurrency: 1,
    onProgress: progress => { if (progress.completedFiles === 2) controller.abort(new Error('lost connection')); } }), /lost connection/);
  assert.deepEqual(await interrupted.open('trip'), previous);
  assert.equal((await storage.list(`objects/${inventory.id}/`)).length, 2);
  next.calls.length = 0;
  const restarted = createSnapshotRepository({ store: storage, read: next.read });
  await restarted.save('trip', inventory, { concurrency: 1 });
  assert.equal(next.calls.length, inventory.files.length - 2);
  assert.equal((await restarted.open('trip')).inventory.referenceTime, next.manifest.case.referenceTime);
  assert.equal((await storage.list(`objects/${previous.inventory.id}/`)).length, 0, 'successful replacement frees unshared previous objects');
});

test('wrong bytes, mutated metadata and failed atomic commit cannot replace a usable saved forecast', async () => {
  const storage = store(), source = published(), next = published('2026-01-02T00:00:00Z');
  const old = await createSnapshotRepository({ store: storage, read: source.read }).save('trip', await prepareRegionalSnapshot(source));
  const inventory = await prepareRegionalSnapshot(next);
  const corrupt = createSnapshotRepository({ store: storage, read: async url => url.endsWith('f1.json.gz') ? new Uint8Array([1, 2]) : next.read(url) });
  await assert.rejects(corrupt.save('trip', inventory), /checksum or size mismatch/);
  assert.deepEqual(await corrupt.open('trip'), old);
  const changed = structuredClone(inventory); changed.manifest.capturedAt = '2026-03-01T00:00:00Z';
  await assert.rejects(createSnapshotRepository({ store: storage, read: next.read }).save('trip', changed), /Invalid saved forecast inventory/);
  let commitFailed = false;
  const quota = { ...storage, async put(key, bytes) { if (key.startsWith('saved/')) { commitFailed = true; throw new Error('quota'); } await storage.put(key, bytes); } };
  await assert.rejects(createSnapshotRepository({ store: quota, read: next.read }).save('trip', inventory), /quota/);
  assert.equal(commitFailed, true);
  assert.deepEqual(await corrupt.open('trip'), old);
  const stored = JSON.parse(new TextDecoder().decode(await storage.get('saved/trip.json')));
  stored.inventory.manifest.capturedAt = '2026-03-01T00:00:00Z';
  await storage.put('saved/trip.json', encode(stored));
  await assert.rejects(corrupt.open('trip'), /Invalid saved forecast inventory/, 'persisted metadata is bound to the saved content identity');
});

test('concurrency is bounded; cancellation settles all workers without a late commit', async () => {
  const source = published(), inventory = await prepareRegionalSnapshot(source), storage = store();
  const controller = new AbortController(); let active = 0, maximum = 0, finished = 0;
  const read = async (url, signal) => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setTimeout(resolve, 5)); return await source.read(url, signal); }
    finally { active--; finished++; }
  };
  const repository = createSnapshotRepository({ store: storage, read });
  await assert.rejects(repository.save('trip', inventory, { concurrency: 2, signal: controller.signal,
    onProgress: () => controller.abort(new Error('cancelled')) }), /cancelled/);
  assert.equal(maximum, 2); assert.equal(active, 0); assert.ok(finished >= 2);
  assert.equal(await repository.open('trip'), null);
  await assert.rejects(repository.save('trip', inventory, { concurrency: 0 }), /concurrency/);
});

test('removal preserves shared saved bytes, pruning removes abandoned downloads, reads detect corruption', async () => {
  const source = published(), inventory = await prepareRegionalSnapshot(source), storage = store();
  const repository = createSnapshotRepository({ store: storage, read: source.read });
  await repository.save('trip', inventory); await repository.save('backup', inventory);
  await repository.remove('trip');
  const backup = await repository.open('backup');
  assert.ok(await repository.read(backup, 'grid.geojson'));
  await storage.put('objects/abandoned/file.json', encode({}));
  await repository.prune(); assert.equal(await storage.get('objects/abandoned/file.json'), null);
  await storage.put(`objects/${inventory.id}/grid.geojson`, encode({ damaged: true }));
  await assert.rejects(repository.read(backup, 'grid.geojson'), /missing or corrupt/);
  await storage.remove(`objects/${inventory.id}/grid.geojson`);
  await assert.rejects(repository.open('backup'), /incomplete/);
  await repository.remove('backup');
  assert.deepEqual(await repository.list(), []); assert.equal(storage.objects.size, 0);
});

test('a host-wide lock prevents another repository pruning an in-flight download', async () => {
  const source = published(), inventory = await prepareRegionalSnapshot(source), storage = store();
  let queue = Promise.resolve();
  storage.withLock = operation => {
    const result = queue.then(operation);
    queue = result.then(() => {}, () => {});
    return result;
  };
  let resume, began;
  const blocked = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  let calls = 0;
  const first = createSnapshotRepository({ store: storage, read: async url => {
    if (++calls === 3) { began(); await gate; }
    return source.read(url);
  } });
  const second = createSnapshotRepository({ store: storage });
  const saving = first.save('trip', inventory, { concurrency: 1 });
  await blocked;
  assert.equal((await storage.list('objects/')).length, 2);
  let pruned = false;
  const pruning = second.prune().then(() => { pruned = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pruned, false);
  resume(); await saving; await pruning;
  assert.ok(await second.open('trip'));
  assert.equal((await storage.list('objects/')).length, inventory.files.length);
});
