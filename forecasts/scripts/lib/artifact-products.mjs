// Application publication policy. Generic staging stays in @windgrams/pipeline.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { catalogueFingerprint, validateModelDirectory } from '@windgrams/pipeline';
import { MODELS, modelCoversSite, modelDescriptor } from '@windgrams/providers/registry';
import { validateReplayManifest, validateReplayGrid, validateReplayHour, validateReplayAudit, validateLaunchesDoc, validateCrossSectionDoc } from '@windgrams/contracts/regional';
import { parsePublishedProfileJson } from '@windgrams/contracts/published-lift';
import { validateCurrentDiagnostics } from './diagnostic-completeness.mjs';
import { validateRrfsProfile } from '../validate-rrfs.mjs';
import { legacyCaseModel } from './model-coverage.mjs';
import { SOARING_CONTRACT_VERSION } from '../../soaring/science.mjs';

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const readBundleJson = path => JSON.parse(path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8'));
const ownedRoots = new Set([...MODELS.map(model => model.id), 'ecmwf', 'nws', 'raob', 'history', 'health', 'soaring', 'sites.json', 'models.json', 'runs.json']);
/** Publication owns forecast products; large optional solar/source caches stay in place. */
export const publicationOwnedName = name => ownedRoots.has(name) || /^site-context(?:-[a-z0-9-]+)?\.json$/.test(name);
export const timestamp = value => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new Error('Missing or invalid publication timestamp');
  return time;
};

/** Incoming artifacts contain data files only; aliases never cross the publication boundary. */
export function validateFileTree(root) {
  const stat = lstatSync(root);
  if (stat.isDirectory()) for (const name of readdirSync(root)) validateFileTree(join(root, name));
  else if (!stat.isFile()) throw new Error(`Artifact contains a symbolic link or special file: ${root}`);
}

export function pointProduct(root, model, sites) {
  const descriptor = modelDescriptor(model);
  const manifest = readJson(join(root, model, 'manifest.json'));
  if (manifest.trial) throw new Error(`${model}: trial forecasts cannot replace production`);
  const covered = sites.filter(site => modelCoversSite(model, site));
  const exclusions = manifest.coverage?.excluded ?? [];
  if (exclusions.length && (manifest.coverage.requestedSiteHash !== catalogueFingerprint(covered)
    || exclusions.some(slug => !covered.some(site => site.slug === slug)))) throw new Error(`${model}: outdated coverage inventory`);
  validateModelDirectory(root, { model, expectedSites: covered.filter(site => !exclusions.includes(site.slug)).map(site => site.slug),
    siteLocations: covered, expectedForecastHours: descriptor.forecastHours, validateProfile: (profile, run, slug) => {
      validateCurrentDiagnostics(profile, run, slug);
      if (model === 'rrfs') validateRrfsProfile(profile, run, slug);
    } });
  return { referenceTime: timestamp(manifest.referenceTime), generatedAt: timestamp(manifest.generatedAt), manifest };
}

