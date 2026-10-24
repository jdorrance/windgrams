// One acquisition supplies every Armenian point and native regional map.
// Validate in staging, then replace provider-owned files with rollback on error.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseForecastManifest, parseSiteForecast } from '@azohra/meteo.briefing/contract';
import { acquireIcon, buildIconPointProfiles, ICON_FORECAST_HOURS, readIconAcquisition } from './lib/icon-eu.mjs';
import { writeIconRegionalBundle } from '../soaring/icon-replay.mjs';
import { assertAgreement } from '../soaring/science.mjs';
import { postprocessAndArchiveModelOutput } from './build-covered.mjs';
import { archiveModelRun } from '../verification/history.mjs';
import { enrichBundleWithSidecars, initialRegionSidecars, regionPublication, validateNativeRegions } from './build-live-soaring.mjs';
import { mergeSoaringRegionFiles } from './merge-soaring-regions.mjs';
import { contextIsFresh, measure } from './terrain.mjs';
import { armeniaTerrainFragment } from './merge-armenia-terrain.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = path => JSON.parse(path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString() : readFileSync(path, 'utf8'));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value) + '\n'); };
const amSites = sites => sites.filter(site => site.timeZone === 'Asia/Yerevan');

// Native columns are large. Keep the current and previous complete ICON bundle
// for open browser tabs; US models retain their existing 48-hour policy.
export function pruneIconBundles(root, caseId) {
  const caseRoot = join(root, caseId), bundles = join(caseRoot, 'bundles');
  const active = read(join(caseRoot, 'index.json')).bundle.replace('bundles/', '');
  const older = readdirSync(bundles).filter(name => /^[a-f0-9]{64}$/.test(name) && name !== active)
    .map(name => ({ name, capturedAt: Date.parse(read(join(bundles, name, 'manifest.json')).capturedAt) }))
    .sort((a, b) => b.capturedAt - a.capturedAt);
  for (const { name } of older.slice(1)) rmSync(join(bundles, name), { recursive: true, force: true });
}

export function validateIconDataset(output, sites, { expectedHours = ICON_FORECAST_HOURS } = {}) {
  if (!expectedHours.length || expectedHours.some((hour, i) => !Number.isInteger(hour) || hour < 1 || hour > 78 || (i > 0 && hour <= expectedHours[i - 1]))) {
    throw new Error('Invalid ICON expected horizon');
  }
  const manifest = read(join(output, 'icon-eu', 'manifest.json'));
  if (!parseForecastManifest(manifest) || manifest.model !== 'icon-eu' || manifest.forecastHours !== expectedHours.length
    || manifest.firstForecastHour !== expectedHours[0] || manifest.lastForecastHour !== expectedHours.at(-1)) throw new Error('Incomplete ICON point manifest');
  const expectedSites = new Map(amSites(sites).map(site => [site.slug, site]));
  const expected = [...expectedSites.keys()].sort();
  const published = manifest.sites.map(site => site.slug).sort();
  if (JSON.stringify(expected) !== JSON.stringify(published)) throw new Error('ICON launch inventory differs from the catalogue');
  validateNativeRegions(output, 'icon-eu', manifest.referenceTime);
  const pointer = read(join(output, 'soaring/v1/armenia-icon-eu-live/index.json'));
  const bundle = join(output, 'soaring/v1/armenia-icon-eu-live', pointer.bundle);
  const regional = read(join(bundle, 'manifest.json'));
  if (JSON.stringify(regional.case.forecastHours) !== JSON.stringify(expectedHours)) throw new Error('Incomplete ICON regional horizon');
  const grid = read(join(bundle, 'grid.geojson'));
  const cellByGridIndex = new Map(grid.features.map(feature => [feature.properties.gridIndex, feature.properties.cellIndex]));
  const hours = regional.hours.map(hour => read(join(bundle, hour.file)));
  for (const slug of expected) {
    const doc = read(join(output, 'icon-eu/sites', `${slug}.json`));
    const site = expectedSites.get(slug);
    if (!parseSiteForecast(doc) || doc.model !== 'icon-eu' || doc.run.referenceTime !== manifest.referenceTime || doc.hours.length !== expectedHours.length
      || doc.site.id !== slug || doc.site.name !== site.name || doc.site.latitude !== site.latitude || doc.site.longitude !== site.longitude || doc.site.timeZone !== site.timeZone
      || doc.semantics?.gust !== 'hourMax' || doc.semantics?.precipitation !== 'windowMeanRate') throw new Error(`Invalid ICON profile: ${slug}`);
    for (let i = 0; i < doc.hours.length; i++) {
      const hour = doc.hours[i];
      if (Date.parse(hour.validAt) !== Date.parse(manifest.referenceTime) + expectedHours[i] * 3600000
        || hour.levels.length < 3 || !hour.soaring || hour.levels.some(level => !Number.isFinite(level.pressureHpa) || !Number.isFinite(level.heightM))) {
        throw new Error(`Incomplete ICON hour: ${slug} f${expectedHours[i]}`);
      }
    }
    const cellIndex = cellByGridIndex.get(doc.source?.gridIndex);
    if (!Number.isInteger(cellIndex)) throw new Error(`ICON launch has no native cell: ${slug}`);
    assertAgreement(doc, hours, cellIndex);
    const cellProfile = read(join(bundle, `cell-${cellIndex}.json.gz`));
    if (!parseSiteForecast(cellProfile) || cellProfile.run.referenceTime !== manifest.referenceTime || cellProfile.source?.gridIndex !== doc.source.gridIndex
      || JSON.stringify(cellProfile.hours.map(hour => hour.levels)) !== JSON.stringify(doc.hours.map(hour => hour.levels))) throw new Error(`ICON lazy profile differs from launch column: ${slug}`);
  }
  return { model: 'icon-eu', referenceTime: manifest.referenceTime, sites: expected.length, hours: expectedHours.length, cells: regional.cellCount };
}

