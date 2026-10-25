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
