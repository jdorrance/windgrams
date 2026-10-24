import { fetchWithRetry } from './http.ts';
import { parsePublishedProfileJson } from './published-lift.ts';
import type { SiteForecast } from '@azohra/meteo.briefing/contract';
import { replayModel, type ReplayManifest } from './soaring.ts';

/** Static hosts can serve .gz as a file or transparently decode Content-Encoding. */
export async function decodeRegionalJson<T>(response: Response): Promise<T> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text()) as T;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export async function readRegionalJson<T>(url: string): Promise<T> {
  const response = await fetchWithRetry(url);
  if (!response.ok) throw new Error(`Forecast data unavailable (${response.status}).`);
  return url.endsWith('.gz') ? decodeRegionalJson<T>(response) : response.json();
}

/** Keep only visited profiles; native regional columns never load as one cube. */
export function createReplayProfileCache(
  root: string,
  manifest: ReplayManifest,
  read: (url: string) => Promise<unknown> = readRegionalJson,
  capacity = 8,
) {
  const cache = new Map<number, SiteForecast>();
  const pending = new Map<number, Promise<SiteForecast>>();
  const filename = manifest.cellProfiles;
  if (filename !== 'cell-{index}.json.gz') throw new Error('Unsupported regional cell profile path');
  return {
    cached(index: number) {
      const profile = cache.get(index);
      if (profile) { cache.delete(index); cache.set(index, profile); }
      return profile;
    },
    load(index: number, gridIndex: number): Promise<SiteForecast> {
      if (!Number.isInteger(index) || index < 0 || index >= manifest.cellCount) return Promise.reject(new Error('Invalid regional cell'));
      const cached = cache.get(index);
      if (cached) return Promise.resolve(cached);
      const existing = pending.get(index);
      if (existing) return existing;
      const task = read(`${root}/${filename.replace('{index}', String(index))}`).then(raw => {
        const profile = parsePublishedProfileJson(JSON.stringify(raw));
        const source = (raw as { source?: { gridIndex?: number } })?.source;
        if (!profile || profile.model !== replayModel(manifest) || profile.run.referenceTime !== manifest.case.referenceTime
          || source?.gridIndex !== gridIndex || profile.hours.length !== manifest.hours.length
          || profile.hours.some((hour, i) => hour.validAt !== manifest.hours[i].validAt)) {
          throw new Error('Regional cell profile differs from its map');
        }
        while (cache.size >= Math.max(1, capacity)) cache.delete(cache.keys().next().value!);
        cache.set(index, profile);
        return profile;
      }).finally(() => { pending.delete(index); });
      pending.set(index, task);
      return task;
    },
  };
}
