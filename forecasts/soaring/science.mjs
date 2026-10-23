import { roundDocument } from '@azohra/meteo.forecast';
import { parseSiteForecast } from '@azohra/meteo.briefing/contract';
import {
  DRY_ADIABATIC_LAPSE_C_PER_M,
  buoyancyShearRatio,
  componentsToWind,
  mixingRatioKgKg,
  normalizeDegrees,
  surfaceToBoundaryLayerShearMps,
  usableLiftTopM,
  windToComponents,
} from '@azohra/meteo.briefing/derive';
import { deriveSiteForecast } from './vendor/derive-0.6.0.mjs';
import { wind, storageCoordinates } from './grid.mjs';
import { modelFor, semanticsFor, validAt } from './common.mjs';

export const SOARING_CONTRACT_VERSION = '2.0.0';
export const metrics = ['thermalVelocityMps', 'usableLiftTopM', 'boundaryLayerTopM', 'cloudBaseM', 'pblHeightM'];
export const WXTOFLY_SINK_MPS = 225 * 0.00508; // 225 ft/min = 1.143 m/s (WxToFly windgram specification)
export const v2LayerMetrics = [
  'resolvedThermalTopM',
  'thermalTopPlus1CM',
  'thermalVelocityV2Mps',
  'usableLiftTopV2M',
  'hcritWxtoflyM',
  'dryHcritM',
  'surfaceLclM',
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

const RD_J_PER_KG_K = 287.05;
const GRAVITY_MPS2 = 9.80665;
const POISSON_KAPPA = 0.2854; // Rd / cpd
const EPSILON = 0.622;
const MAGNUS_A = 17.625;
const MAGNUS_B_C = 243.04;
const MAGNUS_ES0_HPA = 6.1094;
const SATURATED_DEPRESSION_C = 0.5;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const round1 = n => (finite(n) ? Math.round(n * 10) / 10 : null);
const round2 = n => (finite(n) ? Math.round(n * 100) / 100 : null);
const optional = ['windGustMps', 'capeJkg', 'cinJkg', 'pblHeightM', 'lowCloudPercent', 'midCloudPercent', 'highCloudPercent'];

export function geometricWFromOmegaMps(omegaPaS, pressureHpa, temperatureC) {
  if (!finite(omegaPaS) || !finite(pressureHpa) || !finite(temperatureC) || pressureHpa <= 0) return null;
  const temperatureK = temperatureC + 273.15;
  const densityKgM3 = (pressureHpa * 100) / (RD_J_PER_KG_K * temperatureK);
  return -omegaPaS / (densityKgM3 * GRAVITY_MPS2);
}

/**
 * Bolton (1980) LCL temperature and dry-adiabatic height above surface (m AGL).
 */
export function parcelLclAglM(temperatureC, dewPointC) {
  if (!finite(temperatureC) || !finite(dewPointC)) return null;
  if (dewPointC >= temperatureC) return 0;
  const temperatureK = temperatureC + 273.15;
  const dewPointK = dewPointC + 273.15;
  const lclTemperatureK = 1 / (1 / (dewPointK - 56) + Math.log(temperatureK / dewPointK) / 800) + 56;
  return Math.max(0, (temperatureK - lclTemperatureK) / DRY_ADIABATIC_LAPSE_C_PER_M);
}

/**
 * Hypsometric surface pressure (hPa) anchored to the lowest above-ground pressure level.
 */
export function hypsometricSurfacePressureHpa(terrainM, surfaceTempC, firstLevel) {
  if (!finite(terrainM) || !finite(surfaceTempC) || !firstLevel || !finite(firstLevel.pressureHpa) || !finite(firstLevel.heightM) || !finite(firstLevel.temperatureC)) {
    return 1013.25;
  }
  const meanTempK = 0.5 * (surfaceTempC + firstLevel.temperatureC) + 273.15;
  return firstLevel.pressureHpa * Math.exp((GRAVITY_MPS2 * (firstLevel.heightM - terrainM)) / (RD_J_PER_KG_K * meanTempK));
}

/**
 * Inverts Alduchov & Eskridge (1996) Magnus saturation vapor pressure to recover
 * dew point (degC) from water-vapor mixing ratio r (kg/kg) and pressure p (hPa).
 */
export function dewPointFromMixingRatioC(mixingRatio, pressureHpa) {
  if (!finite(mixingRatio) || !finite(pressureHpa) || mixingRatio <= 0 || pressureHpa <= 0) return -60;
  const vaporPressureHpa = Math.max(1e-6, (mixingRatio * pressureHpa) / (EPSILON + mixingRatio));
  const lnRatio = Math.log(vaporPressureHpa / MAGNUS_ES0_HPA);
  return (MAGNUS_B_C * lnRatio) / (MAGNUS_A - lnRatio);
}

/**
 * Physical Mixed-Layer LCL (DrJack `zblcl`, m MSL) without arbitrary scaling multipliers:
 * averages potential temperature θ and water-vapor mixing ratio r across the boundary
 * layer, references the mixed parcel to surface pressure, and lifts via Bolton's LCL.
 */
export function computeMixedLayerLclM(terrainM, surfaceTempC, surfaceDewPointC, levels, blTopM) {
  if (!finite(terrainM) || !finite(surfaceTempC) || !finite(surfaceDewPointC) || !levels?.length) return null;
  const firstLevel = levels[0];
  const pSfcHpa = hypsometricSurfacePressureHpa(terrainM, surfaceTempC, firstLevel);
  const capM = Math.max(blTopM ?? terrainM, firstLevel.heightM);
  const blLevels = levels.filter(l => l.heightM <= capM);
  const sampleLevels = blLevels.length > 0 ? blLevels : [firstLevel];

  const nodes = [
    { pressureHpa: pSfcHpa, temperatureC: surfaceTempC, dewPointC: Math.min(surfaceTempC, surfaceDewPointC) },
    ...sampleLevels.map(l => {
      const td = finite(l.dewPointC) ? l.dewPointC : l.temperatureC - (l.dewPointDepressionC ?? 0);
      return { pressureHpa: l.pressureHpa, temperatureC: l.temperatureC, dewPointC: Math.min(l.temperatureC, td) };
    }),
  ];

  let sumThetaK = 0;
  let sumMixingRatio = 0;
  for (const node of nodes) {
    sumThetaK += (node.temperatureC + 273.15) * (1000 / node.pressureHpa) ** POISSON_KAPPA;
    sumMixingRatio += mixingRatioKgKg(node.dewPointC, node.pressureHpa);
  }
  const meanThetaK = sumThetaK / nodes.length;
  const meanMixingRatio = sumMixingRatio / nodes.length;
  const mixedSurfaceTempC = meanThetaK * (pSfcHpa / 1000) ** POISSON_KAPPA - 273.15;
  const mixedSurfaceDewPointC = Math.min(mixedSurfaceTempC, dewPointFromMixingRatioC(meanMixingRatio, pSfcHpa));
  const lclAglM = parcelLclAglM(mixedSurfaceTempC, mixedSurfaceDewPointC);
  return lclAglM == null ? null : Math.max(terrainM, terrainM + lclAglM);
}

/**
 * Deardorff (1970) convective velocity scale W* (m/s) driven by surface virtual heat flux
 * and resolved boundary-layer depth (m). Uses the exact thermodynamic constants of v1
 * so v1 and v2 agree identically whenever resolvedDepthM equals v1 boundaryLayerDepthM.
 */
export function computeThermalVelocityMps(surfaceTemperatureC, sensibleHeatFluxWm2, latentHeatFluxWm2, boundaryLayerDepthM, firstPressureHpa) {
  if (!finite(boundaryLayerDepthM) || boundaryLayerDepthM <= 0 || !finite(firstPressureHpa) || firstPressureHpa <= 0) return 0;
  const surfaceTemperatureK = surfaceTemperatureC + 273.15;
  const virtualHeatFlux = (sensibleHeatFluxWm2 ?? 0) + 245268e-9 * surfaceTemperatureK * (latentHeatFluxWm2 ?? 0);
  if (virtualHeatFlux <= 0) return 0;
  const potentialTemperatureK = surfaceTemperatureK * (1015 / firstPressureHpa) ** 0.28482;
  return Math.cbrt((0.0075516 / potentialTemperatureK) * virtualHeatFlux * boundaryLayerDepthM);
}

/**
 * Evaluates usable-lift top (m MSL) for a given sink rate along the Lenschow & Stephens (1980)
 * convective updraft profile bounded strictly within [modelElevationM, resolvedThermalTopM].
 * Including normalized boundary-layer height nodes prevents sparse 9-level profiles (where
 * 925 hPa is above a shallow PBL top) from extrapolating usable lift above resolvedThermalTopM.
 */
export function computeUsableLiftTopV2M({ modelElevationM, resolvedThermalTopM, thermalVelocityV2Mps, cloudBaseM, levels }, sinkRateMps = 1.0) {
  if (!finite(modelElevationM) || !finite(resolvedThermalTopM) || !finite(thermalVelocityV2Mps)) return null;
  const depthM = resolvedThermalTopM - modelElevationM;
  if (depthM <= 0 || thermalVelocityV2Mps * 2.02 < sinkRateMps) return null;
  const fractions = [0.25, 0.3125, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const syntheticNodes = fractions.map(f => ({ heightM: modelElevationM + depthM * f }));
  const nativeInsideBl = (levels ?? [])
    .filter(l => finite(l.heightM) && l.heightM >= modelElevationM + depthM * 0.25 && l.heightM <= resolvedThermalTopM)
    .map(l => ({ heightM: l.heightM }));
  const boundedLevels = [...syntheticNodes, ...nativeInsideBl].sort((a, b) => a.heightM - b.heightM);
  const rawTop = usableLiftTopM({
    modelElevationM,
    boundaryLayerTopM: resolvedThermalTopM,
    thermalVelocityMps: thermalVelocityV2Mps,
    cloudBaseM: finite(cloudBaseM) ? cloudBaseM : 99999,
    levels: boundedLevels,
  }, sinkRateMps);
  if (rawTop == null) return null;
  return Math.min(resolvedThermalTopM, rawTop);
}

export function resolvedParcelDepthM(surfaceTemperatureC, sensibleHeatFluxWm2, latentHeatFluxWm2, pblHeightM, modelElevationM, levels, deltaTC = 0) {
  const parcelSurfaceTC = surfaceTemperatureC + deltaTC;
  const surfaceTemperatureK = surfaceTemperatureC + 273.15;
  const virtualHeatFlux = (sensibleHeatFluxWm2 ?? 0) + 245268e-9 * surfaceTemperatureK * (latentHeatFluxWm2 ?? 0);
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    const altitudeAglM = level.heightM - modelElevationM;
    if (parcelSurfaceTC - altitudeAglM * DRY_ADIABATIC_LAPSE_C_PER_M > level.temperatureC) continue;
    if (index === 0) {
      // Fix v1 index===0 jump: when the surface parcel is already cooler than the
      // dry adiabat at the first pressure level (e.g. 925 hPa), do not jump to 925 hPa.
      if (virtualHeatFlux <= 0 && deltaTC <= 0) return 0;
      if (finite(pblHeightM) && pblHeightM > 0) {
        const capM = Math.max(0, altitudeAglM);
        const sensBoostM = deltaTC > 0 ? Math.min(250 * deltaTC, Math.max(0, capM - pblHeightM)) : 0;
        return Math.min(capM, Math.max(0, pblHeightM + sensBoostM));
      }
      const superadiabaticExcessC = Math.max(0, deltaTC + Math.min(1.5, Math.max(0, sensibleHeatFluxWm2 ?? 0) * 0.012));
      const envLapse = (level.temperatureC - surfaceTemperatureC) / Math.max(1, altitudeAglM);
      const denom = DRY_ADIABATIC_LAPSE_C_PER_M + envLapse;
      if (denom <= 1e-5) return 0;
      return Math.min(altitudeAglM, Math.max(0, superadiabaticExcessC / denom));
    }
    const previous = levels[index - 1];
    const previousAglM = previous.heightM - modelElevationM;
    const lapse = (level.temperatureC - previous.temperatureC) / (level.heightM - previous.heightM);
    const denominator = DRY_ADIABATIC_LAPSE_C_PER_M + lapse;
    if (Math.abs(denominator) < 1e-5) return Math.max(0, previousAglM);
    return Math.max(0, (parcelSurfaceTC - previous.temperatureC + lapse * previousAglM) / denominator);
  }
  if (levels.length > 0) return Math.max(0, levels[levels.length - 1].heightM - modelElevationM);
  return 0;
}

/**
 * Experimental terrain adjustment isolated from authoritative MSL heights.
 * Interpolates horizontal wind components (u, v) at launchElevationM ONLY when
 * the model profile brackets launchElevationM; never shifts published MSL cloud base
 * or usable lift heights.
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
        .map(l => ({ heightM: l.heightM, ...windToComponents(l.windSpeedMps, l.windDirectionDeg) })),
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

export function deriveDiagnosticsV2(terrain, source, v1Hour, options = {}) {
  if (!source || !finite(terrain) || !v1Hour) return null;
  const levels = source.levels
    .filter(l => finite(l.heightM) && l.heightM > terrain + 20)
    .sort((a, b) => a.heightM - b.heightM);
  if (levels.length < 3) return null;

  const surfaceDewPointC = finite(source.dewPointC)
    ? source.dewPointC
    : source.temperatureC - source.dewPointDepressionC;
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

  // Consistent v2 convective velocity scale W* computed from resolvedDepthM (NOT v1 depth)
  const thermalVelocityV2Raw = computeThermalVelocityMps(
    source.temperatureC,
    source.sensibleHeatFluxWm2,
    source.latentHeatFluxWm2,
    resolvedDepthM,
    levels[0].pressureHpa,
  );
  const thermalVelocityV2Mps = round2(thermalVelocityV2Raw) ?? 0;

  // Physical Mixed-Layer LCL (zblcl) without arbitrary 0.85 scaling
  const blTopForMixM = resolvedThermalTopM ?? (terrain + (source.pblHeightM ?? 300));
  const mixedLayerLclM = computeMixedLayerLclM(terrain, source.temperatureC, surfaceDewPointC, levels, blTopForMixM);

  const cuPotentialM = resolvedThermalTopM != null && surfaceLclM != null ? resolvedThermalTopM - surfaceLclM : null;
  const odPotentialM = resolvedThermalTopM != null && mixedLayerLclM != null ? resolvedThermalTopM - mixedLayerLclM : null;

  const v2CloudBaseM = v1Hour.derived?.cloudBaseM ?? surfaceLclM;

  // Consistent v2 usable-lift diagnostics computed from resolvedThermalTopM and thermalVelocityV2Mps
  const usableLiftTopV2M = computeUsableLiftTopV2M({
    modelElevationM: terrain,
    resolvedThermalTopM,
    thermalVelocityV2Mps,
    cloudBaseM: v2CloudBaseM,
    levels,
  }, 1.0);

  const hcritWxtoflyM = computeUsableLiftTopV2M({
    modelElevationM: terrain,
    resolvedThermalTopM,
    thermalVelocityV2Mps,
    cloudBaseM: v2CloudBaseM,
    levels,
  }, WXTOFLY_SINK_MPS);

  const dryHcritM = computeUsableLiftTopV2M({
    modelElevationM: terrain,
    resolvedThermalTopM,
    thermalVelocityV2Mps,
    cloudBaseM: 99999,
    levels,
  }, 1.0);

  // Boundary-layer mean wind & BL top wind & vector shear
  const windNodes = [
    { heightM: terrain, ...windToComponents(source.windSpeedMps, source.windDirectionDeg) },
    ...(finite(source.wind80mSpeedMps) && finite(source.wind80mDirectionDeg)
      ? [{ heightM: terrain + 80, ...windToComponents(source.wind80mSpeedMps, source.wind80mDirectionDeg) }]
      : []),
    ...levels.map(l => ({ heightM: l.heightM, ...windToComponents(l.windSpeedMps, l.windDirectionDeg) })),
  ].sort((a, b) => a.heightM - b.heightM);

  const targetTopM = resolvedThermalTopM ?? v1Hour.derived.boundaryLayerTopM ?? (terrain + (source.pblHeightM ?? 0));
  let sumU = windNodes[0].uMps;
  let sumV = windNodes[0].vMps;
  let countW = 1;
  for (const node of windNodes.slice(1)) {
    if (node.heightM <= Math.max(targetTopM, levels[0].heightM)) {
      sumU += node.uMps;
      sumV += node.vMps;
      countW += 1;
    }
  }
  const meanU = sumU / countW;
  const meanV = sumV / countW;
  const blMeanWindSpeedMps = Math.hypot(meanU, meanV);
  const blMeanWindDirDeg = normalizeDegrees((Math.atan2(-meanU, -meanV) * 180) / Math.PI);

  // Interpolate wind at targetTopM
  let topU = windNodes[windNodes.length - 1].uMps;
  let topV = windNodes[windNodes.length - 1].vMps;
  if (targetTopM <= windNodes[0].heightM) {
    topU = windNodes[0].uMps;
    topV = windNodes[0].vMps;
  } else {
    for (let k = 0; k < windNodes.length - 1; k++) {
      if (targetTopM <= windNodes[k + 1].heightM) {
        const frac = (targetTopM - windNodes[k].heightM) / Math.max(1, windNodes[k + 1].heightM - windNodes[k].heightM);
        topU = windNodes[k].uMps + frac * (windNodes[k + 1].uMps - windNodes[k].uMps);
        topV = windNodes[k].vMps + frac * (windNodes[k + 1].vMps - windNodes[k].vMps);
        break;
      }
    }
  }
  const blTopWindSpeedMps = Math.hypot(topU, topV);
  const blTopWindDirDeg = normalizeDegrees((Math.atan2(-topU, -topV) * 180) / Math.PI);
  const blWindShearMps = surfaceToBoundaryLayerShearMps({
    modelElevationM: terrain,
    boundaryLayerTopM: targetTopM > terrain ? targetTopM : levels[0].heightM,
    surfaceWind: { windSpeedMps: source.windSpeedMps, windDirectionDeg: source.windDirectionDeg },
    levels,
  });
  const bsRatioRaw = blWindShearMps != null ? buoyancyShearRatio(thermalVelocityV2Mps, Math.max(0.2, blWindShearMps)) : null;

  // Vertical velocities in geometric m/s
  let maxUpwardVelocityMps = null;
  let minDownwardVelocityMps = null;
  const wByPressure = {};
  for (const l of source.levels) {
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
  const hasSub925 = source.levels.some(l => l.pressureHpa > 925);
  const hasAbove600 = source.levels.some(l => l.pressureHpa < 600);

  const result = {
    contractVersion: SOARING_CONTRACT_VERSION,
    resolvedThermalTopM: round1(resolvedThermalTopM),
    thermalTopPlus1CM: round1(thermalTopPlus1CM),
    thermalVelocityV2Mps,
    usableLiftTopV2M: round1(usableLiftTopV2M),
    hcritWxtoflyM: round1(hcritWxtoflyM),
    dryHcritM: round1(dryHcritM),
    surfaceLclM: round1(surfaceLclM),
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
      nativeLevelCount: source.levels.length,
      aboveGroundLevelCount: levels.length,
      isSparseProfile: source.levels.length <= 9,
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

/**
 * Computes horizontal convergence (-du/dx - dv/dy) in units of 10^-5 s^-1
 * on the native 3 km Lambert grid before display reprojection.
 */
export function computeNativeGridConvergence(grid, cells, uGridArray, vGridArray) {
  const byGridIJ = new Map();
  for (let idx = 0; idx < cells.length; idx++) {
    const [i, j] = storageCoordinates(grid, cells[idx].index);
    byGridIJ.set(`${i},${j}`, idx);
  }
  const dx = grid.dxM * (grid.iScansNegatively ? -1 : 1);
  const dy = grid.dyM * (grid.jScansPositively ? 1 : -1);
  return cells.map(cell => {
    const [i, j] = storageCoordinates(grid, cell.index);
    const cIdx = byGridIJ.get(`${i},${j}`);
    const eIdx = byGridIJ.get(`${i + 1},${j}`) ?? cIdx;
    const wIdx = byGridIJ.get(`${i - 1},${j}`) ?? cIdx;
    const nIdx = byGridIJ.get(`${i},${j + 1}`) ?? cIdx;
    const sIdx = byGridIJ.get(`${i},${j - 1}`) ?? cIdx;
    const spanX = (eIdx !== cIdx ? 1 : 0) + (wIdx !== cIdx ? 1 : 0);
    const spanY = (nIdx !== cIdx ? 1 : 0) + (sIdx !== cIdx ? 1 : 0);
    if (!spanX || !spanY) return null;
    const uE = uGridArray[eIdx], uW = uGridArray[wIdx];
    const vN = vGridArray[nIdx], vS = vGridArray[sIdx];
    if (![uE, uW, vN, vS].every(finite)) return null;
    const dudx = (uE - uW) / (spanX * dx);
    const dvdy = (vN - vS) / (spanY * dy);
    const convergencePerSec = -(dudx + dvdy);
    const rounded = round2(convergencePerSec * 1e5);
    return rounded === 0 ? 0 : rounded;
  });
}

export function cellSource(c, grid, cell, hour, raw) {
  const surfaceWind = wind(grid, cell.longitude, raw.u, raw.v);
  const required = ['temperature', 'dewpoint', 'cloudCoverPercent', 'latentHeatFluxWm2', 'sensibleHeatFluxWm2', 'precipitationMm', 'seaLevelPressureHpa'];
  if (!surfaceWind || !required.every(k => finite(raw[k]))) return null;
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
    const get = key => raw[`${p}.${key}`];
    const w = wind(grid, cell.longitude, get('UGRD'), get('VGRD'));
    if (!w || !['TMP', 'DPT', 'HGT'].every(k => finite(get(k)))) continue;
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

export function deriveCell(c, terrain, source, capturedAt) {
  const levels = source?.levels.filter(l => l.heightM > terrain + 20).sort((a, b) => a.heightM - b.heightM) ?? [];
  const status = !source || !finite(terrain) ? 'missing' : levels.length < c.minimumAboveGroundLevels ? 'insufficient-levels' : 'valid';
  const ceilingReached = status === 'valid' && levels.every(l => source.temperatureC - (l.heightM - terrain) * DRY_ADIABATIC_LAPSE_C_PER_M > l.temperatureC);
  if (status !== 'valid') return { status, levelCount: levels.length, ceilingReached: false, hour: null, v2: null };
  const profile = roundDocument(deriveSiteForecast({
    ...c.site,
    siteId: c.site.slug,
    siteName: c.site.name,
    siteTimeZone: c.site.timeZone,
    modelElevationM: terrain,
    referenceTime: c.referenceTime,
    generatedAt: capturedAt,
    hours: [source],
  }, modelFor(c), semanticsFor(c)));
  const v2 = deriveDiagnosticsV2(terrain, source, profile.hours[0], {
    launchElevationM: c.launchElevation?.elevationM ?? null,
  });
  return { status, levelCount: levels.length, ceilingReached, hour: profile.hours[0], site: profile.site, v2 };
}

export function profileFor(c, site, hours, capturedAt) {
  const profile = { schemaVersion: 2, model: modelFor(c), run: { referenceTime: c.referenceTime, generatedAt: capturedAt }, site, semantics: semanticsFor(c), hours };
  if (!parseSiteForecast(profile)) throw new Error('Blanchard profile failed the public SiteForecast contract');
  return profile;
}
export function metric(hour, key) { return (key === 'pblHeightM' ? hour?.surface[key] : hour?.derived[key]) ?? null; }
export function assertAgreement(profile, hourly, siteCell) {
  if (profile.hours.length !== hourly.length) throw new Error('Map/profile hour count mismatch');
  for (let i = 0; i < hourly.length; i++) {
    if (profile.hours[i].validAt !== hourly[i].validAt) throw new Error('Map/profile time mismatch');
    for (const key of metrics) if (metric(profile.hours[i], key) !== hourly[i][key][siteCell]) throw new Error(`Map/profile mismatch: ${i} ${key}`);
    if (profile.hours[i].soaring) for (const key of v2LayerMetrics) {
      if ((profile.hours[i].soaring[key] ?? null) !== hourly[i][key][siteCell]) throw new Error(`Map/profile v2 mismatch: ${i} ${key}`);
    }
  }
  return { exact: true, hours: hourly.length, valuesChecked: hourly.length * metrics.length + profile.hours.filter(h => h.soaring).length * v2LayerMetrics.length };
}
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
