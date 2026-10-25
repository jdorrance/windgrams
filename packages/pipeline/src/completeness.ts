import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseSiteForecast } from '@azohra/meteo.briefing/contract';
import type { SiteForecast } from '@azohra/meteo.briefing/contract';
import type { SiteLocation } from '@windgrams/providers';

export interface CompletenessOptions {
  model: string; expectedSites?: readonly string[]; referenceTime?: string;
  expectedForecastHours?: readonly number[];
  siteLocations?: readonly SiteLocation[];
  validateProfile?: (profile: SiteForecast, referenceTime: string, site: string) => void;
}
export interface ModelManifest {
  model: string; referenceTime: string; forecastHours: number; sites: { slug: string; name?: string }[];
  schemaVersion?: number; generatedAt?: string; firstForecastHour?: number; lastForecastHour?: number;
  trial?: boolean; coverage?: { requestedSiteHash: string; excluded: string[]; reason: 'outside-native-grid' };
  stats?: { downloads: number; downloadBytes: number; durationMs: number; retries: number };
}
export interface CompleteModel { model: string; referenceTime: string; sites: string[]; manifest: ModelManifest }
export function catalogueFingerprint(sites: readonly (SiteLocation & { country?: string })[]): string {
  const canonical = [...sites].sort((a, b) => a.slug.localeCompare(b.slug)).map(site => ({ slug: site.slug, latitude: site.latitude, longitude: site.longitude, name: site.name, timeZone: site.timeZone, country: site.country }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
export function validateModelDirectory(root: string, options: CompletenessOptions): CompleteModel {
  const { model } = options;
  const manifest = JSON.parse(readFileSync(join(root, model, 'manifest.json'), 'utf8'));
  if (manifest.model !== model || !Array.isArray(manifest.sites) || !manifest.sites.length || !Number.isFinite(Date.parse(manifest.referenceTime)) || !Number.isInteger(manifest.forecastHours) || manifest.forecastHours < 1) throw new Error(`${model}: invalid staged manifest`);
  const sites: string[] = manifest.sites.map((site: { slug: string }) => site.slug);
  if (sites.some(site => typeof site !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(site)) || new Set(sites).size !== sites.length) throw new Error(`${model}: invalid site inventory`);
  if (options.expectedSites && JSON.stringify([...sites].sort()) !== JSON.stringify([...options.expectedSites].sort())) throw new Error(`${model}: site inventory differs from requested catalogue`);
  if (options.referenceTime && Date.parse(manifest.referenceTime) !== Date.parse(options.referenceTime)) throw new Error(`${model}: published run differs from selected run`);
  for (const site of sites) {
    const raw = JSON.parse(readFileSync(join(root, model, 'sites', `${site}.json`), 'utf8'));
    if (Date.parse(raw.run?.referenceTime) !== Date.parse(manifest.referenceTime)) throw new Error(`${model}: ${site} run differs from manifest`);
    const profile = parseSiteForecast(raw);
    if (!profile || profile.model !== model || profile.site.id !== site) throw new Error(`${model}: invalid profile ${site}`);
    if (Number.isInteger(manifest.forecastHours) && profile.hours.length !== manifest.forecastHours) throw new Error(`${model}: incomplete profile hours ${site}`);
    const offsets = profile.hours.map(hour => (Date.parse(hour.validAt) - Date.parse(manifest.referenceTime)) / 3_600_000);
    if (offsets.some((hour, index) => !Number.isFinite(hour) || hour < 0 || !Number.isInteger(hour) || index > 0 && hour <= offsets[index - 1])) throw new Error(`${model}: invalid or duplicate valid times ${site}`);
    if (Number.isFinite(manifest.firstForecastHour) && offsets[0] !== manifest.firstForecastHour
      || Number.isFinite(manifest.lastForecastHour) && offsets.at(-1) !== manifest.lastForecastHour) throw new Error(`${model}: profile horizon differs from manifest ${site}`);
    if (options.expectedForecastHours && JSON.stringify(offsets) !== JSON.stringify(options.expectedForecastHours)) throw new Error(`${model}: profile differs from requested forecast hours ${site}`);
    const location = options.siteLocations?.find(location => location.slug === site);
    if (location && (profile.site.latitude !== location.latitude || profile.site.longitude !== location.longitude
      || location.name !== undefined && profile.site.name !== location.name || location.timeZone !== undefined && profile.site.timeZone !== location.timeZone)) throw new Error(`${model}: outdated site metadata ${site}`);
    options.validateProfile?.(raw, manifest.referenceTime, site);
  }
  return { model, referenceTime: manifest.referenceTime, sites, manifest };
}
export function hasCompleteModel(root: string, options: CompletenessOptions): boolean {
  try { validateModelDirectory(root, options); return true; } catch { return false; }
}
export function terrainPrerequisites(context: unknown, sites: readonly { slug: string; latitude: number; longitude: number }[]): string[] {
  const entries = (context as { sites?: Record<string, { point?: { latitude?: number; longitude?: number }; elevation?: { elevationM?: number } }> } | null)?.sites ?? {};
  return sites.filter(site => {
    const entry = entries[site.slug];
    return !entry || !Number.isFinite(entry.elevation?.elevationM) || entry.point?.latitude !== site.latitude || entry.point?.longitude !== site.longitude;
  }).map(site => site.slug);
}
export function readManifest(root: string, model: string): ModelManifest | null {
  const path = join(root, model, 'manifest.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
