// One artifact per independently refreshed provider, with trusted-run provenance.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_GROUPS } from '@windgrams/providers/registry';
import { SOARING_CONTRACT_VERSION } from '../soaring/science.mjs';
import { packProviderArtifact } from './pack-provider.mjs';
import { packSlice } from './pack-slice.mjs';

export function packRefresh(group, destination = 'slice', root = 'data', sha = process.env.GITHUB_SHA) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('A refresh artifact requires its source commit SHA');
  if (Object.hasOwn(PROVIDER_GROUPS, group)) packProviderArtifact(group, destination, root);
  else if (group === 'observations') packSlice(destination, ['nws', 'ecmwf', 'raob'], root);
  else if (group === 'terrain') packSlice(destination, ['site-context.json'], root);
  else throw new Error(`Unknown refresh group: ${group}`);
  writeFileSync(join(destination, '.artifact.json'), JSON.stringify({ schemaVersion: 1, group, sourceSha: sha,
    soaringContractVersion: SOARING_CONTRACT_VERSION, createdAt: new Date().toISOString() }) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packRefresh(process.argv[2]);
