import type { IdxRecord, LambertGrid, LatLonGrid } from '@azohra/meteo.grib';
import type { NormalizedColumnRecord } from '@windgrams/contracts';
import type { Bounds } from '@windgrams/geography';
import type { SiteLocation } from '../../registry.ts';

export type NoaaModel = 'hrrr-conus' | 'rrfs' | 'gfs';
export type NoaaGrid = LambertGrid | LatLonGrid;
export type NoaaVerticalMode = 'legacy-pressure' | 'expanded-pressure' | 'hrrr-native';
/** Raw GRIB identities; unit conversion occurs after validated decoding. */
export interface NoaaField { key: string; variable: string; level: string; required: boolean; conversion: string; product?: string; forecast?: string }
export interface NoaaSelection extends NoaaField { record: IdxRecord | null }
export interface NoaaColumnOptions {
  model?: NoaaModel; referenceTime: string; terrainForecastHour: number;
  pressureLevels?: readonly number[]; includeExtendedFields?: boolean;
}
export interface NoaaAcquireOptions {
  model: NoaaModel;
  referenceTime: string;
  /** Unique ascending forecast leads, hours 1 through the selected model's schedule. */
  forecastHours: readonly number[];
  cacheDir: string;
  sites?: readonly SiteLocation[];
  bounds?: Bounds;
  /** Opt-in experiment. The default retains the legacy pressure-level inventory. */
  verticalMode?: NoaaVerticalMode;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Guard against accidental national-domain acquisitions. Default 12,000 selected cells. */
  maxCells?: number;
}
export interface NoaaCell {
  index: number; id: string; latitude: number; longitude: number; modelElevationM: number;
  corners: readonly (readonly [number, number])[];
}
export interface NoaaSourceAsset {
  url: string; range: string | null; sha256: string; size: number; file: string;
}
export interface NoaaAcquisition {
  schemaVersion: 1; adapterVersion: 'noaa-columns-1'; adapterImplementationSha256: string; model: NoaaModel; referenceTime: string;
  verticalMode: NoaaVerticalMode; capturedAt: string; grid: NoaaGrid;
  completeness: 'complete' | 'partial';
  cells: readonly NoaaCell[]; siteCells: Readonly<Record<string, number>>;
  hours: readonly { forecastHour: number; validAt: string; columns: readonly (NormalizedColumnRecord | null)[]; missingReasons: readonly (string | null)[] }[];
  assets: readonly NoaaSourceAsset[];
}
