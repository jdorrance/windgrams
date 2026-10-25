import type { SiteForecast } from '@azohra/meteo.briefing/contract';
import type { Grid, ReplayHour, ReplayManifest } from '@windgrams/contracts/regional';
import type { FieldValue, RegionalField } from '@windgrams/contracts/fields';
import type { Bounds, Position } from '@windgrams/geography';
import type { RegionalReadOptions } from './regional.ts';

export interface RegionalDatasetOptions extends RegionalReadOptions {
  /** Dataset root, such as /data. Regional cases live below soaring/v1/. */
  baseUrl: string;
  caseId: string;
  /** Expected model. Also supplies an explicit identity for archives published before model metadata. */
  model?: string;
}

export interface RegionalDiscoveryOptions extends RegionalReadOptions {
  baseUrl: string;
}
export interface RegionalDatasetDescriptor {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly bounds: Bounds;
  readonly timeZone: string;
}

export interface RegionalDatasetDocuments {
  /** Immutable bundle root. The injected reader receives URLs below this root. */
  bundleUrl: string;
  manifest: ReplayManifest;
  grid: Grid;
  model?: string;
  read?: (url: string) => Promise<unknown>;
  signal?: AbortSignal;
  /** Omit to expose the complete manifest. Useful for a saved subset of a bundle. */
  availableValidTimes?: readonly string[];
  availableCellIndices?: readonly number[];
  /** Saved file paths relative to bundleUrl. Must include selected hours and published cell shards. */
  availableFiles?: readonly string[];
}

export interface RegionalDatasetIdentity {
  readonly caseId: string;
  readonly model: string;
  readonly referenceTime: string;
  readonly bundleUrl: string;
}

export interface RegionalSampleRequest {
  position: Position;
  validAt: string;
  fields: readonly RegionalField[];
  /** Zero by default. A positive tolerance permits the nearest published time; ties choose earlier. */
  timeToleranceMinutes?: number;
}

export interface RegionalCellSelection extends Position {
  cellIndex: number;
  gridIndex: number;
  /** Native model ground, metres MSL; unknown terrain remains null. */
  modelElevationM: number | null;
  /** Great-circle offset from the requested position to this cell's centre. */
  distanceKm: number;
}
export interface RegionalTimeSelection {
  validAt: string;
  forecastHour: number;
}
export interface RegionalSample {
  readonly requested: RegionalSampleRequest;
  readonly selected: {
    readonly cell: RegionalCellSelection | null;
    readonly time: RegionalTimeSelection | null;
  };
  /** Coordinate coverage is checked first when neither coordinate nor time is covered. */
  readonly gap: 'outside-coverage' | 'time-unavailable' | null;
  readonly values: Readonly<Partial<Record<RegionalField, FieldValue>>>;
}

export interface RegionalDataset {
  readonly identity: RegionalDatasetIdentity;
  /** Snapshot documents are cloned and deeply frozen when the dataset opens. */
  readonly manifest: ReplayManifest;
  readonly grid: Grid;
  /** Exact instant only; returns null when the hour is outside the available scope. */
  loadHour(validAt: string): Promise<ReplayHour | null>;
  /** Returns null for an unavailable or incomplete profile. Invalid cell indexes throw. */
  loadCellProfile(cellIndex: number): Promise<SiteForecast | null>;
  sample(request: RegionalSampleRequest): Promise<RegionalSample>;
  /** Sample the supplied positions/times in order. Concurrency defaults to four, with a maximum of sixteen. */
  sampleRoute(requests: readonly RegionalSampleRequest[], options?: { concurrency?: number }): Promise<RegionalSample[]>;
}
