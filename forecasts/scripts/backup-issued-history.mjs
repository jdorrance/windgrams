// Durable, hash-verified backup of first-issued history outside Actions caches/artifacts.
// The backup is a tar of forecasts/data/history plus a manifest naming every file's
// SHA-256 and a tree hash over the sorted inventory. Release assets hold the chunks
// (see .github/workflows/backup-history.yml); this script owns pack/verify/restore so
// the round trip is testable offline. Revision payloads are additionally checked
// against their issued revision receipts via archivedModelRuns, which owns that logic.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { archivedModelRuns } from '../verification/issued-history.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const DEFAULT_CHUNK_BYTES = 1_500_000_000; // GitHub release assets must stay below 2 GiB.

function regularFiles(root, prefix = '') {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`History backup refuses symlinks: ${path}`);
    return entry.isDirectory() ? regularFiles(join(root, entry.name), `${path}/`) : [path];
  }).sort();
}

/** Sorted per-file inventory plus a tree hash over `path sha256 bytes` lines. */
export function inventoryHistory(historyRoot) {
  if (!existsSync(historyRoot)) throw new Error(`History directory does not exist: ${historyRoot}`);
  const files = regularFiles(historyRoot).map(path => {
    const bytes = readFileSync(join(historyRoot, path));
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const treeSha256 = sha256(Buffer.from(files.map(f => `${f.path} ${f.sha256} ${f.bytes}\n`).join(''), 'utf8'));
  return { files, fileCount: files.length, totalBytes: files.reduce((sum, f) => sum + f.bytes, 0), treeSha256 };
}

export function verifyHistoryInventory(historyRoot, inventory) {
  const actual = inventoryHistory(historyRoot);
  if (actual.treeSha256 !== inventory.treeSha256 || actual.fileCount !== inventory.fileCount || actual.totalBytes !== inventory.totalBytes) {
    throw new Error(`History inventory differs: expected tree ${inventory.treeSha256}, found ${actual.treeSha256}`);
  }
  return actual;
}

/** Every issued revision must still satisfy its receipt hashes (owned by issued-history). */
export function verifyRevisionEvidence(historyRoot) {
  if (basename(historyRoot) !== 'history') throw new Error('History root must be the directory named "history"');
  const dataRoot = dirname(historyRoot);
  let revisions = 0;
  for (const entry of readdirSync(historyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    // archivedModelRuns verifies every retained revision of the runs it returns;
    // its bound (120) matches the retention policy, so this covers retained evidence.
    revisions += archivedModelRuns(dataRoot, entry.name, { maxRuns: 120 }).length;
  }
  return revisions;
}

export function packHistory({ historyRoot, outputDir, createdAt = new Date().toISOString(), chunkBytes = DEFAULT_CHUNK_BYTES }) {
  const revisions = verifyRevisionEvidence(historyRoot);
  const inventory = inventoryHistory(historyRoot);
  mkdirSync(outputDir, { recursive: true });
  const stage = mkdtempSync(join(outputDir, '.pack-'));
  try {
    const tarPath = join(stage, 'issued-history.tar');
    execFileSync('tar', ['-cf', tarPath, '-C', historyRoot, '.'], { stdio: 'inherit' });
    const tar = readFileSync(tarPath);
    const chunks = [];
    for (let offset = 0, index = 0; offset < tar.length; offset += chunkBytes, index += 1) {
      const bytes = tar.subarray(offset, Math.min(tar.length, offset + chunkBytes));
      const file = `issued-history.tar.part-${String(index).padStart(3, '0')}`;
      writeFileSync(join(outputDir, file), bytes);
      chunks.push({ file, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const manifest = {
      schemaVersion: 1, createdAt, revisions,
      fileCount: inventory.fileCount, totalBytes: inventory.totalBytes, treeSha256: inventory.treeSha256,
      files: inventory.files,
      archive: { bytes: tar.length, sha256: sha256(tar), chunks },
    };
    writeFileSync(join(outputDir, 'history-backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function restoreHistory({ archiveDir, outputRoot }) {
  const manifest = JSON.parse(readFileSync(join(archiveDir, 'history-backup-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.archive?.chunks?.length) throw new Error('Invalid history backup manifest');
  const parts = manifest.archive.chunks.map(chunk => {
    const bytes = readFileSync(join(archiveDir, chunk.file));
    if (bytes.length !== chunk.bytes || sha256(bytes) !== chunk.sha256) throw new Error(`Corrupt backup chunk: ${chunk.file}`);
    return bytes;
  });
  const tar = Buffer.concat(parts);
  if (tar.length !== manifest.archive.bytes || sha256(tar) !== manifest.archive.sha256) throw new Error('Backup archive hash differs from manifest');
  if (existsSync(outputRoot) && readdirSync(outputRoot).length) throw new Error(`Restore output is not empty: ${outputRoot}`);
  const parent = dirname(outputRoot);
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(parent, '.restore-'));
  try {
    const tarPath = join(stage, 'issued-history.tar');
    writeFileSync(tarPath, tar);
    const extracted = join(stage, 'history');
    mkdirSync(extracted);
    execFileSync('tar', ['-xf', tarPath, '-C', extracted], { stdio: 'inherit' });
    verifyHistoryInventory(extracted, manifest);
    verifyRevisionEvidence(extracted);
    mkdirSync(outputRoot, { recursive: true });
    // Move verified entries into place; outputRoot was verified empty above.
    for (const entry of readdirSync(extracted)) renameSync(join(extracted, entry), join(outputRoot, entry));
    return manifest;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    history: { type: 'string' }, archive: { type: 'string' }, output: { type: 'string' }, manifest: { type: 'string' },
  } });
  const mode = positionals[0];
  values[mode] = true;
  if (values.pack) {
    if (!values.history || !values.output) throw new Error('pack requires --history DIR --output DIR');
    const manifest = packHistory({ historyRoot: values.history, outputDir: values.output });
    console.log(JSON.stringify({ packed: true, files: manifest.fileCount, bytes: manifest.totalBytes, revisions: manifest.revisions, treeSha256: manifest.treeSha256, chunks: manifest.archive.chunks.length }));
  } else if (values.restore) {
    if (!values.archive || !values.output) throw new Error('restore requires --archive DIR --output DIR');
    const manifest = restoreHistory({ archiveDir: values.archive, outputRoot: values.output });
    console.log(JSON.stringify({ restored: true, files: manifest.fileCount, treeSha256: manifest.treeSha256 }));
  } else if (values.verify) {
    if (!values.history) throw new Error('verify requires --history DIR [--manifest FILE]');
    const revisions = verifyRevisionEvidence(values.history);
    if (values.manifest) verifyHistoryInventory(values.history, JSON.parse(readFileSync(values.manifest, 'utf8')));
    else inventoryHistory(values.history);
    console.log(JSON.stringify({ verified: true, revisions }));
  } else throw new Error('Use one of: pack, verify, restore (as the first argument)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => { console.error(error); process.exitCode = 1; });
