import { fetchWithRetry } from './http.ts';
import { parsePublishedProfileJson } from '@windgrams/contracts/published-lift';
import type { SiteForecast } from '@azohra/meteo.briefing/contract';
import { type ReplayManifest } from '@windgrams/contracts/regional';

export interface RegionalReadOptions { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }
export interface ReplayProfileCache {
  cached(index: number): SiteForecast | undefined;
  load(index: number, gridIndex: number): Promise<SiteForecast>;
}

/** Static hosts can serve .gz as a file or transparently decode Content-Encoding. */
export async function decodeRegionalJson(response: Response): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function readRegionalJson(url: string, options: RegionalReadOptions = {}): Promise<unknown> {
  const response = await fetchWithRetry(url, { signal: options.signal }, { fetchImpl: options.fetch, timeoutMs: options.timeoutMs });
  if (!response.ok) throw new Error(`Forecast data unavailable (${response.status}).`);
  return url.endsWith('.gz') ? decodeRegionalJson(response) : response.json();
}

/**
 * Cache profiles for one manifest and share concurrent requests for the same cell.
 * Each profile must match the manifest's model, run, cell and hours. Capacity is a
 * positive integer; failed reads can be retried. Pass a reader with an AbortSignal
 * to cancel requests when the consuming view is removed.
 */
export function createReplayProfileCache(
  root: string,
  manifest: ReplayManifest,
  read: (url: string) => Promise<unknown> = readRegionalJson,
  capacity = 8,
): ReplayProfileCache {
  const model = manifest.model ?? manifest.case.model;
  if (!model || model === 'unknown') throw new Error('Regional forecast is missing its model identity');
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Profile cache capacity must be a positive integer');
  const cache = new Map<number, { gridIndex: number; profile: SiteForecast }>();
  const pending = new Map<number, { gridIndex: number; promise: Promise<SiteForecast> }>();
  const filename = manifest.cellProfiles;
  if (filename !== 'cell-{index}.json.gz') throw new Error('Unsupported regional cell profile path');
  return {
    cached(index: number) {
      const profile = cache.get(index);
      if (profile) { cache.delete(index); cache.set(index, profile); }
      return profile?.profile;
    },
    load(index: number, gridIndex: number): Promise<SiteForecast> {
      if (!Number.isInteger(index) || index < 0 || index >= manifest.cellCount || !Number.isSafeInteger(gridIndex) || gridIndex < 0) return Promise.reject(new Error('Invalid regional cell'));
      const cached = cache.get(index);
      if (cached) return cached.gridIndex === gridIndex ? Promise.resolve(cached.profile) : Promise.reject(new Error('Regional cell profile differs from its map'));
      const existing = pending.get(index);
      if (existing) return existing.gridIndex === gridIndex ? existing.promise : Promise.reject(new Error('Regional cell profile differs from its map'));
      const task = Promise.resolve().then(() => read(`${root}/${filename.replace('{index}', String(index))}`)).then(raw => {
        const profile = parsePublishedProfileJson(JSON.stringify(raw));
        const source = raw && typeof raw === 'object' && 'source' in raw ? raw.source : null;
        const sourceGridIndex = source && typeof source === 'object' && 'gridIndex' in source ? source.gridIndex : null;
        if (!profile || profile.model !== model || profile.run.referenceTime !== manifest.case.referenceTime
          || sourceGridIndex !== gridIndex || profile.hours.length !== manifest.hours.length
          || profile.hours.some((hour, i) => hour.validAt !== manifest.hours[i].validAt)) {
          throw new Error('Regional cell profile differs from its map');
        }
        while (cache.size >= capacity) cache.delete(cache.keys().next().value!);
        cache.set(index, { gridIndex, profile });
        return profile;
      }).finally(() => { pending.delete(index); });
      pending.set(index, { gridIndex, promise: task });
      return task;
    },
  };
}
