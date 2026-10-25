// GRIB cell column extraction and per-cell V1/V2 derivation.

import { roundDocument } from '@azohra/meteo.forecast';
import { DRY_ADIABATIC_LAPSE_C_PER_M } from '@azohra/meteo.briefing/derive';
import { deriveSiteForecast } from './vendor/derive-0.6.0.mjs';
import { wind } from './grid.mjs';
import { modelFor, semanticsFor, validAt } from './common.mjs';
import { finite } from './thermodynamics.mjs';
import { deriveDiagnosticsV2 } from './diagnostics.mjs';

const optional = ['windGustMps', 'capeJkg', 'cinJkg', 'pblHeightM', 'lowCloudPercent', 'midCloudPercent', 'highCloudPercent'];

/**
 * Extracts a normalized cell atmospheric column from decoded GRIB records.
 *
 * @param {Record<string, any>} c
 * @param {Record<string, any>} grid
 * @param {{ longitude: number }} cell
 * @param {number} hour
 * @param {Record<string, any>} raw
 * @returns {import("@windgrams/contracts").AtmosphericColumn | null}
 */
export function cellSource(c, grid, cell, hour, raw) {
  const surfaceWind = wind(grid, cell.longitude, raw.u, raw.v);
  const required = ['temperature', 'dewpoint', 'cloudCoverPercent', 'latentHeatFluxWm2', 'sensibleHeatFluxWm2', 'precipitationMm', 'seaLevelPressureHpa'];
  if (!surfaceWind || !required.every(k => finite(raw[k]))) return null;
  /** @type {import("@windgrams/contracts").AtmosphericColumn & { levels: import("@windgrams/contracts").AtmosphericLevel[] }} */
  const source = {
    validAt: validAt(c, hour),
    temperatureC: raw.temperature - 273.15,
    dewPointDepressionC: raw.temperature - raw.dewpoint,
    ...surfaceWind,
    cloudCoverPercent: raw.cloudCoverPercent,
    latentHeatFluxWm2: raw.latentHeatFluxWm2,
    sensibleHeatFluxWm2: raw.sensibleHeatFluxWm2,
    precipitationMm: raw.precipitationMm * (modelFor(c) === 'rrfs' ? 1 : 3600),
    seaLevelPressureHpa: raw.seaLevelPressureHpa / 100,
    levels: [],
  };
  for (const key of optional) if (finite(raw[key])) source[key] = raw[key];
  if (finite(raw.u80m) && finite(raw.v80m)) {
    const w80 = wind(grid, cell.longitude, raw.u80m, raw.v80m);
    if (w80) {
      source.wind80mSpeedMps = w80.windSpeedMps;
      source.wind80mDirectionDeg = w80.windDirectionDeg;
    }
  }
  for (const extKey of ['nativeCloudCeilingM', 'nativeCloudBaseM', 'nativeCloudTopM', 'nativeAdiabaticLclM', 'nativeLfcM', 'nativeEquilibriumLevelM']) {
    if (finite(raw[extKey])) source[extKey] = raw[extKey];
  }
  if (['smoke.surfaceUgm3', 'smoke.columnMgm2', 'smoke.aot'].every(k => finite(raw[k]))) {
    source.smoke = { surfaceUgm3: raw['smoke.surfaceUgm3'] * 1e9, columnMgm2: raw['smoke.columnMgm2'] * 1e6, aot: raw['smoke.aot'] };
  }
  for (const p of c.pressureLevels) {
    const get = (/** @type {string} */ key) => raw[`${p}.${key}`];
    const w = wind(grid, cell.longitude, get('UGRD'), get('VGRD'));
    if (!w || !['TMP', 'DPT', 'HGT'].every(k => finite(get(k)))) continue;
    /** @type {import("@windgrams/contracts").AtmosphericLevel} */
    const level = {
      pressureHpa: p,
      heightM: get('HGT'),
      temperatureC: get('TMP') - 273.15,
      dewPointDepressionC: get('TMP') - get('DPT'),
      ...w,
    };
    if (finite(get('VVEL'))) level.verticalVelocityPaS = modelFor(c) === 'rrfs'
      ? -(p * 100 * 9.80665 * get('VVEL')) / (287.05 * get('TMP'))
      : get('VVEL');
    source.levels.push(level);
  }
  return source;
}

/**
 * Derives baseline V1 and V2 soaring diagnostics for a single grid cell.
 *
 * @param {Record<string, any>} c
 * @param {number | null | undefined} terrain
 * @param {import("@windgrams/contracts").AtmosphericColumn | null | undefined} source
 * @param {string} capturedAt
 */
export function deriveCell(c, terrain, source, capturedAt) {
  const levels = source?.levels.filter((/** @type {{ heightM: number }} */ l) => finite(terrain) && l.heightM > terrain + 20).sort((/** @type {{ heightM: number }} */ a, /** @type {{ heightM: number }} */ b) => a.heightM - b.heightM) ?? [];
  if (!source || !finite(terrain)) return { status: 'missing', levelCount: levels.length, ceilingReached: false, hour: null, v2: null };
  if (levels.length < c.minimumAboveGroundLevels) return { status: 'insufficient-levels', levelCount: levels.length, ceilingReached: false, hour: null, v2: null };
  const ceilingReached = levels.every((/** @type {{ heightM: number; temperatureC: number }} */ l) => source.temperatureC - (l.heightM - terrain) * DRY_ADIABATIC_LAPSE_C_PER_M > l.temperatureC);
  // roundDocument rounds numeric leaves while preserving this deterministic profile's shape.
  const profile = /** @type {ReturnType<typeof deriveSiteForecast>} */ (roundDocument(deriveSiteForecast({
    ...c.site,
    siteId: c.site.slug,
    siteName: c.site.name,
    siteTimeZone: c.site.timeZone,
    modelElevationM: terrain,
    referenceTime: c.referenceTime,
    generatedAt: capturedAt,
    hours: [source],
  }, modelFor(c), semanticsFor(c))));
  const v2 = deriveDiagnosticsV2(terrain, source, profile.hours[0], {
    launchElevationM: c.launchElevation?.elevationM ?? null,
  });
  return { status: 'valid', levelCount: levels.length, ceilingReached, hour: profile.hours[0], site: profile.site, v2 };
}
