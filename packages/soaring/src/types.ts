import type { AtmosphericColumn, AtmosphericLevel, Scalar, SiteForecast } from '@windgrams/contracts';
import type { PressureLevel } from '@windgrams/meteorology';

export interface DiagnosticOptions { launchElevationM?: number | null }
/** Baseline cloud ceiling used to cap lift, in metres MSL. */
export interface BaselineLiftHour { derived?: { cloudBaseM?: number | null } }
/** Upward heat flux in W/m²; boundary-layer depth in metres AGL; terrain in metres MSL. */
export interface ThermalVelocityInput {
  surfaceTemperatureC: number; surfaceDewPointC?: number | null;
  sensibleHeatFluxWm2?: number | null; latentHeatFluxWm2?: number | null;
  boundaryLayerDepthM?: number | null; surfacePressureHpa?: number | null;
  referencePressureHpa?: number | null; terrainM?: number | null;
  firstLevel?: PressureLevel | null;
}
/** Heights are metres MSL; sink and convective velocity are m/s. */
export interface UsableLiftInput {
  modelElevationM?: number | null; resolvedThermalTopM?: number | null;
  thermalVelocityV2Mps?: number | null; cloudBaseM?: number | null;
}
export interface TerrainAdjustment {
  experimental: true; launchElevationM: number; modelElevationM: number; terrainDeltaM: number;
  bracketsLaunchAltitude: boolean; launchWindSpeedMps: number | null; launchWindDirectionDeg: number | null;
  rawMslHeightsPreserved: true; assumptions: string[];
}
export interface VerticalResolution {
  nativeLevelCount: number; aboveGroundLevelCount: number; isSparseProfile: boolean;
  hasSub925Levels: boolean; hasUpperAirAbove600Levels: boolean; has80mWind: boolean; synthesizedLevels: 0;
}
export type SoaringMetric =
  | 'resolvedThermalTopM' | 'thermalTopPlus1CM' | 'thermalVelocityV2Mps' | 'usableLiftTopV2M'
  | 'hcritWxtoflyM' | 'dryHcritM' | 'surfaceLclM' | 'effectiveCloudLimitM' | 'mixedLayerLclM'
  | 'cuPotentialM' | 'odPotentialM' | 'blMeanWindSpeedMps' | 'blMeanWindDirDeg'
  | 'blTopWindSpeedMps' | 'blTopWindDirDeg' | 'blWindShearMps' | 'buoyancyShearRatio'
  | 'wind10mSpeedMps' | 'wind10mDirDeg' | 'wind80mSpeedMps' | 'wind80mDirDeg' | 'windGustMps'
  | 'wind925SpeedMps' | 'wind925DirDeg' | 'wind850SpeedMps' | 'wind850DirDeg'
  | 'maxUpwardVelocityMps' | 'minDownwardVelocityMps' | 'w925Mps' | 'w850Mps'
  | 'sensibleHeatFluxWm2' | 'latentHeatFluxWm2' | 'cloudCoverPercent' | 'lowCloudPercent'
  | 'midCloudPercent' | 'highCloudPercent' | 'precipitationMmHr' | 'capeJkg' | 'cinJkg';
export type SoaringDiagnostics = Record<SoaringMetric, number | null> & {
  contractVersion: '2.1.0'; thermalVelocityV2Mps: number; verticalResolution: VerticalResolution;
  experimental?: { terrainAdjustment: TerrainAdjustment | null };
};
export interface EnsembleMetric {
  members: number; p10: number | null; p25: number | null; p50: number | null; p75: number | null; p90: number | null;
  ceiledMembers?: number;
}
export type EnsembleSoaringMetric = 'resolvedThermalTopM' | 'thermalTopPlus1CM' | 'usableLiftTopV2M'
  | 'hcritWxtoflyM' | 'dryHcritM' | 'surfaceLclM' | 'effectiveCloudLimitM' | 'mixedLayerLclM'
  | 'cuPotentialM' | 'odPotentialM' | 'thermalVelocityV2Mps' | 'blMeanWindSpeedMps'
  | 'blTopWindSpeedMps' | 'blWindShearMps' | 'buoyancyShearRatio';
