// GRIB cell column extraction and per-cell V1/V2 derivation.

import { roundDocument } from '@azohra/meteo.forecast';
import { DRY_ADIABATIC_LAPSE_C_PER_M } from '@azohra/meteo.briefing/derive';
import { deriveSiteForecast } from './vendor/derive-0.6.0.mjs';
import { modelFor, semanticsFor } from './common.mjs';
import { finite } from './thermodynamics.mjs';
import { deriveDiagnosticsV2 } from './diagnostics.mjs';

export { cellSource } from '@windgrams/providers/noaa';

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
