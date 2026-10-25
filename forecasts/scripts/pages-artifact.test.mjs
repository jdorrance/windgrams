import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPagesArtifact, PAGES_MAX_BYTES, prunePublishedBundles } from './pages-artifact.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value) + '\n'); };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pages-artifact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function bundle(root, caseId, day, current = false) {
  const profile = '{}\n';
  const manifest = JSON.stringify({ case: { id: caseId }, capturedAt: `2026-10-${day}T12:00:00Z`, files: { 'profile.json': hash(profile) } }) + '\n';
  const id = hash(manifest), dir = join(root, caseId, 'bundles', id);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'manifest.json'), manifest); writeFileSync(join(dir, 'profile.json'), profile);
  if (current) write(join(root, caseId, 'index.json'), { bundle: `bundles/${id}`, manifestSha256: id });
  return dir;
}

test('publication keeps current plus previous across providers after additive overlays, preserving historical cases', t => {
  const output = fixture(t), root = join(output, 'soaring/v1');
  write(join(root, 'regions.json'), { regions: [{ status: 'active-verified-trial', caseId: 'us-hrrr',
    nativeModels: [{ caseId: 'us-hrrr' }, { caseId: 'us-rrfs' }, { caseId: 'armenia-icon-eu-live' }] },
  { status: 'historical', caseId: 'historical' }] });
  const retained = [], discarded = [], pointers = new Map();
  for (const id of ['us-hrrr', 'us-rrfs', 'armenia-icon-eu-live']) {
    // The active pointer wins even if a cached bundle has a newer capture date.
    retained.push(bundle(root, id, 23, true), bundle(root, id, 24));
    discarded.push(bundle(root, id, 21), bundle(root, id, 22));
    pointers.set(id, readFileSync(join(root, id, 'index.json'), 'utf8'));
  }
  const historical = [21, 22, 23].map(day => bundle(root, 'historical', day, day === 23));
  const unlisted = [21, 22, 23].map(day => bundle(root, 'unlisted-replay', day, day === 23));
  assert.deepEqual(prunePublishedBundles(output), { cases: 3, removed: 6 });
  for (const path of [...retained, ...historical, ...unlisted]) assert.ok(existsSync(path));
  for (const path of discarded) assert.equal(existsSync(path), false);
  for (const [id, pointer] of pointers) assert.equal(readFileSync(join(root, id, 'index.json'), 'utf8'), pointer);
  assert.deepEqual(prunePublishedBundles(output), { cases: 3, removed: 0 });
});

test('invalid active bundles stop all pruning, and a missing catalogue is harmless', t => {
  const output = fixture(t), root = join(output, 'soaring/v1');
  assert.deepEqual(prunePublishedBundles(output), { cases: 0, removed: 0 });
  write(join(root, 'regions.json'), { regions: [{ status: 'active-verified-trial', caseId: 'good', nativeModels: [{ caseId: 'broken' }] }] });
  bundle(root, 'good', 24, true); bundle(root, 'good', 23); const oldest = bundle(root, 'good', 22);
  assert.throws(() => prunePublishedBundles(output), /incomplete active regional case: broken/);
  assert.ok(existsSync(oldest), 'validation precedes every deletion');
});

test('Pages size guard counts exact upload bytes and rejects 1 GB, empty trees and symbolic links', t => {
  const root = fixture(t);
  assert.throws(() => checkPagesArtifact(root), /empty/);
  mkdirSync(join(root, 'data')); writeFileSync(join(root, 'index.html'), 'hello'); writeFileSync(join(root, 'data', 'cell.json.gz'), 'gzip');
  assert.deepEqual(checkPagesArtifact(root), { bytes: 9, files: 2, remainingBytes: PAGES_MAX_BYTES - 9, warning: false });
  truncateSync(join(root, 'data', 'cell.json.gz'), 800_000_000 - 5);
  assert.equal(checkPagesArtifact(root).warning, true);
  truncateSync(join(root, 'data', 'cell.json.gz'), PAGES_MAX_BYTES - 5);
  assert.throws(() => checkPagesArtifact(root), /1000000000 bytes/);
  truncateSync(join(root, 'data', 'cell.json.gz'), 4);
  symlinkSync(join(root, 'index.html'), join(root, 'linked'));
  assert.throws(() => checkPagesArtifact(root), /symbolic link/);
});
