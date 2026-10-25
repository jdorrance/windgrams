import type { SiteForecast, ForecastManifest } from '@azohra/meteo.briefing/contract';
import type { NormalizedColumnRecord } from '@windgrams/contracts';
import type { SiteLocation, ModelDescriptor } from './registry.ts';
export interface SelectedRun { provider: string; model: string; referenceTime: string; product: string }
export interface AcquisitionRequest {
  run: SelectedRun; sites: readonly SiteLocation[]; outputRoot: string; cacheDir?: string;
  /** Positive count limiting acquisition to the first N hours of the adapter's configured schedule. */
  maxSteps?: number;
}
export interface ProcessedProfileResult {
  kind: 'processed-profile'; run: SelectedRun; stage: 'upstream-derived';
  /** Identity and version of the implementation that derived the incoming profiles. */
  derivation: { package: string; version: string };
  profiles: SiteForecast[]; manifest: ForecastManifest;
}
export interface NormalizedColumnsResult {
  kind: 'normalized-columns'; run: SelectedRun; stage: 'normalized'; columns: readonly NormalizedColumnRecord[];
}
export type AcquisitionResult = ProcessedProfileResult | NormalizedColumnsResult;
export interface AcquisitionAdapter<T extends AcquisitionResult = AcquisitionResult> {
  readonly model: ModelDescriptor;
  acquire(request: AcquisitionRequest): Promise<T>;
}
