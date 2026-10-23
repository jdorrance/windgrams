import { parseSiteForecast, type SiteForecast } from '@azohra/meteo.briefing/contract';

type Hour = SiteForecast['hours'][number];
const fields = {
  thermalVelocityMps: 'thermalVelocityV2Mps',
  boundaryLayerTopM: 'resolvedThermalTopM',
  usableLiftTopM: 'usableLiftTopV2M',
  cloudBaseM: 'surfaceLclM',
} as const;
const retainedFields = [...Object.values(fields), 'hcritWxtoflyM'] as const;
type Lift = { [K in keyof typeof fields]: Hour['derived'][K] | null };

/** Select a published diagnostic family, never replace its nulls with older physics. */
export function publishedLift(hour: Hour): Lift {
  const extension = (hour as Hour & { soaring?: Record<string, unknown> }).soaring;
  if (!extension || !Object.hasOwn(extension, 'thermalVelocityV2Mps')) return hour.derived;
  return Object.fromEntries(Object.entries(fields).map(([key, source]) => [key, extension[source] ?? null])) as Lift;
}

/** Published glider ceiling at 225 ft/min sink (1.143 m/s), as in the WxToFly guide. */
export function publishedWxtoflyLiftTop(hour: Hour): Lift['usableLiftTopM'] {
  const extension = (hour as Hour & { soaring?: Record<string, unknown> }).soaring;
  // The 1 m/s diagnostic is not interchangeable, including for legacy or ensemble data.
  return (extension?.hcritWxtoflyM ?? null) as Lift['usableLiftTopM'];
}

/** The upstream contract strips extensions. Retain just validated display fields. */
export function parsePublishedProfileJson(text: string): SiteForecast | null {
  try {
    const raw = JSON.parse(text);
    const profile = parseSiteForecast(raw);
    if (!profile) return null;
    profile.hours = profile.hours.map((hour, i) => {
      const soaring = raw.hours[i]?.soaring;
      if (!soaring || !Object.hasOwn(soaring, 'thermalVelocityV2Mps')) return hour;
      const values = Object.fromEntries(retainedFields.map(key => {
        const value = soaring[key];
        // Validate scalar and ensemble values using the corresponding public schema.
        const candidate = parseSiteForecast({ ...profile, hours: [{ ...hour, derived: { ...hour.derived, thermalVelocityMps: value } }] });
        return [key, candidate?.hours[0].derived.thermalVelocityMps ?? null];
      }));
      return { ...hour, soaring: values };
    });
    return profile;
  } catch { return null; }
}
