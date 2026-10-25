// Limit DWD's terrain artifact to its current Armenian launch points.
import { parseSiteContextJson } from '@azohra/meteo.briefing/contract';

const validate = document => {
  if (!parseSiteContextJson(JSON.stringify(document))) throw new Error('Invalid Armenian terrain context');
  return document;
};
const current = (entry, site) => entry?.point?.latitude === site.latitude && entry?.point?.longitude === site.longitude
  && entry.elevation?.source === 'glo90' && Number.isFinite(entry.elevation.elevationM);

export function armeniaTerrainFragment(context, sites) {
  const selected = sites.filter(site => site.country === 'AM' || site.slug.startsWith('am-'));
  const entries = Object.fromEntries(selected.map(site => {
    const entry = context?.sites?.[site.slug];
    if (!current(entry, site)) throw new Error(`Missing current Armenian terrain: ${site.slug}`);
    return [site.slug, entry];
  }));
  return validate({ ...context, sites: entries });
}
