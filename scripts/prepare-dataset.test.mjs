import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDataset } from './prepare-dataset.mjs';

test('dataset assembly compacts ordinary documents and preserves immutable bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dataset-delivery-'));
  try {
    const source = join(root, 'source'), output = join(root, 'output');
    const bundle = 'soaring/v1/example/bundles/hash/manifest.json';
    for (const path of ['gfs', 'soaring/v1/example/bundles/hash', 'solar', 'history']) mkdirSync(join(source, path), { recursive: true });
    const bytes = '{\n  "version": 1\n}\n';
    writeFileSync(join(source, 'gfs/manifest.json'), bytes);
    writeFileSync(join(source, bundle), bytes);
    writeFileSync(join(source, 'solar/private.json'), bytes);
    const report = prepareDataset(source, output);
    assert.equal(readFileSync(join(output, bundle), 'utf8'), bytes);
    assert.equal(readFileSync(join(output, 'gfs/manifest.json'), 'utf8'), '{"version":1}\n');
    assert.equal(readFileSync(join(source, 'gfs/manifest.json'), 'utf8'), bytes);
    assert.equal(existsSync(join(output, 'solar')), false);
    assert.equal(report.files, 2);
    assert.ok(report.bytes < report.sourceBytes);
    assert.throws(() => prepareDataset(source, source));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dataset assembly rejects aliased input/output overlap before changing data', t => {
  const root = mkdtempSync(join(tmpdir(), 'dataset-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  const original = '{\n  "retained": true\n}\n';
  writeFileSync(join(source, 'manifest.json'), original);
  symlinkSync(root, join(root, 'alias'), 'junction');
  for (const output of ['alias/source', 'alias/source/new/output', 'alias']) {
    assert.throws(() => prepareDataset(source, join(root, output)), /separate/);
    assert.equal(readFileSync(join(source, 'manifest.json'), 'utf8'), original);
  }
  assert.equal(existsSync(join(source, 'new')), false);
});

test('public assembly excludes every retired grid generation while keeping Armenia and point forecasts', t => {
  const root = mkdtempSync(join(tmpdir(), 'dataset-retired-grids-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), output = join(root, 'output');
  const retired = ['north-sound-20261021-00z', 'north-sound-20261021-00z-live', 'north-sound-expanded-v2',
    'shenandoah-blue-ridge-20261021-00z-rrfs-live', 'shenandoah-massanutten-20261021-06z',
    'tiger-puget-trough-20261021-06z-live', 'columbia-gorge-gap-flow-20261021-06z',
    'rogue-valley-woodrat-20261021-06z-rrfs-live', 'intermountain-idaho-utah-v2'];
  for (const caseId of [...retired, 'armenia-icon-eu-live']) {
    mkdirSync(join(source, 'soaring/v1', caseId), { recursive: true });
    writeFileSync(join(source, 'soaring/v1', caseId, 'index.json'), '{}');
  }
  mkdirSync(join(source, 'rrfs/sites'), { recursive: true });
  writeFileSync(join(source, 'rrfs/sites/va-daniels.json'), '{}');
  writeFileSync(join(source, 'soaring/v1/regions.json'), JSON.stringify({ trialRegionId: 'north-sound', regions: [
    { id: 'north-sound', caseId: retired[0] }, { id: 'shenandoah-blue-ridge', caseId: retired[3] },
    { id: 'armenia', caseId: 'armenia-icon-eu-live' },
  ] }));
  prepareDataset(source, output);
  for (const caseId of retired) {
    assert.equal(existsSync(join(output, 'soaring/v1', caseId)), false);
    assert.equal(existsSync(join(source, 'soaring/v1', caseId)), true, 'assembly never removes source evidence');
  }
  assert.equal(existsSync(join(output, 'rrfs/sites/va-daniels.json')), true);
  assert.equal(existsSync(join(output, 'soaring/v1/armenia-icon-eu-live/index.json')), true);
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'soaring/v1/regions.json'))).regions.map(region => region.id), ['armenia']);
});