export async function ensureArmeniaTerrain(output, sites, measureImpl = measure) {
  const path = join(output, 'site-context.json');
  const old = existsSync(path) ? read(path) : null;
  const pending = sites.filter(site => !contextIsFresh([site], old) || old.sites[site.slug]?.elevation?.source !== 'glo90'
    || !Number.isFinite(old.sites[site.slug]?.elevation?.elevationM));
  if (!pending.length) {
    write(join(output, 'site-context-armenia.json'), armeniaTerrainFragment(old, sites));
    return old;
  }
  const measured = await measureImpl(pending);
  const context = { ...measured, sites: { ...old?.sites, ...measured.sites },
    sources: [...new Map([...(old?.sources ?? []), ...measured.sources].map(source => [source.id, source])).values()] };
  const fragment = armeniaTerrainFragment(context, sites);
  write(path, context);
  write(join(output, 'site-context-armenia.json'), fragment);
  return context;
}

/** All source and derived documents are complete before any live pointer moves. */
export async function buildIconDataset({ output, sites, acquired, context, expectedHours = ICON_FORECAST_HOURS, log = console.log }) {
  sites = amSites(sites);
  if (!sites.length) throw new Error('No Armenian launches configured');
  if (JSON.stringify(acquired.hours.map(hour => hour.forecastHour)) !== JSON.stringify(expectedHours)) throw new Error('ICON acquisition horizon differs from request');
  const regions = read(join(ROOT, 'soaring/regions.json'));
  const region = regions.regions.find(item => item.id === 'armenia');
  if (!region || JSON.stringify([...region.launches].sort()) !== JSON.stringify(sites.map(site => site.slug).sort())) throw new Error('Armenian region launch inventory differs from catalogue');
  const oldManifest = join(output, 'icon-eu/manifest.json');
  if (existsSync(oldManifest) && Date.parse(read(oldManifest).referenceTime) > Date.parse(acquired.referenceTime)) throw new Error('Refusing an older ICON run');
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(join(output, '.build-icon-'));
  try {
    write(join(staging, 'site-context.json'), context);
    for (const model of [...region.deterministicModels, ...region.ensembleModels]) {
      if (model !== 'icon-eu' && existsSync(join(output, model))) symlinkSync(resolve(output, model), join(staging, model), 'dir');
    }
    await buildIconPointProfiles({ sites, outputRoot: staging, acquisition: acquired });
    postprocessAndArchiveModelOutput(staging, 'icon-eu');
    const root = join(staging, 'soaring/v1');
    log(`Deriving ${acquired.cells.length} native ICON cells × ${acquired.hours.length} hours`);
    const { dir, manifest } = writeIconRegionalBundle(acquired, region, sites, context, root);
    const sidecars = initialRegionSidecars(region);
    // Coordinate and terrain edits flow into every refreshed bundle.
    sidecars.launches.launches = sites.map(site => ({ ...site, launchElevationM: context.sites[site.slug].elevation.elevationM }));
    enrichBundleWithSidecars(staging, root, manifest.case.id, dir, sidecars);
    const oldBundles = join(output, 'soaring/v1', manifest.case.id, 'bundles');
    if (existsSync(oldBundles)) cpSync(oldBundles, join(root, manifest.case.id, 'bundles'), { recursive: true, force: false, preserveTimestamps: true });
    pruneIconBundles(root, manifest.case.id);
    region.nativeModels = [{ model: 'icon-eu', caseId: manifest.case.id }];
    region.caseId = manifest.case.id;
    write(join(root, 'regions-icon-eu.json'), regionPublication({ ...regions, regions: [region] }, 'icon-eu', root));
    const validated = validateIconDataset(staging, sites, { expectedHours });
    const targets = ['icon-eu', 'soaring/v1/armenia-icon-eu-live', 'soaring/v1/regions-icon-eu.json'];
    const moved = [], backed = [];
    try {
      for (const relative of targets) {
        const live = join(output, relative), backup = join(staging, 'previous', relative);
        mkdirSync(dirname(live), { recursive: true });
        if (existsSync(live)) { mkdirSync(dirname(backup), { recursive: true }); renameSync(live, backup); backed.push(relative); }
        renameSync(join(staging, relative), live); moved.push(relative);
      }
    } catch (error) {
      for (const relative of moved.reverse()) rmSync(join(output, relative), { recursive: true, force: true });
      for (const relative of backed.reverse()) renameSync(join(staging, 'previous', relative), join(output, relative));
      throw error;
    }
    archiveModelRun(output, 'icon-eu');
    mergeSoaringRegionFiles(output);
    log(`ICON-EU complete: ${validated.sites} launches, ${validated.cells} native cells, ${validated.hours} hours`);
    return validated;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

async function main() {
  const { values } = parseArgs({ options: {
    output: { type: 'string', default: 'data' }, sites: { type: 'string', default: 'sites.json' },
    'reference-time': { type: 'string' }, 'cache-root': { type: 'string', default: '.soaring-cache/icon-eu' },
    acquired: { type: 'string' }, hours: { type: 'string' }, 'validate-only': { type: 'boolean', default: false },
    'prune-only': { type: 'boolean', default: false },
  } });
  const output = resolve(values.output);
  if (values['prune-only']) {
    const root = join(output, 'soaring/v1'), caseId = 'armenia-icon-eu-live';
    if (existsSync(join(root, caseId, 'index.json'))) pruneIconBundles(root, caseId);
    return;
  }
  const sites = read(resolve(values.sites)).sites;
  if (values['validate-only']) { console.log(validateIconDataset(output, sites)); return; }
  const expectedHours = values.hours ? values.hours.split(',').map(Number) : ICON_FORECAST_HOURS;
  const context = await ensureArmeniaTerrain(output, amSites(sites));
  const region = read(join(ROOT, 'soaring/regions.json')).regions.find(region => region.id === 'armenia');
  const acquired = values.acquired ? readIconAcquisition(resolve(values.acquired)) : await acquireIcon({
    referenceTime: values['reference-time'], sites: amSites(sites), bbox: region.bbox,
    forecastHours: expectedHours, cacheDir: resolve(values['cache-root']),
  });
  if (values['reference-time'] && Date.parse(acquired.referenceTime) !== Date.parse(values['reference-time'])) throw new Error('Acquired ICON run differs from request');
  await buildIconDataset({ output, sites, acquired, context, expectedHours });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
