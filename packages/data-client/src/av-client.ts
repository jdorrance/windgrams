/** Build-pinned AV reads with bounded bodies, scalar batches and verified response digests. */
import { z } from 'zod';
import { fetchWithRetry } from './http.ts';
import {
  avModel,
  latestSchema,
  profileSchema,
  batchSchema,
  pointSchema,
  type AvModel,
  type AvManifest,
  type AvProfile,
  type AvSample,
  type AvPoint,
} from './av-wire.ts';

const RETRY_STATUSES = new Set([500, 502, 503, 504]);
class AvHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`AV data unavailable (${status})`);
  }
}
export const MAX_BODY_BYTES = 1024 * 1024;
export interface AvBuild {
  readonly manifest: AvManifest;
  readonly templates: Readonly<Record<string, string>>;
}
export interface AvClientOptions {
  apiBaseUrl: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  offline?: boolean;
}
export interface AvClient {
  pin(model: AvModel): Promise<AvBuild>;
  profile(build: AvBuild, point: AvPoint, frameIds?: readonly string[], signal?: AbortSignal): Promise<AvProfile>;
  samples(
    build: AvBuild,
    points: readonly AvPoint[],
    frameIds: readonly string[],
    layers: readonly string[],
    signal?: AbortSignal,
  ): Promise<AvSample[]>;
}

export async function avSha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function readAvBytes(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error('AV response exceeds byte budget');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY_BYTES || chunks.length > 65536) {
        await reader.cancel();
        throw new Error('AV response exceeds byte budget');
      }
      chunks.push(value);
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (!response.ok) {
    let code: string | undefined;
    try {
      code = JSON.parse(new TextDecoder().decode(bytes)).title;
    } catch {
      /* HTTP status remains available. */
    }
    throw new AvHttpError(response.status, code);
  }
  return bytes;
}

