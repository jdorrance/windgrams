import { z } from 'zod';
import { scalarSchema, siteForecastSchema, type SiteForecast } from '@azohra/meteo.briefing/contract';
import { checked } from './schema.js';
import { surfaceExtensionsSchema } from './atmosphere.js';
import { diagnosticSupportSchema, verticalResolutionSchema } from './diagnostic-support.js';
export { surfaceExtensionsSchema } from './atmosphere.js';
export type { DiagnosticSupport, VerticalResolution, VerticalSampling, ThermalDepthSupport } from './diagnostic-support.js';

type Hour = SiteForecast['hours'][number];
const fields = {
  thermalVelocityMps: 'thermalVelocityV2Mps',
  boundaryLayerTopM: 'resolvedThermalTopM',
  usableLiftTopM: 'usableLiftTopV2M',
  cloudBaseM: 'surfaceLclM',
} as const;
type Lift = { [K in keyof typeof fields]: Hour['derived'][K] | null };
const diagnosticValue = scalarSchema.nullish();
const layerWindFields = {
  blMeanWindSpeedMps: diagnosticValue, blMeanWindDirDeg: diagnosticValue,
  blTopWindSpeedMps: diagnosticValue, blTopWindDirDeg: diagnosticValue,
  blWindShearMps: diagnosticValue, buoyancyShearRatio: diagnosticValue,
};
const valueFields = {
  thermalVelocityV2Mps: diagnosticValue, resolvedThermalTopM: diagnosticValue,
  usableLiftTopV2M: diagnosticValue, surfaceLclM: diagnosticValue,
  hcritWxtoflyM: diagnosticValue, effectiveCloudLimitM: diagnosticValue, mixedLayerLclM: diagnosticValue,
  ...layerWindFields,
};
const metadataFields = { verticalResolution: verticalResolutionSchema.optional(), diagnosticSupport: diagnosticSupportSchema.optional() };
const diagnosticsSchema = z.object({ ...valueFields, ...metadataFields });
export type PublishedSoaringDiagnostics = z.infer<typeof diagnosticsSchema>;
/** Optional native surface measurements use the atmospheric-column units. */
export type PublishedSurfaceExtensions = z.infer<typeof surfaceExtensionsSchema>;
export type PublishedForecastHour = Hour & { surface: Hour['surface'] & PublishedSurfaceExtensions; soaring?: PublishedSoaringDiagnostics };
export type PublishedSiteForecast = Omit<SiteForecast, 'hours'> & { hours: PublishedForecastHour[] };

/**
 * Which lift family a published hour carries: the current diagnostics (`hour.soaring`, V2)
 * or the earlier upstream method (`hour.derived`, V1) that remains when V2 was not published
 * (ensemble percentiles always). See README "Reading published data".
 */
export type PublishedLiftFamily = 'v2' | 'v1-legacy';

export function publishedLiftFamily(hour: PublishedForecastHour): PublishedLiftFamily {
  const extension = hour.soaring;
  return extension && Object.hasOwn(extension, 'thermalVelocityV2Mps') ? 'v2' : 'v1-legacy';
}

/** Select one published diagnostic family and preserve its nulls. */
export function publishedLift(hour: PublishedForecastHour): Lift {
  const extension = hour.soaring;
  if (!extension || publishedLiftFamily(hour) === 'v1-legacy') return hour.derived;
  return Object.fromEntries(Object.entries(fields).map(([key, source]) => [key, extension[source] ?? null])) as Lift;
}

/** Cloud height (m MSL): V2 surface LCL or legacy effective cloud limit.
 * Use publishedCloudBaseKind for its label. */
export function publishedSurfaceLcl(hour: PublishedForecastHour): Lift['cloudBaseM'] {
  return publishedLift(hour).cloudBaseM;
}

/** Cloud-base meaning: V2 surface-parcel LCL or legacy effective cloud limit. */
export function publishedCloudBaseKind(hour: PublishedForecastHour): 'potential' | 'effective' {
  return publishedLiftFamily(hour) === 'v2' ? 'potential' : 'effective';
}

/**
 * Effective cloud limit (m MSL) that caps usable lift: the lower of surface LCL
 * and the model-derived near-saturation proxy (T − Td ≤ 0.5 °C).
 * V2 reads its published effectiveCloudLimitM; null or missing values return null.
 */
export function publishedEffectiveCloudLimit(hour: PublishedForecastHour): Lift['cloudBaseM'] {
  const extension = hour.soaring;
  if (!extension || publishedLiftFamily(hour) === 'v1-legacy') return hour.derived.cloudBaseM;
  return extension.effectiveCloudLimitM ?? null;
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

/** Parse a profile; malformed optional measurements become null and invalid metadata is omitted. */
export function parsePublishedProfileJson(text: string): PublishedSiteForecast | null {
  try {
    const profile = checked(siteForecastSchema, JSON.parse(text));
    if (!profile) return null;
    for (const hour of profile.hours) {
      const target = hour as PublishedForecastHour;
      const surface = target.surface as Record<string, unknown>;
      for (const [key, schema] of Object.entries(surfaceExtensionsSchema.shape)) {
        if (!Object.hasOwn(surface, key) || schema.safeParse(surface[key]).success) continue;
        if (key === 'convectiveParcel') delete surface[key];
        else surface[key] = null;
      }
      const soaring: unknown = target.soaring;
      if (!soaring || typeof soaring !== 'object' || Array.isArray(soaring)
        || !Object.hasOwn(soaring, 'thermalVelocityV2Mps')) { delete target.soaring; continue; }
      const values = soaring as Record<string, unknown>;
      for (const key of Object.keys(valueFields)) {
        if (Object.hasOwn(layerWindFields, key) && !Object.hasOwn(values, key)) continue;
        const value = values[key];
        values[key] = diagnosticValue.safeParse(value).success ? value ?? null : null;
      }
      for (const [key, schema] of Object.entries(metadataFields)) {
        if (!schema.safeParse(values[key]).success) delete values[key];
      }
      target.soaring = checked(diagnosticsSchema, values)!;
    }
    return profile;
  } catch { return null; }
}
