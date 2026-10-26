// One artifact per independently refreshed provider, with trusted-run provenance.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_GROUPS } from '@windgrams/providers/registry';
import { SOARING_CONTRACT_VERSION } from '../soaring/science.mjs';
import { packProviderArtifact } from './pack-provider.mjs';
import { acceptsDiagnosticMethod } from './lib/diagnostic-completeness.mjs';
import { pointProduct, readJson, regionalProduct } from './lib/artifact-products.mjs';
import { REGION_INDEXES } from './lib/model-coverage.mjs';
import { packSlice } from './pack-slice.mjs';

export function packRefresh(group, destination = 'slice', root = 'data', sha = process.env.GITHUB_SHA) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('A refresh artifact requires its source commit SHA');
  if (Object.hasOwn(PROVIDER_GROUPS, group)) packProviderArtifact(group, destination, root);
  else if (group === 'observations') packSlice(destination, ['nws', 'ecmwf', 'raob'], root);
  else if (group === 'terrain') packSlice(destination, ['site-context.json'], root);
  else throw new Error(`Unknown refresh group: ${group}`);
  const retainedProducts = retainedProductMethods(destination, PROVIDER_GROUPS[group] ?? []);
  writeFileSync(join(destination, '.artifact.json'), JSON.stringify({ schemaVersion: 1, group, sourceSha: sha,
    soaringContractVersion: SOARING_CONTRACT_VERSION, retainedProducts, createdAt: new Date().toISOString() }) + '\n');
}

/** The envelope identifies the producer; each retained payload keeps its own verified method. */
function retainedProductMethods(root, models) {
  const retained = {};
  const isPrior = method => method !== SOARING_CONTRACT_VERSION && acceptsDiagnosticMethod(method, { retained: true });
  const remember = (key, inspect) => {
    try { const method = inspect(); if (isPrior(method)) retained[key] = method; }
    catch { /* Leave invalid products unmarked; the merger rejects them without losing valid siblings. */ }
  };
  for (const model of models) remember(model, () => {
    const manifest = readJson(join(root, model, 'manifest.json')), site = manifest.sites?.[0]?.slug;
    const method = site && readJson(join(root, model, 'sites', `${site}.json`)).soaringMeta?.contractVersion;
    return isPrior(method) ? pointProduct(root, model, [], { retained: true }).methodVersion : method;
  });
  const regionalRoot = join(root, 'soaring/v1');
  if (!existsSync(regionalRoot)) return retained;
  for (const entry of readdirSync(regionalRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())) remember(`soaring/${entry.name}`, () => {
    const pointer = readJson(join(regionalRoot, entry.name, 'index.json'));
    if (!/^bundles\/[a-f0-9]{64}$/.test(pointer.bundle)) throw new Error('Invalid retained regional pointer');
    const method = readJson(join(regionalRoot, entry.name, pointer.bundle, 'manifest.json')).soaringContractVersion;
    return isPrior(method) ? regionalProduct(regionalRoot, entry.name, models, { retained: true }).manifest.soaringContractVersion : method;
  });
  for (const entry of REGION_INDEXES.filter(entry => models.includes(entry.model))) {
    const key = `soaring/v1/${entry.file}`;
    remember(key, () => readJson(join(root, key)).soaringContractVersion);
  }
  return retained;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packRefresh(process.argv[2]);
