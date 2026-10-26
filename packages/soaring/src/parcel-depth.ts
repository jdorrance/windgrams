import { DRY_ADIABATIC_LAPSE_C_PER_M } from '@azohra/meteo.briefing/derive';
import { finite } from '@windgrams/meteorology/thermodynamics';
import type { ThermalDepthSupport } from './types.js';

interface ParcelDepthInput {
  surfaceTemperatureC: number;
  sensibleHeatFluxWm2?: number | null;
  latentHeatFluxWm2?: number | null;
  pblHeightM?: number | null;
  modelElevationM: number;
  levels: readonly { heightM: number; temperatureC: number }[];
  deltaTC?: number;
}

/**
 * Resolve parcel convective depth in metres AGL from ascending above-ground levels.
 * Missing inputs needed by the selected shallow-layer closure return null.
 */
export function resolvedParcelDepthM(surfaceTemperatureC: number, sensibleHeatFluxWm2: number | null | undefined, latentHeatFluxWm2: number | null | undefined, pblHeightM: number | null | undefined, modelElevationM: number, levels: readonly {
    heightM: number;
    temperatureC: number;
}[], deltaTC: number = 0): number | null {
  return resolveParcelDepth({ surfaceTemperatureC, sensibleHeatFluxWm2, latentHeatFluxWm2, pblHeightM, modelElevationM, levels, deltaTC }).depthM;
}

/** Resolve depth and branch provenance together; levels must ascend above model terrain. */
export function resolveParcelDepth({ surfaceTemperatureC, sensibleHeatFluxWm2, latentHeatFluxWm2,
  pblHeightM, modelElevationM, levels, deltaTC = 0,
}: ParcelDepthInput): { depthM: number | null; support: ThermalDepthSupport } {
  const result = (depthM: number | null, branch: ThermalDepthSupport['branch'], bracketMslM: [number, number] | null = null) =>
    ({ depthM, support: { branch, bracketMslM, topLimited: branch === 'profile-top' } });
  if (!finite(surfaceTemperatureC) || !finite(modelElevationM) || !finite(deltaTC) || !levels.length
    || levels.some((level, index) => !finite(level.heightM) || !finite(level.temperatureC) || level.heightM <= modelElevationM
      || (index > 0 && level.heightM <= levels[index - 1].heightM))) return result(null, 'unavailable');
  const parcelSurfaceTC = surfaceTemperatureC + deltaTC;
  const surfaceTemperatureK = surfaceTemperatureC + 273.15;
  const virtualHeatFlux = finite(sensibleHeatFluxWm2) && finite(latentHeatFluxWm2)
    ? sensibleHeatFluxWm2 + 245268e-9 * surfaceTemperatureK * latentHeatFluxWm2 : null;
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    const altitudeAglM = level.heightM - modelElevationM;
    if (parcelSurfaceTC - altitudeAglM * DRY_ADIABATIC_LAPSE_C_PER_M > level.temperatureC) continue;
    if (index === 0) {
      // Fix v1 index===0 jump: when the surface parcel is already cooler than the
      // dry adiabat at the first pressure level (e.g. 925 hPa), do not jump to 925 hPa.
      if (deltaTC <= 0) {
        if (virtualHeatFlux === null) return result(null, 'unavailable');
        if (virtualHeatFlux <= 0) return result(0, 'non-convective');
      }
      if (finite(pblHeightM) && pblHeightM > 0) {
        const sensBoostM = deltaTC > 0 ? Math.min(250 * deltaTC, Math.max(0, altitudeAglM - pblHeightM)) : 0;
        return result(Math.min(altitudeAglM, pblHeightM + sensBoostM), 'model-pbl-fallback', [modelElevationM, level.heightM]);
      }
      if (!finite(sensibleHeatFluxWm2)) return result(null, 'unavailable');
      const superadiabaticExcessC = Math.max(0, deltaTC + Math.min(1.5, Math.max(0, sensibleHeatFluxWm2) * 0.012));
      if (superadiabaticExcessC === 0) return result(0, 'non-convective');
      // Linear first-layer deficit D(z) = D(z1) z/z1. Compare before dividing:
      // a positive excess reaches z1 as D(z1) tends to zero, never zero depth.
      const deficitC = level.temperatureC - (surfaceTemperatureC - altitudeAglM * DRY_ADIABATIC_LAPSE_C_PER_M);
      if (deficitC <= superadiabaticExcessC) return result(altitudeAglM, 'heat-flux-fallback', [modelElevationM, level.heightM]);
      return result(altitudeAglM * (superadiabaticExcessC / deficitC), 'heat-flux-fallback', [modelElevationM, level.heightM]);
    }
    const previous = levels[index - 1];
    const previousAglM = previous.heightM - modelElevationM;
    const previousExcessC = parcelSurfaceTC - previousAglM * DRY_ADIABATIC_LAPSE_C_PER_M - previous.temperatureC;
    const excessC = parcelSurfaceTC - altitudeAglM * DRY_ADIABATIC_LAPSE_C_PER_M - level.temperatureC;
    // The previous point is positive and this point is nonpositive. Their
    // bracketed linear crossing needs no lapse-rate tolerance or extrapolation.
    const fraction = previousExcessC / (previousExcessC - excessC);
    return result(previousAglM + fraction * (altitudeAglM - previousAglM), 'parcel-crossing', [previous.heightM, level.heightM]);
  }
  return result(levels[levels.length - 1].heightM - modelElevationM, 'profile-top');
}
