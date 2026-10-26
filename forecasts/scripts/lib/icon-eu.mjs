// Acquisition and decoding are supplied by the reusable provider package.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { roundDocument } from '@azohra/meteo.forecast';
import { deriveSourceForecast } from '../../soaring/source-profile.mjs';
import { postprocessPointForecast } from '@windgrams/soaring/compatibility';
import { acquireIcon, ICON_BASE, ICON_FORECAST_HOURS, ICON_SEMANTICS } from '@windgrams/providers/icon';
export { acquireIcon, ICON_BASE, ICON_MODEL_LEVELS, ICON_FORECAST_HOURS, ICON_SEMANTICS,
  discoverIconRun, normalizeIconExtract, writeIconAcquisition, readIconAcquisition } from '@windgrams/providers/icon';

/** Map and point both call this function on the same captured native-cell source. */
export function deriveIconProfile(acquired, cellIndex, site, { launchElevationM = null, generatedAt = acquired.provenance.capturedAt } = {}) {
  const cell = acquired.cells[cellIndex];
  if (!cell) throw new Error('ICON cell index is outside the extraction');
  const hours = acquired.hours.map(hour => hour.sources[cellIndex]);
  if (hours.some(hour => !hour)) throw new Error(`ICON ${site.slug}: incomplete native profile`);
  const profile = roundDocument(deriveSourceForecast({ siteId: site.slug, siteName: site.name, latitude: site.latitude, longitude: site.longitude,
    siteTimeZone: site.timeZone ?? 'Asia/Yerevan', modelElevationM: cell.terrainM,
    referenceTime: acquired.referenceTime, generatedAt, hours }, 'icon-eu', ICON_SEMANTICS));
  // The common publication table leaves arbitrary native pressures untouched.
  for (const hour of profile.hours) for (const level of hour.levels) level.pressureHpa = Math.round(level.pressureHpa * 100) / 100;
  const result = postprocessPointForecast(profile, { modelSlug: 'icon-eu', launchElevationM });
  result.source = { provider: 'DWD', license: 'CC BY 4.0', product: ICON_BASE, gridUuid: acquired.grid.uuid,
    gridIndex: cell.index, latitude: cell.latitude, longitude: cell.longitude, nativeModelLevels: acquired.levels,
    heatFlux: 'Preceding-hour upward mean from successive DWD run means', precipitation: 'Preceding-hour accumulation difference' };
  return result;
}

/** Writes staged files; the caller owns atomic publication and history. */
export async function buildIconPointProfiles({ sitesPath, sites, outputRoot, referenceTime, maxSteps,
  acquisition, ...options } = {}) {
  sites ??= JSON.parse(readFileSync(sitesPath, 'utf8')).sites;
  sites = sites.filter(site => site.country === 'AM' || site.region === 'am' || site.slug.startsWith('am-'));
  if (!sites.length) throw new Error('ICON-EU catalogue has no Armenian launches');
  const forecastHours = maxSteps ? ICON_FORECAST_HOURS.slice(0, maxSteps) : ICON_FORECAST_HOURS;
  const acquired = acquisition ?? await acquireIcon({ ...options, sites, referenceTime, forecastHours });
  const generatedAt = acquired.provenance.capturedAt;
  const root = join(outputRoot, 'icon-eu');
  mkdirSync(join(root, 'sites'), { recursive: true });
  for (const site of sites) {
    const doc = deriveIconProfile(acquired, acquired.siteCells[site.slug], site, { generatedAt });
    writeFileSync(join(root, 'sites', `${site.slug}.json`), `${JSON.stringify(doc)}\n`);
  }
  const manifest = { schemaVersion: 1, model: 'icon-eu', referenceTime: acquired.referenceTime, generatedAt,
    firstForecastHour: acquired.hours[0].forecastHour, lastForecastHour: acquired.hours.at(-1).forecastHour,
    forecastHours: acquired.hours.length, sites: sites.map(({ name, slug }) => ({ name, slug })),
    stats: { downloads: acquired.provenance.downloads ?? (acquired.provenance.downloadedBytes ? acquired.provenance.sourceObjects.length + (acquired.grid.geometrySource?.records?.length ?? 0) : 0),
      downloadBytes: acquired.provenance.downloadedBytes, retries: acquired.provenance.retries ?? 0, durationMs: Math.round(acquired.provenance.elapsedSeconds * 1000) } };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(root, 'source.json'), `${JSON.stringify({ grid: acquired.grid, provenance: acquired.provenance })}\n`);
  return { acquired, manifest };
}
