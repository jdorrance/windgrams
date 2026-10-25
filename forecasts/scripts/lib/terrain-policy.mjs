import config from '../../terrain-policy.json' with { type: 'json' };
import { containsPoint } from '@windgrams/geography';
import { terrainPolicyId as policyId, terrainSourcesMatchPolicy as matches } from '@windgrams/providers/terrain-policy';

/** Deployment source selection. Rules are ordered; published fingerprints remain stable. */
export function terrainPolicy(site) {
  return config.rules.find(rule => (rule.country !== undefined && site.country === rule.country)
    || (rule.region !== undefined && site.region === rule.region)
    || (rule.slugPrefix !== undefined && site.slug.startsWith(rule.slugPrefix))
    || (rule.bounds !== undefined && containsPoint(rule.bounds, site)))?.policy ?? config.defaultPolicy;
}
export const terrainPolicyId = site => policyId(config.policies[terrainPolicy(site)]);
export const terrainSourcesMatchPolicy = (entry, site) => matches(entry, config.policies[terrainPolicy(site)]);
