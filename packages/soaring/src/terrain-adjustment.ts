import { sampleWindAtHeight, type SurfaceWind, type WindLevel } from '@windgrams/meteorology';
import type { TerrainAdjustment } from './types.js';
import { finite, round1, round2 } from '@windgrams/meteorology/thermodynamics';

/**
 * Free-air wind at the launch ground elevation MSL, not wind 10 m above that launch.
 * Use only adjacent valid nodes. Missing/duplicate nodes block interpolation;
 * no extrapolation or terrain correction is applied to other quantities.
 */
export function computeExperimentalTerrainAdjustment(terrainM: number | null | undefined, launchElevationM: number | null | undefined, source: SurfaceWind | null | undefined, levels: readonly WindLevel[] | null | undefined): TerrainAdjustment | null {
  if (!finite(terrainM) || !finite(launchElevationM) || !source) return null;
  const nodes: WindLevel[] = [
    { heightM: terrainM + 10, windSpeedMps: source.windSpeedMps, windDirectionDeg: source.windDirectionDeg },
    ...(source.wind80mSpeedMps != null || source.wind80mDirectionDeg != null
      ? [{ heightM: terrainM + 80, windSpeedMps: source.wind80mSpeedMps, windDirectionDeg: source.wind80mDirectionDeg }] : []),
    ...(levels ?? []).filter(level => finite(level.heightM) && level.heightM > terrainM),
  ];
  const sample = launchElevationM < terrainM
    ? { status: 'unavailable', reason: 'below-model-ground' } as const
    : sampleWindAtHeight(nodes, launchElevationM);
  const speed = sample.status === 'available' ? round2(sample.speedMps) : null;
  return {
    experimental: true, launchElevationM: round1(launchElevationM)!, modelElevationM: round1(terrainM)!,
    terrainDeltaM: round1(launchElevationM - terrainM)!, targetHeightMslM: launchElevationM, targetReference: 'launch-elevation',
    bracketsLaunchAltitude: sample.status === 'available',
    bracketMslM: sample.status === 'available' ? sample.bracketMslM : null,
    unavailableReason: sample.status === 'unavailable' ? sample.reason : null,
    launchWindSpeedMps: speed,
    launchWindDirectionDeg: sample.status === 'available' && speed !== 0 ? round1(sample.directionDeg) : null,
    rawMslHeightsPreserved: true,
    assumptions: [
      'Free-air horizontal components at launch ground elevation MSL use adjacent valid model nodes; model surface wind is at terrain + 10 m and optional 80 m wind at terrain + 80 m.',
      'No extrapolation, interpolation across missing wind nodes, or duplicate-height selection. Calm wind has no direction.',
      'This estimate does not resolve slope flow, shelter or gusts. Model terrain, parcel inputs and MSL cloud/lift heights remain unchanged.',
    ],
  };
}
