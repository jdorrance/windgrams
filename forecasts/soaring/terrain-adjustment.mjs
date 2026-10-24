// Experimental launch-elevation wind interpolation, isolated from authoritative MSL heights.

import { componentsToWind, windToComponents } from '@azohra/meteo.briefing/derive';
import { finite, round1, round2 } from './thermodynamics.mjs';

/**
 * Experimental terrain adjustment isolated from authoritative MSL heights.
 * Interpolates horizontal wind components (u, v) at launchElevationM ONLY when
 * the model profile brackets launchElevationM; never shifts published MSL cloud base
 * or usable lift heights.
 *
 * @param {number | null | undefined} terrainM
 * @param {number | null | undefined} launchElevationM
 * @param {{ windSpeedMps?: number | null; windDirectionDeg?: number | null; wind80mSpeedMps?: number | null; wind80mDirectionDeg?: number | null } | null | undefined} source
 * @param {readonly { heightM: number; windSpeedMps?: number | null; windDirectionDeg?: number | null }[] | null | undefined} levels
 */
export function computeExperimentalTerrainAdjustment(terrainM, launchElevationM, source, levels) {
  if (!finite(terrainM) || !finite(launchElevationM) || !source || !levels?.length) return null;
  const sorted = [...levels].filter(l => finite(l.heightM)).sort((a, b) => a.heightM - b.heightM);
  if (!sorted.length) return null;
  const maxHeightM = sorted[sorted.length - 1].heightM;
  const terrainDeltaM = round1(launchElevationM - terrainM);
  const bracketsLaunchAltitude = launchElevationM >= terrainM && launchElevationM <= maxHeightM;

  let launchWindSpeedMps = null;
  let launchWindDirectionDeg = null;
  if (bracketsLaunchAltitude && finite(source.windSpeedMps) && finite(source.windDirectionDeg)) {
    const nodes = [
      { heightM: terrainM, ...windToComponents(source.windSpeedMps, source.windDirectionDeg) },
      ...(finite(source.wind80mSpeedMps) && finite(source.wind80mDirectionDeg)
        ? [{ heightM: terrainM + 80, ...windToComponents(source.wind80mSpeedMps, source.wind80mDirectionDeg) }]
        : []),
      ...sorted
        .filter(l => l.heightM > terrainM && finite(l.windSpeedMps) && finite(l.windDirectionDeg))
        .map(l => ({ heightM: l.heightM, ...windToComponents(/** @type {number} */ (l.windSpeedMps), /** @type {number} */ (l.windDirectionDeg)) })),
    ].sort((a, b) => a.heightM - b.heightM);

    for (let i = 0; i < nodes.length - 1; i += 1) {
      const a = nodes[i];
      const b = nodes[i + 1];
      if (launchElevationM >= a.heightM && launchElevationM <= b.heightM) {
        const frac = b.heightM > a.heightM ? (launchElevationM - a.heightM) / (b.heightM - a.heightM) : 0;
        const u = a.uMps + frac * (b.uMps - a.uMps);
        const v = a.vMps + frac * (b.vMps - a.vMps);
        const w = componentsToWind(u, v);
        launchWindSpeedMps = round2(w.speedMps);
        launchWindDirectionDeg = round1(w.directionDeg);
        break;
      }
    }
  }

  return {
    experimental: true,
    launchElevationM: round1(launchElevationM),
    modelElevationM: round1(terrainM),
    terrainDeltaM,
    bracketsLaunchAltitude,
    launchWindSpeedMps,
    launchWindDirectionDeg,
    rawMslHeightsPreserved: true,
    assumptions: [
      'Horizontal wind at launchElevationM is vector-interpolated between bracketing model levels only when modelElevationM <= launchElevationM <= highestLevelM.',
      'Elevation difference alone does not establish slope temperature, moisture, or surface heat flux; raw MSL cloud base and usable-lift heights are preserved unchanged.',
    ],
  };
}
