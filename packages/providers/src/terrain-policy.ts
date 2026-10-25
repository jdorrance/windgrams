/** Source requirements chosen by the operator for a terrain product. */
export interface TerrainPolicy {
  id: string;
  elevationSources: readonly string[];
  terrainSource: string;
  landCoverSource: string;
}
export interface TerrainSourceSelection {
  elevation?: { source?: string };
  terrain?: { source?: string };
  landCover?: { source?: string };
}
export function terrainPolicyId(policy: TerrainPolicy): string { return `terrain-v1:${policy.id}`; }
/** Accept a cached measurement only when its credited sources satisfy the requested policy. */
export function terrainSourcesMatchPolicy(entry: TerrainSourceSelection | undefined, policy: TerrainPolicy): boolean {
  return entry?.landCover?.source === policy.landCoverSource && entry.terrain?.source === policy.terrainSource
    && policy.elevationSources.includes(entry.elevation?.source ?? '');
}
