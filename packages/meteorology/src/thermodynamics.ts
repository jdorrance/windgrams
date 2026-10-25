// Atmospheric thermodynamics used by the soaring calculations.

import type { PressureLevel, ThermodynamicLevel } from './types.js';
import { DRY_ADIABATIC_LAPSE_C_PER_M, mixingRatioKgKg } from '@azohra/meteo.briefing/derive';

export const RD_J_PER_KG_K = 287.05;
export const CPD_J_PER_KG_K = 1004.0;
export const LV_J_PER_KG = 2501000.0;
export const GRAVITY_MPS2 = 9.80665;
export const POISSON_KAPPA = 0.2854; // Rd / cpd for mixed-layer potential temperature
export const EPSILON = 0.622;
export const VIRTUAL_TEMP_DELTA = (1 - EPSILON) / EPSILON; // ~0.607717
export const MAGNUS_A = 17.625;
export const MAGNUS_B_C = 243.04;
export const MAGNUS_ES0_HPA = 6.1094;

export const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
export const round1 = (n: unknown): number | null => (finite(n) ? Math.round(n * 10) / 10 : null);
export const round2 = (n: unknown): number | null => (finite(n) ? Math.round(n * 100) / 100 : null);

/**
 * Converts pressure vertical velocity omega (Pa/s) to geometric vertical velocity w (m/s).
 */
export function geometricWFromOmegaMps(omegaPaS: number | null | undefined, pressureHpa: number | null | undefined, temperatureC: number | null | undefined): number | null {
  if (!finite(omegaPaS) || !finite(pressureHpa) || !finite(temperatureC) || pressureHpa <= 0) return null;
  const temperatureK = temperatureC + 273.15;
  const densityKgM3 = (pressureHpa * 100) / (RD_J_PER_KG_K * temperatureK);
  return -omegaPaS / (densityKgM3 * GRAVITY_MPS2);
}

/**
 * Bolton (1980) LCL temperature and dry-adiabatic height above surface (m AGL).
 */
export function parcelLclAglM(temperatureC: number | null | undefined, dewPointC: number | null | undefined): number | null {
  if (!finite(temperatureC) || !finite(dewPointC)) return null;
  if (dewPointC >= temperatureC) return 0;
  const temperatureK = temperatureC + 273.15;
  const dewPointK = dewPointC + 273.15;
  const lclTemperatureK = 1 / (1 / (dewPointK - 56) + Math.log(temperatureK / dewPointK) / 800) + 56;
  return Math.max(0, (temperatureK - lclTemperatureK) / DRY_ADIABATIC_LAPSE_C_PER_M);
}

/**
 * Hypsometric surface pressure (hPa) anchored to the lowest above-ground pressure level.
 * Returns 1013.25 hPa when any required input is absent or non-finite.
 */
export function hypsometricSurfacePressureHpa(terrainM: number | null | undefined, surfaceTempC: number | null | undefined, firstLevel: PressureLevel | null | undefined): number {
  if (!finite(terrainM) || !finite(surfaceTempC) || !firstLevel || !finite(firstLevel.pressureHpa) || !finite(firstLevel.heightM) || !finite(firstLevel.temperatureC)) {
    return 1013.25;
  }
  const meanTempK = 0.5 * (surfaceTempC + firstLevel.temperatureC) + 273.15;
  return firstLevel.pressureHpa * Math.exp((GRAVITY_MPS2 * (firstLevel.heightM - terrainM)) / (RD_J_PER_KG_K * meanTempK));
}

/**
 * Inverts Alduchov & Eskridge (1996) Magnus saturation vapor pressure to recover
 * dew point (degC) from water-vapor mixing ratio r (kg/kg) and pressure p (hPa).
 * Returns −60 °C for invalid or nonpositive inputs.
 */
export function dewPointFromMixingRatioC(mixingRatio: number | null | undefined, pressureHpa: number | null | undefined): number {
  if (!finite(mixingRatio) || !finite(pressureHpa) || mixingRatio <= 0 || pressureHpa <= 0) return -60;
  const vaporPressureHpa = Math.max(1e-6, (mixingRatio * pressureHpa) / (EPSILON + mixingRatio));
  const lnRatio = Math.log(vaporPressureHpa / MAGNUS_ES0_HPA);
  return (MAGNUS_B_C * lnRatio) / (MAGNUS_A - lnRatio);
}

/**
 * Physical Mixed-Layer LCL (DrJack `zblcl`, m MSL) using pressure-mass averages
 * of potential temperature theta and water-vapor mixing ratio r across [terrainM, blTopM]
 * with interpolated layer boundaries (consistent with MetPy's mixed-layer integration),
 * clipped strictly at the actual layer top without including levels above shallow layers.
 */
export function computeMixedLayerLclM(terrainM: number | null | undefined, surfaceTempC: number | null | undefined, surfaceDewPointC: number | null | undefined, levels: readonly ThermodynamicLevel[], blTopM: number | null | undefined): number | null {
  if (!finite(terrainM) || !finite(surfaceTempC) || !finite(surfaceDewPointC) || !Array.isArray(levels) || !levels.length) return null;
  const typedLevels: readonly ThermodynamicLevel[] = levels;
  const validLevels = typedLevels
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
      const td = Math.min(l.temperatureC, finite(l.dewPointC) ? l.dewPointC : l.temperatureC - (l.dewPointDepressionC ?? 0));
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
