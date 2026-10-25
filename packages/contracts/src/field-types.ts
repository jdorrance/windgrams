import type { ReplayHour } from './regional-types.js';

/** Published scalar fields. Native units remain unchanged across consumers. */
export type RegionalField = Exclude<{
  [K in keyof ReplayHour]-?: NonNullable<ReplayHour[K]> extends readonly (number | null)[] ? K : never
}[keyof ReplayHour], 'levelCount'>;

export type HeightReference = 'MSL' | 'model-AGL' | 'terrain-AGL';
export interface FieldDefinition {
  readonly label: string;
  readonly unit: 'm' | 'm/s' | '°C' | 'hPa' | 'W/m²' | '%' | 'mm/h' | 'J/kg' | '°' | '1' | '10⁻⁵ s⁻¹';
  readonly heightReference?: HeightReference;
  readonly sinkMps?: number;
  /** Profile quality gates this diagnostic; independent surface observations remain usable. */
  readonly requiresProfile?: boolean;
}
export type FieldValue =
  | { readonly status: 'valid'; readonly value: number }
  | { readonly status: 'missing' | 'unsupported' | 'insufficient-profile'; readonly value: null };

/** A sampled ground elevation, with a datum compatible with the forecast's MSL heights. */
export interface GroundReference {
  readonly kind: 'model' | 'terrain';
  readonly elevationM: number;
  readonly verticalDatum: string;
  readonly source: string;
  readonly resolutionM?: number;
}
export interface RelativeHeight {
  readonly heightM: number;
  readonly heightMslM: number;
  readonly reference: GroundReference;
  readonly belowGround: boolean;
}

