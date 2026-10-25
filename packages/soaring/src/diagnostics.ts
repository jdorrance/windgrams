import type { AtmosphericColumn, AtmosphericLevel } from "@windgrams/contracts";
import type { BaselineLiftHour, DiagnosticOptions, SoaringDiagnostics } from "./types.js";
// V2 soaring diagnostic composition, contract version, and publication rounding.

import { buoyancyShearRatio } from '@azohra/meteo.briefing/derive';
import {
  computeMixedLayerLclM,
  finite,
  geometricWFromOmegaMps,
  hypsometricSurfacePressureHpa,
  parcelLclAglM,
  round1,
  round2,
} from '@windgrams/meteorology/thermodynamics';
import {
  WXTOFLY_SINK_MPS,
  computeThermalVelocityMps,
  computeUsableLiftTopV2M,
  resolvedParcelDepthM,
} from './convective-lift.js';
import { computeBoundaryLayerWind } from '@windgrams/meteorology';
import { computeExperimentalTerrainAdjustment } from './terrain-adjustment.js';

export const SOARING_CONTRACT_VERSION = '2.1.0';
export const metrics = ['thermalVelocityMps', 'usableLiftTopM', 'boundaryLayerTopM', 'cloudBaseM', 'pblHeightM'];
export const v2LayerMetrics = [
  'resolvedThermalTopM',
  'thermalTopPlus1CM',
  'thermalVelocityV2Mps',
  'usableLiftTopV2M',
  'hcritWxtoflyM',
  'dryHcritM',
  'surfaceLclM',
  'effectiveCloudLimitM',
  'mixedLayerLclM',
  'cuPotentialM',
  'odPotentialM',
  'blMeanWindSpeedMps',
  'blMeanWindDirDeg',
  'blTopWindSpeedMps',
  'blTopWindDirDeg',
  'blWindShearMps',
  'buoyancyShearRatio',
  'wind10mSpeedMps',
  'wind10mDirDeg',
  'wind80mSpeedMps',
  'wind80mDirDeg',
  'windGustMps',
  'wind925SpeedMps',
  'wind925DirDeg',
  'wind850SpeedMps',
  'wind850DirDeg',
  'maxUpwardVelocityMps',
  'minDownwardVelocityMps',
  'w925Mps',
  'w850Mps',
  'convergence10mX1e5',
  'convergence925X1e5',
  'sensibleHeatFluxWm2',
  'latentHeatFluxWm2',
  'cloudCoverPercent',
  'lowCloudPercent',
  'midCloudPercent',
  'highCloudPercent',
  'precipitationMmHr',
  'capeJkg',
  'cinJkg',
];

/**
 * Composes V2 soaring diagnostics for a single atmospheric column.
 */
