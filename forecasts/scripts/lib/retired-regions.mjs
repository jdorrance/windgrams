// Retired generated grids cannot return through retained caches, older artifacts or CDN seeds.
// Point forecasts, issued history and source replay fixtures are outside this policy.
const retiredRegions = new Set(['north-sound', 'shenandoah-blue-ridge', 'central-puget-tiger',
  'columbia-gorge-eastern-wa', 'rogue-oregon-outback', 'intermountain-idaho-utah']);
export const isRetiredRegionalCase = caseId => typeof caseId === 'string'
  && /^(?:north-sound|shenandoah-blue-ridge|shenandoah-massanutten|tiger-puget-trough|columbia-gorge-gap-flow|rogue-valley-woodrat|intermountain-idaho-utah)(?:-|$)/.test(caseId);

export function publicRegionCatalogue(index) {
  if (!index || !Array.isArray(index.regions)) return index;
  let changed = false;
  const regions = index.regions.filter(region => !retiredRegions.has(region?.id)
    && !isRetiredRegionalCase(region?.caseId) && !isRetiredRegionalCase(region?.templateCaseId))
    .map(region => {
      if (!region || typeof region !== 'object' || Array.isArray(region)) return region;
      const next = { ...region };
      if (isRetiredRegionalCase(next.expandedCaseId)) { delete next.expandedCaseId; changed = true; }
      if (Array.isArray(next.nativeModels)) {
        next.nativeModels = next.nativeModels.filter(model => !isRetiredRegionalCase(model?.caseId)).map(model => {
          if (!isRetiredRegionalCase(model?.expandedCaseId)) return model;
          changed = true;
          const retained = { ...model };
          delete retained.expandedCaseId;
          return retained;
        });
        if (next.nativeModels.length !== region.nativeModels.length) changed = true;
      }
      return next;
    });
  if (typeof index.trialRegionId === 'string' && regions.length && !regions.some(region => region?.id === index.trialRegionId)) changed = true;
  if (!changed && regions.length === index.regions.length) return index;
  const fallback = regions.find(region => region?.status === 'active-verified-trial') ?? regions.find(region => typeof region?.id === 'string');
  return { ...index, trialRegionId: regions.some(region => region?.id === index.trialRegionId) ? index.trialRegionId : fallback?.id ?? 'unavailable', regions };
}
