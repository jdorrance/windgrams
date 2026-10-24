// Offline acceptance check for a complete, postprocessed deterministic RRFS run.
// Run after build-covered; this checks every launch/hour, not a sample.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseForecastManifest, parseSiteForecast } from '@azohra/meteo.briefing/contract';
import { SOARING_CONTRACT_VERSION } from '../soaring/science.mjs';
import { modelCoversSite } from './lib/model-coverage.mjs';

const finite = Number.isFinite;
function requireValue(condition, message) { if (!condition) throw new Error(message); }

export function validateRrfsProfile(document, referenceTime, siteId, { horizon = 84 } = {}) {
  requireValue(parseSiteForecast(document), `${siteId}: invalid forecast contract`);
  requireValue(document.model === 'rrfs' && document.site.id === siteId, `${siteId}: wrong model/site`);
  requireValue(document.run.referenceTime === referenceTime, `${siteId}: wrong initialization`);
  requireValue(document.semantics.precipitation === 'windowMeanRate', `${siteId}: wrong precipitation semantics`);
  requireValue(document.hours.length === horizon, `${siteId}: expected ${horizon} forecast hours`);
  const referenceMs = Date.parse(referenceTime);
  for (const [index, hour] of document.hours.entries()) {
    const at = `${siteId} f${index + 1}`;
    requireValue(Date.parse(hour.validAt) === referenceMs + (index + 1) * 3_600_000, `${at}: non-hourly or wrong valid time`);
    const s = hour.surface;
    for (const key of ['temperatureC', 'dewPointC', 'windSpeedMps', 'windDirectionDeg', 'precipitationMmHr', 'seaLevelPressureHpa', 'sensibleHeatFluxWm2', 'latentHeatFluxWm2']) {
      requireValue(finite(s[key]), `${at}: missing/nonfinite ${key}`);
    }
    requireValue(s.precipitationMmHr >= 0, `${at}: negative hourly precipitation`);
    requireValue(s.windSpeedMps >= 0 && s.windDirectionDeg >= 0 && s.windDirectionDeg <= 360, `${at}: invalid surface wind`);
    requireValue(hour.levels.length >= 3, `${at}: incomplete pressure column`);
    requireValue(new Set(hour.levels.map(l => l.pressureHpa)).size === hour.levels.length, `${at}: duplicate pressure levels`);
    requireValue(hour.levels.every(l => finite(l.heightM) && finite(l.temperatureC) && finite(l.dewPointC)
      && finite(l.windSpeedMps) && l.windSpeedMps >= 0 && finite(l.windDirectionDeg) && l.windDirectionDeg >= 0 && l.windDirectionDeg <= 360), `${at}: invalid upper-air field`);
    const v2 = hour.soaring;
    requireValue(v2?.contractVersion === SOARING_CONTRACT_VERSION, `${at}: missing soaring postprocessing`);
    requireValue(finite(v2.thermalVelocityV2Mps) && v2.thermalVelocityV2Mps >= 0, `${at}: invalid thermal velocity`);
    for (const key of ['usableLiftTopV2M', 'hcritWxtoflyM', 'dryHcritM']) {
      if (v2[key] == null) continue;
      requireValue(finite(v2[key]) && finite(v2.resolvedThermalTopM) && v2[key] <= v2.resolvedThermalTopM + 0.2, `${at}: ${key} exceeds thermal top`);
    }
  }
  return { site: siteId, hours: document.hours.length, firstValidAt: document.hours[0].validAt, lastValidAt: document.hours.at(-1).validAt };
}

export function validateRrfsDataset(dataRoot, sitesPath) {
  const manifest = JSON.parse(readFileSync(join(dataRoot, 'rrfs', 'manifest.json'), 'utf8'));
  requireValue(parseForecastManifest(manifest) && manifest.model === 'rrfs', 'Invalid RRFS manifest');
  requireValue(manifest.firstForecastHour === 1 && manifest.lastForecastHour === 84 && manifest.forecastHours === 84, 'RRFS manifest does not cover f001–f084');
  const sites = JSON.parse(readFileSync(sitesPath, 'utf8')).sites;
  const expected = sites.filter(site => modelCoversSite('rrfs', site)).map(s => s.slug).sort();
  requireValue(JSON.stringify(manifest.sites.map(s => s.slug).sort()) === JSON.stringify(expected), 'RRFS manifest does not contain the complete launch catalogue');
  const profiles = expected.map(slug => validateRrfsProfile(JSON.parse(readFileSync(join(dataRoot, 'rrfs', 'sites', `${slug}.json`), 'utf8')), manifest.referenceTime, slug));
  return { model: 'rrfs', referenceTime: manifest.referenceTime, sites: profiles.length, forecastHoursPerSite: 84,
    validatedSiteHours: profiles.reduce((n, p) => n + p.hours, 0), firstValidAt: profiles[0].firstValidAt, lastValidAt: profiles[0].lastValidAt,
    stats: manifest.stats, checks: ['forecast-contract', 'all-catalogued-launches', 'hourly-f001-through-f084', 'precipitation-window-semantics', 'surface-and-upper-air-winds', 'v2-lift-bounded-by-thermal-top'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { data: { type: 'string', default: 'data' }, sites: { type: 'string', default: 'sites.json' }, report: { type: 'string' } } });
    const report = validateRrfsDataset(resolve(values.data), resolve(values.sites));
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (values.report) writeFileSync(values.report, text);
    console.log(text.trim());
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
