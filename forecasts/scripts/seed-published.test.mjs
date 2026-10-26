import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyGroup, collectGroup, groupHasLocal, seedPublishedGroup, seedPublishedGroups } from "./seed-published.mjs";
import { isPublishedCase } from './merge-soaring-regions.mjs';
import { modelDescriptor } from '@windgrams/providers/registry';

const script = join(dirname(fileURLToPath(import.meta.url)), "seed-published.mjs");

test('multi-group recovery attempts every group once after an independent seed failure', async () => {
  const attempted = [];
  const results = await seedPublishedGroups('unused', ['terrain', 'observations', 'terrain'], {}, async (_, group) => {
    attempted.push(group);
    if (group === 'terrain') throw new Error('terrain feed unavailable');
    return { objects: 2, outcomes: [{ model: 'observations', status: 'seeded' }] };
  });
  assert.deepEqual(attempted, ['terrain', 'observations']);
  assert.deepEqual(results.map(result => result.outcomes[0].status), ['unavailable', 'seeded']);
  await assert.rejects(() => seedPublishedGroups('unused', ['terrain', 'typo'], {}, () => assert.fail('Validate group names before writing')), /Unknown seed group/);
});

test('collectGroup rejects partial or mixed runs for every point model', async () => {
  const run = '2026-10-24T00:00:00Z';
  const docs = {
    'hrrr-conus/manifest.json': { model: 'hrrr-conus', referenceTime: run, sites: [{ slug: 'va-daniels' }, { slug: 'va-eagle-rock' }] },
    'hrrr-conus/sites/va-daniels.json': { run: { referenceTime: run } },
  };
  const get = async key => docs[key] ?? null;
  await assert.rejects(collectGroup('noaa-cloud', { get }), /Incomplete published/);
  docs['hrrr-conus/sites/va-eagle-rock.json'] = { run: { referenceTime: '2026-10-23T18:00:00Z' } };
  await assert.rejects(collectGroup('noaa-cloud', { get }), /Incomplete published/);
  docs['hrrr-conus/sites/va-eagle-rock.json'].run.referenceTime = run;
  assert.equal((await collectGroup('noaa-cloud', { get })).size, 3);
});

test("collectGroup reads NWS offices, ECMWF sites, and one balloon file per launch", async () => {
  const asked = [];
  await collectGroup("observations", {
    sites: [{ slug: "va-daniels" }],
    get: async (key) => {
      asked.push(key);
      if (key === "nws/manifest.json") return { sites: [{ slug: "va-daniels" }], offices: [{ office: "LWX" }] };
      if (key === "ecmwf/manifest.json") return { sites: [{ slug: "va-daniels" }] };
      if (key === 'raob/manifest.json') return null; // Legacy publication without attempt metadata.
      return { key };
    },
  });
  assert.deepEqual(asked, [
    "nws/manifest.json",
    "nws/sites/va-daniels.json",
    "nws/offices/LWX.json",
    "ecmwf/manifest.json",
    "ecmwf/sites/va-daniels.json",
    "raob/manifest.json",
    "raob/sites/va-daniels.json",
  ]);
});

