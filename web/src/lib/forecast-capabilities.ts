import { MODELS, modelCoversSite } from '@windgrams/providers/registry';
import type { LaunchDetails, SiteEntry } from './launches.ts';

export type LaunchCountry = string;
type Location = Pick<SiteEntry, 'latitude' | 'longitude'> & Pick<LaunchDetails, 'countryCode'>;
/** Application preferences; coverage and published manifests determine availability. */
const policies: Record<string, { models: string[]; observations: boolean; soaringRegion?: string }> = {
  US: { models: ['hrrr-conus', 'hrdps-continental', 'rrfs', 'rdps', 'gfs', 'gdps', 'geps'], observations: true },
  AM: { models: ['icon-eu', 'gfs', 'gdps', 'geps'], observations: false, soaringRegion: 'armenia' },
};

export function launchCountry(site: Pick<LaunchDetails, 'countryCode'>): LaunchCountry {
  return /^[A-Z]{2}$/.test(site.countryCode ?? '') ? site.countryCode : 'ZZ';
}

export function launchCountries(launches: readonly Pick<LaunchDetails, 'countryCode'>[]) {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  return [...new Set(launches.map(launchCountry))].sort((a, b) => a === 'US' ? -1 : b === 'US' ? 1 : a.localeCompare(b))
    .map(code => ({ code, label: code === 'ZZ' ? 'Unassigned' : names.of(code) ?? code }));
}

export function defaultSoaringRegion(country: string): string | undefined { return policies[country]?.soaringRegion; }

export function forecastCapabilities(site: Location) {
  const policy = policies[launchCountry(site)];
  const covered = MODELS.filter(model => modelCoversSite(model.id, site)).map(model => model.id);
  const priority = policy?.models ?? [];
  const models = [...new Set([...priority, ...covered])].filter(model => covered.includes(model));
  return { models, nws: policy?.observations ?? false, raob: policy?.observations ?? false };
}

export function shortModelLabel(slug: string) {
  return slug === 'icon-eu' ? 'ICON-EU' : slug.split('-')[0].toUpperCase();
}
