// Model providers publish separate region indexes from independent jobs. Merge
// only pointers backed by a complete local bundle after artifact overlays.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { SOARING_CONTRACT_VERSION } from '../soaring/science.mjs';
import { mergeRegionCatalogues } from '@windgrams/pipeline';
import { REGION_INDEXES, REGIONAL_MERGE_OPTIONS } from './lib/model-coverage.mjs';
import { publicRegionCatalogue } from './lib/retired-regions.mjs';

export function isPublishedCase(root, caseId) {
  if (typeof caseId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(caseId)) return false;
  try {
    const index = JSON.parse(readFileSync(join(root, caseId, 'index.json')));
    if (!/^bundles\/[a-f0-9]{64}$/.test(index.bundle)) return false;
    const dir = join(root, caseId, index.bundle);
    const bytes = readFileSync(join(dir, 'manifest.json'));
    const hash = value => createHash('sha256').update(value).digest('hex');
    if (hash(bytes) !== index.manifestSha256) return false;
    const manifest = JSON.parse(bytes);
    if (manifest.case?.id !== caseId || !Object.keys(manifest.files ?? {}).length) return false;
    return Object.entries(manifest.files).every(([name, digest]) =>
      /^[a-zA-Z0-9.-]+$/.test(name) && hash(readFileSync(join(dir, name))) === digest);
  } catch { return false; }
}

export function mergeRegionIndexes(primary, rrfs, isPublished, iconEu = null) {
  return { ...publicRegionCatalogue(mergeRegionCatalogues(publicRegionCatalogue(primary), [{ model: 'rrfs', index: publicRegionCatalogue(rrfs) }, { model: 'icon-eu', index: publicRegionCatalogue(iconEu) }], isPublished, REGIONAL_MERGE_OPTIONS)), soaringContractVersion: SOARING_CONTRACT_VERSION };
}

export function mergeSoaringRegionFiles(output) {
  const root = join(output, 'soaring', 'v1');
  const indexes = REGION_INDEXES.map(entry => ({ model: entry.model, path: join(root, entry.file) }));
  if (!indexes.some(item => existsSync(item.path))) return;
  const overlays = indexes.map(item => ({ model: item.model, index: existsSync(item.path) ? publicRegionCatalogue(JSON.parse(readFileSync(item.path))) : null }));
  const primary = overlays.find(item => item.model === 'hrrr-conus')?.index ?? null;
  const result = mergeRegionCatalogues(primary, overlays.filter(item => item.model !== 'hrrr-conus'), caseId => isPublishedCase(root, caseId), REGIONAL_MERGE_OPTIONS);
  writeFileSync(join(root, 'regions.json'), JSON.stringify({ ...publicRegionCatalogue(result), soaringContractVersion: SOARING_CONTRACT_VERSION }, null, 2) + '\n');

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string', default: 'data' } } });
  mergeSoaringRegionFiles(resolve(values.output));
}