test('balloon seeding follows attempt inventory and respects newer cached attempts', async t => {
  const output = mkdtempSync(join(tmpdir(), 'balloon-seed-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const manifest = { schemaVersion: 1, generatedAt: '2026-10-25T12:00:00Z', sites: [
    { slug: 'absent', ok: true, absent: true }, { slug: 'retained', ok: false, error: 'Timeout' },
  ] };
  const asked = [], payload = { schemaVersion: 1, generatedAt: '2026-10-25T00:00:00Z', site: { slug: 'retained' }, soundings: [] };
  const files = await collectGroup('observations', { sites: [{ slug: 'not-covered' }], get: async key => {
    asked.push(key);
    return key === 'raob/manifest.json' ? manifest : key === 'raob/sites/retained.json' ? payload : null;
  } });
  assert.deepEqual(asked.filter(key => key.startsWith('raob/')), ['raob/manifest.json', 'raob/sites/retained.json']);
  mkdirSync(join(output, 'raob/sites'), { recursive: true });
  writeFileSync(join(output, 'raob/sites/absent.json'), JSON.stringify(payload));
  applyGroup(output, 'observations', files);
  assert.equal(existsSync(join(output, 'raob/sites/absent.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'raob/sites/retained.json'))), payload);
  const current = readFileSync(join(output, 'raob/manifest.json'));
  applyGroup(output, 'observations', new Map([
    ['raob/manifest.json', { ...manifest, generatedAt: '2026-10-25T06:00:00Z', sites: [{ slug: 'retained', ok: true, absent: true }] }],
  ]));
  assert.deepEqual(readFileSync(join(output, 'raob/manifest.json')), current);
  assert.equal(existsSync(join(output, 'raob/sites/retained.json')), true);
});

test('a legacy balloon seed cannot resurrect flights or replace payloads after a newer recorded attempt', async t => {
  const output = mkdtempSync(join(tmpdir(), 'balloon-legacy-seed-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  mkdirSync(join(output, 'raob/sites'), { recursive: true });
  const manifest = { schemaVersion: 1, generatedAt: '2026-10-25T12:00:00Z', sites: [
    { slug: 'absent', ok: true, absent: true }, { slug: 'retained', ok: false, error: 'Timeout', retained: true },
  ] };
  const retained = { schemaVersion: 1, generatedAt: '2026-10-25T06:00:00Z', site: { slug: 'retained' }, soundings: [] };
  writeFileSync(join(output, 'raob/manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(output, 'raob/sites/retained.json'), JSON.stringify(retained));
  const legacy = slug => ({ schemaVersion: 1, generatedAt: '2026-10-25T00:00:00Z', site: { slug }, soundings: [] });
  const files = await collectGroup('observations', { sites: manifest.sites.map(({ slug }) => ({ slug })), get: async key => {
    if (key === 'nws/manifest.json') return { schemaVersion: 1, generatedAt: '2026-10-25T13:00:00Z', sites: [], offices: [] };
    if (key.startsWith('raob/sites/')) return legacy(key.split('/').at(-1).slice(0, -5));
    return null; // The lagging publication predates RAOB manifests.
  } });
  assert.equal(files.has('raob/manifest.json'), false);
  applyGroup(output, 'observations', files);
  assert.equal(existsSync(join(output, 'raob/sites/absent.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'raob/sites/retained.json'))), retained);
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'raob/manifest.json'))), manifest);
  assert.equal(existsSync(join(output, 'nws/manifest.json')), true, 'unrelated observation products still seed');
  const emptyCache = join(output, 'empty-cache');
  applyGroup(emptyCache, 'observations', files);
  assert.deepEqual(JSON.parse(readFileSync(join(emptyCache, 'raob/sites/absent.json'))), legacy('absent'), 'legacy publications still seed a cache with no newer attempt');
});

test("--list prints that group's model slugs", () => {
  const listed = spawnSync(process.execPath, [script, "--list", "noaa-cloud"], { encoding: "utf8" });
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout, "hrrr-conus gfs\n");
  const dwd = spawnSync(process.execPath, [script, "--list", "dwd"], { encoding: "utf8" });
  assert.equal(dwd.status, 0);
  assert.equal(dwd.stdout, "icon-eu\n");
  const missing = spawnSync(process.execPath, [script, "--list", "nope"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
});

test("applyGroup replaces a model directory and leaves an unfetched model", () => {
  const output = mkdtempSync(join(tmpdir(), "seed-"));
  mkdirSync(join(output, "hrrr-conus", "sites"), { recursive: true });
  mkdirSync(join(output, "gfs"), { recursive: true });
  writeFileSync(join(output, "hrrr-conus", "sites", "old.json"), "{}\n");
  writeFileSync(join(output, "gfs", "manifest.json"), "{}\n");
  applyGroup(output, "noaa-cloud", new Map([
    ["hrrr-conus/manifest.json", { model: "hrrr-conus" }],
    ["hrrr-conus/sites/va-daniels.json", { slug: "va-daniels" }],
  ]));
  assert.equal(readFileSync(join(output, "hrrr-conus", "sites", "va-daniels.json"), "utf8").includes("va-daniels"), true);
  assert.equal(readFileSync(join(output, "gfs", "manifest.json"), "utf8"), "{}\n");
  assert.throws(() => readFileSync(join(output, "hrrr-conus", "sites", "old.json")));
  assert.equal(groupHasLocal(output, "noaa-cloud"), true);
});

function soaringDocuments(version, model = 'rrfs', region = 'north', compressed = false) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const caseId = `${region}-${model}-live`;
  const bundle = `bundles/${hash(version)}`;
  const root = `soaring/v1/${caseId}/${bundle}`;
  // Whitespace is intentionally significant: reserializing invalidates hashes.
  const profileText = Buffer.from(`{ "version": "${version}" }\n`);
  const profile = compressed ? gzipSync(profileText, { level: 1 }) : profileText;
  const profileName = compressed ? 'cell-0.json.gz' : 'profile.json';
  const manifest = Buffer.from(JSON.stringify({ case: { id: caseId }, files: { [profileName]: hash(profile) } }, null, 2));
  const index = Buffer.from(JSON.stringify({ bundle, manifestSha256: hash(manifest) }, null, 2));
  const regions = Buffer.from(JSON.stringify({ regions: [{ id: region, nativeModels: [{ model, caseId }] }] }, null, 2));
  return new Map([
    ['soaring/v1/regions.json', regions],
    [`soaring/v1/regions-${model}.json`, regions],
    [`soaring/v1/${caseId}/index.json`, index],
    [`${root}/manifest.json`, manifest],
    [`${root}/${profileName}`, profile],
  ]);
}

function datedSoaringDocuments(version, referenceTime, capturedAt = referenceTime) {
  const files = soaringDocuments(version);
  const manifestKey = [...files.keys()].find(key => key.endsWith('/manifest.json'));
  const manifest = JSON.parse(files.get(manifestKey));
  manifest.case.referenceTime = referenceTime;
  manifest.capturedAt = capturedAt;
  const bytes = Buffer.from(JSON.stringify(manifest));
  files.set(manifestKey, bytes);
  const pointerKey = 'soaring/v1/north-rrfs-live/index.json';
  const pointer = JSON.parse(files.get(pointerKey));
  pointer.manifestSha256 = createHash('sha256').update(bytes).digest('hex');
  files.set(pointerKey, Buffer.from(JSON.stringify(pointer)));
  for (const name of ['regions.json', 'regions-rrfs.json']) {
    const key = `soaring/v1/${name}`, catalogue = JSON.parse(files.get(key));
    catalogue.generatedAt = capturedAt;
    files.set(key, Buffer.from(JSON.stringify(catalogue)));
  }
  return files;
}

test('lagging remote regional pointers and catalogues cannot replace a newer cached publication', async t => {
  const output = mkdtempSync(join(tmpdir(), 'seed-soaring-monotonic-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const latest = datedSoaringDocuments('latest', '2026-10-25T12:00:00Z', '2026-10-25T16:00:00Z');
  applyGroup(output, 'soaring', latest);
  for (const [run, captured] of [['2026-10-25T06:00:00Z', '2026-10-25T10:00:00Z'], ['2026-10-25T12:00:00Z', '2026-10-25T15:00:00Z']]) {
    const remote = datedSoaringDocuments(captured, run, captured);
    await seedPublishedGroup(output, 'soaring', { getBytes: async key => remote.get(key) ?? null });
    for (const key of ['soaring/v1/north-rrfs-live/index.json', 'soaring/v1/regions.json', 'soaring/v1/regions-rrfs.json']) assert.deepEqual(readFileSync(join(output, key)), latest.get(key));
    assert.equal(isPublishedCase(join(output, 'soaring/v1'), 'north-rrfs-live'), true);
  }
});

test('same-run verified regional bytes repair corruption without changing the run pointer', async t => {
  const output = mkdtempSync(join(tmpdir(), 'seed-soaring-repair-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const documents = datedSoaringDocuments('repair', '2026-10-25T12:00:00Z', '2026-10-25T16:00:00Z');
  applyGroup(output, 'soaring', documents);
  const profile = [...documents.keys()].find(key => key.endsWith('/profile.json'));
  writeFileSync(join(output, profile), 'corrupt');
  assert.equal(isPublishedCase(join(output, 'soaring/v1'), 'north-rrfs-live'), false);
  await seedPublishedGroup(output, 'soaring', { getBytes: async key => documents.get(key) ?? null });
  assert.equal(isPublishedCase(join(output, 'soaring/v1'), 'north-rrfs-live'), true);
  assert.deepEqual(readFileSync(join(output, profile)), documents.get(profile));
});

test('soaring seed preserves hashed bytes and follows native RRFS pointers', async t => {
  const output = mkdtempSync(join(tmpdir(), 'seed-soaring-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const docs = soaringDocuments('new');
  const files = await collectGroup('soaring', { getBytes: async key => docs.get(key) ?? null });
  applyGroup(output, 'soaring', files);
  for (const [key, bytes] of docs) assert.deepEqual(readFileSync(join(output, key)), bytes);
  assert.equal(isPublishedCase(join(output, 'soaring', 'v1'), 'north-rrfs-live'), true);
  assert.equal(groupHasLocal(output, 'soaring'), true);
});

test('old CDN catalogues cannot reseed retired grids or advertise their pointers', async () => {
  const docs = soaringDocuments('current', 'icon-eu', 'armenia', true), asked = [];
  const retired = [
    { id: 'north-sound', caseId: 'north-sound-20261021-00z-live', nativeModels: [{ model: 'rrfs', caseId: 'north-sound-20261021-00z-rrfs-live' }] },
    { id: 'shenandoah-blue-ridge', caseId: 'shenandoah-blue-ridge-20261021-00z-live' },
  ];
  for (const key of ['soaring/v1/regions.json', 'soaring/v1/regions-icon-eu.json']) {
    const catalogue = JSON.parse(docs.get(key));
    docs.set(key, Buffer.from(JSON.stringify({ ...catalogue, trialRegionId: 'north-sound', regions: [...retired, ...catalogue.regions] })));
  }
  const files = await collectGroup('soaring', { getBytes: async key => { asked.push(key); return docs.get(key) ?? null; } });
  assert.equal(asked.some(key => /\/north-sound|\/shenandoah/.test(key)), false, 'retired bytes need not exist for a complete seed');
  assert.equal(files.has('soaring/v1/armenia-icon-eu-live/index.json'), true);
  const catalogue = JSON.parse(files.get('soaring/v1/regions.json'));
  assert.deepEqual(catalogue.regions.map(region => region.id), ['armenia']);
  assert.equal(catalogue.trialRegionId, 'armenia');
});

test('soaring seed reuses only hash-verified immutable bytes and always refreshes pointers and catalogues', async () => {
  const docs = soaringDocuments('cached', 'icon-eu', 'armenia', true);
  const asked = [], cacheAsked = [];
  const files = await collectGroup('soaring', {
    getBytes: async key => { asked.push(key); return docs.get(key) ?? null; },
    getCachedBytes: async key => { cacheAsked.push(key); return docs.get(key) ?? null; },
  });
  assert.ok(asked.includes('soaring/v1/regions.json'));
  assert.ok(asked.includes('soaring/v1/regions-icon-eu.json'));
  assert.ok(asked.includes('soaring/v1/armenia-icon-eu-live/index.json'));
  assert.equal(asked.some(key => key.includes('/bundles/')), false, 'matching bundle needs no network transfer');
  assert.equal(cacheAsked.length, 2, 'only the immutable manifest and cell shard use the cache');
  for (const [key, bytes] of docs) assert.deepEqual(files.get(key), bytes);
});

test('soaring seed refetches missing, corrupted and obsolete cache entries without accepting stale content', async () => {
  const fresh = soaringDocuments('fresh', 'icon-eu', 'armenia', true);
  const old = soaringDocuments('old', 'icon-eu', 'armenia', true);
  for (const mode of ['missing', 'corrupt', 'old']) {
    const asked = [];
    const files = await collectGroup('soaring', {
      getBytes: async key => { asked.push(key); return fresh.get(key) ?? null; },
      getCachedBytes: async key => mode === 'missing' ? null : mode === 'corrupt' ? Buffer.from('corrupt') : old.get(key) ?? null,
    });
    assert.equal(asked.filter(key => key.includes('/bundles/')).length, 2, mode);
    for (const [key, bytes] of fresh) assert.deepEqual(files.get(key), bytes);
  }
  await assert.rejects(collectGroup('soaring', {
    getBytes: async key => key.endsWith('.gz') ? Buffer.from('corrupt source') : fresh.get(key) ?? null,
    getCachedBytes: async () => Buffer.from('corrupt cache'),
  }), /incorrect header check|corrupt soaring bundle/);
});

test('DWD seed requires every profile from the manifest to use the same ICON run', async () => {
  const referenceTime = '2026-10-24T00:00:00Z';
  const docs = {
    'icon-eu/manifest.json': { model: 'icon-eu', referenceTime, sites: [{ slug: 'am-hatis-500' }] },
    'icon-eu/sites/am-hatis-500.json': { run: { referenceTime } },
  };
  const get = async key => docs[key] ?? null;
  assert.equal((await collectGroup('dwd', { get })).size, 2);
  docs['icon-eu/source.json'] = { grid: { uuid: 'native-grid' }, provenance: { provider: 'DWD' } };
  assert.deepEqual((await collectGroup('dwd', { get })).get('icon-eu/source.json'), docs['icon-eu/source.json']);
  docs['icon-eu/sites/am-hatis-500.json'].run.referenceTime = '2026-10-23T18:00:00Z';
  await assert.rejects(collectGroup('dwd', { get }), /Incomplete published ICON-EU run/);
  delete docs['icon-eu/sites/am-hatis-500.json'];
  await assert.rejects(collectGroup('dwd', { get }), /Incomplete published ICON-EU run/);
});

test('compressed ICON seed verifies uncompressed JSON while preserving exact compressed bytes', async t => {
  const output = mkdtempSync(join(tmpdir(), 'seed-soaring-icon-gzip-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const docs = soaringDocuments('compressed', 'icon-eu', 'armenia', true);
  const files = await collectGroup('soaring', { getBytes: async key => docs.get(key) ?? null });
  applyGroup(output, 'soaring', files);
  for (const [key, bytes] of docs) assert.deepEqual(readFileSync(join(output, key)), bytes);
  assert.equal(isPublishedCase(join(output, 'soaring/v1'), 'armenia-icon-eu-live'), true);
  const legacy = new Map([...docs].map(([key, bytes]) => [key, JSON.parse((key.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'))]));
  const manifestKey = [...legacy.keys()].find(key => key.endsWith('/manifest.json'));
  legacy.get('soaring/v1/armenia-icon-eu-live/index.json').manifestSha256 = createHash('sha256').update(JSON.stringify(legacy.get(manifestKey)) + '\n').digest('hex');
  await assert.rejects(collectGroup('soaring', { get: async key => legacy.get(key) ?? null }), /getBytes is required/);
  for (const corrupt of [Buffer.from('broken gzip'), gzipSync(Buffer.from('{"version":"changed"}\n'))]) {
    const invalid = new Map(docs), key = [...docs.keys()].find(key => key.endsWith('.gz'));
    invalid.set(key, corrupt);
    await assert.rejects(async () => applyGroup(output, 'soaring', await collectGroup('soaring', {
      getBytes: async file => invalid.get(file) ?? null,
    })));
    for (const [file, bytes] of docs) assert.deepEqual(readFileSync(join(output, file)), bytes);
  }
});

test('soaring seed retains ICON-only regional bundles before a combined index exists', async t => {
  const output = mkdtempSync(join(tmpdir(), 'seed-soaring-icon-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const docs = soaringDocuments('new', 'icon-eu', 'armenia');
  docs.delete('soaring/v1/regions.json');
  const files = await collectGroup('soaring', { getBytes: async key => docs.get(key) ?? null });
  applyGroup(output, 'soaring', files);
  for (const [key, bytes] of docs) assert.deepEqual(readFileSync(join(output, key)), bytes);
  assert.equal(isPublishedCase(join(output, 'soaring', 'v1'), 'armenia-icon-eu-live'), true);
  assert.equal(groupHasLocal(output, 'soaring'), true);
});

test('incomplete or corrupted soaring seeds leave last-good pointers and catalogues intact', async t => {
  const output = mkdtempSync(join(tmpdir(), 'seed-soaring-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const old = soaringDocuments('old');
  applyGroup(output, 'soaring', old);
  for (const mode of ['missing-file', 'corrupt-file', 'corrupt-manifest', 'missing-pointer']) {
    const docs = soaringDocuments('new');
    const profileKey = [...docs.keys()].find(key => key.endsWith('/profile.json'));
    const manifestKey = [...docs.keys()].find(key => key.endsWith('/manifest.json'));
    if (mode === 'missing-file') docs.delete(profileKey);
    if (mode === 'corrupt-file') docs.set(profileKey, Buffer.from('{}'));
    if (mode === 'corrupt-manifest') docs.set(manifestKey, Buffer.from('{}'));
    if (mode === 'missing-pointer') docs.delete('soaring/v1/north-rrfs-live/index.json');
    await assert.rejects(async () => {
      const files = await collectGroup('soaring', { getBytes: async key => docs.get(key) ?? null });
      applyGroup(output, 'soaring', files);
    }, /Incomplete|corrupt|Missing/);
    for (const [key, bytes] of old) assert.deepEqual(readFileSync(join(output, key)), bytes);
    assert.equal(isPublishedCase(join(output, 'soaring', 'v1'), 'north-rrfs-live'), true);
  }
});

// Synthetic horizons reuse a real scalar column to exercise publication identity
// and completeness. These documents are never meteorological reference fixtures.
function pointDocuments(model, referenceTime = '2026-10-24T00:00:00Z') {
  const document = JSON.parse(readFileSync(new URL('../soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
  const sample = document.hours[0], leads = modelDescriptor(model).forecastHours;
  document.model = model;
  document.run.referenceTime = referenceTime;
  document.hours = leads.map(lead => ({ ...sample, validAt: new Date(Date.parse(referenceTime) + lead * 3_600_000).toISOString() }));
  const manifest = { model, referenceTime, forecastHours: leads.length, firstForecastHour: leads[0], lastForecastHour: leads.at(-1), sites: [{ slug: document.site.id }] };
  return new Map([[`${model}/manifest.json`, manifest], [`${model}/sites/${document.site.id}.json`, document]]);
}

test('seed CLI core applies a healthy model after another model fails and withholds invalid cache', async t => {
  const output = mkdtempSync(join(tmpdir(), 'seed-independent-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  mkdirSync(join(output, 'hrrr-conus'), { recursive: true });
  writeFileSync(join(output, 'hrrr-conus/manifest.json'), '{}');
  const docs = pointDocuments('gfs');
  const result = await seedPublishedGroup(output, 'noaa-cloud', {
    get: async key => { if (key.startsWith('hrrr-conus/')) throw new Error('HRRR published origin offline'); return docs.get(key) ?? null; },
  });
  assert.deepEqual(result.outcomes.map(outcome => outcome.status), ['unavailable', 'seeded']);
  assert.equal(existsSync(join(output, 'hrrr-conus')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'gfs/manifest.json'))), docs.get('gfs/manifest.json'));
});

test('per-model seeding retains only a validated complete cache when its published feed fails', async t => {
  const output = mkdtempSync(join(tmpdir(), 'seed-last-good-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  applyGroup(output, 'noaa-cloud', pointDocuments('hrrr-conus'));
  const before = readFileSync(join(output, 'hrrr-conus/manifest.json'));
  const result = await seedPublishedGroup(output, 'noaa-cloud', { get: async () => { throw new Error('offline'); } });
  assert.deepEqual(result.outcomes.map(outcome => outcome.status), ['retained', 'unavailable']);
  assert.deepEqual(readFileSync(join(output, 'hrrr-conus/manifest.json')), before);
});

test('self-consistent shortened published runs cannot displace full cache or stop another model seeding', async t => {
  const output = mkdtempSync(join(tmpdir(), 'seed-short-run-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const cached = pointDocuments('hrrr-conus');
  applyGroup(output, 'noaa-cloud', cached);
  const docs = new Map([...pointDocuments('hrrr-conus'), ...pointDocuments('gfs')]);
  const manifest = docs.get('hrrr-conus/manifest.json');
  manifest.forecastHours = 1; manifest.lastForecastHour = 1;
  docs.get(`hrrr-conus/sites/${manifest.sites[0].slug}.json`).hours.length = 1;
  const result = await seedPublishedGroup(output, 'noaa-cloud', { get: async key => docs.get(key) ?? null });
  assert.deepEqual(result.outcomes.map(outcome => outcome.status), ['retained', 'seeded']);
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'hrrr-conus/manifest.json'))), cached.get('hrrr-conus/manifest.json'));
});

test('older remote pointers preserve a newer complete cached run', async t => {
  const output = mkdtempSync(join(tmpdir(), 'seed-newer-cache-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const cached = pointDocuments('hrrr-conus', '2026-10-24T06:00:00Z');
  applyGroup(output, 'noaa-cloud', cached);
  const old = pointDocuments('hrrr-conus');
  const result = await seedPublishedGroup(output, 'noaa-cloud', { get: async key => old.get(key) ?? null });
  assert.deepEqual(result.outcomes.map(outcome => outcome.status), ['retained', 'absent']);
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'hrrr-conus/manifest.json'))), cached.get('hrrr-conus/manifest.json'));
});