export type EnsembleSoaringDiagnostics = Record<EnsembleSoaringMetric, EnsembleMetric> & {
  contractVersion: '2.1.0'; modelKind: 'ensemble-percentiles'; derivationRule: 'per-member-before-percentiles'; memberCount: number;
};
export interface MemberColumn { source: AtmosphericColumn; v1Hour: BaselineLiftHour }
/** Reconstructed fields may contain scalars or ensemble percentiles; validate before using them as a scalar column. */
export type ReconstructedColumn = NonNullable<ReturnType<typeof import('./point-postprocess.js').sourceFromPublishedDeterministicHour>>;
export interface PostprocessOptions extends DiagnosticOptions { modelSlug?: string | null }
export type ModelKind = 'deterministic-column' | 'ensemble-percentiles' | 'surface-or-sparse-adapter';
/** Forecast fields accepted from NWS/ECMWF documents and upstream scalar or percentile profiles. */
export interface CompatibilityHour {
  validAt: string;
  temperatureC?: number | null; dewPointC?: number | null; dewpointC?: number | null;
  windSpeedMps?: number | null; windDirectionDeg?: number | null; windGustMps?: number | null;
  cloudCoverPercent?: number | null; skyCoverPct?: number | null;
  boundaryLayerHeightM?: number | null; mixingHeightM?: number | null;
  transportWindSpeedMps?: number | null; transportWindDirectionDeg?: number | null;
  surface?: Partial<Record<Exclude<keyof AtmosphericColumn, 'validAt' | 'levels' | 'smoke' | 'precipitationMm'> | 'precipitationMmHr', Scalar | null>>;
  levels?: readonly SiteForecast['hours'][number]['levels'][number][] | readonly AtmosphericLevel[];
  derived?: Partial<Record<'thermalVelocityMps' | 'usableLiftTopM' | 'boundaryLayerTopM' | 'cloudBaseM', Scalar | null>>;
  soaring?: Partial<Record<SoaringMetric | 'modelBlTopM', Scalar | null>> & {
    experimental?: { terrainAdjustment?: TerrainAdjustment | null };
  } | null;
}
export interface CompatibilityDocument {
  model?: string;
  run?: { referenceTime?: string; members?: number };
  site?: { modelElevationM?: number | null; gridElevationM?: number | null };
  grid?: { elevationM?: number | null; office?: string };
  models?: { surface?: { run?: string | null } };
  generatedAt?: string; updateTime?: string;
  soaringMeta?: Partial<SoaringMetadata>;
  hours?: readonly CompatibilityHour[];
}
export interface SoaringMetadata {
  contractVersion: string; model: string; modelKind: ModelKind;
  launchElevationM?: number | null; terrainDeltaM?: number | null;
  nativeLevelCount?: number; isSparseProfile?: boolean; baselineDerivedRetained?: true;
  synthesizedLevels: 0; rawMslHeightsPreserved?: true;
  members?: number; derivationRule?: 'per-member-before-percentiles';
  postprocessAction?: 'retained-upstream-member-percentiles'; nonlinearMedianPostprocessRefused?: true;
  reason?: string; supportedDiagnostics?: string[]; unsupportedDiagnostics?: string[]; unsupportedReason?: string;
}
export interface SparseSoaringDiagnostics {
  contractVersion: '2.1.0'; modelKind: 'surface-or-sparse-adapter';
  surfaceLclM: number | null; modelBlTopM: number | null;
  blMeanWindSpeedMps: number | null; blMeanWindDirDeg: number | null;
  thermalVelocityV2Mps: null; usableLiftTopV2M: null; hcritWxtoflyM: null; dryHcritM: null; mixedLayerLclM: null;
  unsupportedDiagnostics: string[]; unsupportedReason: string;
}
export type PostprocessedHour<T> = Omit<T, 'soaring'> & { soaring?: SoaringDiagnostics | SparseSoaringDiagnostics | CompatibilityHour['soaring'] };
export type PostprocessedDocument<T extends CompatibilityDocument> = Omit<T, 'hours' | 'soaringMeta'> & {
  soaringMeta?: SoaringMetadata | T['soaringMeta'];
} & (T extends { hours: readonly (infer H)[] }
  ? { hours: readonly PostprocessedHour<H>[] }
  : { hours?: readonly PostprocessedHour<NonNullable<T['hours']>[number]>[] });
/** A point forecast with added diagnostics and the original required hours, site and run fields. */
export type PostprocessedSiteForecast = Omit<SiteForecast, 'hours'> & {
  hours: PostprocessedHour<SiteForecast['hours'][number]>[]; soaringMeta?: SoaringMetadata;
};
export interface ModelMetadata {
  modelKind: ModelKind; contractVersion: string; referenceTime: string | null;
  modelElevationM: number | null; unsupportedReason: string | null;
}
export interface ModelWindowSummary {
  model: string; modelKind: ModelKind; contractVersion?: string; referenceTime: string | null;
  derivationRule?: 'per-member-before-percentiles';
  modelElevationM: number | null; coverageSamples: number; coverageSpanHours: number | null;
  status: 'available' | 'unavailable'; peakWstarV2Mps: number | null; peakUsableLiftTopV2M: number | null;
  peakResolvedThermalTopM?: number | null; peakLegacyWstarMps?: number | null; peakLegacyUsableLiftTopM?: number | null;
  minSurfaceLclM?: number | null; minEffectiveCloudLimitM?: number | null;
  meanWindSpeedMps: number | null; maxTempC: number | null; unsupportedReason?: string | null;
}
