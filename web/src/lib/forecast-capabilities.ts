import type { SiteEntry } from './launches.ts';

export type LaunchCountry = 'US' | 'AM';
export const LAUNCH_COUNTRIES = [{ code: 'US', label: 'United States' }, { code: 'AM', label: 'Armenia' }] as const;

export function launchCountry(site: Pick<SiteEntry, 'timeZone'>): LaunchCountry {
  return site.timeZone === 'Asia/Yerevan' ? 'AM' : 'US';
}

/** Published providers for each catalogue area; model manifests still decide available runs. */
export function forecastCapabilities(site: Pick<SiteEntry, 'timeZone'>) {
  const armenia = launchCountry(site) === 'AM';
  return {
    models: armenia
      ? ['icon-eu', 'gfs', 'gdps', 'geps']
      : ['hrrr-conus', 'hrdps-continental', 'rrfs', 'rdps', 'gfs', 'gdps', 'geps'],
    nws: !armenia,
    raob: !armenia,
  };
}

export function shortModelLabel(slug: string) {
  return slug === 'icon-eu' ? 'ICON-EU' : slug.split('-')[0].toUpperCase();
}
