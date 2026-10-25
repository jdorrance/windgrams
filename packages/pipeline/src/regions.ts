export interface NativeModel { model: string; caseId: string }
export interface RegionEntry {
  id: string; name?: string; status?: string; caseId?: string; expandedCaseId?: string; templateCaseId?: string;
  nativeModels?: NativeModel[]; timeZone?: string; morningBriefingLocalHour?: number; matchedRaobStation?: string;
  bbox?: readonly [west: number, south: number, east: number, north: number]; primarySite?: string;
  launches?: string[]; deterministicModels?: string[]; ensembleModels?: string[]; sparseAdapters?: string[]; regionalModels?: string[];
}
export interface RegionIndex { schemaVersion?: number; soaringContractVersion?: string; trialRegionId?: string; generatedAt?: string; regions: RegionEntry[] }
export interface RegionMergeOptions { primaryModel?: string; preferredModels?: readonly string[]; resolveLegacyCase?: (caseId: string) => string | undefined }
/** Merge published cases, applying each overlay only to entries for its declared model. */
export function mergeRegionCatalogues(primary: RegionIndex | null, overlays: readonly { model: string; index: RegionIndex | null }[], isPublished: (caseId: string) => boolean, { primaryModel, preferredModels = [], resolveLegacyCase }: RegionMergeOptions = {}): RegionIndex {
  const base = primary ?? overlays.find(overlay => overlay.index)?.index ?? { regions: [] };
  const all = new Map(base.regions.map(region => [region.id, region]));
  for (const overlay of overlays) for (const region of overlay.index?.regions ?? []) if (!all.has(region.id)) all.set(region.id, region);
  const regions = [...all.values()].flatMap(region => {
    const native = new Map((region.nativeModels ?? []).filter(item => isPublished(item.caseId)).map(item => [item.model, item]));
    if (region.caseId && isPublished(region.caseId)) {
      const model = region.nativeModels?.find(item => item.caseId === region.caseId)?.model
        ?? overlays.find(overlay => overlay.index?.regions.some(item => item.caseId === region.caseId))?.model
        ?? primaryModel ?? resolveLegacyCase?.(region.caseId);
      if (model) native.set(model, { model, caseId: region.caseId });
    }
    for (const overlay of overlays) for (const item of overlay.index?.regions.find(item => item.id === region.id)?.nativeModels ?? []) {
      if (item.model === overlay.model && isPublished(item.caseId)) native.set(item.model, item);
    }
    if (region.status === 'active-verified-trial' && !native.size) return [];
    const active = preferredModels.map(model => native.get(model)).find(Boolean) ?? [...native.values()][0];
    const merged = { ...region, ...(active ? { caseId: active.caseId } : {}), nativeModels: [...native.values()] };
    if (merged.expandedCaseId && !isPublished(merged.expandedCaseId)) delete merged.expandedCaseId;
    return [merged];
  });
  return { ...base, regions };
}
