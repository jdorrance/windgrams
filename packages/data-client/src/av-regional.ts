/** One AV run: raster tiles, scalar point batches and an eight-entry native profile cache. */
import { createAvClient, type AvClientOptions, type AvBuild, type AvClient } from './av-client.ts';
import { avProfileToPublishedSiteForecast, type AvSite } from './av-profile.ts';
import type { PublishedSiteForecast } from '@windgrams/contracts/published-lift';
import type { AvModel, AvPoint, AvProfile, AvSample } from './av-wire.ts';

export interface AvRegionalDataset {
  readonly kind: 'av';
  readonly build: AvBuild;
  readonly mapFrames: AvBuild['manifest']['frames'];
  tileMaxZoom(layer: string): number;
  tileUrl(frame: string, layer: string): string;
  loadProfile(point: AvPoint, frameIds?: readonly string[], signal?: AbortSignal): Promise<AvProfile>;
  loadPublishedProfile(site: AvSite, signal?: AbortSignal): Promise<PublishedSiteForecast>;
  sample(
    points: readonly AvPoint[],
    frameIds: readonly string[],
    layers: readonly string[],
    signal?: AbortSignal,
  ): Promise<AvSample[]>;
}
export async function openAvRegionalDataset(
  options: AvClientOptions & { model: AvModel; client?: AvClient },
): Promise<AvRegionalDataset> {
  const client = options.client ?? createAvClient(options),
    build = await client.pin(options.model);
  const profiles = new Map<string, AvProfile>(),
    pending = new Map<string, Promise<AvProfile>>();
  let requestSerial = 0;
  const loadProfile = (point: AvPoint, frames?: readonly string[], signal?: AbortSignal): Promise<AvProfile> => {
    options.signal?.throwIfAborted();
    signal?.throwIfAborted();
    if (!options.offline && Date.parse(build.manifest.expiresAt) <= (options.now ?? Date.now)())
      return Promise.reject(new Error('AV build expired'));
    const key = JSON.stringify([point.lat, point.lon, frames ?? null]),
      cached = profiles.get(key);
    if (cached) {
      profiles.delete(key);
      profiles.set(key, cached);
      return Promise.resolve(cached);
    }
    const requestKey = signal ? `${key}:${++requestSerial}` : key;
    const inflight = pending.get(requestKey);
    if (inflight) return inflight;
    if (pending.size >= 8) return Promise.reject(new Error('AV profile request budget exceeded'));
    const task = client
      .profile(build, point, frames, signal)
      .then((profile) => {
        profiles.set(key, profile);
        while (profiles.size > 8) profiles.delete(profiles.keys().next().value!);
        return profile;
      })
      .finally(() => pending.delete(requestKey));
    pending.set(requestKey, task);
    return task;
  };
  return {
    kind: 'av',
    build,
    mapFrames: build.manifest.frames.slice(0, build.manifest.mapFrameCount ?? build.manifest.frames.length),
    tileMaxZoom(layer) {
      const owner = build.manifest.surfaces.find((surface) => surface.layers.includes(layer));
      if (!owner) throw new Error('Unknown AV layer');
      return owner.coverage.maxZoom;
    },
    tileUrl(frame, layer) {
      if (
        !build.manifest.frames
          .slice(0, build.manifest.mapFrameCount ?? build.manifest.frames.length)
          .some((item) => item.id === frame) ||
        !build.templates[layer]
      )
        throw new Error('AV raster selection unavailable');
      return build.templates[layer].replace('{frame}', encodeURIComponent(frame));
    },
    loadProfile,
    async loadPublishedProfile(site, signal) {
      return avProfileToPublishedSiteForecast(await loadProfile(site, undefined, signal), site);
    },
    sample: (points, frames, layers, signal) => client.samples(build, points, frames, layers, signal),
  };
}
