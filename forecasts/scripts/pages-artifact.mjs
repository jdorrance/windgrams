// Bound rolling forecast storage after provider overlays, before Pages upload.
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isPublishedCase } from './merge-soaring-regions.mjs';

export const PAGES_MAX_BYTES = 1_000_000_000;
const read = path => JSON.parse(readFileSync(path, 'utf8'));

/** Keep the active and most recently superseded bundle of each rolling case.
 * Cases outside the active region catalogue are retained as historical replays.
 * Plan every removal before touching disk, so an invalid pointer leaves all data.
 */
export function prunePublishedBundles(output) {
  const root = join(output, 'soaring/v1');
  const catalogue = join(root, 'regions.json');
  if (!existsSync(catalogue)) return { cases: 0, removed: 0 };
  const cases = new Set(read(catalogue).regions.filter(region => region.status === 'active-verified-trial')
    .flatMap(region => [region.caseId, ...(region.nativeModels ?? []).map(model => model.caseId)]).filter(Boolean));
  const removals = [];
  for (const caseId of cases) {
    if (!isPublishedCase(root, caseId)) throw new Error(`Cannot prune an incomplete active regional case: ${caseId}`);
    const caseRoot = join(root, caseId);
    const current = read(join(caseRoot, 'index.json')).bundle.slice('bundles/'.length);
    const bundles = join(caseRoot, 'bundles');
    const superseded = readdirSync(bundles, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name) && entry.name !== current)
      .map(entry => {
        const manifest = read(join(bundles, entry.name, 'manifest.json'));
        const capturedAt = Date.parse(manifest.capturedAt);
        if (manifest.case?.id !== caseId || !Number.isFinite(capturedAt)) throw new Error(`Invalid superseded bundle: ${caseId}/${entry.name}`);
        return { name: entry.name, capturedAt };
      }).sort((a, b) => b.capturedAt - a.capturedAt || a.name.localeCompare(b.name));
    removals.push(...superseded.slice(1).map(bundle => join(bundles, bundle.name)));
  }
  for (const path of removals) rmSync(path, { recursive: true });
  return { cases: cases.size, removed: removals.length };
}

/** Inspect the exact upload tree, including app assets and compressed file bytes. */
export function checkPagesArtifact(root) {
  let bytes = 0, files = 0;
  const visit = path => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Pages artifact contains a symbolic link: ${path}`);
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else if (stat.isFile()) { bytes += stat.size; files++; }
    else throw new Error(`Pages artifact contains a special file: ${path}`);
  };
  visit(root);
  if (!files) throw new Error('Pages artifact is empty');
  if (bytes >= PAGES_MAX_BYTES) throw new Error(`Pages artifact is ${bytes} bytes; it must stay below ${PAGES_MAX_BYTES} bytes (1 GB).`);
  return { bytes, files, remainingBytes: PAGES_MAX_BYTES - bytes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'prune-data': { type: 'string' }, 'check-site': { type: 'string' } } });
  if (Boolean(values['prune-data']) === Boolean(values['check-site'])) throw new Error('Use --prune-data DATA or --check-site DIST');
  console.log(values['prune-data'] ? prunePublishedBundles(resolve(values['prune-data'])) : checkPagesArtifact(resolve(values['check-site'])));
}
