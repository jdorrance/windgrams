import type { ForecastSite, RequestOptions, SparseMetadata, SparseSoaring } from '../supplemental.ts';
export type EcmwfSurfaceField = 'temperatureC' | 'dewPointC' | 'windSpeedMps' | 'windDirectionDeg' | 'windGustMps'
  | 'cloudCoverPct' | 'cloudLowPct' | 'cloudMidPct' | 'cloudHighPct' | 'precipitationMm' | 'capeJkg' | 'boundaryLayerHeightM' | 'shortwaveWm2';
export type EcmwfAloftField = 'wind850SpeedMps' | 'wind850DirectionDeg' | 'height850M' | 'wind700SpeedMps' | 'wind700DirectionDeg' | 'height700M';
export type EcmwfField = EcmwfSurfaceField | EcmwfAloftField;
export type EcmwfFieldSpec = readonly [sourceField: string, acceptedUnits: readonly string[], decimalPlaces: number];
export interface OpenMeteoResponse {
  latitude?: number | null; longitude?: number | null; elevation?: number | null;
  hourly: { time: number[] } & Record<string, readonly unknown[]>;
  hourly_units?: Record<string, string>;
}
export interface EcmwfRuns { surface?: string | null; aloft?: string | null }
export type EcmwfHour = Record<EcmwfField, number | null> & { validAt: string; soaring: SparseSoaring };
export interface EcmwfDocument {
  schemaVersion: 1; source: string; generatedAt: string; soaringMeta: SparseMetadata;
  models: { surface: { id: 'ecmwf_ifs'; label: string; run: string | null }; aloft: { id: 'ecmwf_ifs025'; label: string; run: string | null } };
  site: ForecastSite & { gridLatitude: number | null; gridLongitude: number | null; gridElevationM: number | null };
  units: Record<EcmwfField, string>; hours: EcmwfHour[];
}
export interface EcmwfBuildOptions extends RequestOptions { site: ForecastSite; surface: OpenMeteoResponse; aloft: OpenMeteoResponse | null; runs?: EcmwfRuns }
export type EcmwfSiteStatus = { slug: string; ok: true; hours: number } | { slug: string; ok: false; error: string };
export interface EcmwfManifest { schemaVersion: 1; source: string; generatedAt: string; runs: EcmwfRuns; sites: EcmwfSiteStatus[] }

