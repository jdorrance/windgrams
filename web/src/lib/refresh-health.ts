import { parseProviderHealth, type ProviderHealth, type ProviderRefresh } from '@windgrams/contracts/provider-health';
import { createForecastClient, type ForecastClientOptions } from '@windgrams/data-client';
import { MODELS, PROVIDER_GROUPS } from '@windgrams/providers/registry';

/** How long a successful health read is reused before a long-lived tab re-reads it. */
export const HEALTH_TTL_MS = 5 * 60_000;

/**
 * Sibling models share one validated health request per provider group.
 * A successful read is reused for HEALTH_TTL_MS; a failed read is not cached,
 * so the next call retries. Missing health stays unknown.
 */
export function createRefreshHealthReader(options: ForecastClientOptions & { now?: () => number }): (model: string) => Promise<ProviderRefresh | null> {
  const client = createForecastClient(options);
  const cache = new Map<string, { at: number; promise: Promise<ProviderHealth | null> }>();
  const now = options.now ?? Date.now;
  return async model => {
    const group = MODELS.find(item => item.id === model)?.jobGroup;
    if (!group) return null;
    const hit = cache.get(group);
    if (!hit || now() - hit.at >= HEALTH_TTL_MS) {
      const promise = client.readJson(`health/${group}.json`, raw =>
        parseProviderHealth(raw, { group, models: PROVIDER_GROUPS[group] })).catch(() => null);
      cache.set(group, { at: now(), promise });
      void promise.then(health => { if (!health && cache.get(group)?.promise === promise) cache.delete(group); });
    }
    return (await cache.get(group)?.promise)?.models[model] ?? null;
  };
}
