// DWD publishes only Armenian terrain. Merge it after independent provider
// overlays so an old DWD cache cannot replace freshly measured US launches.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseSiteContextJson } from '@azohra/meteo.briefing/contract';

const validate = document => {
  if (!parseSiteContextJson(JSON.stringify(document))) throw new Error('Invalid Armenian terrain context');
  return document;
};
const current = (entry, site) => entry?.point?.latitude === site.latitude && entry?.point?.longitude === site.longitude
  && entry.elevation?.source === 'glo90' && Number.isFinite(entry.elevation.elevationM);

export function armeniaTerrainFragment(context, sites) {
  const selected = sites.filter(site => site.timeZone === 'Asia/Yerevan');
  const entries = Object.fromEntries(selected.map(site => {
    const entry = context?.sites?.[site.slug];
    if (!current(entry, site)) throw new Error(`Missing current Armenian terrain: ${site.slug}`);
    return [site.slug, entry];
  }));
  return validate({ ...context, sites: entries });
}

export function mergeArmeniaTerrain(context, fragment, sites) {
  validate(fragment);
  const allowed = new Map(sites.filter(site => site.timeZone === 'Asia/Yerevan').map(site => [site.slug, site]));
  const merged = { ...(context?.sites ?? {}) };
  for (const [slug, entry] of Object.entries(fragment.sites)) {
    const site = allowed.get(slug);
    if (!site || !current(entry, site)) throw new Error(`Unexpected or outdated Armenian terrain: ${slug}`);
    // A newer terrain job can already have measured this same Armenian point.
    if (!current(merged[slug], site) || Date.parse(context.generatedAt) < Date.parse(fragment.generatedAt)) merged[slug] = entry;
  }
  const generatedAt = !context || Date.parse(fragment.generatedAt) > Date.parse(context.generatedAt) ? fragment.generatedAt : context.generatedAt;
  const sources = [...new Map([...(context?.sources ?? []), ...fragment.sources].map(source => [source.id, source])).values()];
  return validate({ ...context, ...fragment, generatedAt, sources, sites: merged });
}

export function mergeArmeniaTerrainFile(output, sites) {
  const fragmentPath = join(output, 'site-context-armenia.json');
  if (!existsSync(fragmentPath)) return false;
  const path = join(output, 'site-context.json');
  const context = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const merged = mergeArmeniaTerrain(context, JSON.parse(readFileSync(fragmentPath, 'utf8')), sites);
  const temp = `${path}.armenia.tmp`;
  try { writeFileSync(temp, JSON.stringify(merged) + '\n'); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
  rmSync(fragmentPath);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string', default: 'data' }, sites: { type: 'string', default: 'sites.json' } } });
  mergeArmeniaTerrainFile(resolve(values.output), JSON.parse(readFileSync(resolve(values.sites), 'utf8')).sites);
}
