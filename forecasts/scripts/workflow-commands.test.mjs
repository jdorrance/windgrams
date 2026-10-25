import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packSlice } from './pack-slice.mjs';
import { mergeArtifacts } from './merge-artifacts.mjs';
import { runObservations } from './run-observations.mjs';
import { runBoundedProbe, smokeArguments, smokeCatalogue } from './live-smoke.mjs';
import { checkEngines } from './check-engines.mjs';
import { selectModels } from '@windgrams/providers/registry';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'windgrams-workflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('packing replaces old slices and marks an empty provider without publishing stale paths', t => {
  const root = workspace(t), source = join(root, 'data'), output = join(root, 'slice');
  mkdirSync(join(source, 'nws'), { recursive: true });
  writeFileSync(join(source, 'nws', 'manifest.json'), 'new');
  assert.equal(packSlice(output, ['nws', 'missing'], source), 1);
  assert.equal(readFileSync(join(output, 'nws', 'manifest.json'), 'utf8'), 'new');
  assert.equal(packSlice(output, ['missing'], source), 0);
  assert.deepEqual(readdirSync(output), ['EMPTY']);
  assert.throws(() => packSlice(source, ['nws'], source), /separate directories/);
  assert.throws(() => packSlice(output, ['../elsewhere'], source), /Invalid artifact path/);
  symlinkSync(output, join(source, 'aliased-output'), 'dir');
  assert.throws(() => packSlice(output, ['aliased-output'], source), /separate directories/);
  assert.deepEqual(readdirSync(output), ['EMPTY']);
  assert.ok(existsSync(join(source, 'nws', 'manifest.json')));
});

test('flat and nested artifacts reject incomplete models and preserve untouched providers', t => {
  const root = workspace(t), incoming = join(root, 'incoming'), output = join(root, 'data');
  for (const path of ['data-observations/nws', 'data-eccc/slice/gdps', 'data-empty']) mkdirSync(join(incoming, path), { recursive: true });
  mkdirSync(join(output, 'rrfs'), { recursive: true });
  writeFileSync(join(output, 'rrfs', 'manifest.json'), 'retained');
  const observation = JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-25T00:00:00Z', sites: [], offices: [] });
  writeFileSync(join(incoming, 'data-observations/nws/manifest.json'), observation);
  writeFileSync(join(incoming, 'data-eccc/slice/gdps/manifest.json'), 'incomplete');
  writeFileSync(join(incoming, 'data-empty/EMPTY'), 'empty');
  const report = mergeArtifacts(incoming, output);
  assert.deepEqual(report.accepted, ['nws']);
  assert.equal(report.rejected[0].product, 'gdps');
  assert.equal(readFileSync(join(output, 'rrfs/manifest.json'), 'utf8'), 'retained');
  assert.equal(existsSync(join(output, 'gdps')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'nws/manifest.json'), 'utf8')), JSON.parse(observation));
  assert.equal(existsSync(join(output, 'EMPTY')), false);
  assert.deepEqual(mergeArtifacts(join(root, 'missing'), output), { accepted: [], retained: [], rejected: [] });
});

test('packing rejects symlink aliases and new output beneath an aliased source before deleting files', t => {
  const root = workspace(t), source = join(root, 'data'), alias = join(root, 'alias');
  mkdirSync(join(source, 'nws'), { recursive: true });
  writeFileSync(join(source, 'nws', 'manifest.json'), 'retained');
  symlinkSync(source, alias, 'dir');
  for (const [output, input] of [[alias, source], [join(alias, 'new', 'slice'), source], [source, join(alias, 'nws')]]) {
    assert.throws(() => packSlice(output, ['nws'], input), /separate directories/);
    assert.equal(readFileSync(join(source, 'nws', 'manifest.json'), 'utf8'), 'retained');
  }
});

test('engine checks use registered processed-profile adapters and propagate process failure', () => {
  const calls = [];
  const expected = selectModels({ product: 'processed-profile' }).map(model => model.id);
  assert.deepEqual(checkEngines({ sites: 'launches.json', output: 'trial' }, (node, args) => {
    assert.equal(node, process.execPath);
    assert.ok(existsSync(args[0]));
    assert.deepEqual(args.slice(1), ['forecast', 'build', '--model', expected[calls.length], '--sites', 'launches.json', '--output', 'trial', '--dry-run']);
    calls.push(args);
    return { status: 0 };
  }), expected);
  assert.equal(calls.length, expected.length);
  for (const result of [{ status: 7 }, { status: null, signal: 'SIGTERM' }]) {
    let attempts = 0;
    assert.throws(() => checkEngines({}, () => { attempts++; return result; }), /engine check failed/);
    assert.equal(attempts, 1);
  }
  const failure = new Error('Could not start CLI');
  assert.throws(() => checkEngines({}, () => ({ error: failure })), error => error === failure);
});

test('observation failures wait for the other hosts and retain each outcome', async () => {
  const pending = new Map();
  let finished = false;
  const run = runObservations('data', source => new Promise((resolve, reject) => pending.set(source, { resolve, reject })))
    .then(result => { finished = true; return result; });
  assert.deepEqual([...pending.keys()], ['nws', 'ecmwf', 'raob']);
  pending.get('nws').reject(new Error('NWS unavailable'));
  pending.get('ecmwf').resolve();
  await Promise.resolve();
  assert.equal(finished, false);
  pending.get('raob').resolve();
  assert.deepEqual(await run, [{ source: 'nws', ok: false, error: 'NWS unavailable' }, { source: 'ecmwf', ok: true }, { source: 'raob', ok: true }]);
});

test('smoke probes select real representative launches and never request publication', () => {
  const source = JSON.parse(readFileSync(new URL('../sites.json', import.meta.url), 'utf8'));
  const selected = smokeCatalogue(source);
  assert.deepEqual(selected.sites.map(site => site.slug), ['wa-blanchard', 'va-woodstock', 'am-hatis-300']);
  assert.throws(() => smokeCatalogue({ ...source, sites: source.sites.filter(site => site.slug !== 'va-woodstock') }), /Missing smoke launch/);
  for (const probe of ['nws', 'ecmwf', 'raob', 'solar']) {
    const args = smokeArguments(probe, '/temporary');
    assert.equal(args.includes('--publish'), false);
    assert.ok(args.includes('/temporary/sites.json'));
  }
  assert.ok(smokeArguments('solar', '/temporary').includes('--ignore-areas'));
  assert.throws(() => smokeArguments('../unexpected', '/temporary'), /Unknown smoke probe/);
});

test('bounded probes propagate child failure and terminate a stalled service', () => {
  assert.doesNotThrow(() => runBoundedProbe(['--eval', 'process.exit(0)']));
  assert.throws(() => runBoundedProbe(['--eval', 'process.exit(7)']), /Probe failed/);
  assert.throws(() => runBoundedProbe(['--eval', 'setTimeout(() => {}, 5000)'], 50), error => error.code === 'ETIMEDOUT');
});
