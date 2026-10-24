// Publication profile assembly, map/profile agreement checks, and baseline audit diffing.

import { parseSiteForecast } from '@azohra/meteo.briefing/contract';
import { modelFor, semanticsFor } from './common.mjs';
import { finite } from './thermodynamics.mjs';
import { metrics, v2LayerMetrics } from './diagnostics.mjs';

/**
 * Validates and builds a schema-v2 SiteForecast document.
 * @param {Record<string, any>} c
 * @param {Record<string, any>} site
 * @param {any[]} hours
 * @param {string} capturedAt
 */
export function profileFor(c, site, hours, capturedAt) {
  const profile = { schemaVersion: 2, model: modelFor(c), run: { referenceTime: c.referenceTime, generatedAt: capturedAt }, site, semantics: semanticsFor(c), hours };
  if (!parseSiteForecast(profile)) throw new Error('Blanchard profile failed the public SiteForecast contract');
  return profile;
}

/**
 * Reads a baseline v1 metric from a derived hour.
 * @param {Record<string, any> | null | undefined} hour
 * @param {string} key
 */
export function metric(hour, key) {
  return (key === 'pblHeightM' ? hour?.surface[key] : hour?.derived[key]) ?? null;
}

/**
 * Verifies exact numerical agreement between the primary site profile and its regional map cell.
 * @param {Record<string, any>} profile
 * @param {Record<string, any>[]} hourly
 * @param {number} siteCell
 */
export function assertAgreement(profile, hourly, siteCell) {
  if (profile.hours.length !== hourly.length) throw new Error('Map/profile hour count mismatch');
  for (let i = 0; i < hourly.length; i++) {
    if (profile.hours[i].validAt !== hourly[i].validAt) throw new Error('Map/profile time mismatch');
    for (const key of metrics) if (metric(profile.hours[i], key) !== hourly[i][key][siteCell]) throw new Error(`Map/profile mismatch: ${i} ${key}`);
    if (profile.hours[i].soaring) for (const key of v2LayerMetrics) {
      if ((profile.hours[i].soaring[key] ?? null) !== hourly[i][key][siteCell]) throw new Error(`Map/profile v2 mismatch: ${i} ${key}`);
    }
  }
  return { exact: true, hours: hourly.length, valuesChecked: hourly.length * metrics.length + profile.hours.filter((/** @type {any} */ h) => h.soaring).length * v2LayerMetrics.length };
}

/**
 * Recursively computes value differences between two forecast documents, ignoring `run.generatedAt`.
 * @param {any} actual
 * @param {any} expected
 * @param {string} [path='']
 * @returns {{ path: string; replay: any; published: any; delta?: number }[]}
 */
export function differences(actual, expected, path = '') {
  if (path === 'run.generatedAt') return [];
  if (actual === expected) return [];
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    return [...new Set([...Object.keys(actual), ...Object.keys(expected)])].flatMap(k => differences(actual[k], expected[k], path ? `${path}.${k}` : k));
  }
  return [{
    path,
    replay: actual ?? null,
    published: expected ?? null,
    ...(finite(actual) && finite(expected) ? { delta: actual - expected } : {}),
  }];
}
