import type { ReplayHour } from './regional-types.js';
import type { FieldDefinition, FieldValue, GroundReference, RegionalField, RelativeHeight } from './field-types.js';
import { fieldDefinitions } from './internal/field-definitions.js';

export type { FieldDefinition, FieldValue, GroundReference, HeightReference, RegionalField, RelativeHeight } from './field-types.js';

export function fieldDefinition(field: RegionalField): FieldDefinition {
  const definition = Object.hasOwn(fieldDefinitions, field) ? fieldDefinitions[field] : undefined;
  if (!definition) throw new RangeError('Unknown regional field');
  return definition;
}

/** A null carries no inferred threshold reason. Absent arrays mean unavailable in this product. */
export function readRegionalField(hour: ReplayHour, field: RegionalField, cellIndex: number): FieldValue {
  const definition = fieldDefinition(field);
  if (!Number.isSafeInteger(cellIndex) || cellIndex < 0 || cellIndex >= hour.status.length) throw new RangeError('Invalid regional cell');
  const values = hour[field];
  if (!values) return { status: 'unsupported', value: null };
  if (definition.requiresProfile && hour.status[cellIndex] !== 'valid') {
    return { status: hour.status[cellIndex] === 'insufficient-levels' ? 'insufficient-profile' : 'missing', value: null };
  }
  const result = values[cellIndex];
  return typeof result === 'number' && Number.isFinite(result)
    ? { status: 'valid', value: result } : { status: 'missing', value: null };
}

/** Convert a published ceiling using explicitly compatible vertical datums. Preserve negative clearance. */
export function heightAboveGround(heightMslM: number | null, verticalDatum: string, ground: GroundReference): RelativeHeight | null {
  if (heightMslM === null) return null;
  if (!Number.isFinite(heightMslM) || !Number.isFinite(ground.elevationM) || !ground.source
    || !verticalDatum || verticalDatum === 'unknown' || verticalDatum !== ground.verticalDatum
    || (ground.resolutionM !== undefined && (!Number.isFinite(ground.resolutionM) || ground.resolutionM <= 0))) {
    throw new RangeError('Height conversion requires finite elevations and compatible vertical datums');
  }
  const heightM = heightMslM - ground.elevationM;
  return { heightM, heightMslM, reference: { ...ground }, belowGround: heightM < 0 };
}