export function regionalProduct(root, caseId, models) {
  if (!/^[a-zA-Z0-9_-]+$/.test(caseId)) throw new Error('Invalid regional case identity');
  const pointer = readJson(join(root, caseId, 'index.json'));
  if (!/^bundles\/[a-f0-9]{64}$/.test(pointer.bundle)) throw new Error(`${caseId}: invalid regional pointer`);
  const bundle = join(root, caseId, pointer.bundle);
  if (digest(join(bundle, 'manifest.json')) !== pointer.manifestSha256) throw new Error(`${caseId}: corrupt regional manifest`);
  const manifest = validateReplayManifest(readJson(join(bundle, 'manifest.json')));
  if (!manifest || manifest.case.id !== caseId || !manifest.files) throw new Error(`${caseId}: invalid regional manifest`);
  const model = manifest.model ?? manifest.case?.model ?? legacyCaseModel(caseId);
  if (!models.includes(model)) throw new Error(`${caseId}: incorrect provider ownership`);
  if (manifest.soaringContractVersion !== SOARING_CONTRACT_VERSION) throw new Error(`${caseId}: outdated diagnostic method`);
  const hours = manifest.case?.forecastHours;
  if (!Array.isArray(hours) || !hours.length || hours.some((hour, i) => !Number.isInteger(hour) || hour < 0 || i && hour <= hours[i - 1])
    || manifest.hours.length !== hours.length || manifest.hours.some((hour, i) => hour.forecastHour !== hours[i]
      || timestamp(hour.validAt) !== timestamp(manifest.case.referenceTime) + hours[i] * 3600000)) {
    throw new Error(`${caseId}: incomplete regional horizon`);
  }
  for (const name of ['grid.geojson', 'profile.json', 'audit.json', 'launches.json', 'cross-section.json', ...manifest.hours.map(hour => hour.file)]) {
    if (!manifest.files[name]) throw new Error(`${caseId}: missing required regional file ${name}`);
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!/^[a-zA-Z0-9.-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(expected) || digest(join(bundle, name)) !== expected) throw new Error(`${caseId}: corrupt regional file ${name}`);
  }
  const grid = validateReplayGrid(readJson(join(bundle, 'grid.geojson')), manifest.cellCount);
  const audit = validateReplayAudit(readJson(join(bundle, 'audit.json')));
  if (audit.mapProfileAgreement.exact !== true || audit.mapProfileAgreement.hours !== hours.length) throw new Error(`${caseId}: incomplete regional agreement audit`);
  for (const item of manifest.hours) {
    const hour = validateReplayHour(readBundleJson(join(bundle, item.file)), manifest.cellCount);
    if (!hour || hour.forecastHour !== item.forecastHour || timestamp(hour.validAt) !== timestamp(item.validAt)
      || hour.soaringContractVersion !== SOARING_CONTRACT_VERSION) throw new Error(`${caseId}: invalid regional hour ${item.file}`);
  }
  const checkProfile = (name, gridIndex) => {
    const raw = readBundleJson(join(bundle, name)), profile = parsePublishedProfileJson(JSON.stringify(raw));
    if (!profile || profile.model !== model || timestamp(profile.run.referenceTime) !== timestamp(manifest.case.referenceTime)
      || profile.hours.length !== hours.length || profile.hours.some((hour, i) => timestamp(hour.validAt) !== timestamp(manifest.hours[i].validAt))
      || gridIndex !== undefined && raw.source?.gridIndex !== gridIndex) throw new Error(`${caseId}: regional profile differs from manifest: ${name}`);
    // Regional manifests own method identity; legacy regional profiles have no point metadata.
    validateCurrentDiagnostics({ ...raw, soaringMeta: { contractVersion: manifest.soaringContractVersion, modelKind: 'deterministic-column' } });
  };
  checkProfile('profile.json');
  if (manifest.cellProfiles) for (const feature of grid.features) {
    const name = manifest.cellProfiles.replace('{index}', String(feature.properties.cellIndex));
    if (!manifest.files[name]) throw new Error(`${caseId}: missing regional cell profile ${name}`);
    checkProfile(name, feature.properties.gridIndex);
  }
  const launches = validateLaunchesDoc(readJson(join(bundle, 'launches.json'))), section = validateCrossSectionDoc(readJson(join(bundle, 'cross-section.json')));
  if (!launches || !section || launches.caseId !== undefined && launches.caseId !== caseId || section.caseId !== undefined && section.caseId !== caseId
    || launches.model && launches.model !== model || section.model && section.model !== model
    || manifest.case.site.slug && !launches.launches.some(launch => launch.slug === manifest.case.site.slug)
    || [...launches.launches, ...section.nodes].some(item => item.cellIndex >= manifest.cellCount || grid.features[item.cellIndex].properties.gridIndex !== item.gridIndex)) throw new Error(`${caseId}: invalid regional geography`);
  return { model, pointer, manifest, launchSlugs: launches.launches.map(launch => launch.slug), referenceTime: timestamp(manifest.case.referenceTime), generatedAt: timestamp(manifest.capturedAt) };
}

/** Reference time is authoritative even when the retained product needs repair. */
export function newerProduct(next, previous, previousValid) {
  if (!previous) return true;
  if (next.referenceTime !== previous.referenceTime) return next.referenceTime > previous.referenceTime;
  return !previousValid || next.generatedAt > previous.generatedAt;
}

export function replaceTree(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const staging = mkdtempSync(join(dirname(destination), '.publication-'));
  const next = join(staging, 'next'), previous = join(staging, 'previous');
  try {
    cpSync(source, next, { recursive: true });
    if (existsSync(destination)) renameSync(destination, previous);
    try { renameSync(next, destination); }
    catch (error) { if (existsSync(previous)) renameSync(previous, destination); throw error; }
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function writeJson(path, document) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.publication.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(document)}\n`); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export function copyImmutable(source, destination, { expectedSha256, repairCorrupt = false } = {}) {
  const verified = digest(source);
  if (expectedSha256 && verified !== expectedSha256) throw new Error(`Unverified immutable source: ${source}`);
  if (existsSync(destination)) {
    if (verified !== digest(destination)) {
      if (!repairCorrupt || !expectedSha256) throw new Error(`Conflicting immutable file: ${destination}`);
      const temporary = `${destination}.repair.tmp`;
      try { cpSync(source, temporary); renameSync(temporary, destination); }
      finally { rmSync(temporary, { force: true }); }
    }
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}
