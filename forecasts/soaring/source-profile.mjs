// Retain native model fields through the pinned baseline serializer.
import { forecastSurfaceSchema } from '@azohra/meteo.briefing/contract';
import { surfaceExtensionsSchema } from '@windgrams/contracts/published-lift';
import { deriveSiteForecast } from './vendor/derive-0.6.0.mjs';

const requiredFields = Object.entries(forecastSurfaceSchema.shape).filter(([, schema]) => !schema.isOptional())
  .map(([field]) => field === 'precipitationMmHr' ? 'precipitationMm' : field === 'dewPointC' ? 'dewPointDepressionC' : field);
const extensions = Object.entries(surfaceExtensionsSchema.shape);

// Upstream optional measurements use absence; null would be coerced to zero.
const forBaseline = value => ({ ...Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null)),
  dewPointDepressionC: Number.isFinite(value.dewPointDepressionC) ? value.dewPointDepressionC
    : Number.isFinite(value.dewPointC) ? value.temperatureC - value.dewPointC : NaN,
});

/** Convert columns to a profile; required published measurements must be finite. */
export function deriveSourceForecast(source, model, semantics) {
  const hours = source.hours.map(column => {
    const hour = { ...forBaseline(column), levels: column.levels.map(forBaseline) };
    const missing = requiredFields.find(field => !Number.isFinite(hour[field]));
    if (missing) throw new Error(`Missing required profile field ${missing} at ${column.validAt}`);
    return hour;
  });
  const profile = deriveSiteForecast({ ...source, hours }, model, semantics);
  for (const [index, hour] of profile.hours.entries()) {
    const column = source.hours[index];
    for (const [field, schema] of extensions) {
      if (column[field] !== undefined && schema.safeParse(column[field]).success) hour.surface[field] = column[field];
    }
  }
  return profile;
}
