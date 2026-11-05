/** Verified AV JSON snapshots; reopening uses stored responses and never reaches the network. */
import { z } from 'zod';
import {
  createAvClient,
  createRecordingAvClient,
  avSha256,
  MAX_BODY_BYTES,
  type AvClient,
  type AvClientOptions,
  type AvBuild,
} from './av-client.ts';
import { pointSchema, avModels, type AvModel, type AvPoint, type AvSample } from './av-wire.ts';
import type { SnapshotObjectStore } from './offline-types.ts';
import { createAvResumeJournal, AV_RESUME_KEY, AV_SNAPSHOT_MAX_BYTES as MAX_BYTES, AV_SNAPSHOT_MAX_FILES as MAX_FILES } from './av-offline-resume.ts';

const MAX_INVENTORY_BYTES = 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  identity = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const siteSchema = pointSchema.extend({
  slug: identity,
  name: z.string().min(1).max(256),
  timeZone: z.string().min(1).max(128),
});
const routeSchema = z.object({
  title: z.string().min(1).max(256),
  totalDistanceKm: z.number().finite().nonnegative(),
  nodes: z
    .array(
      z.object({
        point: pointSchema,
        distanceKm: z.number().finite().nonnegative(),
        waypointLabel: z.string().max(256).nullable(),
        launchElevationM: z.number().finite().nullable(),
      }),
    )
    .min(2)
    .max(64),
});
const inventorySchema = z.object({
  version: z.literal(1),
  id: hash,
  savedAt: z.iso.datetime(),
  model: z.enum(avModels),
  apiBaseUrl: z.string(),
  buildId: z.string(),
  cycle: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  points: z.array(pointSchema).min(1).max(64),
  frames: z.array(z.string()).min(1).max(256),
  layers: z.array(z.string()).min(1).max(64),
  site: siteSchema.optional(),
  pointTime:z.iso.datetime().optional(),
  route: routeSchema.optional(),
  files: z
    .array(
      z.object({
        url: z.string(),
        sha256: hash,
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_BODY_BYTES),
      }),
    )
    .min(1)
    .max(MAX_FILES),
  totalBytes: z.number().int().nonnegative().max(MAX_BYTES),
});
export type AvSnapshotInventory = z.infer<typeof inventorySchema>;
export interface AvSnapshotSelection {
  model: AvModel;
  build?: AvBuild;
  points: readonly AvPoint[];
  frames: readonly string[];
  layers: readonly string[];
  site?: z.infer<typeof siteSchema>;
  pointTime?:string;
  route?: z.infer<typeof routeSchema>;
}
export interface AvSavedSnapshot {
  inventory: AvSnapshotInventory;
  client: AvClient;
}
export interface AvSnapshotRepository {
  save(slot: string, selection: AvSnapshotSelection): Promise<AvSavedSnapshot>;
  open(slot: string): Promise<AvSavedSnapshot | null>;
  remove(slot: string): Promise<void>;
  prune(): Promise<void>;
}
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const slotKey = (slot: string) => `av/slots/${identity.parse(slot)}.json`;
const blobKey = (digest: string) => `av/objects/${digest}`;
const inventoryPayload = ({ id: _id, ...inventory }: AvSnapshotInventory) => encode(inventory);

function assertScope(value:{points:readonly AvPoint[];site?:AvSnapshotSelection['site'];route?:AvSnapshotSelection['route']}){
  const selected=(point:AvPoint)=>value.points.some(saved=>saved.lat===point.lat&&saved.lon===point.lon);
  if(value.site&&!selected(value.site)||value.route?.nodes.some(node=>!selected(node.point)))throw new Error('AV snapshot context lies outside selected points');
}
function cancellable<T>(task:Promise<T>,signal?:AbortSignal):Promise<T>{
  if(!signal)return task;
  return new Promise((resolve,reject)=>{signal.throwIfAborted();const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});task.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}

