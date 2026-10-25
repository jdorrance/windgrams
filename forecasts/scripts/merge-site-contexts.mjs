// Merge provider terrain without letting an old cache overwrite a fresh launch.
// Publication stops when a current point forecast lacks matching launch terrain.
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseSiteContextJson, parseSiteForecast } from '@azohra/meteo.briefing/contract';
import { MODELS } from '@windgrams/providers/registry';
import { terrainPolicyId, terrainSourcesMatchPolicy } from './lib/terrain-policy.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const sourcesOf = entry => [entry.elevation.source, entry.terrain.source, entry.landCover.source];

function validateContext(document) {
  if (!parseSiteContextJson(JSON.stringify(document)) || !stamp(document.generatedAt)) throw new Error('Invalid provider terrain context');
  return document;
}

function candidate(document, site, allowLegacy) {
  const entry = document?.sites?.[site.slug];
  if (!entry || entry.point.latitude !== site.latitude || entry.point.longitude !== site.longitude
    || !Number.isFinite(entry.elevation.elevationM)) return null;
  const policy = document.measurementPolicies?.[site.slug];
  // One-time source-verified metadata migration. The measured values stay intact.
  if (policy !== terrainPolicyId(site) && !(allowLegacy && policy === undefined && terrainSourcesMatchPolicy(entry, site))) return null;
  const measuredAt = document.measurementTimes?.[site.slug] ?? document.generatedAt;
  if (!stamp(measuredAt)) return null;
  const credits = new Map(document.sources.map(source => [source.id, source]));
  if (sourcesOf(entry).some(id => !credits.has(id))) return null;
  return { entry, measuredAt, credits };
}

/** Current coordinates and policy win first; measurement time breaks ties. */
export function mergeSiteContextDocuments(context, fragments, sites) {
  if (context) validateContext(context);
  fragments.forEach(validateContext);
  if (!context && !fragments.length) return null;
  const entries = {}, measurementPolicies = {}, measurementTimes = {}, credits = new Map();
  for (const document of [context, ...fragments].filter(Boolean)) {
    for (const source of document.sources) if (!credits.has(source.id)) credits.set(source.id, source);
  }
  for (const site of sites) {
    let selected = context ? candidate(context, site, true) : null;
    for (const fragment of fragments) {
      const next = candidate(fragment, site, false);
      if (next && (!selected || Date.parse(next.measuredAt) > Date.parse(selected.measuredAt))) selected = next;
    }
    if (!selected) continue;
    entries[site.slug] = selected.entry;
    measurementPolicies[site.slug] = terrainPolicyId(site);
    measurementTimes[site.slug] = selected.measuredAt;
    for (const id of sourcesOf(selected.entry)) credits.set(id, selected.credits.get(id));
  }
  const generatedAt = Object.values(measurementTimes).sort((a, b) => Date.parse(b) - Date.parse(a))[0]
    ?? (context ?? fragments[0]).generatedAt;
  return validateContext({ schemaVersion: 3, generatedAt, sources: [...credits.values()], sites: entries,
    measurementPolicies, measurementTimes });
}

/** Verify every currently catalogued published point before committing terrain. */
export function validatePublishedTerrain(output, sites, context) {
  const catalogue = new Map(sites.map(site => [site.slug, site]));
  let checked = 0;
  for (const model of MODELS) {
    const manifestPath = join(output, model.id, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = read(manifestPath);
    if (manifest.model !== model.id || !Array.isArray(manifest.sites)) throw new Error(`Invalid published model manifest: ${model.id}`);
    for (const published of manifest.sites) {
      const site = catalogue.get(published.slug);
      if (!site) continue;
      const raw = read(join(output, model.id, 'sites', `${site.slug}.json`));
      const profile = parseSiteForecast(raw);
      if (!profile || profile.model !== model.id || profile.site.id !== site.slug
        || profile.site.latitude !== site.latitude || profile.site.longitude !== site.longitude
        || Date.parse(profile.run.referenceTime) !== Date.parse(manifest.referenceTime)) {
        throw new Error(`Published profile differs from current launch: ${model.id}/${site.slug}`);
      }
      const terrain = context && candidate(context, site, false);
      if (!terrain) throw new Error(`Missing current launch terrain: ${model.id}/${site.slug}`);
      const usedElevation = raw.soaringMeta?.launchElevationM;
      if (Number.isFinite(usedElevation) && Math.abs(usedElevation - terrain.entry.elevation.elevationM) > 0.051) {
        throw new Error(`Published diagnostics use different launch terrain: ${model.id}/${site.slug}`);
      }
      checked++;
    }
  }
  return checked;
}

/** Fragments remain on disk if validation fails; the previous context is untouched. */
export function mergeSiteContextFiles(output, sites) {
  const path = join(output, 'site-context.json');
  const context = existsSync(path) ? read(path) : null;
  const files = existsSync(output) ? readdirSync(output).filter(name => /^site-context-[a-z0-9-]+\.json$/.test(name)).sort() : [];
  const merged = mergeSiteContextDocuments(context, files.map(name => read(join(output, name))), sites);
  const checked = validatePublishedTerrain(output, sites, merged);
  if (merged) {
    const temporary = `${path}.merge.tmp`;
    try { writeFileSync(temporary, JSON.stringify(merged) + '\n'); renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
  }
  for (const name of files) rmSync(join(output, name));
  return { fragments: files.length, profilesChecked: checked };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string', default: 'data' }, sites: { type: 'string', default: 'sites.json' } } });
  console.log(JSON.stringify(mergeSiteContextFiles(resolve(values.output), read(resolve(values.sites)).sites)));
}
