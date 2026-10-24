// Build regional HRRR/RRFS daylight forecasts. Historical case namespaces are immutable;
// rolling updates use a separate -live namespace. Regions with the same field/hour
// selection share a capture. Replay and enrichment stay private until validated.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { capture } from '../soaring/capture.mjs';
import { replay } from '../soaring/replay.mjs';
import { modelFor } from '../soaring/common.mjs';
import { SOARING_CONTRACT_VERSION } from '../soaring/science.mjs';
import { COMPARISON_MODEL_ORDER, extractModelMetadata, normalizeLaunchComparisonHour } from '../soaring/model-comparison.mjs';
import { greatCircleDistanceKm } from '@azohra/meteo.grib';
import { isPublishedCase } from './merge-soaring-regions.mjs';
import { regionSupportsModel, regionIndexName } from './lib/model-coverage.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function loadRegionConfiguration(soaringV1Root) {
  const defaults = JSON.parse(readFileSync(join(ROOT, 'soaring', 'regions.json'), 'utf8'));
  const publishedPath = join(soaringV1Root, 'regions.json');
  if (!existsSync(publishedPath)) return { ...defaults, soaringContractVersion: SOARING_CONTRACT_VERSION };
  const published = JSON.parse(readFileSync(publishedPath, 'utf8'));
  const regions = new Map(defaults.regions.map(region => [region.id, region]));
  for (const region of published.regions ?? []) regions.set(region.id, { ...regions.get(region.id), ...region });
  return { ...defaults, ...published, soaringContractVersion: SOARING_CONTRACT_VERSION, regions: [...regions.values()] };
}

export function initialRegionSidecars(region) {
  const source = JSON.parse(readFileSync(join(ROOT, 'soaring', 'regions', `${region.id}.json`), 'utf8'));
  return { launches: source.launches, crossSection: source.crossSection, verification: null };
}

// A provider overlay must advertise only completed bundles it actually owns.
// Unbuilt active regions remain in the tracked configuration for the next run.
export function regionPublication(regionsDoc, model, soaringV1Root) {
  const regions = [];
  for (const region of regionsDoc.regions ?? []) {
    const native = (region.nativeModels ?? []).filter(entry =>
      (model === 'hrrr-conus' || entry.model === model) && isPublishedCase(soaringV1Root, entry.caseId));
    if (region.status === 'active-verified-trial' && !native.length) continue;
    const preferred = native.find(entry => entry.model === model) ?? native[0];
    const published = { ...region, ...(preferred ? { caseId: preferred.caseId } : {}), nativeModels: native };
    if (published.expandedCaseId && !isPublishedCase(soaringV1Root, published.expandedCaseId)) delete published.expandedCaseId;
    regions.push(published);
  }
  return {
    ...regionsDoc,
    soaringContractVersion: SOARING_CONTRACT_VERSION,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    regions,
  };
}

export function validateNativeRegions(dataRoot, model, referenceTime) {
  const root = join(dataRoot, 'soaring', 'v1');
  const configured = loadRegionConfiguration(root).regions.filter(region => region.status === 'active-verified-trial' && regionSupportsModel(region, model));
  if (!configured.length) throw new Error(`No active native ${model} regions configured`);
  const path = join(root, regionIndexName(model));
  if (!existsSync(path)) throw new Error(`Missing native ${model} region catalogue`);
  const catalogue = JSON.parse(readFileSync(path, 'utf8'));
  for (const region of configured) {
    const entry = catalogue.regions?.find(item => item.id === region.id)?.nativeModels?.find(item => item.model === model);
    if (!entry || !isRegionBundleCurrent(root, entry.caseId, referenceTime)) throw new Error(`Incomplete native ${model} forecast: ${region.id} @ ${referenceTime}`);
    const pointer = JSON.parse(readFileSync(join(root, entry.caseId, 'index.json'), 'utf8'));
    const bundle = join(root, entry.caseId, pointer.bundle);
    const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
    if ((manifest.model ?? manifest.case?.model ?? 'hrrr-conus') !== model
      || manifest.hours?.length !== manifest.case?.forecastHours?.length
      || manifest.case.forecastHours.some(hour => !manifest.hours.some(item => item.forecastHour === hour
        && Date.parse(item.validAt) === Date.parse(referenceTime) + hour * 3600000))) throw new Error(`Incomplete native ${model} hours: ${region.id}`);
    for (const name of ['launches.json', 'cross-section.json']) if (!manifest.files[name]) throw new Error(`Missing ${region.id} ${name}`);
    const launches = JSON.parse(readFileSync(join(bundle, 'launches.json'), 'utf8'));
    const section = JSON.parse(readFileSync(join(bundle, 'cross-section.json'), 'utf8'));
    if (launches.caseId !== entry.caseId || section.caseId !== entry.caseId || (section.nodes ?? []).length < 2
      || (region.launches ?? []).some(slug => !launches.launches?.some(launch => launch.slug === slug))) throw new Error(`Incomplete native ${model} geography: ${region.id}`);
  }
  return { model, referenceTime, regions: configured.length };
}

