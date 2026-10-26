// Reconcile all accepted products before the website sees the dataset.
import { appendFileSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { MODELS } from '@windgrams/providers/registry';
import { validateRegionCatalogue } from '@windgrams/contracts/regional';
import { mergeArtifacts } from './merge-artifacts.mjs';
import { pointProduct, publicationOwnedName, regionalProduct, readJson, writeJson } from './lib/artifact-products.mjs';
import { REGION_INDEXES } from './lib/model-coverage.mjs';
import { mergeSiteContextFiles } from './merge-site-contexts.mjs';
import { mergeSoaringRegionFiles } from './merge-soaring-regions.mjs';
import { prunePublishedBundles } from './pages-artifact.mjs';
import { modelsCatalogue } from './write-models-catalogue.mjs';
import { runsIndexFromDisk } from './write-runs-index.mjs';

export function preparePublication(incoming, output, catalogue = readJson(new URL('../sites.json', import.meta.url)), { dryRun = false } = {}) {
  const start = Date.now();
  output = resolve(output);
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), '.publication-')), candidate = join(staging, 'dataset'), previous = join(staging, 'previous');
  try {
    if (existsSync(output)) cpSync(output, candidate, { recursive: true, mode: constants.COPYFILE_FICLONE,
      filter: path => { const first = relative(output, path).split(sep)[0]; return !first || publicationOwnedName(first); } });
    const report = prepareCandidate(incoming, candidate, catalogue);
    if (dryRun) return { ...report, validationMs: Date.now() - start };
    if (existsSync(output)) renameSync(output, previous);
    const moved = [];
    try {
      // Transfer excluded caches by rename; never duplicate their bytes or delete them.
      if (existsSync(previous)) for (const name of readdirSync(previous).filter(name => !publicationOwnedName(name))) {
        renameSync(join(previous, name), join(candidate, name)); moved.push(name);
      }
      renameSync(candidate, output);
    } catch (error) {
      for (const name of moved.reverse()) renameSync(join(candidate, name), join(previous, name));
      if (existsSync(previous)) renameSync(previous, output);
      throw error;
    }
    return { ...report, validationMs: Date.now() - start };
  } finally {
    // Leave a recoverable original if an exceptional filesystem rollback failed.
    if (!existsSync(previous) || existsSync(output)) rmSync(staging, { recursive: true, force: true });
  }
}

function prepareCandidate(incoming, output, catalogue) {
  const merged = mergeArtifacts(incoming, output, { sites: catalogue.sites });
  const validated = [];
  const unavailable = [];
  const retainedMethods = [];
  for (const model of MODELS) if (existsSync(join(output, model.id))) {
    try {
      const product = pointProduct(output, model.id, catalogue.sites, { retained: true });
      if (product.methodVersion !== SOARING_CONTRACT_VERSION) retainedMethods.push({ product: model.id, methodVersion: product.methodVersion });
      validated.push(model.id);
    } catch (error) { unavailable.push({ model: model.id, reason: error.message }); }
  }
  if (!validated.length) throw new Error('Publication requires at least one complete model; restore last-good data or refresh a provider');
  // An unusable generated cache cannot block another provider's complete update.
  // Leave its issued archive intact; the served monitor reports the missing product.
  for (const item of unavailable) rmSync(join(output, item.model), { recursive: true });
  const unavailableRegions = [];
  const regionalRoot = join(output, 'soaring/v1'), activeCases = new Map();
  for (const entry of REGION_INDEXES) {
    const path = join(regionalRoot, entry.file);
    if (!existsSync(path)) continue;
    let index;
    try { index = validateRegionCatalogue(readJson(path)); if (!index) throw new Error('Invalid regional catalogue'); }
    catch (error) { unavailableRegions.push({ catalogue: entry.file, reason: error.message }); rmSync(path); continue; }
    for (const region of index.regions.filter(region => region.status === 'active-verified-trial')) {
      const references = region.nativeModels?.length ? region.nativeModels : [{ model: entry.model, caseId: region.caseId, expandedCaseId: region.expandedCaseId }];
      for (const item of references) for (const caseId of [item.caseId, item.expandedCaseId].filter(Boolean)) {
        const models = activeCases.get(caseId) ?? new Set(); models.add(item.model); activeCases.set(caseId, models);
      }
      // Legacy expanded pointers carry no model label; their manifest owns it.
      for (const caseId of [region.caseId, region.expandedCaseId].filter(Boolean)) if (!activeCases.has(caseId)) activeCases.set(caseId, new Set());
    }
  }
  for (const [caseId, models] of activeCases) {
    try {
      if (models.size) for (const model of models) regionalProduct(regionalRoot, caseId, [model], { retained: true });
      else regionalProduct(regionalRoot, caseId, MODELS.map(model => model.id), { retained: true });
    }
    catch (error) {
      unavailableRegions.push({ caseId, reason: error.message });
      // Keep immutable bytes for diagnosis; no active pointer may advertise an invalid bundle.
      rmSync(join(regionalRoot, caseId, 'index.json'), { force: true });
    }
  }
  const terrain = mergeSiteContextFiles(output, catalogue.sites);
  mergeSoaringRegionFiles(output);
  const pruned = prunePublishedBundles(output);
  writeJson(join(output, 'sites.json'), catalogue);
  writeJson(join(output, 'models.json'), modelsCatalogue());
  writeJson(join(output, 'runs.json'), runsIndexFromDisk(output));
  return { merged, validated, retainedMethods, unavailable, unavailableRegions, terrain, pruned };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { incoming: { type: 'string', default: 'incoming' }, output: { type: 'string', default: 'forecasts/data' }, 'dry-run': { type: 'boolean', default: false } } });
  const report = preparePublication(resolve(values.incoming), resolve(values.output), undefined, { dryRun: values['dry-run'] });
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Publication\n\n${report.validated.length} complete models; ${report.merged.accepted.length} accepted products; ${report.merged.rejected.length} rejected candidates. Validation ${(report.validationMs / 1000).toFixed(1)} s.\n`);
  for (const item of report.merged.rejected) console.warn(`::warning::Retained ${item.product}: ${item.reason.replace(/[\r\n]/g, ' ')}`);
  for (const item of report.unavailable) console.warn(`::warning::${item.model} unavailable: ${item.reason.replace(/[\r\n]/g, ' ')}`);
  for (const item of report.unavailableRegions) console.warn(`::warning::${item.caseId ?? item.catalogue} unavailable: ${item.reason.replace(/[\r\n]/g, ' ')}`);
}
