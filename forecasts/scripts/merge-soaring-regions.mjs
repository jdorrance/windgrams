// RRFS and HRRR publish separate region indexes from independent jobs. Merge
// only pointers backed by a complete local bundle after artifact overlays.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { SOARING_CONTRACT_VERSION } from '../soaring/science.mjs';

export function isPublishedCase(root, caseId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(caseId)) return false;
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

export function mergeRegionIndexes(primary, rrfs, isPublished) {
  const base = primary ?? rrfs ?? { regions: [] };
  const rrfsById = new Map((rrfs?.regions ?? []).map(region => [region.id, region]));
  const allRegions = new Map((base.regions ?? []).map(region => [region.id, region]));
  for (const region of rrfs?.regions ?? []) if (!allRegions.has(region.id)) allRegions.set(region.id, region);
  const regions = [...allRegions.values()].flatMap(region => {
    const native = new Map((region.nativeModels ?? []).filter(item => isPublished(item.caseId)).map(item => [item.model, item]));
    if (isPublished(region.caseId)) {
      const model = (region.nativeModels ?? []).find(item => item.caseId === region.caseId)?.model
        ?? (region.caseId.endsWith('-rrfs-live') ? 'rrfs' : 'hrrr-conus');
      native.set(model, { model, caseId: region.caseId });
    }
    for (const item of rrfsById.get(region.id)?.nativeModels ?? []) {
      if (item.model === 'rrfs' && isPublished(item.caseId)) native.set('rrfs', item);
    }
    if (region.status === 'active-verified-trial' && !native.size) return [];
    const preferred = native.get('hrrr-conus') ?? native.get('rrfs') ?? [...native.values()][0];
    const merged = { ...region, ...(preferred ? { caseId: preferred.caseId } : {}), nativeModels: [...native.values()] };
    if (merged.expandedCaseId && !isPublished(merged.expandedCaseId)) delete merged.expandedCaseId;
    return [merged];
  });
  return { ...base, soaringContractVersion: SOARING_CONTRACT_VERSION, regions };
}

export function mergeSoaringRegionFiles(output) {
  const root = join(output, 'soaring', 'v1');
  const primaryPath = join(root, 'regions.json');
  const rrfsPath = join(root, 'regions-rrfs.json');
  if (!existsSync(primaryPath) && !existsSync(rrfsPath)) return;
  const primary = existsSync(primaryPath) ? JSON.parse(readFileSync(primaryPath)) : null;
  const rrfs = existsSync(rrfsPath) ? JSON.parse(readFileSync(rrfsPath)) : null;
  writeFileSync(primaryPath, `${JSON.stringify(mergeRegionIndexes(primary, rrfs, caseId => isPublishedCase(root, caseId)), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string', default: 'data' } } });
  mergeSoaringRegionFiles(resolve(values.output));
}
