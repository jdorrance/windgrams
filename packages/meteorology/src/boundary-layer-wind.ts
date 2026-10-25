import type { Wind, SurfaceWind, WindLevel, BoundaryLayerWind } from './types.js';
// Height-weighted boundary-layer vector wind integration and shear calculation.

import { componentsToWind, normalizeDegrees, windToComponents } from '@azohra/meteo.briefing/derive';
import { finite } from './thermodynamics.js';

/**
 * Integrates horizontal wind components (u, v) over geometric height z across [terrainM, blTopM]
 * using the trapezoidal rule with interpolated layer boundaries, clipped strictly at the actual
 * boundary-layer top without including free-tropospheric levels above shallow layers.
 */
export function computeBoundaryLayerWind(
  terrainM: number | null | undefined, surfaceWind: SurfaceWind | null | undefined,
  levels: readonly WindLevel[], blTopM: number | null | undefined, wind80m: Wind | null = null,
): BoundaryLayerWind | null {
  if (!finite(terrainM) || !surfaceWind || !finite(surfaceWind.windSpeedMps) || !finite(surfaceWind.windDirectionDeg) || !Array.isArray(levels)) {
    return null;
  }
  const typedLevels: readonly WindLevel[] = levels;
  const validLevels = typedLevels
    .filter((l): l is WindLevel & { windSpeedMps: number; windDirectionDeg: number } => l && finite(l.heightM) && l.heightM > terrainM && finite(l.windSpeedMps) && finite(l.windDirectionDeg))
    .sort((a, b) => a.heightM - b.heightM);
  const w80 = wind80m && finite(wind80m.windSpeedMps) && finite(wind80m.windDirectionDeg)
    ? { windSpeedMps: wind80m.windSpeedMps, windDirectionDeg: wind80m.windDirectionDeg }
    : (finite(surfaceWind.wind80mSpeedMps) && finite(surfaceWind.wind80mDirectionDeg)
        ? { windSpeedMps: surfaceWind.wind80mSpeedMps, windDirectionDeg: surfaceWind.wind80mDirectionDeg }
        : null);
  if (validLevels.length === 0 && !w80) return null;

  const sfcComp = windToComponents(surfaceWind.windSpeedMps, surfaceWind.windDirectionDeg);
  const rawWindNodes = [
   { heightM: terrainM, ...sfcComp, count: 1 },
    ...(w80 ? [{ heightM: terrainM + 80, ...windToComponents(w80.windSpeedMps, w80.windDirectionDeg), count: 1 }] : []),
    ...validLevels.map(l => ({ heightM: l.heightM, ...windToComponents(l.windSpeedMps, l.windDirectionDeg), count: 1 })),
  ].sort((a, b) => a.heightM - b.heightM);

  const windNodes: { heightM: number; uMps: number; vMps: number; count: number }[] = [];
  for (const node of rawWindNodes) {
    const prev = windNodes[windNodes.length - 1];
    if (prev && Math.abs(node.heightM - prev.heightM) <= 1e-6) {
      const nextCount = prev.count + 1;
      prev.uMps = (prev.uMps * prev.count + node.uMps) / nextCount;
      prev.vMps = (prev.vMps * prev.count + node.vMps) / nextCount;
      prev.count = nextCount;
    } else {
      windNodes.push({ ...node });
    }
  }

  const maxHeightM = windNodes[windNodes.length - 1].heightM;
  const targetTopM = Math.min(Math.max(terrainM, finite(blTopM) ? blTopM : terrainM), maxHeightM);

  if (targetTopM <= terrainM) {
    const w = componentsToWind(sfcComp.uMps, sfcComp.vMps);
    return {
      blMeanWindSpeedMps: w.speedMps,
      blMeanWindDirDeg: normalizeDegrees(w.directionDeg),
      blTopWindSpeedMps: w.speedMps,
      blTopWindDirDeg: normalizeDegrees(w.directionDeg),
      blWindShearMps: 0,
    };
  }

  const clipped = [windNodes[0]];
  for (let i = 1; i < windNodes.length; i += 1) {
    const prev = windNodes[i - 1];
    const curr = windNodes[i];
    if (curr.heightM <= targetTopM) {
      clipped.push(curr);
      if (curr.heightM === targetTopM) break;
    } else {
      if (targetTopM > prev.heightM) {
        const fh = (targetTopM - prev.heightM) / (curr.heightM - prev.heightM);
        clipped.push({
          heightM: targetTopM,
          uMps: prev.uMps + fh * (curr.uMps - prev.uMps),
          vMps: prev.vMps + fh * (curr.vMps - prev.vMps),
          count: 1,
        });
      }
      break;
    }
  }

  let totalDz = 0;
  let sumUDz = 0;
  let sumVDz = 0;
  for (let i = 0; i < clipped.length - 1; i += 1) {
    const a = clipped[i];
    const b = clipped[i + 1];
    const dz = Math.max(0, b.heightM - a.heightM);
    if (dz <= 0) continue;
    totalDz += dz;
    sumUDz += 0.5 * (a.uMps + b.uMps) * dz;
    sumVDz += 0.5 * (a.vMps + b.vMps) * dz;
  }

  const meanU = totalDz > 0 ? sumUDz / totalDz : sfcComp.uMps;
  const meanV = totalDz > 0 ? sumVDz / totalDz : sfcComp.vMps;
  const topNode = clipped[clipped.length - 1];
  const meanWind = componentsToWind(meanU, meanV);
  const topWind = componentsToWind(topNode.uMps, topNode.vMps);
  const blWindShearMps = Math.hypot(topNode.uMps - sfcComp.uMps, topNode.vMps - sfcComp.vMps);

  return {
    blMeanWindSpeedMps: meanWind.speedMps,
    blMeanWindDirDeg: normalizeDegrees(meanWind.directionDeg),
    blTopWindSpeedMps: topWind.speedMps,
    blTopWindDirDeg: normalizeDegrees(topWind.directionDeg),
    blWindShearMps,
  };
}
