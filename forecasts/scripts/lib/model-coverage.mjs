// Coarse acquisition envelopes exclude unrelated continents before a download.
// Each model's actual grid lookup remains the final point-coverage check.
const envelopes = {
  'hrrr-conus': [-126, 21, -60, 53],
  rrfs: [-126, 21, -60, 53],
  'hrdps-continental': [-170, 20, -40, 85],
  'hrdps-west': [-170, 20, -40, 85],
  rdps: [-170, 20, -40, 85],
  'icon-eu': [-23.5, 29.5, 62.5, 70.5],
};

export function modelCoversSite(model, site) {
  const { latitude, longitude } = site;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  const bounds = envelopes[model];
  return !bounds || longitude >= bounds[0] && latitude >= bounds[1] && longitude <= bounds[2] && latitude <= bounds[3];
}

export function nwsCoversSite(site) {
  // The catalogue currently contains US launches and Armenia. Preserve Alaska,
  // Hawaii and US territories when an existing/new US catalogue uses them.
  return /^(America\/(New_York|Chicago|Denver|Los_Angeles|Boise|Phoenix|Detroit|Indiana\/|Kentucky\/|North_Dakota\/|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak)|Pacific\/(Honolulu|Guam|Saipan|Pago_Pago)|America\/(Puerto_Rico|St_Thomas))/.test(site.timeZone ?? '');
}

export function regionSupportsModel(region, model) {
  return (region.regionalModels ?? ['hrrr-conus', 'rrfs']).includes(model);
}

export const regionIndexName = model => model === 'hrrr-conus' ? 'regions.json' : `regions-${model}.json`;
