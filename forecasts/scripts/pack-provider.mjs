import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packProvider } from '@windgrams/pipeline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { REGION_INDEXES, legacyCaseModel } from './lib/model-coverage.mjs';
import { isRetiredRegionalCase, publicRegionCatalogue } from './lib/retired-regions.mjs';
export function packProviderArtifact(group, destination = 'slice', root = 'data') {
  const paths = packProvider(resolve(root), resolve(destination), group, { extraPaths: [group === 'dwd' ? 'site-context-armenia.json' : `site-context-${group}.json`, `health/${group}.json`], regionIndexes: REGION_INDEXES, resolveLegacyCase: legacyCaseModel,
    includeRegionalCase: caseId => !isRetiredRegionalCase(caseId) });
  for (const entry of REGION_INDEXES) {
    const path = join(destination, 'soaring/v1', entry.file);
    if (existsSync(path)) writeFileSync(path, JSON.stringify(publicRegionCatalogue(JSON.parse(readFileSync(path, 'utf8')))) + '\n');
  }
  return paths;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { packProviderArtifact(process.argv[2], process.argv[3]); } catch (error) { console.error(error); process.exitCode = 1; }
}
