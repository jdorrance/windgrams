/** Build sunlight terrain tiles and relief from elevation grids. */
export { DEFAULT_MAX_DISTANCE_KM, DEFAULT_RADIUS_KM, FINE_MARGIN_M } from './internal/solar/constants.ts';
export { domainFor, domainOf, blocksOf, expandBounds, metresPerDegree, gridFromFunction } from './internal/solar/grid.ts';
export { startSolarTerrain, buildSolarTerrain, indexIsFresh } from './internal/solar/build.ts';
export { reliefFrame, fillRelief, encodeRelief, reliefIsFresh } from './internal/solar/relief.ts';
export type { ElevationGrid, TerrainBounds, SolarArea, SolarSite, TerrainDomain, TerrainSource, TerrainSources, SolarDomainOptions, SolarTerrainOptions, TerrainTile, ReliefMeta, ReliefFrame, ReliefProduct, SolarTerrainIndex, SolarTerrainProduct, SolarTerrainBuild } from './internal/solar/types.ts';
