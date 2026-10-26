// Thermodynamic conversions shared by the provider adapters.
// Providers may not depend on @windgrams/meteorology, so the Bolton (1980) forms the
// decoders have always used live here unchanged; unifying them with the Magnus forms in
// @windgrams/meteorology is a numerical change that needs its own review.
import { DRY_ADIABATIC_LAPSE_C_PER_M } from '@azohra/meteo.briefing/derive';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Dew point (°C) from specific humidity (kg water per kg moist air, not mixing ratio) and pressure (Pa),
 * inverting Bolton's saturation vapour pressure. Null for missing or physically impossible inputs.
 */
export function specificHumidityDewpointC(specificHumidity: number | null | undefined, pressurePa: number | null | undefined): number | null {
  if (!finite(specificHumidity) || !finite(pressurePa) || specificHumidity <= 0 || specificHumidity >= 1 || pressurePa <= 0) return null;
  const vaporPressureHpa = specificHumidity * pressurePa / (0.622 + 0.378 * specificHumidity) / 100;
  const logarithm = Math.log(vaporPressureHpa / 6.112);
  const dewPointC = 243.5 * logarithm / (17.67 - logarithm);
  return Number.isFinite(dewPointC) ? dewPointC : null;
}

/**
 * Surface-parcel lifting condensation level (m MSL, unrounded) from surface temperature and dew point (°C)
 * and ground elevation (m MSL): Bolton's LCL temperature lifted at the dry-adiabatic lapse.
 * A saturated surface returns the ground; any missing input returns null. Callers own display rounding.
 */
export function surfaceLclM(temperatureC: number | null | undefined, dewPointC: number | null | undefined, elevationM: number | null | undefined): number | null {
  if (!finite(temperatureC) || !finite(dewPointC) || !finite(elevationM)) return null;
  if (dewPointC >= temperatureC) return elevationM;
  const tk = temperatureC + 273.15, tdk = dewPointC + 273.15;
  const tlcl = 1 / (1 / (tdk - 56) + Math.log(tk / tdk) / 800) + 56;
  return elevationM + Math.max(0, (tk - tlcl) / DRY_ADIABATIC_LAPSE_C_PER_M);
}
