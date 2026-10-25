import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeArtifacts } from './merge-artifacts.mjs';

const oldTime = '2026-10-25T06:00:00Z', newTime = '2026-10-25T12:00:00Z';
const read = path => JSON.parse(readFileSync(path));
function write(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value)}\n`); }
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'observation-publication-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { source: join(root, 'incoming/data-observations'), incoming: join(root, 'incoming'), output: join(root, 'data') };
}
function site(root, product, slug, generatedAt, office = 'SEW') {
  write(join(root, product, 'sites', `${slug}.json`), { schemaVersion: 1, generatedAt, updateTime: generatedAt,
    site: { slug }, grid: { office }, hours: [{ validAt: generatedAt }] });
}
function manifest(root, product, generatedAt, sites, offices = []) {
  write(join(root, product, 'manifest.json'), { schemaVersion: 1, generatedAt, sites, ...(product === 'nws' ? { offices } : {}) });
}
function office(root, code, generatedAt) {
  write(join(root, 'nws/offices', `${code}.json`), { schemaVersion: 1, office: code, generatedAt,
    products: { afd: { issuanceTime: generatedAt, text: `Forecast issued ${generatedAt}` }, srg: null } });
}

for (const product of ['nws', 'ecmwf']) test(`${product} partial refresh updates healthy sites and preserves failed payload bytes and timestamps`, t => {
  const { source, incoming, output } = workspace(t);
  for (const slug of ['healthy', 'failed']) site(output, product, slug, oldTime);
  manifest(output, product, oldTime, [{ slug: 'healthy', ok: true }, { slug: 'failed', ok: true }]);
  site(source, product, 'healthy', newTime);
  manifest(source, product, newTime, [{ slug: 'healthy', ok: true }, { slug: 'failed', ok: false, error: 'Source unavailable' }]);
  const failedPath = join(output, product, 'sites/failed.json'), original = readFileSync(failedPath);
  const dryRun = mergeArtifacts(incoming, output, { sites: [], dryRun: true });
  assert.equal(read(join(output, product, 'sites/healthy.json')).generatedAt, oldTime);
  const report = mergeArtifacts(incoming, output, { sites: [] });
  assert.deepEqual(report, dryRun); assert.deepEqual(report.rejected, []); assert.ok(report.accepted.includes(product));
  assert.equal(read(join(output, product, 'sites/healthy.json')).generatedAt, newTime);
  assert.deepEqual(readFileSync(failedPath), original);
  const result = read(join(output, product, 'manifest.json'));
  assert.equal(result.generatedAt, newTime);
  assert.deepEqual(result.sites[1], { slug: 'failed', ok: false, error: 'Source unavailable', retained: true });
  assert.equal(read(failedPath).updateTime, oldTime);
});

test('NWS retains failed-site office products and issuance times alongside healthy incoming offices', t => {
  const { source, incoming, output } = workspace(t);
  site(output, 'nws', 'failed', oldTime, 'SEW'); office(output, 'SEW', oldTime);
  manifest(output, 'nws', oldTime, [{ slug: 'failed', ok: true }], [{ office: 'SEW', afdIssuanceTime: oldTime, srgIssuanceTime: null }]);
  site(source, 'nws', 'healthy', newTime, 'LWX'); office(source, 'LWX', newTime);
  manifest(source, 'nws', newTime, [{ slug: 'healthy', ok: true }, { slug: 'failed', ok: false, error: 'Timeout' }], [{ office: 'LWX' }]);
  const path = join(output, 'nws/offices/SEW.json'), original = readFileSync(path);
  assert.deepEqual(mergeArtifacts(incoming, output, { sites: [] }).rejected, []);
  assert.deepEqual(readFileSync(path), original);
  assert.equal(read(join(output, 'nws/offices/LWX.json')).generatedAt, newTime);
  assert.deepEqual(read(join(output, 'nws/manifest.json')).offices, [
    { office: 'LWX', afdIssuanceTime: newTime, srgIssuanceTime: null },
    { office: 'SEW', afdIssuanceTime: oldTime, srgIssuanceTime: null },
  ]);
});

test('failed entries use seeded last-good bytes only when available and never roll newer cached payloads back', t => {
  const { source, incoming, output } = workspace(t);
  site(output, 'ecmwf', 'cached', oldTime); site(source, 'ecmwf', 'cached', '2026-10-25T00:00:00Z');
  site(source, 'ecmwf', 'seeded', oldTime);
  manifest(source, 'ecmwf', newTime, ['cached', 'seeded', 'absent'].map(slug => ({ slug, ok: false, error: 'Timeout', retained: true })));
  assert.deepEqual(mergeArtifacts(incoming, output, { sites: [] }).rejected, []);
  assert.equal(read(join(output, 'ecmwf/sites/cached.json')).generatedAt, oldTime);
  assert.deepEqual(readFileSync(join(output, 'ecmwf/sites/seeded.json')), readFileSync(join(source, 'ecmwf/sites/seeded.json')));
  assert.equal(existsSync(join(output, 'ecmwf/sites/absent.json')), false);
  assert.deepEqual(read(join(output, 'ecmwf/manifest.json')).sites[2], { slug: 'absent', ok: false, error: 'Timeout' });
});

test('invalid failed slugs, duplicate inventory, and missing healthy payloads leave the publication untouched', t => {
  for (const sites of [
    [{ slug: '../escape', ok: false }],
    [{ slug: 'healthy', ok: true }, { slug: 'healthy', ok: false }],
    [{ slug: 'healthy', ok: true }, { slug: 'missing', ok: true }],
  ]) {
    const { source, incoming, output } = workspace(t);
    site(output, 'ecmwf', 'healthy', oldTime); manifest(output, 'ecmwf', oldTime, [{ slug: 'healthy', ok: true }]);
    site(source, 'ecmwf', 'healthy', newTime); manifest(source, 'ecmwf', newTime, sites);
    const path = join(output, 'ecmwf/sites/healthy.json'), original = readFileSync(path);
    assert.equal(mergeArtifacts(incoming, output, { sites: [] }).rejected[0].product, 'ecmwf');
    assert.deepEqual(readFileSync(path), original);
    assert.equal(read(join(output, 'ecmwf/manifest.json')).generatedAt, oldTime);
  }
});

test('balloon publication preserves failed observations but removes a confirmed absent flight', t => {
  for (const absent of [false, true]) {
    const { source, incoming, output } = workspace(t);
    const payloadPath = join(output, 'raob/sites/boise.json');
    write(payloadPath, { schemaVersion: 1, generatedAt: oldTime, site: { slug: 'boise' }, soundings: [{ validAt: oldTime, levels: [] }] });
    const original = readFileSync(payloadPath);
    manifest(output, 'raob', oldTime, [{ slug: 'boise', ok: true, absent: false }]);
    manifest(source, 'raob', newTime, [{ slug: 'boise', ...(absent ? { ok: true, absent: true } : { ok: false, error: 'HTTP 503' }) }]);
    const report = mergeArtifacts(incoming, output, { sites: [] });
    assert.deepEqual(report.rejected, []);
    assert.ok(report.accepted.includes('raob'));
    if (absent) assert.equal(existsSync(payloadPath), false);
    else assert.deepEqual(readFileSync(payloadPath), original);
    assert.deepEqual(read(join(output, 'raob/manifest.json')).sites[0], absent
      ? { slug: 'boise', ok: true, absent: true }
      : { slug: 'boise', ok: false, error: 'HTTP 503', retained: true });
  }
});

test('balloon publication rejects contradictory absence and invalid sounding payloads', t => {
  for (const row of [{ slug: 'boise', ok: false, absent: true, error: 'Timeout' }, { slug: 'boise', ok: true, absent: false }]) {
    const { source, incoming, output } = workspace(t);
    manifest(source, 'raob', newTime, [row]);
    write(join(source, 'raob/sites/boise.json'), { schemaVersion: 1, generatedAt: newTime, site: { slug: 'boise' } });
    assert.equal(mergeArtifacts(incoming, output, { sites: [] }).rejected[0].product, 'raob');
  }
});

test('an older legacy balloon artifact cannot resurrect a subsequently confirmed absent flight', t => {
  const { source, incoming, output } = workspace(t);
  manifest(output, 'raob', newTime, [{ slug: 'boise', ok: true, absent: true }]);
  write(join(source, 'raob/sites/boise.json'), { schemaVersion: 1, generatedAt: oldTime, site: { slug: 'boise' }, soundings: [] });
  const report = mergeArtifacts(incoming, output, { sites: [] });
  assert.deepEqual(report.rejected, []);
  assert.equal(existsSync(join(output, 'raob/sites/boise.json')), false);
  assert.equal(read(join(output, 'raob/manifest.json')).generatedAt, newTime);
});
