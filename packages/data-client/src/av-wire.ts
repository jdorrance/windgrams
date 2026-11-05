/** Consumed AV wire fields; the server owns storage geometry and unused metadata. */
import { z } from 'zod';

export const avModels = ['gfs', 'icon-eu', 'rrfs'] as const;
export type AvModel = (typeof avModels)[number];
export const avModel = (model: string): model is AvModel => (avModels as readonly string[]).includes(model);
const time = z.iso.datetime(),
  number = z.number().finite(),
  nullable = number.nullable();
const id = z.string().min(1).max(128),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const pointSchema = z.object({ lat: number.min(-90).max(90), lon: number.min(-180).max(180) });
const method = z.object({ id: z.string().min(1), hash });
const source = z.object({ provider: z.string(), provenanceKey: z.string(), provenanceSha256: hash });
const frame = z.object({ id, validTime: time, intervalStart: time, intervalEnd: time });
const surface = z.object({
  id,
  kind: z.enum(['native', 'fine']),
  layers: z.array(z.string()).min(1),
  coverage: z.object({ maxZoom: number.int().min(0).max(30) }),
  grid: z.object({ width: number.int().positive(), height: number.int().positive() }),
  profiles: z.object({ levelCount: number.int().positive().max(256) }).optional(),
});
export const buildSchema = z
  .object({
    version: z.literal(5),
    model: z.enum(avModels),
    buildId: id,
    cycle: time,
    createdAt: time,
    expiresAt: time,
    method,
    source,
    frames: z.array(frame).min(1).max(256),
    mapFrameCount: number.int().positive().optional(),
    layers: z.array(z.string()).min(1).max(64),
    surfaces: z.array(surface).min(1).max(2),
    descriptors: z.object({
      maxSampleValues: number.int().positive().max(256),
      layers: z.record(
        z.string(),
        z.object({
          units: z.string(),
          verticalReference: z.string(),
          delivery: z.enum(['tiles-and-samples', 'samples-only']).optional(),
        }),
      ),
    }),
  })
  .superRefine((build, ctx) => {
    const frames = new Set(build.frames.map((frame) => frame.id)),
      layers = new Set(build.layers),
      native = build.surfaces.find((surface) => surface.kind === 'native');
    if (
      frames.size !== build.frames.length ||
      layers.size !== build.layers.length ||
      !native ||
      (build.mapFrameCount ?? build.frames.length) > build.frames.length
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid AV build dimensions' });
    for (const frame of build.frames)
      if (
        Date.parse(frame.validTime) !== Date.parse(frame.intervalEnd) ||
        Date.parse(frame.intervalStart) >= Date.parse(frame.intervalEnd)
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid AV frame interval' });
    const owned = build.surfaces.flatMap((surface) => surface.layers);
    if (
      new Set(owned).size !== owned.length ||
      owned.length !== layers.size ||
      owned.some((layer) => !layers.has(layer))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid AV layer ownership' });
    for (const layer of build.layers)
      if (!build.descriptors.layers[layer])
        ctx.addIssue({ code: 'custom', message: 'Missing AV layer descriptor' });
  });
export const latestSchema = z.object({
  pointer: z.object({
    model: z.enum(avModels),
    latestBuildId: id,
    retained: z.array(z.object({ buildId: id, cycle: time, expiresAt: time, manifestKey: z.string() })).max(256),
  }),
  manifest: buildSchema,
  templates: z.record(z.string(), z.string()),
});
export const sampleCellSchema = z
  .object({
    value: nullable,
    status: z.enum(['valid', 'no-usable-lift', 'unavailable', 'outside-domain']),
    support: number.int().min(0).max(252),
    interpolated: z.boolean(),
    surfaceId: id,
  })
  .superRefine((cell, ctx) => {
    if (
      (cell.support & ~252) !== 0 ||
      (cell.status === 'valid'
        ? cell.value === null
        : cell.status === 'unavailable' || cell.status === 'outside-domain'
          ? cell.value !== null
          : false) ||
      (cell.status === 'outside-domain' && cell.support !== 0)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid AV sample value/status' });
  });
const sampleFrame = frame.extend({ layers: z.record(z.string(), sampleCellSchema) });
export const sampleSchema = z.object({
  version: z.literal(5),
  model: z.enum(avModels),
  buildId: id,
  lat: pointSchema.shape.lat,
  lon: pointSchema.shape.lon,
  method,
  source,
  expiresAt: time,
  frames: z.array(sampleFrame).min(1).max(256),
});
export const batchSchema = z.object({
  version: z.literal(1),
  model: z.enum(avModels),
  buildId: id,
  expiresAt: time,
  points: z
    .array(z.object({ index: number.int().nonnegative().max(63), sample: sampleSchema }))
    .min(1)
    .max(64),
});
const derivedKeys = [
  'usableLiftTopV2M',
  'hcritWxtoflyM',
  'dryHcritM',
  'cuPotentialM',
  'odPotentialM',
  'wind10mSpeedMps',
  'wind10mDirDeg',
  'blMeanWindSpeedMps',
  'blMeanWindDirDeg',
  'blTopWindSpeedMps',
  'blTopWindDirDeg',
  'blWindShearMps',
  'buoyancyShearRatio',
  'mixedLayerLclM',
  'effectiveCloudLimitM',
] as const;
const derived = z
  .object(
    Object.fromEntries(derivedKeys.map((key) => [key, nullable])) as Record<
      (typeof derivedKeys)[number],
      typeof nullable
    >,
  )
  .extend({
    cumulus: z.boolean().nullable(),
    overdeveloped: z.boolean().nullable(),
    cloudCapped: z.boolean().nullable(),
  });
const level = z.object({
  pressureHpa: number.positive().nullable(),
  heightM: nullable,
  temperatureC: nullable,
  dewPointC: nullable,
  uWindMps: nullable,
  vWindMps: nullable,
  omegaPaS: nullable,
});
export const profileSchema = z.object({
  version: z.literal(1),
  model: z.enum(avModels),
  buildId: id,
  cycle: time,
  createdAt: time,
  expiresAt: time,
  lat: pointSchema.shape.lat,
  lon: pointSchema.shape.lon,
  method,
  source,
  cell: pointSchema.extend({ index: number.int().nonnegative(), surfaceId: id }).nullable(),
  frames: z
    .array(
      sampleFrame.extend({
        derived,
        profile: z.object({
          modelTerrainM: nullable,
          surfacePressureHpa: number.positive().nullable(),
          status: z.enum(['valid', 'unavailable', 'outside-domain']),
          levels: z.array(level).max(256),
        }),
      }),
    )
    .min(1)
    .max(256),
});
export type AvManifest = z.infer<typeof buildSchema>;
export type AvProfile = z.infer<typeof profileSchema>;
export type AvSample = z.infer<typeof sampleSchema>;
export type AvPoint = z.infer<typeof pointSchema>;