export function deriveDiagnosticsV2(terrain: number | null | undefined, source: AtmosphericColumn | null | undefined, v1Hour: BaselineLiftHour | null | undefined, options: DiagnosticOptions = {}): SoaringDiagnostics | null {
  if (!source || !finite(terrain) || !v1Hour) return null;
  const rawLevels: readonly AtmosphericLevel[] = Array.isArray(source.levels) ? source.levels : [];
  const levels = rawLevels
    .filter(l => finite(l.heightM) && l.heightM > terrain + 20)
    .sort((a, b) => a.heightM - b.heightM);
  if (levels.length < 3) return null;

  const surfaceDewPointC = finite(source.dewPointC)
    ? source.dewPointC
    : source.temperatureC - (source.dewPointDepressionC ?? NaN);
  const sfcLclAgl = parcelLclAglM(source.temperatureC, surfaceDewPointC);
  const surfaceLclM = sfcLclAgl == null ? null : Math.max(terrain, terrain + sfcLclAgl);

  const resolvedDepthM = resolvedParcelDepthM(
    source.temperatureC,
    source.sensibleHeatFluxWm2,
    source.latentHeatFluxWm2,
    source.pblHeightM,
    terrain,
    levels,
    0,
  );
  const resolvedThermalTopM = resolvedDepthM > 0 ? terrain + resolvedDepthM : null;

  const plus1DepthM = resolvedParcelDepthM(
    source.temperatureC,
    source.sensibleHeatFluxWm2,
    source.latentHeatFluxWm2,
    source.pblHeightM,
    terrain,
    levels,
    1.0,
  );
  const thermalTopPlus1CM = plus1DepthM > 0 ? terrain + plus1DepthM : null;

  const pSfcHpa = hypsometricSurfacePressureHpa(terrain, source.temperatureC, levels[0]);
  const thermalVelocityV2Raw = computeThermalVelocityMps({
    surfaceTemperatureC: source.temperatureC,
    surfaceDewPointC,
    sensibleHeatFluxWm2: source.sensibleHeatFluxWm2,
    latentHeatFluxWm2: source.latentHeatFluxWm2,
    boundaryLayerDepthM: resolvedDepthM,
    surfacePressureHpa: pSfcHpa,
  });
  const thermalVelocityV2Mps = round2(thermalVelocityV2Raw) ?? 0;

  // Physical Mixed-Layer LCL (zblcl) integrated over pressure mass and clipped at actual layer top
  const blTopForMixM = resolvedThermalTopM ?? (terrain + (source.pblHeightM ?? 0));
  const mixedLayerLclM = computeMixedLayerLclM(terrain, source.temperatureC, surfaceDewPointC, levels, blTopForMixM);

  const cuPotentialM = resolvedThermalTopM != null && surfaceLclM != null ? resolvedThermalTopM - surfaceLclM : null;
  const odPotentialM = resolvedThermalTopM != null && mixedLayerLclM != null ? resolvedThermalTopM - mixedLayerLclM : null;

  const effectiveCloudLimitM = v1Hour.derived?.cloudBaseM ?? surfaceLclM;

  // Consistent v2 usable-lift diagnostics computed from resolvedThermalTopM and thermalVelocityV2Mps
  const usableLiftTopV2M = computeUsableLiftTopV2M({
    modelElevationM: terrain,
    resolvedThermalTopM,
    thermalVelocityV2Mps,
    cloudBaseM: effectiveCloudLimitM,
  }, 1.0);

  const hcritWxtoflyM = computeUsableLiftTopV2M({
    modelElevationM: terrain,
    resolvedThermalTopM,
    thermalVelocityV2Mps,
    cloudBaseM: effectiveCloudLimitM,
  }, WXTOFLY_SINK_MPS);

  const dryHcritM = computeUsableLiftTopV2M({
    modelElevationM: terrain,
    resolvedThermalTopM,
    thermalVelocityV2Mps,
    cloudBaseM: null,
  }, 1.0);

  // Height-weighted boundary-layer mean wind, BL top wind, and vector shear clipped at actual BL top
  const targetTopM = resolvedThermalTopM ?? (terrain + (source.pblHeightM ?? 0));
  const blWind = computeBoundaryLayerWind(
    terrain,
   { windSpeedMps: source.windSpeedMps, windDirectionDeg: source.windDirectionDeg },
    levels,
    targetTopM,
    finite(source.wind80mSpeedMps) && finite(source.wind80mDirectionDeg)
      ? { windSpeedMps: source.wind80mSpeedMps, windDirectionDeg: source.wind80mDirectionDeg }
      : null,
  );
  const blMeanWindSpeedMps = blWind?.blMeanWindSpeedMps ?? null;
  const blMeanWindDirDeg = blWind?.blMeanWindDirDeg ?? null;
  const blTopWindSpeedMps = blWind?.blTopWindSpeedMps ?? null;
  const blTopWindDirDeg = blWind?.blTopWindDirDeg ?? null;
  const blWindShearMps = blWind?.blWindShearMps ?? null;
  const bsRatioRaw = blWindShearMps != null ? buoyancyShearRatio(thermalVelocityV2Mps, Math.max(0.2, blWindShearMps)) : null;

  // Vertical velocities in geometric m/s
  let maxUpwardVelocityMps: number | null = null;
  let minDownwardVelocityMps: number | null = null;
  const wByPressure: Record<number, number> = {};
  for (const l of rawLevels) {
    if (l.heightM <= terrain + 20) continue;
    const w = geometricWFromOmegaMps(l.verticalVelocityPaS, l.pressureHpa, l.temperatureC);
    if (w != null) {
      wByPressure[l.pressureHpa] = w;
      if (l.heightM > terrain + 20) {
        if (maxUpwardVelocityMps === null || w > maxUpwardVelocityMps) maxUpwardVelocityMps = w;
        if (minDownwardVelocityMps === null || w < minDownwardVelocityMps) minDownwardVelocityMps = w;
      }
    }
  }

  const l925 = levels.find(l => l.pressureHpa === 925);
  const l850 = levels.find(l => l.pressureHpa === 850);
  const hasSub925 = rawLevels.some(l => l.pressureHpa > 925);
  const hasAbove600 = rawLevels.some(l => l.pressureHpa < 600);

  const result: SoaringDiagnostics = {
    contractVersion: SOARING_CONTRACT_VERSION,
    resolvedThermalTopM: round1(resolvedThermalTopM),
    thermalTopPlus1CM: round1(thermalTopPlus1CM),
    thermalVelocityV2Mps,
    usableLiftTopV2M: round1(usableLiftTopV2M),
    hcritWxtoflyM: round1(hcritWxtoflyM),
    dryHcritM: round1(dryHcritM),
    surfaceLclM: round1(surfaceLclM),
    effectiveCloudLimitM: round1(effectiveCloudLimitM),
    mixedLayerLclM: round1(mixedLayerLclM),
    cuPotentialM: round1(cuPotentialM),
    odPotentialM: round1(odPotentialM),
    blMeanWindSpeedMps: round2(blMeanWindSpeedMps),
    blMeanWindDirDeg: round1(blMeanWindDirDeg),
    blTopWindSpeedMps: round2(blTopWindSpeedMps),
    blTopWindDirDeg: round1(blTopWindDirDeg),
    blWindShearMps: round2(blWindShearMps),
    buoyancyShearRatio: round2(bsRatioRaw),
    wind10mSpeedMps: round2(source.windSpeedMps),
    wind10mDirDeg: round1(source.windDirectionDeg),
    wind80mSpeedMps: round2(source.wind80mSpeedMps ?? null),
    wind80mDirDeg: round1(source.wind80mDirectionDeg ?? null),
    windGustMps: round2(source.windGustMps ?? null),
    wind925SpeedMps: round2(l925?.windSpeedMps ?? null),
    wind925DirDeg: round1(l925?.windDirectionDeg ?? null),
    wind850SpeedMps: round2(l850?.windSpeedMps ?? null),
    wind850DirDeg: round1(l850?.windDirectionDeg ?? null),
    maxUpwardVelocityMps: round2(maxUpwardVelocityMps),
    minDownwardVelocityMps: round2(minDownwardVelocityMps),
    w925Mps: round2(wByPressure[925] ?? null),
    w850Mps: round2(wByPressure[850] ?? null),
    sensibleHeatFluxWm2: round1(source.sensibleHeatFluxWm2),
    latentHeatFluxWm2: round1(source.latentHeatFluxWm2),
    cloudCoverPercent: round1(source.cloudCoverPercent),
    lowCloudPercent: round1(source.lowCloudPercent ?? null),
    midCloudPercent: round1(source.midCloudPercent ?? null),
    highCloudPercent: round1(source.highCloudPercent ?? null),
    precipitationMmHr: round2(source.precipitationMm),
    capeJkg: round1(source.capeJkg ?? null),
    cinJkg: round1(source.cinJkg ?? null),
    verticalResolution: {
      nativeLevelCount: rawLevels.length,
      aboveGroundLevelCount: levels.length,
      isSparseProfile: rawLevels.length <= 9,
      hasSub925Levels: hasSub925,
      hasUpperAirAbove600Levels: hasAbove600,
      has80mWind: finite(source.wind80mSpeedMps),
      synthesizedLevels: 0,
    },
  };

  if (finite(options.launchElevationM)) {
    result.experimental = {
      terrainAdjustment: computeExperimentalTerrainAdjustment(terrain, options.launchElevationM, source, levels),
    };
  }

  return result;
}
