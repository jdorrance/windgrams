import type { ThermalVelocityInput, UsableLiftInput } from './types.js';
// Pure convective velocity scale (W*), Lenschow (1980) updraft profile solver,
// and resolved parcel depth policy.

import { DRY_ADIABATIC_LAPSE_C_PER_M, mixingRatioKgKg } from '@azohra/meteo.briefing/derive';
import {
  CPD_J_PER_KG_K,
  EPSILON,
  GRAVITY_MPS2,
  LV_J_PER_KG,
  RD_J_PER_KG_K,
  VIRTUAL_TEMP_DELTA,
  finite,
  hypsometricSurfacePressureHpa,
} from '@windgrams/meteorology/thermodynamics';

export const WXTOFLY_SINK_MPS = 225 * 0.00508; // 225 ft/min = 1.143 m/s (WxToFly windgram specification)
export const LENSCHOW_PEAK_ZETA = 0.3125; // 5 / 16: exact maximum of 4 * zeta^(1/3) * (1 - 0.8 * zeta)
export const LENSCHOW_F_MAX = 4 * Math.cbrt(LENSCHOW_PEAK_ZETA) * (1 - 0.8 * LENSCHOW_PEAK_ZETA); // 2.03581321244618

/**
 * Legacy v1/v2.0 fixed-density / first-level-pressure convective velocity scale W* (m/s).
 * Retained for controlled sensitivity comparisons against the surface-density-consistent formulation.
 */
export function computeLegacyThermalVelocityMps(surfaceTemperatureC: number, sensibleHeatFluxWm2: number | null | undefined, latentHeatFluxWm2: number | null | undefined, boundaryLayerDepthM: number | null | undefined, firstPressureHpa: number | null | undefined): number {
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
export function computeThermalVelocityMps(
  surfaceTemperatureCOrOpts: number | Partial<ThermalVelocityInput>,
  sensibleHeatFluxWm2?: number | null, latentHeatFluxWm2?: number | null,
  boundaryLayerDepthM?: number | null, surfacePressureHpa?: number | null,
  options: Partial<ThermalVelocityInput> = {},
): number {
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

export function lenschowNormalizedUpdraft(zeta: number | null | undefined): number {
  if (!finite(zeta) || zeta <= 0) return 0;
  return 4 * Math.cbrt(zeta) * (1 - 0.8 * zeta);
}

/**
 * Evaluates usable-lift top (m MSL) for a given sink rate along the Lenschow & Stephens (1980)
 * convective updraft profile F(zeta) = 4 * zeta^(1/3) * (1 - 0.8 * zeta) bounded strictly within
 * [modelElevationM, resolvedThermalTopM].
 */
export function computeUsableLiftTopV2M({ modelElevationM, resolvedThermalTopM, thermalVelocityV2Mps, cloudBaseM }: UsableLiftInput, sinkRateMps = 1.0): number | null {
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

/**
 * Resolve parcel convective depth in metres AGL from surface conditions and above-ground levels.
 */
export function resolvedParcelDepthM(surfaceTemperatureC: number, sensibleHeatFluxWm2: number | null | undefined, latentHeatFluxWm2: number | null | undefined, pblHeightM: number | null | undefined, modelElevationM: number, levels: readonly {
    heightM: number;
    temperatureC: number;
}[], deltaTC: number = 0): number {
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
