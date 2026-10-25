import { z } from 'zod';
import { checked, finite, index, latitude, longitude, text, timestamp } from './schema.js';

const optionalNumber = finite.nullish();
const sourceTimestamp = timestamp.regex(/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/);
const moistureSchema = z.union([
  z.object({ dewPointC: finite, dewPointDepressionC: optionalNumber }),
  z.object({ dewPointC: optionalNumber, dewPointDepressionC: finite }),
]);
/** At least one moisture representation is required; both may be supplied. */
export type Moisture = z.infer<typeof moistureSchema>;

const levelSchema = z.intersection(moistureSchema, z.object({
  pressureHpa: finite.positive(), heightM: finite, temperatureC: finite,
  windSpeedMps: finite, windDirectionDeg: finite,
  verticalVelocityPaS: optionalNumber, cloudFractionPercent: optionalNumber,
  modelLevel: finite.int().optional(),
}));
/** Heights are metres MSL; pressure is hPa; native model identifiers are retained. */
export type AtmosphericLevel = z.infer<typeof levelSchema>;

const columnSchema = z.intersection(moistureSchema, z.object({
  validAt: sourceTimestamp, temperatureC: finite, windSpeedMps: finite, windDirectionDeg: finite,
  wind80mSpeedMps: optionalNumber, wind80mDirectionDeg: optionalNumber, windGustMps: optionalNumber,
  cloudCoverPercent: optionalNumber, lowCloudPercent: optionalNumber,
  midCloudPercent: optionalNumber, highCloudPercent: optionalNumber,
  /** Amount/rate support is declared in fieldSemantics. */
  precipitationMm: optionalNumber,
  sensibleHeatFluxWm2: optionalNumber, latentHeatFluxWm2: optionalNumber,
  seaLevelPressureHpa: optionalNumber, surfacePressureHpa: optionalNumber,
  capeJkg: optionalNumber, cinJkg: optionalNumber, pblHeightM: optionalNumber,
  nativeCloudCeilingM: optionalNumber, nativeCloudBaseM: optionalNumber, nativeCloudTopM: optionalNumber,
  nativeAdiabaticLclM: optionalNumber, nativeLfcM: optionalNumber, nativeEquilibriumLevelM: optionalNumber,
  smoke: z.object({ surfaceUgm3: finite, columnMgm2: finite, aot: finite }).optional(),
  levels: z.array(levelSchema).readonly(),
}));
/** Scalar science inputs: °C, hPa, m/s, metres MSL; PBL depth uses metres AGL. */
export type AtmosphericColumn = z.infer<typeof columnSchema>;

const verticalCoordinatesSchema = z.enum(['pressure-levels', 'model-levels', 'surface-only', 'mixed']);
const fieldAvailabilitySchema = z.enum(['available', 'unsupported', 'unknown']);
const capabilitiesSchema = z.object({
  verticalCoordinates: verticalCoordinatesSchema,
  fields: z.record(z.string(), fieldAvailabilitySchema).readonly(),
  ensemble: z.enum(['deterministic', 'members', 'percentiles']),
});
export type VerticalCoordinates = z.infer<typeof verticalCoordinatesSchema>;
export type FieldAvailability = z.infer<typeof fieldAvailabilitySchema>;
export type SourceCapabilities = z.infer<typeof capabilitiesSchema>;

const sourceRunSchema = z.object({
  id: text, provider: text, product: text, model: text,
  referenceTime: sourceTimestamp.nullable(), acquiredAt: sourceTimestamp,
  gridId: text, memberId: text.optional(),
});
/** Unknown model initialization time stays null; acquisition time is separate. */
export type SourceRun = z.infer<typeof sourceRunSchema>;

const timeSupportSchema = z.union([
  z.object({ kind: z.literal('instant'), validAt: sourceTimestamp }),
  z.object({ kind: z.enum(['mean', 'accumulation', 'maximum']), start: sourceTimestamp, end: sourceTimestamp })
    .refine(value => Date.parse(value.end) > Date.parse(value.start), 'Interval end must follow start'),
]);
const fieldSemanticsSchema = z.object({
  sourceRunId: text, sourceField: text, unit: text, timeSupport: timeSupportSchema,
  positiveDirection: z.enum(['upward', 'downward']).optional(),
  heightDatum: z.enum(['MSL', 'AGL']).optional(),
  sampling: z.enum(['native', 'interpolated', 'derived']), normalization: text.optional(),
});
export type TimeSupport = z.infer<typeof timeSupportSchema>;
export type FieldSemantics = z.infer<typeof fieldSemanticsSchema>;

const provenanceSchema = z.object({
  sources: z.array(sourceRunSchema).min(1).readonly(),
  fieldSemantics: z.record(z.string(), fieldSemanticsSchema).readonly(),
  gridCell: z.object({ id: text, latitude, longitude, gridIndex: index.optional() }),
  capabilities: capabilitiesSchema,
}).refine(value => {
  const ids = new Set(value.sources.map(source => source.id));
  return ids.size === value.sources.length && Object.values(value.fieldSemantics).every(field => ids.has(field.sourceRunId));
}, 'Sources must have unique IDs and resolve all field references');
export type ColumnProvenance = z.infer<typeof provenanceSchema>;

export const ATMOSPHERIC_COLUMN_SCHEMA_VERSION = 1;
const normalizedColumnSchema = z.object({
  schemaVersion: z.literal(ATMOSPHERIC_COLUMN_SCHEMA_VERSION),
  column: columnSchema, modelElevationM: finite, provenance: provenanceSchema,
});
export type NormalizedColumnRecord = z.infer<typeof normalizedColumnSchema>;
/** Build input only; source references are additionally checked by the runtime validator. */
export function columnWireSchema(): unknown { return z.toJSONSchema(normalizedColumnSchema, { io: 'input' }); }

/** A diagnostic value, or a reason the calculation could not produce one. */
export type DiagnosticResult<T> =
  | { status: 'valid'; value: T }
  | { status: 'unsupported' | 'missing' | 'insufficient-profile' | 'below-threshold'; value: null; reason: string };

/** Validate and return the original record with metadata and native arrays intact; invalid input returns null. */
export function parseAtmosphericColumn(value: unknown): AtmosphericColumn | null {
  return checked(columnSchema, value);
}

/** Return the original column and provenance record when valid, or null when validation fails. */
export function parseNormalizedColumnRecord(value: unknown): NormalizedColumnRecord | null {
  return checked(normalizedColumnSchema, value);
}
