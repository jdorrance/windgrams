import type { SiteLocation } from './registry.ts';
/** Fetch JSON for a source adapter to parse. */
export type JsonClient = (url: string) => Promise<unknown>;
export interface ForecastSite extends SiteLocation { name: string; timeZone: string }
export interface RequestOptions { now?: number; warn?: (message: string) => void }
export interface ClientOptions { fetchImpl?: typeof fetch; retryDelayMs?: number }
export interface SparseSoaring {
  contractVersion: '2.0.0'; modelKind: 'surface-or-sparse-adapter';
  surfaceLclM: number | null; modelBlTopM: number | null;
  blMeanWindSpeedMps: number | null; blMeanWindDirDeg: number | null;
  thermalVelocityV2Mps: null; usableLiftTopV2M: null; hcritWxtoflyM: null; dryHcritM: null; mixedLayerLclM: null;
  unsupportedDiagnostics: string[]; unsupportedReason: string;
}
export interface SparseMetadata {
  contractVersion: '2.0.0'; model: 'nws' | 'ecmwf'; modelKind: 'surface-or-sparse-adapter';
  supportedDiagnostics: string[]; unsupportedDiagnostics: string[]; unsupportedReason: string; synthesizedLevels: 0;
}
