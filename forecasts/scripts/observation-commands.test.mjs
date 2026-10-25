import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mergeArtifacts } from './merge-artifacts.mjs';

const forecastRoot = fileURLToPath(new URL('..', import.meta.url));
const site = { slug: 'id-test-boise', name: 'Test Boise', latitude: 43.62332, longitude: -115.98076, timeZone: 'America/Boise' };
const oldTime = '2026-10-24T00:00:00Z';
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
function workspace(t, fetchSource) {
  const root = mkdtempSync(join(tmpdir(), 'observation-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(join(root, 'sites.json'), { schemaVersion: 2, sites: [site] });
  writeFileSync(join(root, 'fetch.mjs'), fetchSource);
  return { root, run(source, output, store) {
    return spawnSync(process.execPath, ['--import', join(root, 'fetch.mjs'), `scripts/${source}.mjs`, '--sites', join(root, 'sites.json'), '--output', output, ...(store ? ['--publish'] : [])], {
      cwd: forecastRoot, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...(store ? { WINDGRAMS_STORE: 'file', WINDGRAMS_DATA_DIR: store } : {}) },
    });
  } };
}

for (const product of ['nws', 'ecmwf']) test(`${product} total request failure publishes the failed attempt and retains prior payload bytes`, t => {
  const work = workspace(t, 'globalThis.fetch = async () => new Response("Forbidden", { status: 403 });');
  const source = join(work.root, 'incoming/data-observations'), output = join(work.root, 'published');
  const manifest = { schemaVersion: 1, generatedAt: oldTime, sites: [{ slug: site.slug, ok: true }], ...(product === 'nws' ? { offices: [] } : {}) };
  const document = { schemaVersion: 1, generatedAt: oldTime, site, hours: [{ validAt: oldTime }] };
  for (const root of [source, output]) {
    write(join(root, product, 'manifest.json'), manifest);
    write(join(root, product, `sites/${site.slug}.json`), document);
  }
  const previous = readFileSync(join(output, product, `sites/${site.slug}.json`));
  const result = work.run(product, source);
  assert.equal(result.status, 1, result.stderr);
  const attempt = JSON.parse(readFileSync(join(source, product, 'manifest.json')));
  assert.ok(Date.parse(attempt.generatedAt) > Date.parse(oldTime));
  assert.equal(attempt.sites[0].ok, false);
  assert.match(attempt.sites[0].error, /403/);
  const merged = mergeArtifacts(join(work.root, 'incoming'), output, { sites: [site] });
  assert.deepEqual(merged.rejected, []);
  assert.deepEqual(readFileSync(join(output, product, `sites/${site.slug}.json`)), previous);
  const published = JSON.parse(readFileSync(join(output, product, 'manifest.json')));
  assert.equal(published.sites[0].ok, false);
  assert.equal(published.sites[0].retained, true);
});

test('RAOB reports request errors while legitimate absent flights remain successful', t => {
  for (const status of [403, 404]) {
    const work = workspace(t, `globalThis.fetch = async () => new Response('', { status: ${status} });`);
    const output = join(work.root, 'data'), path = join(output, `raob/sites/${site.slug}.json`);
    write(path, { schemaVersion: 1, generatedAt: oldTime, site, soundings: [] });
    const previous = readFileSync(path), result = work.run('raob', output);
    assert.equal(result.status, status === 403 ? 1 : 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(output, 'raob/manifest.json')));
    assert.equal(manifest.sites[0].ok, status === 404);
    if (status === 403) {
      assert.deepEqual(readFileSync(path), previous);
      assert.match(result.stderr, /answered 403/);
    } else {
      assert.equal(manifest.sites[0].absent, true);
      assert.deepEqual(JSON.parse(readFileSync(path)).soundings, []);
      assert.doesNotMatch(result.stderr, /answered 404/);
    }
  }
});

test('RAOB publishes confirmed absence to a separate store while failed requests preserve its old flight', t => {
  for (const status of [403, 404]) {
    const work = workspace(t, `globalThis.fetch = async () => new Response('', { status: ${status} });`);
    const output = join(work.root, 'output'), store = join(work.root, 'store');
    const key = `raob/sites/${site.slug}.json`, path = join(store, key);
    write(path, { schemaVersion: 1, generatedAt: oldTime, site, soundings: [{ validAt: oldTime, levels: [] }] });
    const previous = readFileSync(path), result = work.run('raob', output, store);
    assert.equal(result.status, status === 403 ? 1 : 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(store, 'raob/manifest.json')));
    assert.equal(manifest.sites[0].ok, status === 404);
    if (status === 403) assert.deepEqual(readFileSync(path), previous);
    else {
      const document = JSON.parse(readFileSync(path));
      assert.equal(manifest.sites[0].absent, true);
      assert.equal(document.site.slug, site.slug);
      assert.equal(document.station.elevationM, null);
      assert.deepEqual(document.soundings, []);
      assert.ok(Date.parse(document.generatedAt) > Date.parse(oldTime));
      assert.deepEqual(readFileSync(path), readFileSync(join(output, key)));
    }
  }
});

test('RAOB finishes other flight requests and retains usable results after a request error', t => {
  const work = workspace(t, `let calls = 0;
    const profile = Array.from({ length: 15 }, (_, i) => ({ pres: 910 - i * 20, hght: 874 + i * 200, tmpc: 10 - i, dwpc: -i, drct: 330, sknt: 10 }));
    globalThis.fetch = async () => ++calls === 1 ? new Response('', { status: 403 }) : Response.json({ profiles: [{ profile }] });`);
  const output = join(work.root, 'data'), result = work.run('raob', output);
  assert.equal(result.status, 1, result.stderr);
  const document = JSON.parse(readFileSync(join(output, `raob/sites/${site.slug}.json`)));
  assert.equal(document.soundings.length, 2);
  assert.equal(document.soundings[0].levels.length, 15);
});
