import { roundDocument } from '@azohra/meteo.forecast';
import { parseSiteForecast } from '@azohra/meteo.briefing/contract';
import {
  DRY_ADIABATIC_LAPSE_C_PER_M,
  buoyancyShearRatio,
  componentsToWind,
  mixingRatioKgKg,
  normalizeDegrees,
  windToComponents,
} from '@azohra/meteo.briefing/derive';
import { deriveSiteForecast } from './vendor/derive-0.6.0.mjs';
import { wind, storageCoordinates } from './grid.mjs';
import { modelFor, semanticsFor, validAt } from './common.mjs';

export const SOARING_CONTRACT_VERSION = '2.1.0';
export const metrics = ['thermalVelocityMps', 'usableLiftTopM', 'boundaryLayerTopM', 'cloudBaseM', 'pblHeightM'];
export const WXTOFLY_SINK_MPS = 225 * 0.00508; // 225 ft/min = 1.143 m/s (WxToFly windgram specification)
export const LENSCHOW_PEAK_ZETA = 0.3125; // 5 / 16: exact maximum of 4 * zeta^(1/3) * (1 - 0.8 * zeta)
export const LENSCHOW_F_MAX = 4 * Math.cbrt(LENSCHOW_PEAK_ZETA) * (1 - 0.8 * LENSCHOW_PEAK_ZETA); // 2.03581321244618
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

