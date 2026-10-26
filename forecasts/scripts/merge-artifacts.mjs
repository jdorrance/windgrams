// Merge complete, provider-owned products. Failed candidates retain the prior publication.
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PROVIDER_GROUPS, MODELS } from '@windgrams/providers/registry';
import { validateRegionCatalogue } from '@windgrams/contracts/regional';
import { SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { REGION_INDEXES, legacyCaseModel } from './lib/model-coverage.mjs';
import { copyImmutable, newerProduct, pointProduct, publicationOwnedName, readJson, regionalProduct, replaceTree, timestamp, validateFileTree, writeJson } from './lib/artifact-products.mjs';
import { acceptsDiagnosticMethod } from './lib/diagnostic-completeness.mjs';
import { mergeHistoryArchives } from '../verification/history.mjs';
import { OPERATOR_HISTORY_POLICY } from '../verification/history-policy.mjs';
import { mergeProviderHealth } from './lib/provider-health.mjs';
import { mergeObservationProduct } from './lib/observation-artifacts.mjs';

const tryRead = path => { try { return readJson(path); } catch { return null; } };
const artifactGroup = name => name.replace(/^data-/, '').replace(/--[1-9]\d*$/, '');
const artifactRun = name => Number(/--([1-9]\d*)$/.exec(name)?.[1] ?? 0);
const version = document => {
  if (!document) return null;
  let referenceTime;
  try { referenceTime = timestamp(document.referenceTime ?? document.case?.referenceTime); } catch { return null; }
  let generatedAt = -Infinity;
  try { generatedAt = timestamp(document.generatedAt ?? document.capturedAt); } catch { /* A damaged generation timestamp cannot discard known initialization order. */ }
  return { referenceTime, generatedAt };
};

export function mergeArtifacts(incoming, output, { sites = readJson(new URL('../sites.json', import.meta.url)).sites, dryRun = false } = {}) {
  if (dryRun) {
    const scratch = mkdtempSync(join(tmpdir(), 'windgrams-publication-check-')), candidate = join(scratch, 'dataset');
    try {
      if (existsSync(output)) cpSync(output, candidate, { recursive: true, mode: constants.COPYFILE_FICLONE,
        filter: path => { const first = relative(output, path).split(sep)[0]; return !first || publicationOwnedName(first); } });
      return mergeArtifacts(incoming, candidate, { sites });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  const report = { accepted: [], retained: [], rejected: [] };
  if (!existsSync(incoming)) return report;
  if (!dryRun) mkdirSync(output, { recursive: true });
  const attempt = (key, action) => {
    try { (action() ? report.accepted : report.retained).push(key); }
    catch (error) { report.rejected.push({ product: key, reason: error.message }); }
  };
  const entries = readdirSync(incoming, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .sort((a, b) => artifactGroup(a.name).localeCompare(artifactGroup(b.name)) || artifactRun(a.name) - artifactRun(b.name));
  for (const entry of entries) {
    const directory = join(incoming, entry.name);
    const source = existsSync(join(directory, 'slice')) ? join(directory, 'slice') : directory;
    if (readdirSync(source).every(name => name === 'EMPTY')) continue;
    const group = artifactGroup(entry.name);
    const metadata = tryRead(join(source, '.artifact.json'));
    // Old envelopes and explicitly declared retained products can fill holes only.
    const priorMethod = key => {
      const method = metadata?.retainedProducts?.[key] ?? metadata?.soaringContractVersion;
      return method !== SOARING_CONTRACT_VERSION && acceptsDiagnosticMethod(method, { retained: true }) ? method : null;
    };
    const models = PROVIDER_GROUPS[group] ?? [];
    if (!Object.hasOwn(PROVIDER_GROUPS, group) && !['observations', 'terrain'].includes(group)) {
      report.rejected.push({ product: entry.name, reason: 'Unknown provider artifact' }); continue;
    }
    try { validateFileTree(source); }
    catch (error) { report.rejected.push({ product: entry.name, reason: error.message }); continue; }
    for (const model of MODELS) if (!models.includes(model.id) && existsSync(join(source, model.id))) {
      report.rejected.push({ product: model.id, reason: 'Incorrect provider ownership' });
    }
    for (const model of models) if (existsSync(join(source, model))) attempt(model, () => {
      const method = priorMethod(model), retained = method !== null;
      const next = pointProduct(source, model, sites, { retained });
      if (retained && next.methodVersion !== method) throw new Error('Retained point method differs from artifact declaration');
      const previous = version(tryRead(join(output, model, 'manifest.json')));
      let previousProduct;
      try { previousProduct = pointProduct(output, model, sites, { retained: true }); } catch { /* A complete same-run candidate can repair it. */ }
      if (retained && previousProduct) return false;
      const current = previousProduct?.methodVersion === SOARING_CONTRACT_VERSION;
      if (!newerProduct(next, previous, current)) return false;
      if (!dryRun) replaceTree(join(source, model), join(output, model));
      return true;
    });

    const regions = join(source, 'soaring/v1'), published = join(output, 'soaring/v1');
    if (existsSync(regions)) {
      for (const item of readdirSync(regions, { withFileTypes: true }).filter(item => item.isDirectory())) attempt(`soaring/${item.name}`, () => {
        const method = priorMethod(`soaring/${item.name}`), retained = method !== null;
        const next = regionalProduct(regions, item.name, models, { retained });
        if (retained && next.manifest.soaringContractVersion !== method) throw new Error('Retained regional method differs from artifact declaration');
        const pointer = tryRead(join(published, item.name, 'index.json'));
        const previous = pointer && /^bundles\/[a-f0-9]{64}$/.test(pointer.bundle)
          ? version(tryRead(join(published, item.name, pointer.bundle, 'manifest.json'))) ?? version(pointer) : version(pointer);
        let previousProduct;
        try { previousProduct = regionalProduct(published, item.name, models, { retained: true }); } catch { /* Repair only after validation. */ }
        if (retained && previousProduct) return false;
        const current = previousProduct?.manifest.soaringContractVersion === SOARING_CONTRACT_VERSION;
        if (!newerProduct(next, previous, current)) return false;
        if (!dryRun) {
          const bundle = join(item.name, next.pointer.bundle);
          for (const name of ['manifest.json', ...Object.keys(next.manifest.files)]) copyImmutable(join(regions, bundle, name), join(published, bundle, name), {
            expectedSha256: name === 'manifest.json' ? next.pointer.manifestSha256 : next.manifest.files[name], repairCorrupt: !previousProduct,
          });
          writeJson(join(published, item.name, 'index.json'), next.pointer);
        }
        return true;
      });
      for (const index of REGION_INDEXES.filter(index => models.includes(index.model))) {
        const key = `soaring/v1/${index.file}`, path = join(source, key);
        if (!existsSync(path)) continue;
        attempt(key, () => {
          const method = priorMethod(key), retained = method !== null;
          const next = validateRegionCatalogue(readJson(path)), previous = tryRead(join(output, key));
          if (!next || !acceptsDiagnosticMethod(next.soaringContractVersion, { retained })) throw new Error('Invalid regional catalogue');
          if (retained && next.soaringContractVersion !== method) throw new Error('Retained catalogue method differs from artifact declaration');
          if (retained && previous) return false;
          const cases = next.regions.filter(region => region.status === 'active-verified-trial').flatMap(region => {
            if (region.nativeModels?.length) return region.nativeModels.filter(item => item.model === index.model).flatMap(item => [item.caseId, item.expandedCaseId].filter(Boolean));
            const pointer = tryRead(join(published, region.caseId, 'index.json'));
            const manifest = pointer && /^bundles\/[a-f0-9]{64}$/.test(pointer.bundle) ? tryRead(join(published, region.caseId, pointer.bundle, 'manifest.json')) : null;
            const owner = manifest?.model ?? manifest?.case?.model ?? legacyCaseModel(region.caseId);
            if (!owner) throw new Error(`Cannot identify active regional case: ${region.caseId}`);
            return owner === index.model ? [region.caseId, region.expandedCaseId].filter(Boolean) : [];
          });
          const products = new Map([...new Set(cases)].map(caseId => [caseId, regionalProduct(published, caseId, [index.model], { retained: true })]));
          for (const region of next.regions) {
            const own = (region.nativeModels ?? []).find(item => item.model === index.model)?.caseId ?? region.caseId;
            if (products.has(own) && region.launches.some(slug => !products.get(own).launchSlugs.includes(slug))) throw new Error('Regional catalogue launch inventory differs from bundle');
          }
          if (previous?.soaringContractVersion === next.soaringContractVersion && timestamp(previous.generatedAt) >= timestamp(next.generatedAt)) return false;
          if (!dryRun) writeJson(join(output, key), next);
          return true;
        });
      }
    }
    for (const model of models) if (existsSync(join(source, 'history', model))) attempt(`history/${model}`, () => {
      if (!dryRun) mergeHistoryArchives(source, output, model, OPERATOR_HISTORY_POLICY);
      return true;
    });
    if (models.length && existsSync(join(source, 'health', `${group}.json`))) attempt(`health/${group}`, () => {
      const path = join(output, 'health', `${group}.json`);
      const previous = tryRead(path), next = mergeProviderHealth(previous, readJson(join(source, 'health', `${group}.json`)), group);
      if (JSON.stringify(next) === JSON.stringify(previous)) return false;
      if (!dryRun) writeJson(path, next);
      return true;
    });
    // Terrain owns per-site measurement comparison; merge-site-contexts validates before publication.
    const terrain = group === 'terrain' ? ['site-context.json'] : [group === 'dwd' ? 'site-context-armenia.json' : `site-context-${group}.json`];
    for (const name of terrain) if (existsSync(join(source, name))) attempt(name, () => {
      if (!dryRun) cpSync(join(source, name), join(output, name === 'site-context.json' ? 'site-context-terrain.json' : name));
      return true;
    });
    if (group === 'observations') for (const product of ['nws', 'ecmwf', 'raob']) {
      const directory = join(source, product);
      if (!existsSync(directory) || product === 'raob' && !existsSync(join(directory, 'manifest.json'))) continue;
      attempt(product, () => mergeObservationProduct(directory, join(output, product), product));
    }
    if (group === 'observations' && !existsSync(join(source, 'raob/manifest.json')) && existsSync(join(source, 'raob/sites'))) {
      for (const name of readdirSync(join(source, 'raob/sites')).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name))) attempt(`raob/${name}`, () => {
        const key = `raob/sites/${name}`, next = readJson(join(source, key)), previous = tryRead(join(output, key));
        if (next.schemaVersion !== 1 || next.site?.slug !== name.slice(0, -5) || !Array.isArray(next.soundings)) throw new Error('Invalid sounding document');
        const attempt = tryRead(join(output, 'raob/manifest.json'));
        if (attempt && timestamp(attempt.generatedAt) >= timestamp(next.generatedAt)) return false;
        if (previous && timestamp(previous.generatedAt) >= timestamp(next.generatedAt)) return false;
        timestamp(next.generatedAt);
        if (!dryRun) writeJson(join(output, key), next);
        return true;
      });
    }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { incoming: { type: 'string', default: 'incoming' }, output: { type: 'string', default: 'forecasts/data' }, 'dry-run': { type: 'boolean', default: false } } });
  const report = mergeArtifacts(resolve(values.incoming), resolve(values.output), { dryRun: values['dry-run'] });
  console.log(JSON.stringify(report, null, 2));
  for (const item of report.rejected) console.error(`::warning::Retained ${item.product}: ${item.reason.replace(/[\r\n]/g, ' ')}`);
}