export function createAvClient(options: AvClientOptions): AvClient {
  return avClient(options);
}
export function createRecordingAvClient(
  options: AvClientOptions,
  record: (url: string, bytes: Uint8Array) => Promise<void>,
): AvClient {
  return avClient(options, record);
}
function avClient(options: AvClientOptions, record?: (url: string, bytes: Uint8Array) => Promise<void>): AvClient {
  const base = options.apiBaseUrl.replace(/\/+$/, '');
  if ((!base && options.apiBaseUrl !== '/') || base.startsWith('//') || /[?#\\]/.test(base))
    throw new Error('Invalid AV API base');
  if (base && !base.startsWith('/')) {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid AV API base');
  }
  const records = record ? new WeakMap<object, { url: string; bytes: Uint8Array }>() : null;
  async function remember(payload: object) {
    const entry = records?.get(payload);
    if (entry) {
      records!.delete(payload);
      await record!(entry.url, entry.bytes);
      options.signal?.throwIfAborted();
    }
  }
  const now = options.now ?? Date.now;
  const live = (build: AvBuild) => {
    options.signal?.throwIfAborted();
    if (!options.offline && Date.parse(build.manifest.expiresAt) <= now()) throw new Error('AV build expired');
  };
  async function read<T>(
    path: string,
    schema: z.ZodType<T>,
    digest = true,
    requestSignal?: AbortSignal,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 15000);
    const inherited =
      options.signal && requestSignal
        ? AbortSignal.any([options.signal, requestSignal])
        : (requestSignal ?? options.signal);
    const signal = inherited ? AbortSignal.any([inherited, deadline]) : deadline;
    const response = await fetchWithRetry(
      `${base}${path}`,
      { signal },
      { fetchImpl: options.fetch, timeoutMs: options.timeoutMs, retryStatuses: RETRY_STATUSES },
    );
    const bytes = await readAvBytes(response, signal);
    if (digest) {
      const expected = response.headers.get('etag')?.replace(/^"|"$/g, '');
      if (!expected || !/^[a-f0-9]{64}$/.test(expected) || (await avSha256(bytes)) !== expected)
        throw new Error('AV response digest mismatch');
    }
    const parsed = schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    signal.throwIfAborted();
    if (records && parsed !== null && typeof parsed === 'object')
      records.set(parsed, { url: `${base}${path}`, bytes });
    return parsed;
  }
  const path = (build: AvBuild, endpoint: string, query: URLSearchParams) =>
    `/v1/models/${build.manifest.model}/runs/${encodeURIComponent(build.manifest.buildId)}/${endpoint}?${query}`;
  function validate(
    build: AvBuild,
    payload: AvSample | AvProfile,
    point: AvPoint,
    frameIds: readonly string[],
    layers: readonly string[],
  ) {
    const m = build.manifest;
    if (
      payload.model !== m.model ||
      payload.buildId !== m.buildId ||
      payload.expiresAt !== m.expiresAt ||
      payload.lat !== point.lat ||
      payload.lon !== point.lon ||
      payload.method.id !== m.method.id ||
      payload.method.hash !== m.method.hash ||
      payload.source.provider !== m.source.provider ||
      payload.source.provenanceSha256 !== m.source.provenanceSha256 ||
      payload.source.provenanceKey !== m.source.provenanceKey
    )
      throw new Error('AV response differs from pinned build or point');
    if (
      payload.frames.length !== frameIds.length ||
      new Set(payload.frames.map((frame) => frame.id)).size !== frameIds.length
    )
      throw new Error('AV frame selection differs');
    for (const frame of payload.frames) {
      const expected = m.frames.find((item) => item.id === frame.id);
      if (
        !expected ||
        !frameIds.includes(frame.id) ||
        frame.validTime !== expected.validTime ||
        frame.intervalStart !== expected.intervalStart ||
        frame.intervalEnd !== expected.intervalEnd ||
        Object.keys(frame.layers).length !== layers.length ||
        layers.some((layer) => !Object.hasOwn(frame.layers, layer))
      )
        throw new Error('AV frame or field selection differs');
      for (const layer of layers) {
        const cell = frame.layers[layer],
          owner = m.surfaces.find((surface) => surface.layers.includes(layer));
        if (
          !owner ||
          cell.surfaceId !== owner.id ||
          (cell.support !== 0 &&
            !['usable-lift-msl', 'usable-lift-agl', 'thermal-velocity', 'thermal-top-msl'].includes(layer))
        )
          throw new Error('AV scalar surface or flags differ');
        if (
          cell.status === 'no-usable-lift' &&
          (layer === 'usable-lift-agl' ? cell.value !== 0 : layer !== 'usable-lift-msl' || cell.value !== null)
        )
          throw new Error('Invalid AV no-lift value');
      }
    }
    live(build);
  }
  function selection(
    build: AvBuild,
    points: readonly AvPoint[],
    frames: readonly string[],
    layers: readonly string[],
  ) {
    live(build);
    if (points.length > 64) throw new Error('Select at most 64 AV points');
    points.forEach((point) => pointSchema.parse(point));
    if (
      !points.length ||
      !frames.length ||
      !layers.length ||
      new Set(frames).size !== frames.length ||
      new Set(layers).size !== layers.length ||
      frames.some((id) => !build.manifest.frames.some((frame) => frame.id === id)) ||
      layers.some((layer) => !build.manifest.layers.includes(layer))
    )
      throw new Error('Invalid AV sample selection');
  }
  const client: AvClient = {
    async pin(model) {
      if (!avModel(model)) throw new Error('Unsupported AV model');
      const payload = await read(`/v1/models/${model}/latest?expand=manifest`, latestSchema, false),
        m = payload.manifest;
      const entry = payload.pointer.retained.find((entry) => entry.buildId === m.buildId);
      if (
        m.model !== model ||
        payload.pointer.model !== model ||
        payload.pointer.latestBuildId !== m.buildId ||
        !entry ||
        entry.cycle !== m.cycle ||
        entry.expiresAt !== m.expiresAt ||
        entry.manifestKey !== `builds/${model}/${m.buildId}/manifest.json` ||
        m.source.provenanceKey !== `builds/${model}/${m.buildId}/provenance.json`
      )
        throw new Error('AV latest identity differs');
      const templates = Object.fromEntries(
        m.layers
          .filter((layer) => m.descriptors.layers[layer].delivery !== 'samples-only')
          .map((layer) => {
            const template = payload.templates[layer];
            if (!template || !['{frame}', '{z}', '{x}', '{y}'].every((part) => template.includes(part)))
              throw new Error('Missing AV raster template');
            return [layer, template];
          }),
      );
      const build = { manifest: m, templates };
      live(build);
      await remember(payload);
      live(build);
      return build;
    },
    async profile(build, point, selectedFrameIds, signal) {
      const m = build.manifest,
        native = m.surfaces.find((surface) => surface.kind === 'native');
      if (!native?.profiles) throw new Error('AV build has no atmospheric profiles');
      const frames = selectedFrameIds ? m.frames.filter((frame) => selectedFrameIds.includes(frame.id)) : m.frames;
      if (
        selectedFrameIds &&
        (frames.length !== selectedFrameIds.length || new Set(selectedFrameIds).size !== frames.length)
      )
        throw new Error('Invalid AV profile frame selection');
      selection(
        build,
        [point],
        frames.map((frame) => frame.id),
        native.layers,
      );
      const results: AvProfile[] = [];
      const groupSize = Math.max(
        1,
        Math.min(
          16,
          Math.floor(
            (MAX_BODY_BYTES - 2048) / (native.profiles.levelCount * 180 + native.layers.length * 400 + 2048),
          ),
        ),
      );
      for (let first = 0; first < frames.length; first += groupSize) {
        const ids = frames.slice(first, first + groupSize).map((frame) => frame.id);
        const result = await read(
          path(
            build,
            'profile',
            new URLSearchParams({
              lat: String(point.lat),
              lon: String(point.lon),
              frame: ids.join(','),
              layers: native.layers.join(','),
            }),
          ),
          profileSchema,
          true,
          signal,
        );
        validate(build, result, point, ids, native.layers);
        if (
          result.cycle !== m.cycle ||
          result.createdAt !== m.createdAt ||
          (result.cell &&
            (result.cell.surfaceId !== native.id || result.cell.index >= native.grid.width * native.grid.height))
        )
          throw new Error('AV native profile identity differs');
        for (const frame of result.frames) {
          const p = frame.profile;
          if (
            p.levels.length > native.profiles.levelCount ||
            (p.status === 'valid'
              ? p.modelTerrainM === null || !p.levels.length
              : p.status === 'outside-domain'
                ? p.levels.length > 0
                : p.modelTerrainM !== null && p.levels.length > 0) ||
            (result.cell === null
              ? p.status !== 'outside-domain' || p.modelTerrainM !== null || p.surfacePressureHpa !== null
              : p.status === 'outside-domain')
          )
            throw new Error('AV profile coverage differs');
          let previousHeight: number | null = null,
            previousPressure: number | null = null;
          for (const level of p.levels) {
            if (level.heightM !== null) {
              if (
                (p.modelTerrainM !== null && level.heightM < p.modelTerrainM) ||
                (previousHeight !== null && level.heightM <= previousHeight)
              )
                throw new Error('AV profile coordinates differ');
              previousHeight = level.heightM;
            }
            if (level.pressureHpa !== null) {
              if (previousPressure !== null && level.pressureHpa >= previousPressure)
                throw new Error('AV profile coordinates differ');
              previousPressure = level.pressureHpa;
            }
          }
          if (
            Object.values(frame.layers).some(
              (cell) =>
                cell.interpolated ||
                (result.cell === null ? cell.status !== 'outside-domain' : cell.status === 'outside-domain'),
            )
          )
            throw new Error('AV profile scalar selection differs');
        }
        if (results.length && JSON.stringify(result.cell) !== JSON.stringify(results[0].cell))
          throw new Error('AV profile cell changed across frame groups');
        await remember(result);
        signal?.throwIfAborted();
        results.push(result);
      }
      const byId = new Map(results.flatMap((result) => result.frames).map((frame) => [frame.id, frame]));
      return { ...results[0], frames: frames.map((frame) => byId.get(frame.id)!) };
    },
    async samples(build, points, frames, layers, signal) {
      selection(build, points, frames, layers);
      const limit = Math.max(
        1,
        Math.min(64, Math.floor(build.manifest.descriptors.maxSampleValues / (frames.length * layers.length))),
      );
      if (frames.length * layers.length > build.manifest.descriptors.maxSampleValues)
        throw new Error('Select fewer AV sample frames or fields');
      const results: AvSample[] = [];
      for (let first = 0; first < points.length; first += limit) {
        const group = points.slice(first, first + limit);
        async function load(selected: readonly AvPoint[]): Promise<AvSample[]> {
          try {
            const result = await read(
              path(
                build,
                'samples',
                new URLSearchParams({
                  points: selected.map((point) => `${point.lat},${point.lon}`).join(';'),
                  frame: frames.join(','),
                  layers: layers.join(','),
                }),
              ),
              batchSchema,
              true,
              signal,
            );
            if (
              result.model !== build.manifest.model ||
              result.buildId !== build.manifest.buildId ||
              result.expiresAt !== build.manifest.expiresAt ||
              result.points.length !== selected.length
            )
              throw new Error('AV batch identity differs');
            const samples = result.points.map(({ index, sample }, i) => {
              if (index !== i) throw new Error('AV point order differs');
              validate(build, sample, selected[i], frames, layers);
              return sample;
            });
            await remember(result);
            signal?.throwIfAborted();
            return samples;
          } catch (error) {
            if (
              !(error instanceof AvHttpError) ||
              error.status !== 429 ||
              error.code !== 'sample-limit' ||
              selected.length < 2
            )
              throw error;
            const split = Math.ceil(selected.length / 2);
            return [...(await load(selected.slice(0, split))), ...(await load(selected.slice(split)))];
          }
        }
        results.push(...(await load(group)));
      }
      return results;
    },
  };
  return client;
}