const RD_J_PER_KG_K = 287.05;
const CPD_J_PER_KG_K = 1004.0;
const LV_J_PER_KG = 2501000.0;
const GRAVITY_MPS2 = 9.80665;
const POISSON_KAPPA = 0.2854; // Rd / cpd for mixed-layer potential temperature
const EPSILON = 0.622;
const VIRTUAL_TEMP_DELTA = (1 - EPSILON) / EPSILON; // ~0.607717
const MAGNUS_A = 17.625;
const MAGNUS_B_C = 243.04;
const MAGNUS_ES0_HPA = 6.1094;
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
 * Physical Mixed-Layer LCL (DrJack `zblcl`, m MSL) using pressure-mass averages
 * of potential temperature θ and water-vapor mixing ratio r across [terrainM, blTopM]
 * with interpolated layer boundaries (consistent with MetPy's mixed-layer integration),
 * clipped strictly at the actual layer top without including levels above shallow layers.
 */
export function computeMixedLayerLclM(terrainM, surfaceTempC, surfaceDewPointC, levels, blTopM) {
  if (!finite(terrainM) || !finite(surfaceTempC) || !finite(surfaceDewPointC) || !Array.isArray(levels) || !levels.length) return null;
  const validLevels = levels
    .filter(l => l && finite(l.heightM) && l.heightM > terrainM && finite(l.pressureHpa) && l.pressureHpa > 0 && finite(l.temperatureC) && (finite(l.dewPointC) || finite(l.dewPointDepressionC)))
    .sort((a, b) => a.heightM - b.heightM);
  if (validLevels.length === 0) return null;

  const firstLevel = validLevels[0];
  const pSfcHpa = hypsometricSurfacePressureHpa(terrainM, surfaceTempC, firstLevel);
  const sfcDewC = Math.min(surfaceTempC, surfaceDewPointC);
  const maxHeightM = validLevels[validLevels.length - 1].heightM;
  const targetTopM = Math.min(Math.max(terrainM, finite(blTopM) ? blTopM : terrainM), maxHeightM);

  if (targetTopM <= terrainM) {
    const lclAglM = parcelLclAglM(surfaceTempC, sfcDewC);
    return lclAglM == null ? null : Math.max(terrainM, terrainM + lclAglM);
  }

  const rawNodes = [
    {
      heightM: terrainM,
      pressureHpa: pSfcHpa,
      thetaK: (surfaceTempC + 273.15) * (1000 / pSfcHpa) ** POISSON_KAPPA,
      mixingRatio: mixingRatioKgKg(sfcDewC, pSfcHpa),
    },
    ...validLevels.map(l => {
      const td = Math.min(l.temperatureC, finite(l.dewPointC) ? l.dewPointC : l.temperatureC - l.dewPointDepressionC);
      return {
        heightM: l.heightM,
        pressureHpa: l.pressureHpa,
        thetaK: (l.temperatureC + 273.15) * (1000 / l.pressureHpa) ** POISSON_KAPPA,
        mixingRatio: mixingRatioKgKg(td, l.pressureHpa),
      };
    }),
  ];

  const clipped = [rawNodes[0]];
  for (let i = 1; i < rawNodes.length; i += 1) {
    const prev = rawNodes[i - 1];
    const curr = rawNodes[i];
    if (curr.heightM <= targetTopM) {
      clipped.push(curr);
      if (curr.heightM === targetTopM) break;
    } else {
      if (targetTopM > prev.heightM) {
        const fh = (targetTopM - prev.heightM) / (curr.heightM - prev.heightM);
        const pTop = prev.pressureHpa * Math.exp(fh * Math.log(curr.pressureHpa / prev.pressureHpa));
        const fp = prev.pressureHpa !== curr.pressureHpa ? (prev.pressureHpa - pTop) / (prev.pressureHpa - curr.pressureHpa) : fh;
        clipped.push({
          heightM: targetTopM,
          pressureHpa: pTop,
          thetaK: prev.thetaK + fp * (curr.thetaK - prev.thetaK),
          mixingRatio: prev.mixingRatio + fp * (curr.mixingRatio - prev.mixingRatio),
        });
      }
      break;
    }
  }

  let totalDp = 0;
  let sumThetaDp = 0;
  let sumMixingRatioDp = 0;
  for (let i = 0; i < clipped.length - 1; i += 1) {
    const lower = clipped[i];
    const upper = clipped[i + 1];
    const dp = Math.max(0, lower.pressureHpa - upper.pressureHpa);
    if (dp <= 0) continue;
    totalDp += dp;
    sumThetaDp += 0.5 * (lower.thetaK + upper.thetaK) * dp;
    sumMixingRatioDp += 0.5 * (lower.mixingRatio + upper.mixingRatio) * dp;
  }

  if (totalDp <= 0) {
    const lclAglM = parcelLclAglM(surfaceTempC, sfcDewC);
    return lclAglM == null ? null : Math.max(terrainM, terrainM + lclAglM);
  }

  const meanThetaK = sumThetaDp / totalDp;
  const meanMixingRatio = sumMixingRatioDp / totalDp;
  const mixedSurfaceTempC = meanThetaK * (pSfcHpa / 1000) ** POISSON_KAPPA - 273.15;
  const mixedSurfaceDewPointC = Math.min(mixedSurfaceTempC, dewPointFromMixingRatioC(meanMixingRatio, pSfcHpa));
  const lclAglM = parcelLclAglM(mixedSurfaceTempC, mixedSurfaceDewPointC);
  return lclAglM == null ? null : Math.max(terrainM, terrainM + lclAglM);
}

/**
 * Integrates horizontal wind components (u, v) over geometric height z across [terrainM, blTopM]
 * using the trapezoidal rule with interpolated layer boundaries, clipped strictly at the actual
 * boundary-layer top without including free-tropospheric levels above shallow layers.
 */
export function computeBoundaryLayerWind(terrainM, surfaceWind, levels, blTopM, wind80m = null) {
  if (!finite(terrainM) || !surfaceWind || !finite(surfaceWind.windSpeedMps) || !finite(surfaceWind.windDirectionDeg) || !Array.isArray(levels)) {
    return null;
  }
  const validLevels = levels
    .filter(l => l && finite(l.heightM) && l.heightM > terrainM && finite(l.windSpeedMps) && finite(l.windDirectionDeg))
    .sort((a, b) => a.heightM - b.heightM);
  const w80 = wind80m && finite(wind80m.windSpeedMps) && finite(wind80m.windDirectionDeg)
    ? wind80m
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

  const windNodes = [];
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

/**
 * Legacy v1/v2.0 fixed-density / first-level-pressure convective velocity scale W* (m/s).
 * Retained for controlled sensitivity comparisons against the surface-density-consistent formulation.
 */
export function computeLegacyThermalVelocityMps(surfaceTemperatureC, sensibleHeatFluxWm2, latentHeatFluxWm2, boundaryLayerDepthM, firstPressureHpa) {
  if (!finite(boundaryLayerDepthM) || boundaryLayerDepthM <= 0 || !finite(firstPressureHpa) || firstPressureHpa <= 0) return 0;
  const surfaceTemperatureK = surfaceTemperatureC + 273.15;
  const virtualHeatFlux = (sensibleHeatFluxWm2 ?? 0) + 245268e-9 * surfaceTemperatureK * (latentHeatFluxWm2 ?? 0);
  if (virtualHeatFlux <= 0) return 0;
  const potentialTemperatureK = surfaceTemperatureK * (1015 / firstPressureHpa) ** 0.28482;
  return Math.cbrt((0.0075516 / potentialTemperatureK) * virtualHeatFlux * boundaryLayerDepthM);
}

/**
 * Surface-density-consistent Deardorff (1970) / MacVean convective velocity scale W* (m/s):
 *   w*^3 = (g * z_i / theta_v0) * (w' theta_v')_s
 * Converts both the reference virtual temperature and kinematic virtual heat flux using the same
 * surface-to-reference potential temperature factor (P_ref / P_sfc)^(Rd/cpd) so the arbitrary
 * reference pressure cancels identically, and computes surface air density rho_sfc = P_sfc / (Rd * T_v0)
 * from actual or hypsometric surface pressure rather than a fixed sea-level density or upper-level pressure.
 */
export function computeThermalVelocityMps(surfaceTemperatureCOrOpts, sensibleHeatFluxWm2, latentHeatFluxWm2, boundaryLayerDepthM, surfacePressureHpa, options = {}) {
  const opts = typeof surfaceTemperatureCOrOpts === 'object' && surfaceTemperatureCOrOpts !== null
    ? surfaceTemperatureCOrOpts
    : {
        surfaceTemperatureC: surfaceTemperatureCOrOpts,
        sensibleHeatFluxWm2,
        latentHeatFluxWm2,
        boundaryLayerDepthM,
        surfacePressureHpa,
        ...options,
      };

  const sfcTempC = opts.surfaceTemperatureC;
  const depthM = opts.boundaryLayerDepthM;
  const pSfcHpa = finite(opts.surfacePressureHpa) && opts.surfacePressureHpa > 0
    ? opts.surfacePressureHpa
    : (finite(opts.terrainM) && opts.firstLevel ? hypsometricSurfacePressureHpa(opts.terrainM, sfcTempC, opts.firstLevel) : null);
  const pRefHpa = finite(opts.referencePressureHpa) && opts.referencePressureHpa > 0 ? opts.referencePressureHpa : 1000.0;

  if (!finite(sfcTempC) || !finite(depthM) || depthM <= 0 || !finite(pSfcHpa) || pSfcHpa <= 0) return 0;

  const sfcTempK = sfcTempC + 273.15;
  const sfcDewC = finite(opts.surfaceDewPointC) ? Math.min(sfcTempC, opts.surfaceDewPointC) : null;
  const r0 = sfcDewC !== null ? mixingRatioKgKg(sfcDewC, pSfcHpa) : 0;
  const q0 = r0 / (1 + r0);
  const tv0K = sfcTempK * ((1 + r0 / EPSILON) / (1 + r0));
  const rhoSfcKgM3 = (pSfcHpa * 100) / (RD_J_PER_KG_K * tv0K);
  const kappa = RD_J_PER_KG_K / CPD_J_PER_KG_K;
  const exnerScale = (pRefHpa / pSfcHpa) ** kappa;
  const thetaV0K = tv0K * exnerScale;

  const kinematicSensibleFlux = (opts.sensibleHeatFluxWm2 ?? 0) / (rhoSfcKgM3 * CPD_J_PER_KG_K);
  const kinematicMoistureFlux = (opts.latentHeatFluxWm2 ?? 0) / (rhoSfcKgM3 * LV_J_PER_KG);
  const kinematicVirtualTempFlux = (1 + VIRTUAL_TEMP_DELTA * q0) * kinematicSensibleFlux + VIRTUAL_TEMP_DELTA * sfcTempK * kinematicMoistureFlux;
  const kinematicVirtualThetaFlux = exnerScale * kinematicVirtualTempFlux;

  if (kinematicVirtualThetaFlux <= 0) return 0;
  return Math.cbrt((GRAVITY_MPS2 * depthM / thetaV0K) * kinematicVirtualThetaFlux);
}

export function lenschowNormalizedUpdraft(zeta) {
  if (!finite(zeta) || zeta <= 0) return 0;
  return 4 * Math.cbrt(zeta) * (1 - 0.8 * zeta);
}

/**
 * Evaluates usable-lift top (m MSL) for a given sink rate along the Lenschow & Stephens (1980)
 * convective updraft profile F(zeta) = 4 * zeta^(1/3) * (1 - 0.8 * zeta) bounded strictly within
 * [modelElevationM, resolvedThermalTopM].
 *
 * Handles:
 * 1. Lift below sink everywhere (W* * F_max < sinkRateMps -> null),
 * 2. Cloud base below the first usable portion of the ascending branch (zeta_cap <= 0.3125 and
 *    W* * F(zeta_cap) < sinkRateMps -> null),
 * 3. Lift remaining usable all the way through the thermal top (W* * F(1) >= sinkRateMps -> effectiveCapM),
 * 4. Monotone descending branch crossing on [0.3125, 1.0] capped by effectiveCapM.
 */
export function computeUsableLiftTopV2M({ modelElevationM, resolvedThermalTopM, thermalVelocityV2Mps, cloudBaseM }, sinkRateMps = 1.0) {
  if (!finite(modelElevationM) || !finite(resolvedThermalTopM) || !finite(thermalVelocityV2Mps) || !finite(sinkRateMps) || sinkRateMps <= 0) {
    return null;
  }
  const depthM = resolvedThermalTopM - modelElevationM;
  if (depthM <= 0 || thermalVelocityV2Mps <= 0 || thermalVelocityV2Mps * LENSCHOW_F_MAX < sinkRateMps) return null;

  const effectiveCapM = finite(cloudBaseM) ? Math.min(resolvedThermalTopM, cloudBaseM) : resolvedThermalTopM;
  if (effectiveCapM <= modelElevationM) return null;

  const zetaCap = (effectiveCapM - modelElevationM) / depthM;
  if (zetaCap <= LENSCHOW_PEAK_ZETA) {
    if (thermalVelocityV2Mps * lenschowNormalizedUpdraft(zetaCap) < sinkRateMps) return null;
    return effectiveCapM;
  }

  const targetF = sinkRateMps / thermalVelocityV2Mps;
  if (lenschowNormalizedUpdraft(1.0) >= targetF) {
    return effectiveCapM;
  }

  let lo = LENSCHOW_PEAK_ZETA;
  let hi = 1.0;
  for (let step = 0; step < 60; step += 1) {
    const mid = 0.5 * (lo + hi);
    if (lenschowNormalizedUpdraft(mid) >= targetF) lo = mid;
    else hi = mid;
  }
  const crossingM = modelElevationM + depthM * 0.5 * (lo + hi);
  return Math.min(effectiveCapM, crossingM);
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
    levels,
  }, 1.0);

  const hcritWxtoflyM = computeUsableLiftTopV2M({
    modelElevationM: terrain,
    resolvedThermalTopM,
    thermalVelocityV2Mps,
    cloudBaseM: effectiveCloudLimitM,
    levels,
  }, WXTOFLY_SINK_MPS);

  const dryHcritM = computeUsableLiftTopV2M({
    modelElevationM: terrain,
    resolvedThermalTopM,
    thermalVelocityV2Mps,
    cloudBaseM: null,
    levels,
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
