import type { Position } from '@windgrams/geography';
/** North-up raster: metres MSL, NaN gaps, dLon/dLat sample spacing in degrees. */
export interface ElevationGrid { values: Float32Array; width: number; height: number; west: number; north: number; dLon: number; dLat: number }
export interface TerrainBounds { south: number; west: number; north: number; east: number }
export interface SolarArea extends TerrainBounds { name: string }
export interface SolarSite extends Position { slug: string }
/** Half-open pixel extent at the terrain builder's maximum zoom. */
export interface TerrainDomain { x0: number; y0: number; x1: number; y1: number; bounds: TerrainBounds }
/** Credited DEM source; resolutionM records nominal source detail independently of grid spacing. */
export interface TerrainSource { id: string; name: string; resolutionM: number; licence: string; url: string }
export interface TerrainSources { surface: TerrainSource; horizon: TerrainSource }
export interface SolarDomainOptions { radiusKm?: number; area?: SolarArea }
/** Coarse grids cover the full horizon radius; coarse gaps can leave open horizons. Fine-grid gaps stay missing. */
export interface SolarTerrainOptions extends SolarDomainOptions { coarse: ElevationGrid; sources: TerrainSources; maxDistanceKm?: number; log?: (message: string) => void }
export interface TerrainTile { z: number; x: number; y: number; body: Uint8Array }
export interface ReliefMeta {
  version: number; path: string; zoom: number; x0: number; y0: number; width: number; height: number;
  offsetM: number; scale: number; minM: number | null; maxM: number | null; encoding: string; bytes: number;
}
export interface ReliefFrame { domain: TerrainDomain; zoom: number; f: number; x0: number; y0: number; width: number; height: number; values: Uint16Array; min: number; max: number }
export interface ReliefProduct { body: Uint8Array; meta: ReliefMeta }
export interface SolarTerrainIndex {
  schemaVersion: 1; slug: string; generatedAt: string; generation: string;
  inputs: SolarDomainOptions & { latitude: number; longitude: number; maxDistanceKm: number; algorithmVersion: number; sources: { surface: string; horizon: string } };
  sources: TerrainSources; bounds: TerrainBounds; referenceElevationM: number | null;
  tiles: { path: string; size: number; minZoom: number; maxZoom: number; ranges: Record<string, [number, number, number, number]>; count: number; bytes: number };
  encoding: { planes: string[]; normal: string; horizonCells: number; horizonBorder: number; azimuthsDeg: number[]; horizonStepDeg: number; delta: 'row'; compression: 'gzip' };
  launch: { elevationM: number | null; slopeDeg: number | null; aspectDeg: number | null; skyViewFactor: number | null; horizonDeg: (number | null)[] } | null;
  relief: ReliefMeta;
}
export interface SolarTerrainProduct { index: SolarTerrainIndex; relief: ReliefProduct }
export interface SolarTerrainBuild {
  domain: TerrainDomain; blocks: TerrainDomain[]; generation: string;
  addBlock(block: TerrainDomain, fine: ElevationGrid): TerrainTile[];
  finish(options?: { generatedAt?: string }): SolarTerrainProduct;
}


export interface SurfaceLevel { z: number; x0: number; y0: number; width: number; height: number; nx: Float32Array; ny: Float32Array; nz: Float32Array; svf: Float32Array }
export interface HorizonGrid { x0: number; y0: number; width: number; height: number; horizons: Float32Array[] }