export function createAvSnapshotRepository(
  store: SnapshotObjectStore,
  options: AvClientOptions,
): AvSnapshotRepository {
  const lock = <T>(run: () => Promise<T>) => (store.withLock ? store.withLock(run, options.signal) : run());
  async function inventory(slot: string): Promise<AvSnapshotInventory | null> {
    const bytes = await store.get(slotKey(slot));
    if (!bytes) return null;
    if (bytes.length > MAX_INVENTORY_BYTES) throw new Error('AV snapshot inventory exceeds byte budget');
    const result = inventorySchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (
      (await avSha256(inventoryPayload(result))) !== result.id ||
      result.totalBytes !== result.files.reduce((sum, file) => sum + file.bytes, 0) ||
      new Set(result.files.map((file) => file.url)).size !== result.files.length
    )
      throw new Error('AV snapshot inventory is corrupt');
    assertScope(result);
    return result;
  }
  function saved(result: AvSnapshotInventory): AvSavedSnapshot {
    const byUrl = new Map(result.files.map((file) => [file.url, file]));
    const client = createAvClient({
      apiBaseUrl: result.apiBaseUrl,
      offline: true,
      signal: options.signal,
      fetch: async (request) => {
        const file = byUrl.get(String(request));
        if (!file) return new Response('', { status: 404 });
        const bytes = await store.get(blobKey(file.sha256));
        if (!bytes || bytes.length !== file.bytes || (await avSha256(bytes)) !== file.sha256)
          throw new Error('AV snapshot file is missing or corrupt');
        return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { etag: `"${file.sha256}"` } });
      },
    });
    let sampleCache: Promise<AvSample[]> | undefined;
    const selected = <T>(requested: readonly T[], available: readonly T[]) =>
      requested.length > 0 &&
      new Set(requested).size === requested.length &&
      requested.every((value) => available.includes(value));
    const samePoint = (a: AvPoint, b: AvPoint) => a.lat === b.lat && a.lon === b.lon;
    const assertBuild = (build: AvBuild) => {
      options.signal?.throwIfAborted();
      const m = build.manifest;
      if (m.model !== result.model || m.buildId !== result.buildId || m.cycle !== result.cycle || m.expiresAt !== result.expiresAt)
        throw new Error('AV saved build differs from snapshot');
    };
    const projected: AvClient = {
      async pin(model) {
        if (model !== result.model) throw new Error('AV saved build differs from snapshot');
        return client.pin(model);
      },
      async profile(build, point, frames, signal) {
        assertBuild(build);
        if (!result.points.some((saved) => samePoint(saved, point)))
          throw new Error('AV saved profile unavailable outside selected points');
        if (
          frames &&
          !selected(
            frames,
            build.manifest.frames.map((frame) => frame.id),
          )
        )
          throw new Error('AV saved profile frame unavailable');
        const profile = await client.profile(build, point, undefined, signal);
        return frames
          ? { ...profile, frames: profile.frames.filter((frame) => frames.includes(frame.id)) }
          : profile;
      },
      async samples(build, points, frames, layers, signal) {
        assertBuild(build);
        if (
          !points.length ||
          points.length > 64 ||
          !selected(frames, result.frames) ||
          !selected(layers, result.layers)
        )
          throw new Error('AV saved sample selection unavailable');
        const indices = points.map((point) => result.points.findIndex((saved) => samePoint(saved, point)));
        if (indices.some((index) => index < 0)) throw new Error('AV saved sample point unavailable');
        signal?.throwIfAborted();
        sampleCache ??= client.samples(build, result.points, result.frames, result.layers).catch((error) => {
          sampleCache = undefined;
          throw error;
        });
        const samples = await cancellable(sampleCache,signal);
        signal?.throwIfAborted();
        return indices.map((index) => ({
          ...samples[index],
          frames: samples[index].frames
            .filter((frame) => frames.includes(frame.id))
            .map((frame) => ({
              ...frame,
              layers: Object.fromEntries(layers.map((layer) => [layer, frame.layers[layer]])),
            })),
        }));
      },
    };
    return { inventory: result, client: projected };
  }
  return {
    save(slot, selection) {
      return lock(async () => {
        slotKey(slot);
        options.signal?.throwIfAborted();
        if (
          !selection.points.length ||
          selection.points.length > 64 ||
          new Set(selection.points.map((point) => JSON.stringify([point.lat, point.lon]))).size !== selection.points.length
        )
          throw new Error('Invalid AV snapshot points');
        if ((await store.list('av/slots/')).length >= 64 && !(await store.get(slotKey(slot))))
          throw new Error('AV snapshot slot budget exceeded');
        const resume = createAvResumeJournal(store, options.now ?? Date.now);
        try {
          const files = new Map<string, { url: string; sha256: string; bytes: number }>();
          let totalBytes = 0;
          if (selection.build && selection.build.manifest.model !== selection.model)
            throw new Error('AV snapshot build model differs');
          const fetchImpl = options.fetch ?? fetch;
          const pinned = selection.build;
          const read: typeof fetch = async (url, init) => {
            const requested = String(url);
            if (pinned && requested === `${options.apiBaseUrl.replace(/\/+$/, '')}/v1/models/${selection.model}/latest?expand=manifest`) {
              return Response.json({ manifest: pinned.manifest, templates: pinned.templates, pointer: {
                model: selection.model, latestBuildId: pinned.manifest.buildId,
                retained: [{ buildId: pinned.manifest.buildId, cycle: pinned.manifest.cycle, expiresAt: pinned.manifest.expiresAt,
                  manifestKey: `builds/${selection.model}/${pinned.manifest.buildId}/manifest.json` }]
              } });
            }
            return await resume.response(requested, init?.signal ?? undefined) ?? fetchImpl(url, init);
          };
          let build: AvBuild | undefined;
          const client = createRecordingAvClient({ ...options, offline: false, fetch: read }, async (url, bytes) => {
            if (files.has(url)) return;
            totalBytes += bytes.length;
            if (totalBytes > MAX_BYTES || files.size >= MAX_FILES)
              throw new Error('AV snapshot exceeds byte budget');
            const sha256 = await avSha256(bytes);
            await store.put(blobKey(sha256), bytes);
            files.set(url, { url, sha256, bytes: bytes.length });
            if (build) await resume.remember({ url, sha256, bytes: bytes.length, expiresAt: build.manifest.expiresAt });
          });
          build = await client.pin(selection.model);
          assertScope(selection);
          if(selection.pointTime&&!build.manifest.frames.some(frame=>frame.validTime===selection.pointTime))throw new Error('AV saved point time unavailable');
          for (const point of selection.points) await client.profile(build, point);
          await client.samples(build, selection.points, selection.frames, selection.layers);
          const base = {
            version: 1 as const,
            savedAt: new Date().toISOString(),
            apiBaseUrl: options.apiBaseUrl.replace(/\/+$/, '') || '/',
            model: selection.model,
            buildId: build.manifest.buildId,
            cycle: build.manifest.cycle,
            expiresAt: build.manifest.expiresAt,
            points: [...selection.points],
            frames: [...selection.frames],
            layers: [...selection.layers],
            ...(selection.site ? { site: selection.site } : {}),
            ...(selection.pointTime ? {pointTime:selection.pointTime}:{}),
            ...(selection.route ? { route: selection.route } : {}),
            files: [...files.values()],
            totalBytes,
          };
          const payload = inventorySchema.omit({ id: true }).parse(base);
          const result = inventorySchema.parse({ ...payload, id: await avSha256(encode(payload)) });
          const metadata = encode(result);
          if (metadata.length > MAX_INVENTORY_BYTES) throw new Error('AV snapshot inventory exceeds byte budget');
          await resume.flush();
          options.signal?.throwIfAborted();
          await store.put(slotKey(slot), metadata);
          return saved(result);
        } finally { await resume.flush(); }
      });
    },
    async open(slot) {
      const result = await inventory(slot);
      if (!result) return null;
      for (const file of result.files) {
        const bytes = await store.get(blobKey(file.sha256));
        if (!bytes || bytes.length !== file.bytes || (await avSha256(bytes)) !== file.sha256)
          throw new Error('AV snapshot file is missing or corrupt');
      }
      const snapshot = saved(result),
        build = await snapshot.client.pin(result.model);
      if (
        build.manifest.buildId !== result.buildId ||
        build.manifest.cycle !== result.cycle ||
        build.manifest.expiresAt !== result.expiresAt || (result.pointTime!==undefined&&!build.manifest.frames.some(frame=>frame.validTime===result.pointTime))
      )
        throw new Error('AV snapshot build identity differs');
      return snapshot;
    },
    remove(slot) {
      return lock(() => store.remove(slotKey(slot)));
    },
    prune() {
      return lock(async () => {
        await store.remove(AV_RESUME_KEY);
        const retained = new Set<string>();
        for (const key of await store.list('av/slots/')) {
          const result = await inventory(key.slice('av/slots/'.length, -5));
          for (const file of result?.files ?? []) retained.add(blobKey(file.sha256));
        }
        for (const key of await store.list('av/objects/')) if (!retained.has(key)) await store.remove(key);
      });
    },
  };
}
