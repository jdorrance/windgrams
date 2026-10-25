import type { AtmosphericColumn, NormalizedColumnRecord } from '@windgrams/contracts';
import type { Bounds, Position } from '@windgrams/geography';
import type { ModelDescriptor } from './registry.ts';
import type { SelectedRun } from './types.ts';
import type { acquireIcon } from './internal/icon-native.ts';
import type { IconAcquisition, IconAcquireOptions } from './internal/icon-types.ts';

export interface AreaAcquisitionRequest {
  run: SelectedRun;
  /** Native cells whose centres fall inside [west, south, east, north]. */
  bounds: Bounds;
  forecastHours: readonly number[];
  /** Required supported fields. Complete normalized columns are returned, including optional missing values. */
  fields?: readonly (keyof AtmosphericColumn)[];
  cacheDir: string;
  signal?: AbortSignal;
}
export interface AreaCell extends Position {
  /** Position in every returned hourly columns array. */
  cellIndex: number;
  gridIndex: number;
  id: string;
  modelElevationM: number;
  /** Native polygon vertices in longitude/latitude order; the ring need not repeat its first vertex. */
  corners: readonly (readonly [longitude: number, latitude: number])[];
}
export interface AreaAcquisitionResult {
  kind: 'normalized-area';
  run: SelectedRun;
  bounds: Bounds;
  grid: { id: string; type: string; pointCount: number };
  cells: readonly AreaCell[];
  hours: readonly {
    forecastHour: number;
    validAt: string;
    /** Null identifies an unavailable native column; its array position remains present. */
    columns: readonly (NormalizedColumnRecord | null)[];
  }[];
}
export interface AreaAcquisitionAdapter<T extends AreaAcquisitionResult = AreaAcquisitionResult> {
  readonly model: ModelDescriptor;
  readonly fields: readonly (keyof AtmosphericColumn)[];
  acquire(request: AreaAcquisitionRequest): Promise<T>;
}

export interface IconAreaResult extends AreaAcquisitionResult {
  /** Materialized on first access and retained for subsequent reads. */
  readonly hours: AreaAcquisitionResult['hours'];
  /** Original acquisition, including optional point-support cells, for ICON publication. */
  native: IconAcquisition;
}

export interface IconAreaOptions extends Omit<IconAcquireOptions, 'referenceTime' | 'forecastHours' | 'bbox' | 'cacheDir' | 'signal'> {
  acquire?: typeof acquireIcon;
}
