import { z } from 'zod';
import { scalarSchema, siteForecastSchema, type SiteForecast } from '@azohra/meteo.briefing/contract';
import { checked } from './schema.js';

type Hour = SiteForecast['hours'][number];
const fields = {
  thermalVelocityMps: 'thermalVelocityV2Mps',
  boundaryLayerTopM: 'resolvedThermalTopM',
  usableLiftTopM: 'usableLiftTopV2M',
  cloudBaseM: 'surfaceLclM',
} as const;
type Lift = { [K in keyof typeof fields]: Hour['derived'][K] | null };
const diagnosticValue = scalarSchema.nullish();
const diagnosticsSchema = z.object({
  thermalVelocityV2Mps: diagnosticValue, resolvedThermalTopM: diagnosticValue,
  usableLiftTopV2M: diagnosticValue, surfaceLclM: diagnosticValue,
  hcritWxtoflyM: diagnosticValue, effectiveCloudLimitM: diagnosticValue, mixedLayerLclM: diagnosticValue,
});
export type PublishedSoaringDiagnostics = z.infer<typeof diagnosticsSchema>;
export type PublishedForecastHour = Hour & { soaring?: PublishedSoaringDiagnostics };
export type PublishedSiteForecast = Omit<SiteForecast, 'hours'> & { hours: PublishedForecastHour[] };

/** Select one published diagnostic family and preserve its nulls. */
export function publishedLift(hour: PublishedForecastHour): Lift {
  const extension = hour.soaring;
  if (!extension || !Object.hasOwn(extension, 'thermalVelocityV2Mps')) return hour.derived;
  return Object.fromEntries(Object.entries(fields).map(([key, source]) => [key, extension[source] ?? null])) as Lift;
}

/** Potential cloud base (surface-parcel Bolton LCL, m MSL). */
export function publishedSurfaceLcl(hour: PublishedForecastHour): Lift['cloudBaseM'] {
  return publishedLift(hour).cloudBaseM;
}

/**
 * Effective cloud ceiling (m MSL) that caps usable lift: the lower of surface LCL
 * and the model-derived near-saturation proxy (T − Td ≤ 0.5 °C).
 */
export function publishedEffectiveCloudLimit(hour: PublishedForecastHour): Lift['cloudBaseM'] {
  const extension = hour.soaring;
  if (!extension || !Object.hasOwn(extension, 'thermalVelocityV2Mps')) return hour.derived.cloudBaseM;
  return extension.effectiveCloudLimitM ?? hour.derived.cloudBaseM ?? extension.surfaceLclM ?? null;
}

/** Mixed-layer parcel LCL (m MSL). */
export function publishedMixedLayerLcl(hour: PublishedForecastHour): Lift['cloudBaseM'] {
  return hour.soaring?.mixedLayerLclM ?? null;
}

/** Published glider ceiling at 225 ft/min sink (1.143 m/s), as in the WxToFly guide. */
export function publishedWxtoflyLiftTop(hour: PublishedForecastHour): Lift['usableLiftTopM'] {
  const extension = hour.soaring;
  // The 1 m/s diagnostic is not interchangeable, including for legacy or ensemble data.
  return extension?.hcritWxtoflyM ?? null;
}

/** Parse an upstream profile, preserve extensions and replace malformed lift fields with null. */
export function parsePublishedProfileJson(text: string): PublishedSiteForecast | null {
  try {
    const profile = checked(siteForecastSchema, JSON.parse(text));
    if (!profile) return null;
    for (const hour of profile.hours) {
      const target = hour as PublishedForecastHour;
      const soaring: unknown = target.soaring;
      if (!soaring || typeof soaring !== 'object' || Array.isArray(soaring)
        || !Object.hasOwn(soaring, 'thermalVelocityV2Mps')) { delete target.soaring; continue; }
      const values = soaring as Record<string, unknown>;
      for (const key of Object.keys(diagnosticsSchema.shape)) {
        const value = values[key];
        values[key] = diagnosticValue.safeParse(value).success ? value ?? null : null;
      }
      target.soaring = checked(diagnosticsSchema, values)!;
    }
    return profile;
  } catch { return null; }
}