function writeAtomic(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(value)}\n`); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}

function verifyBundle(dir, manifest) {
  for (const name of ['grid.geojson', 'profile.json', 'audit.json', ...(manifest.hours ?? []).map(h => h.file)]) {
    if (!manifest.files?.[name]) throw new Error(`Incomplete bundle: ${name}`);
  }
  for (const [name, hash] of Object.entries(manifest.files ?? {})) {
    if (!/^[a-zA-Z0-9.-]+$/.test(name) || sha256(readFileSync(join(dir, name))) !== hash) throw new Error(`Corrupt bundle: ${name}`);
  }
}

/**
 * Remaining 07:00–20:00 hours in the first available local day, respecting DST.
 * Start at f02 because the capture reserves f01 for terrain.
 */
export function daytimeForecastHoursForCycle(referenceTimeIso, timeZone = 'America/Los_Angeles') {
  const run = Date.parse(referenceTimeIso);
  if (!Number.isFinite(run)) throw new Error('Invalid reference time');
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23' });
  let day;
  const hours = [];
  for (let h = 2; h <= 48; h++) {
    const p = Object.fromEntries(format.formatToParts(new Date(run + h * 3600000)).map(x => [x.type, x.value]));
    const date = `${p.year}-${p.month}-${p.day}`;
    if (+p.hour < 7 || +p.hour > 20) continue;
    day ??= date;
    if (date !== day) break;
    hours.push(h);
  }
  if (!hours.length) throw new Error('No daylight hours in forecast horizon');
  return hours;
}

/**
 * Builds a live case specification from a regional case template and a target HRRR `referenceTime`.
 */
export function buildLiveCaseSpec(templateCase, referenceTimeIso, model = 'hrrr-conus') {
  modelFor({ model });
  return {
    ...templateCase,
    model,
    id: `${templateCase.id}${model === 'rrfs' ? '-rrfs' : ''}-live`,
    referenceTime: referenceTimeIso,
    forecastHours: daytimeForecastHoursForCycle(referenceTimeIso, templateCase.site.timeZone),
  };
}

/**
 * Checks whether `data/soaring/v1/<caseId>` already points to a valid bundle for `referenceTimeIso`
 * built under the current `SOARING_CONTRACT_VERSION`.
 */
export function isRegionBundleCurrent(soaringV1Root, caseId, referenceTimeIso) {
  try {
    const indexPath = join(soaringV1Root, caseId, 'index.json');
    if (!existsSync(indexPath)) return false;
    const pointer = JSON.parse(readFileSync(indexPath, 'utf8'));
    if (!/^bundles\/[a-f0-9]{64}$/.test(pointer?.bundle)) return false;
    const manifestPath = join(soaringV1Root, caseId, pointer.bundle, 'manifest.json');
    if (!existsSync(manifestPath)) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest?.case?.referenceTime !== referenceTimeIso || manifest.case.id !== caseId) return false;
    if ((manifest.soaringContractVersion ?? '2.0.0') !== SOARING_CONTRACT_VERSION) return false;
    if (sha256(readFileSync(manifestPath)) !== pointer.manifestSha256) return false;
    verifyBundle(join(soaringV1Root, caseId, pointer.bundle), manifest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refreshes `launches.json`, `cross-section.json`, and `verification.json` from the previous
 * bundle into the newly replayed bundle directory and re-hashes `manifest.json` + `index.json`.
 */
export function enrichBundleWithSidecars(dataRoot, soaringV1Root, caseId, newBundleDir, previousSidecars) {
  const manifestPath = join(newBundleDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.soaringContractVersion ??= SOARING_CONTRACT_VERSION;
  const validSet = new Set((manifest.hours ?? []).map(h => h.validAt));

  const sameGeometry = previousSidecars.gridSha256 === manifest.files['grid.geojson'];
  const grid = JSON.parse(readFileSync(join(newBundleDir, 'grid.geojson'), 'utf8'));
  const remap = item => {
    const cells = grid.features ?? [];
    if (!cells.length) return sameGeometry ? item : null;
    if (![item.latitude, item.longitude].every(Number.isFinite)) return null;
    const ranked = cells.map(cell => ({ cell: cell.properties, distance: greatCircleDistanceKm(6371, item.latitude, item.longitude, cell.properties.latitude, cell.properties.longitude) }));
    const nearest = ranked.reduce((a, b) => b.distance < a.distance ? b : a);
    if (nearest.distance > (manifest.model === 'icon-eu' ? 8 : 5)) return null;
    return { ...item, cellIndex: nearest.cell.cellIndex, gridIndex: nearest.cell.gridIndex, modelElevationM: nearest.cell.modelElevationM, distanceKm: Math.round(nearest.distance * 100) / 100 };
  };
  if (previousSidecars.crossSection) {
    const crossSection = { ...previousSidecars.crossSection, caseId, model: manifest.model ?? 'hrrr-conus', nodes: (previousSidecars.crossSection.nodes ?? []).map(remap).filter(Boolean) };
    // Distances along the transect retain their existing meaning; nearest-cell
    // distance belongs only to launch metadata.
    crossSection.nodes = crossSection.nodes.map((node, i) => ({ ...node, distanceKm: previousSidecars.crossSection.nodes[i]?.distanceKm }));
    if (crossSection.nodes.length !== (previousSidecars.crossSection.nodes ?? []).length) throw new Error('Cross-section falls outside the new regional grid');
    const bytes = Buffer.from(`${JSON.stringify(crossSection)}\n`);
    writeFileSync(join(newBundleDir, 'cross-section.json'), bytes);
    manifest.files['cross-section.json'] = sha256(bytes);
  }

  if (previousSidecars.referenceTime === manifest.case.referenceTime && (previousSidecars.model ?? 'hrrr-conus') === (manifest.model ?? 'hrrr-conus') && previousSidecars.verification) {
    const bytes = Buffer.from(`${JSON.stringify(previousSidecars.verification)}\n`);
    writeFileSync(join(newBundleDir, 'verification.json'), bytes);
    manifest.files['verification.json'] = sha256(bytes);
  }

  if (previousSidecars.launches && (sameGeometry || grid.features?.length)) {
    const launchesDoc = structuredClone(previousSidecars.launches);
    launchesDoc.caseId = caseId;
    launchesDoc.model = manifest.model ?? 'hrrr-conus';
    launchesDoc.launches = (launchesDoc.launches ?? []).map(remap).filter(Boolean);
    delete launchesDoc.raob;
    const office = launchesDoc.nwsOffice?.office;
    const officePath = office && join(dataRoot, 'nws', 'offices', `${office}.json`);
    launchesDoc.nwsOffice = officePath && existsSync(officePath) ? JSON.parse(readFileSync(officePath, 'utf8')) : null;
    for (const launch of launchesDoc.launches ?? []) {
      launch.models = {};
      const slug = launch.slug;
      for (const mslug of COMPARISON_MODEL_ORDER) {
        const mp = join(dataRoot, mslug, 'sites', `${slug}.json`);
        if (!existsSync(mp)) continue;
        const mdoc = JSON.parse(readFileSync(mp, 'utf8'));
        const byValid = new Map((mdoc.hours ?? []).filter(h => Number.isFinite(Date.parse(h.validAt))).map(h => [Date.parse(h.validAt), h]));
        const matchedHours = [...validSet].map(v => {
          const hour = byValid.get(Date.parse(v));
          return hour ? { ...hour, validAt: v } : null;
        }).filter(Boolean);
        if (matchedHours.length === 0) continue;
        const meta = extractModelMetadata(mdoc, mslug);
        launch.models[mslug] = {
          referenceTime: mdoc.run?.referenceTime ?? mdoc.models?.surface?.run ?? mdoc.updateTime ?? null,
          modelElevationM: meta.modelElevationM,
          hours: matchedHours.map(mh => normalizeLaunchComparisonHour(mslug, mh)),
        };
      }
    }
    const bytes = Buffer.from(`${JSON.stringify(launchesDoc)}\n`);
    writeFileSync(join(newBundleDir, 'launches.json'), bytes);
    manifest.files['launches.json'] = sha256(bytes);
  }

  verifyBundle(newBundleDir, manifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const finalBundleHash = sha256(manifestBytes);
  writeFileSync(manifestPath, manifestBytes);
  const caseDir = join(soaringV1Root, caseId);
  const finalDest = join(caseDir, 'bundles', finalBundleHash);
  mkdirSync(join(caseDir, 'bundles'), { recursive: true });
  if (newBundleDir !== finalDest) {
    if (existsSync(finalDest)) {
      verifyBundle(finalDest, manifest);
      if (sha256(readFileSync(join(finalDest, 'manifest.json'))) !== finalBundleHash) throw new Error('Corrupt existing manifest');
    } else renameSync(newBundleDir, finalDest);
  }
  const indexDoc = {
    schemaVersion: 1,
    caseId,
    bundle: `bundles/${finalBundleHash}`,
    manifestSha256: finalBundleHash,
  };
  writeAtomic(join(caseDir, 'index.json'), indexDoc);
  return finalDest;
}

/**
 * Removes older `bundles/<sha>` directories that are no longer referenced by `index.json`.
 */
export function pruneSupersededBundles(soaringV1Root, caseId) {
  const caseDir = join(soaringV1Root, caseId);
  const indexPath = join(caseDir, 'index.json');
  const bundlesDir = join(caseDir, 'bundles');
  if (!existsSync(indexPath) || !existsSync(bundlesDir)) return 0;
  const pointer = JSON.parse(readFileSync(indexPath, 'utf8'));
  const activeId = String(pointer.bundle ?? '').replace(/^bundles\//, '');
  let removed = 0;
  for (const entry of readdirSync(bundlesDir)) {
    // Keep recent bundles for clients still loading through an older pointer.
    if (/^[a-f0-9]{64}$/.test(entry) && entry !== activeId && Date.now() - statSync(join(bundlesDir, entry)).mtimeMs > 48 * 3600000) {
      rmSync(join(bundlesDir, entry), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

function readPreviousSidecars(soaringV1Root, caseId) {
  try {
    const caseDir = join(soaringV1Root, caseId);
    const pointer = JSON.parse(readFileSync(join(caseDir, 'index.json'), 'utf8'));
    if (!/^bundles\/[a-f0-9]{64}$/.test(pointer.bundle)) throw new Error('Invalid pointer');
    const bundleDir = join(caseDir, pointer.bundle);
    const readOpt = name => {
      const p = join(bundleDir, name);
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    };
    const manifest = readOpt('manifest.json');
    return {
      referenceTime: manifest?.case?.referenceTime,
      model: manifest?.model ?? manifest?.case?.model ?? 'hrrr-conus',
      gridSha256: manifest?.files?.['grid.geojson'],
      launches: readOpt('launches.json'),
      crossSection: readOpt('cross-section.json'),
      verification: readOpt('verification.json'),
    };
  } catch {
    return { launches: null, crossSection: null, verification: null };
  }
}

export async function buildLiveSoaring(values, { captureImpl = capture, replayImpl = replay, log = console.log } = {}) {
  const dataRoot = resolve(values.output ?? 'data');
  const model = modelFor({ model: values.model ?? 'hrrr-conus' });
  if (model === 'icon-eu' && !values['validate-only']) {
    throw new Error('Build ICON-EU points and native maps together with node scripts/build-icon.mjs --sites sites.json --output data');
  }
  const soaringV1Root = join(dataRoot, 'soaring', 'v1');
  const regionsPath = join(soaringV1Root, 'regions.json');

  const modelManifestPath = join(dataRoot, model, 'manifest.json');
  const referenceTime = values['reference-time'] ?? (
    existsSync(modelManifestPath)
      ? JSON.parse(readFileSync(modelManifestPath, 'utf8'))?.referenceTime
      : null
  );
  if (!referenceTime) {
    if (model === 'rrfs' || model === 'icon-eu') throw new Error(`No ${model.toUpperCase()} referenceTime available for the required native regional build`);
    log(`No ${model} referenceTime available; keeping seeded soaring bundles.`);
    return;
  }
  if (values['validate-only']) return validateNativeRegions(dataRoot, model, referenceTime);

  const regionsDoc = loadRegionConfiguration(soaringV1Root);
  mkdirSync(soaringV1Root, { recursive: true });
  const modelRegionsPath = join(soaringV1Root, regionIndexName(model));
  if (model !== 'hrrr-conus' && existsSync(modelRegionsPath)) {
    const prior = JSON.parse(readFileSync(modelRegionsPath, 'utf8'));
    for (const region of regionsDoc.regions ?? []) {
      const entry = prior.regions?.find(r => r.id === region.id)?.nativeModels?.find(m => m.model === model);
      if (entry) region.nativeModels = [...(region.nativeModels ?? []).filter(m => m.model !== model), entry];
    }
  }
  const activeRegions = (regionsDoc.regions ?? []).filter(r => r.status === 'active-verified-trial' && typeof r.caseId === 'string' && regionSupportsModel(r, model));
  if (activeRegions.length === 0) {
    if (model === 'rrfs') throw new Error('No active RRFS regions configured');
    log('No active-verified-trial regions configured; skipping.');
    return;
  }

  const templateId = r => r.templateCaseId ?? r.caseId.replace(/-live$/, '');
  const liveId = r => `${templateId(r)}${model === 'rrfs' ? '-rrfs' : ''}-live`;
  const pendingRegions = activeRegions.filter(r => {
    if (!isRegionBundleCurrent(soaringV1Root, liveId(r), referenceTime)) return true;
    r.nativeModels = [...(r.nativeModels ?? []).filter(entry => entry.model !== model), { model, caseId: liveId(r) }];
    return false;
  });
  const publishRegions = () => writeAtomic(modelRegionsPath, regionPublication(regionsDoc, model, soaringV1Root));
  if (pendingRegions.length === 0) {
    publishRegions();
    validateNativeRegions(dataRoot, model, referenceTime);
    log(`All ${activeRegions.length} active soaring region(s) already at ${referenceTime}; skipping rebuild.`);
    return;
  }

  const runKey = referenceTime.replace(/[-:]/g, '').replace('.000Z', 'Z');
  const sharedCacheDir = resolve(values['cache-root'] ?? join(ROOT, '.soaring-cache', `live-${model}-${runKey}`));

  const liveCases = pendingRegions.map(region => {
    const templatePath = join(ROOT, 'soaring', 'cases', `${templateId(region)}.json`);
    const template = JSON.parse(readFileSync(templatePath, 'utf8'));
    let previousSidecars = readPreviousSidecars(soaringV1Root, liveId(region));
    if (!previousSidecars.launches) previousSidecars = readPreviousSidecars(soaringV1Root, region.caseId);
    if (!previousSidecars.launches || !previousSidecars.crossSection) {
      const initial = initialRegionSidecars(region);
      previousSidecars = { ...previousSidecars, launches: previousSidecars.launches ?? initial.launches, crossSection: previousSidecars.crossSection ?? initial.crossSection };
    }
    return { region, caseSpec: buildLiveCaseSpec(template, referenceTime, model), previousSidecars };
  });

  try {
    log(`Capturing shared CONUS ${model} records for ${referenceTime} into ${sharedCacheDir}...`);
    const captures = new Set();

    for (const { region, caseSpec, previousSidecars } of liveCases) {
      log(`Replaying 3 km regional grid for ${region.id} (${caseSpec.id} @ ${referenceTime})...`);
      const key = sha256(JSON.stringify([caseSpec.forecastHours, caseSpec.pressureLevels, caseSpec.includeExtendedFields]));
      const cache = join(sharedCacheDir, key);
      if (!captures.has(key)) { await captureImpl(caseSpec, cache); captures.add(key); }
      const staging = mkdtempSync(join(soaringV1Root, '.live-'));
      try {
        const res = await replayImpl(caseSpec, cache, staging);
        const enrichedPath = enrichBundleWithSidecars(dataRoot, soaringV1Root, caseSpec.id, res.path, previousSidecars);
        region.templateCaseId = templateId(region);
        region.nativeModels = [...(region.nativeModels ?? [{ model: 'hrrr-conus', caseId: region.caseId }]).filter(m => m.model !== model), { model, caseId: caseSpec.id }];
        if (model === 'hrrr-conus') region.caseId = caseSpec.id;
        publishRegions();
        const pruned = pruneSupersededBundles(soaringV1Root, caseSpec.id);
        log(`Built ${region.id} -> ${enrichedPath} (pruned ${pruned} old bundle(s))`);
      } finally { rmSync(staging, { recursive: true, force: true }); }
    }

    regionsDoc.generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    publishRegions();
    validateNativeRegions(dataRoot, model, referenceTime);
  } finally {
    if (!values['cache-root']) {
      rmSync(sharedCacheDir, { recursive: true, force: true });
    }
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    output: { type: 'string', default: 'data' },
    'reference-time': { type: 'string' },
    'cache-root': { type: 'string' },
    model: { type: 'string', default: 'hrrr-conus' },
    'validate-only': { type: 'boolean', default: false },
  } });
  const result = await buildLiveSoaring(values);
  if (values['validate-only']) console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Live soaring build failed; previous bundles remain available: ${error.message}`);
    process.exitCode = 1;
  });
}
