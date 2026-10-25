import legacyModels from '../../soaring/legacy-replay-models.json' with { type: 'json' };
import policy from '../../provider-policy.json' with { type: 'json' };
import { modelCoversSite, modelDescriptor } from '@windgrams/providers/registry';
export { modelCoversSite };
export const REGION_INDEXES = policy.regionIndexes;
export const REGIONAL_MERGE_OPTIONS = { primaryModel: policy.primaryRegionalModel, preferredModels: policy.preferredRegionalModels };
export function regionIndexName(id) {
  const entry = REGION_INDEXES.find(entry => entry.model === id);
  if (!entry) throw new Error(`${id} has no configured regional index`);
  return entry.file;
}
export function regionSupportsModel(region, id) {
  return modelDescriptor(id).nativeGrid && (region.regionalModels ?? policy.defaultRegionalModels).includes(id);
}
const US_PREFIXES = new Set('al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy pr vi gu mp as'.split(' '));
export function nwsCoversSite(site) {
  if (site.country !== undefined) return site.country === 'US';
  return typeof site.slug === 'string' && US_PREFIXES.has(site.slug.split('-')[0]);
}

/** Explicit archive migration; newly published manifests carry their model. */
export const legacyCaseModel = caseId => Object.hasOwn(legacyModels, caseId) ? legacyModels[caseId] : undefined;
