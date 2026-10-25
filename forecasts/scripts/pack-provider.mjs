import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packProvider } from '@windgrams/pipeline';
import { REGION_INDEXES, legacyCaseModel } from './lib/model-coverage.mjs';
export function packProviderArtifact(group, destination = 'slice', root = 'data') {
  return packProvider(resolve(root), resolve(destination), group, { extraPaths: [group === 'dwd' ? 'site-context-armenia.json' : `site-context-${group}.json`, `health/${group}.json`], regionIndexes: REGION_INDEXES, resolveLegacyCase: legacyCaseModel });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { packProviderArtifact(process.argv[2], process.argv[3]); } catch (error) { console.error(error); process.exitCode = 1; }
}
