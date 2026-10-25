import type { AtmosphericColumn } from '@windgrams/contracts';
import type { Bounds, Position } from '@windgrams/geography';
import type { SiteLocation } from '../registry.ts';
export interface IconBounds { west: number; south: number; east: number; north: number }
export interface IconCell extends Position { index: number; id: string; cellIndex: number; terrainM: number; corners: [longitude: number, latitude: number][] }
export interface IconObjectSource { url: string; range: [start: number, end: number] | null; bytes: number; sha256: string; lastModified: string | null }
export interface IconFieldMetadata { units: string; stepType: string; startHour: number; endHour: number; packingError?: number }
export interface IconFieldRecord { metadata: IconFieldMetadata; values: Array<number | null> }
export interface IconSourceObject extends IconObjectSource, IconFieldMetadata { field: string; forecastHour: number; modelLevel: number | null }
export interface IconGrid {
  type: 'icon-native-triangular'; uuid: string; number: number; pointCount: number;
  geometrySource: { url: string; uuid: string; registrySha256: string; headerSha256: string; records?: IconObjectSource[] };
  coordinateSources?: Record<string, IconObjectSource>;
}
export interface IconCaptureProvenance {
  provider: 'DWD'; accessProduct: string; attribution: string; capturedAt: string; downloadedBytes: number;
  elapsedSeconds: number; downloads?: number; retries?: number; decoder: { eccodes: string; numpy: string }; fixtureDescription?: string;
}
export interface IconExtractRecord extends IconFieldRecord { field: string; hour: number; level: number | null; source: IconObjectSource }
export interface IconExtractBase {
  model: 'icon-eu'; referenceTime: string; grid: IconGrid; cells: IconCell[]; siteCells: Record<string, number>; levels: number[];
  forecastHours: number[]; provenance: IconCaptureProvenance;
}
export interface IconAcquisition {
  model: 'icon-eu'; referenceTime: string; grid: IconGrid; cells: IconCell[];
  siteCells: Record<string, number>; levels: number[];
  provenance: IconCaptureProvenance & { sourceObjects: IconSourceObject[] };
  hours: { forecastHour: number; validAt: string; sources: Array<AtmosphericColumn | null> }[];
}
export interface IconAcquireOptions { referenceTime?: string; forecastHours?: readonly number[]; sites?: readonly SiteLocation[]; bbox?: IconBounds | Bounds; cacheDir: string; python?: string; concurrency?: number; maxDownloadBytes?: number; extractPath?: string; acquisitionPath?: string; log?: (line: string) => void }

export type IconExtract = IconExtractBase & ({ records: Record<string, IconExtractRecord>; recordManifest?: Record<string, Omit<IconExtractRecord, 'values'>>; recordFiles?: Record<string, string> } | { records?: undefined; recordManifest: Record<string, Omit<IconExtractRecord, 'values'>>; recordFiles: Record<string, string> });
