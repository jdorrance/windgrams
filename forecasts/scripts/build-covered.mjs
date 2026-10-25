// Build one model for the launches its grid covers, then derive soaring diagnostics
// and archive the issued run.
//
// meteo forecast build fails the whole model when any launch is outside the
// grid. That launch is removed and the build starts again. The first check
// happens on the first file, before profiles are written.
//
//   node scripts/build-covered.mjs --model hrdps-continental --sites sites.json --output data

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from 'node:crypto';
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { postprocessPointForecast } from "../soaring/point-postprocess.mjs";
import { archiveModelRun, DEFAULT_MAX_ROLLING_RUNS } from "../verification/history.mjs";
import { probeCycleReadiness } from "./check-readiness.mjs";
import { validateRrfsProfile } from './validate-rrfs.mjs';
import { validateCurrentDiagnostics } from './lib/diagnostic-completeness.mjs';
import { modelCoversSite } from './lib/model-coverage.mjs';

import { buildCovered, launchOutsideGrid, stageModel, validateModelDirectory, hasCompleteModel, planModelBuild, terrainPrerequisites, postprocessProfiles, catalogueFingerprint, packageBuildHashes } from '@windgrams/pipeline';
import { SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { createLegacyAdapter } from '@windgrams/providers';
import { modelDescriptor } from '@windgrams/providers/registry';
import { measure, contextIsFresh, stampTerrainContext } from './terrain.mjs';
export { buildCovered, launchOutsideGrid };

/**
 * Derive soaring diagnostics for the model's site profiles and archive the issued run.
 */
export function postprocessAndArchiveModelOutput(outputRoot, modelSlug, { maxRollingRuns = DEFAULT_MAX_ROLLING_RUNS } = {}) {
  const postprocessedCount = postprocessProfiles(outputRoot, modelSlug, {
    id: 'windgrams-soaring', version: SOARING_CONTRACT_VERSION,
    derive: (document, context) => postprocessPointForecast(document, context),
  });

  const manifestPath = join(outputRoot, modelSlug, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.diagnosticMethod = { id: 'windgrams-soaring', version: SOARING_CONTRACT_VERSION };
  manifest.diagnosticBuild = { implementationSha256: createHash('sha256')
    .update(JSON.stringify(packageBuildHashes(['@windgrams/soaring'], import.meta.resolve))).digest('hex') };
  writeFileSync(manifestPath, JSON.stringify(manifest) + '\n');

  const archived = archiveModelRun(outputRoot, modelSlug, {
    maxRollingRuns,
    pinnedRunKeys: ["20261021T000000Z", "20261021T060000Z"],
  });
  return { postprocessedCount, archived };
}

/** Keep last-good model files intact until every profile is built and checked. */
export async function stageModelBuild(outputRoot, model, build, finish = postprocessAndArchiveModelOutput, options = {}) {
  const result = await stageModel({ outputRoot, model, build, finish, ...options,
    validateProfile: (document, run, slug) => {
      validateCurrentDiagnostics(document, run, slug);
      if (model === 'rrfs') validateRrfsProfile(document, run, slug, { horizon: document.hours.length });
      options.validateProfile?.(document, run, slug);
    },
    afterPublish: post => {
      if (post.archived) post.archived = archiveModelRun(outputRoot, model, { pinnedRunKeys: ['20261021T000000Z', '20261021T060000Z'] });
      return post;
    },
  });
  return { ...result, post: result.post ?? { postprocessedCount: 0, archived: null } };
}

export async function ensurePointTerrain(output, sites, measureImpl = measure) {
  const path = join(output, 'site-context.json');
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const missing = new Set([...terrainPrerequisites(previous, sites), ...sites.filter(site => !contextIsFresh([site], previous)).map(site => site.slug)]);
  const measured = missing.size ? await measureImpl(sites.filter(site => missing.has(site.slug))) : null;
  const retainedTimes = Object.fromEntries(Object.keys(previous?.sites ?? {}).map(slug => [slug, previous.measurementTimes?.[slug] ?? previous.generatedAt]));
  const measuredTimes = Object.fromEntries(Object.keys(measured?.sites ?? {}).map(slug => [slug, measured.measurementTimes?.[slug] ?? measured.generatedAt]));
  const context = stampTerrainContext({ ...previous, ...measured,
    measurementPolicies: { ...previous?.measurementPolicies, ...measured?.measurementPolicies },
    measurementTimes: { ...retainedTimes, ...measuredTimes }, sites: { ...previous?.sites, ...measured?.sites },
    sources: [...new Map([...(previous?.sources ?? []), ...(measured?.sources ?? [])].map(source => [source.id, source])).values()] }, sites);
  if (terrainPrerequisites(context, sites).length) throw new Error('Missing required measured launch terrain');
  mkdirSync(output, { recursive: true });
  writeFileSync(path, JSON.stringify(context) + '\n');
  return context;
}

/** Application wiring for reusable acquisition, planning and complete publication. */
export async function buildModel(values, { probe = probeCycleReadiness, adapterFactory = createLegacyAdapter, measureImpl = measure, log = console.log } = {}) {
  const model = modelDescriptor(values.model);
  if (values['max-steps'] !== undefined && (!Number.isInteger(Number(values['max-steps'])) || Number(values['max-steps']) < 1)) throw new Error('--max-steps must be a positive integer');
  const readinessOptions = {};
  for (const [flag, key, minimum] of [['readiness-attempts', 'maxAttempts', 1], ['readiness-delay-ms', 'retryDelayMs', 0]]) {
    if (values[flag] === undefined) continue;
    const value = Number(values[flag]);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`--${flag} must be an integer >= ${minimum}`);
    readinessOptions[key] = value;
  }
  if (model.id === 'icon-eu') throw new Error('ICON point/native publication uses build-icon.mjs');
  const catalogue = JSON.parse(readFileSync(values.sites ?? 'sites.json', 'utf8'));
  if (!Array.isArray(catalogue.sites)) throw new Error('Site catalogue has no sites');
  const sites = catalogue.sites.filter(site => modelCoversSite(model.id, site));
  if (!sites.length) return { changed: false, reason: 'no-covered-sites' };
  const output = resolve(values.output ?? 'data');
  const readiness = values['reference-time'] ? null : await probe(model.id, readinessOptions);
  const referenceTime = values['reference-time'] ?? readiness?.selectedCycle?.referenceTime;
  if (!referenceTime) throw new Error(`${model.id}: no complete upstream run; retaining last-good output`);
  const expectedForecastHours = model.forecastHours.slice(0, values['max-steps'] === undefined ? model.forecastHours.length : Number(values['max-steps']));
  const run = { model: model.id, provider: model.provider, product: model.id, referenceTime };
  const manifestPath = join(output, model.id, 'manifest.json');
  const old = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const requestedSiteHash = catalogueFingerprint(sites);
  const exclusions = old?.referenceTime === referenceTime && old?.coverage?.requestedSiteHash === requestedSiteHash ? old.coverage.excluded ?? [] : [];
  const expectedSites = sites.filter(site => !exclusions.includes(site.slug)).map(site => site.slug);
  const inventoryMatches = JSON.stringify([...(old?.sites ?? []).map(site => site.slug)].sort()) === JSON.stringify([...expectedSites].sort());
  const contextPath = join(output, 'site-context.json');
  const context = existsSync(contextPath) ? JSON.parse(readFileSync(contextPath, 'utf8')) : null;
  const completeness = { model: model.id, expectedSites, referenceTime, expectedForecastHours, siteLocations: sites };
  const retainedSourcesComplete = hasCompleteModel(output, completeness);
  const diagnosticsCurrent = retainedSourcesComplete && hasCompleteModel(output, { ...completeness, validateProfile: validateCurrentDiagnostics });
  const validateProfile = (document, run, slug) => {
    validateCurrentDiagnostics(document, run, slug);
    if (model.id === 'rrfs') validateRrfsProfile(document, run, slug, { horizon: document.hours.length });
  };
  const complete = hasCompleteModel(output, { ...completeness, validateProfile }) && terrainPrerequisites(context, sites).length === 0 && contextIsFresh(sites, context);
  const plan = planModelBuild({ run, publishedRun: old?.referenceTime, inventoryMatches, complete });
  // New locations need measured terrain before diagnostics, independent of Actions job order.
  const measuredContext = await ensurePointTerrain(output, sites, measureImpl);
  writeFileSync(join(output, `site-context-${model.jobGroup}.json`), JSON.stringify({ ...measuredContext, sites: Object.fromEntries(sites.map(site => [site.slug, measuredContext.sites[site.slug]])) }) + '\n');
  if (!plan) { validateModelDirectory(output, { ...completeness, referenceTime: undefined, validateProfile }); log(`${model.id}: a complete forecast for this run or a newer run is already published`); return { changed: false, reason: 'current' }; }
  if (plan.reason === 'repair' && retainedSourcesComplete && !diagnosticsCurrent) {
    // Preserve the issued revision before reprocessing its full retained source levels.
    archiveModelRun(output, model.id, { pinnedRunKeys: ['20261021T000000Z', '20261021T060000Z'] });
    const repaired = await stageModelBuild(output, model.id, async staging => cpSync(join(output, model.id), join(staging, model.id), { recursive: true }),
      postprocessAndArchiveModelOutput, completeness);
    log(`${model.id}: repaired diagnostics from retained source profiles`);
    return repaired;
  }
  const adapter = adapterFactory(model.id, { log });
  let coverage;
  const result = await stageModelBuild(output, model.id, async staging => coverage = await buildCovered(model.id, sites, async selected => {
    try { await adapter.acquire({ run, sites: selected, outputRoot: staging, maxSteps: values['max-steps'] === undefined ? undefined : Number(values['max-steps']) }); return { status: 0, text: 'built' }; }
    catch (error) { return { status: 1, text: `${model.id} build failed: ${error.message}` }; }
  }, log), (staging, id) => {
    const path = join(staging, id, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.trial = expectedForecastHours.length !== model.forecastHours.length;
    manifest.coverage = { requestedSiteHash, excluded: coverage.dropped, reason: 'outside-native-grid' };
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
    return postprocessAndArchiveModelOutput(staging, id);
  }, { referenceTime, expectedForecastHours, siteLocations: sites, expectedSitesAfterBuild: result => result.kept.map(site => site.slug) });
  log(`${model.id}: post-processed ${result.post.postprocessedCount} profiles (${plan.reason})`);
  return result;
}

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: "string" },
      sites: { type: "string", default: "sites.json" },
      output: { type: "string", default: "data" },
      'reference-time': { type: 'string' },
      'max-steps': { type: 'string' },
      'readiness-attempts': { type: 'string' },
      'readiness-delay-ms': { type: 'string' },
    },
  });
  if (!values.model) throw new Error("usage: node scripts/build-covered.mjs --model SLUG --sites sites.json --output data");
  if (values.model === 'icon-eu') {
    const args = [fileURLToPath(new URL('./build-icon.mjs', import.meta.url)), '--sites', values.sites, '--output', values.output];
    if (values['reference-time']) args.push('--reference-time', values['reference-time']);
    if (values['max-steps']) throw new Error('Use build-icon.mjs --hours for a separate trial dataset; production ICON requires all 78 hours');
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`ICON build exited ${signal ?? code}`)));
    });
    return;
  }
  const maxSteps = values['max-steps'] === undefined ? undefined : Number(values['max-steps']);
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) throw new Error('--max-steps must be a positive integer');
  await buildModel(values);

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
