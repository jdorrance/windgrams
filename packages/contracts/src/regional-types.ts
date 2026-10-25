import { z } from 'zod';
import { forecastSemanticsSchema } from '@azohra/meteo.briefing/contract';
import { bbox, checked, finite, index, latitude, longitude, relativeFile, text, timestamp, timezone } from './schema.js';

const slug = text.regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const cells = z.array(finite.nullable());
const qualitySchema = z.enum(['valid', 'missing', 'insufficient-levels']);
const levelArraysSchema = z.object({ h: cells, t: cells, td: cells, ws: cells, wd: cells, vv: cells });
export type Quality = z.infer<typeof qualitySchema>;
export type LevelArrays = z.infer<typeof levelArraysSchema>;

const hourSchema = z.object({
  forecastHour: index, validAt: timestamp, soaringContractVersion: text.optional(),
  thermalVelocityMps: cells, usableLiftTopM: cells, boundaryLayerTopM: cells, cloudBaseM: cells, pblHeightM: cells,
  resolvedThermalTopM: cells.optional(), thermalTopPlus1CM: cells.optional(), thermalVelocityV2Mps: cells.optional(),
  usableLiftTopV2M: cells.optional(), hcritWxtoflyM: cells.optional(), dryHcritM: cells.optional(),
  surfaceLclM: cells.optional(), effectiveCloudLimitM: cells.optional(), mixedLayerLclM: cells.optional(),
  cuPotentialM: cells.optional(), odPotentialM: cells.optional(), blMeanWindSpeedMps: cells.optional(),
  blMeanWindDirDeg: cells.optional(), blTopWindSpeedMps: cells.optional(), blTopWindDirDeg: cells.optional(),
  blWindShearMps: cells.optional(), buoyancyShearRatio: cells.optional(), wind10mSpeedMps: cells.optional(),
  wind10mDirDeg: cells.optional(), wind80mSpeedMps: cells.optional(), wind80mDirDeg: cells.optional(),
  windGustMps: cells.optional(), wind925SpeedMps: cells.optional(), wind925DirDeg: cells.optional(),
  wind850SpeedMps: cells.optional(), wind850DirDeg: cells.optional(), maxUpwardVelocityMps: cells.optional(),
  minDownwardVelocityMps: cells.optional(), w925Mps: cells.optional(), w850Mps: cells.optional(),
  convergence10mX1e5: cells.optional(), convergence925X1e5: cells.optional(), sensibleHeatFluxWm2: cells.optional(),
  latentHeatFluxWm2: cells.optional(), cloudCoverPercent: cells.optional(), lowCloudPercent: cells.optional(),
  midCloudPercent: cells.optional(), highCloudPercent: cells.optional(), precipitationMmHr: cells.optional(),
  capeJkg: cells.optional(), cinJkg: cells.optional(), sfcT: cells.optional(),
  sfcTd: cells.optional(), mslp: cells.optional(),
  levelsByPressure: z.record(z.string(), levelArraysSchema).optional(),
  levelsByModel: z.record(z.string(), levelArraysSchema.extend({ p: cells })).optional(),
  status: z.array(qualitySchema), levelCount: z.array(index), ceilingReached: z.array(z.boolean()),
}).refine(value => {
  const count = value.status.length;
  // Dimensions follow every declared array, including newly added fields.
  return Object.values(value).every(field => !Array.isArray(field) || field.length === count)
    && [value.levelsByPressure, value.levelsByModel].every(levels => !levels
      || Object.values(levels).every(level => Object.values(level).every(field => field.length === count)));
}, 'Cell arrays must share the map indexing');
export type ReplayHour = z.infer<typeof hourSchema>;

const manifestSchema = z.object({
  schemaVersion: z.literal(1), model: text.optional(), semantics: forecastSemanticsSchema.optional(),
  soaringContractVersion: text.optional(), capturedAt: timestamp, cellCount: index.positive(),
  files: z.record(relativeFile, text).optional(), cellProfiles: z.literal('cell-{index}.json.gz').optional(),
  /** Exact stored bytes, before HTTP content decoding; keys match files. */
  fileBytes: z.record(relativeFile, index).optional(),
  siteCell: index,
  case: z.object({
    id: text, model: text.optional(), referenceTime: timestamp, bbox, sinkMps: finite,
    pressureLevels: z.array(finite).optional(),
    site: z.object({ slug: text.optional(), name: text, latitude, longitude, timeZone: timezone }),
    launchElevation: z.object({ elevationM: finite }),
  }),
  versions: z.object({ algorithm: text }),
  hours: z.array(z.object({ forecastHour: index, validAt: timestamp, file: relativeFile })),
}).refine(value => value.siteCell < value.cellCount, 'Site cell is outside the grid')
  .refine(value => !value.model || !value.case.model || value.model === value.case.model, 'Conflicting model identities');
export type ReplayManifest = z.infer<typeof manifestSchema>;

const regionSchema = z.object({
  id: slug, name: text, status: text, caseId: slug, expandedCaseId: slug.optional(),
  nativeModels: z.array(z.object({ model: slug, caseId: slug, expandedCaseId: slug.optional() })).optional(),
  timeZone: timezone, morningBriefingLocalHour: finite, bbox, primarySite: slug,
  matchedRaobStation: text.optional(), launches: z.array(text), deterministicModels: z.array(text),
  ensembleModels: z.array(text), sparseAdapters: z.array(text),
});
const catalogueSchema = z.object({
  schemaVersion: z.literal(1), soaringContractVersion: text, generatedAt: timestamp,
  trialRegionId: text, regions: z.array(regionSchema),
});
/** Build input only; runtime validators also enforce cross-field invariants. */
export function regionalWireSchemas(): Record<string, unknown> {
  return Object.fromEntries(Object.entries({ manifest: manifestSchema, hour: hourSchema, catalogue: catalogueSchema })
    .map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]));
}
export type RegionDescriptor = z.infer<typeof regionSchema>;
export type RegionCatalogue = z.infer<typeof catalogueSchema>;

/** Read the model declared by the manifest or its case; return 'unknown' if both omit it. */
export function replayModel(manifest: ReplayManifest): string {
  return manifest.model ?? manifest.case.model ?? 'unknown';
}

/** Return a validated regional catalogue, or null for a malformed document. */
export function validateRegionCatalogue(raw: unknown): RegionCatalogue | null {
  return checked(catalogueSchema, raw);
}

/** Validate manifest metadata and bundle-relative hourly filenames; return null on failure. */
export function validateReplayManifest(raw: unknown): ReplayManifest | null {
  return checked(manifestSchema, raw);
}

/** Return the original hourly arrays, including nulls, or null if validation or the expected cell count fails. */
export function validateReplayHour(raw: unknown, expectedCellCount?: number): ReplayHour | null {
  const hour = checked(hourSchema, raw);
  return hour && (expectedCellCount === undefined || hour.status.length === expectedCellCount) ? hour : null;
}
