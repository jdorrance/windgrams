import { parseProviderHealth, type ProviderHealth, type ProviderRefresh } from '@windgrams/contracts/provider-health';
import { createForecastClient, type ForecastClientOptions } from '@windgrams/data-client';
import { MODELS, PROVIDER_GROUPS } from '@windgrams/providers/registry';

/** One validated health request per provider for this page's lifetime. Missing health stays unknown. */
export function createRefreshHealthReader(options: ForecastClientOptions): (model: string) => Promise<ProviderRefresh | null> {
  const client = createForecastClient(options);
  const pending = new Map<string, Promise<ProviderHealth | null>>();
  return async model => {
    const group = MODELS.find(item => item.id === model)?.jobGroup;
    if (!group) return null;
    if (!pending.has(group)) pending.set(group, client.readJson(`health/${group}.json`, raw =>
      parseProviderHealth(raw, { group, models: PROVIDER_GROUPS[group] })).catch(() => null));
    return (await pending.get(group))?.models[model] ?? null;
  };
}
