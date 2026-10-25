import { z } from 'zod';
import { checked, finite, index, latitude, longitude, text, timestamp, timezone } from './schema.js';

const nullableNumber = finite.nullable();
const optionalNumber = nullableNumber.optional();
const cellSchema = z.object({
  cellIndex: index, id: z.string(), gridIndex: index, latitude, longitude, modelElevationM: nullableNumber,
});
const gridSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.object({
    type: z.literal('Feature'), id: z.string(), properties: cellSchema,
    geometry: z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(z.array(finite).min(2)).min(4)).min(1) }),
  })).min(1),
}).refine(value => value.features.every((feature, position) => feature.properties.cellIndex === position), 'Grid cells must follow array order');
export type Cell = z.infer<typeof cellSchema>;
export type Grid = z.infer<typeof gridSchema>;

const auditSchema = z.object({
  sampledCell: z.object({ distanceKm: finite }),
  terrain: z.object({
    modelElevationM: finite, launch: z.object({ elevationM: finite }),
    differenceM: finite.optional(), rawMslHeightsPreserved: z.boolean().optional(),
  }),
  mapProfileAgreement: z.object({ exact: z.boolean(), hours: index, valuesChecked: index }),
  publishedProfileComparison: z.object({ applicable: z.boolean().optional(), exact: z.boolean().nullable(), differences: z.array(z.unknown()) }).optional(),
  limitations: z.array(z.string()),
});
export type Audit = z.infer<typeof auditSchema>;

const terrainSchema = z.object({
  experimental: z.boolean(), launchElevationM: finite, modelElevationM: finite, terrainDeltaM: finite,
  bracketsLaunchAltitude: z.boolean(), launchWindSpeedMps: nullableNumber, launchWindDirectionDeg: nullableNumber,
  rawMslHeightsPreserved: z.boolean(), assumptions: z.array(z.string()),
});
const spreadSchema = z.object({ p10: nullableNumber, p90: nullableNumber });
export type ExperimentalTerrain = z.infer<typeof terrainSchema>;
export type PercentileSpread = z.infer<typeof spreadSchema>;

const launchHourSchema = z.object({
  validAt: timestamp,
  tempC: optionalNumber, dewPointC: optionalNumber, windSpeedMps: optionalNumber,
  windDirectionDeg: optionalNumber, windGustMps: optionalNumber, cloudCoverPct: optionalNumber,
  pblHeightM: optionalNumber, sensibleHeatWm2: optionalNumber, wstarMps: optionalNumber,
  usableLiftTopM: optionalNumber, wstarV2Mps: optionalNumber, usableLiftTopV2M: optionalNumber,
  hcritWxtoflyM: optionalNumber, resolvedThermalTopM: optionalNumber, surfaceLclM: optionalNumber,
  effectiveCloudLimitM: optionalNumber, mixedLayerLclM: optionalNumber, blTopM: optionalNumber,
  cloudBaseM: optionalNumber,
  tempSpreadC: spreadSchema.nullish(), windSpeedSpreadMps: spreadSchema.nullish(), wstarLegacySpreadMps: spreadSchema.nullish(),
  usableLiftLegacySpreadM: spreadSchema.nullish(), wstarSpreadMps: spreadSchema.nullish(), usableLiftSpreadM: spreadSchema.nullish(),
  thermalTopSpreadM: spreadSchema.nullish(), cloudLimitSpreadM: spreadSchema.nullish(), blTopLegacySpreadM: spreadSchema.nullish(),
  experimentalTerrain: terrainSchema.nullish(),
});
const seriesSchema = z.object({ referenceTime: timestamp.nullish(), modelElevationM: optionalNumber, hours: z.array(launchHourSchema) });
const launchSchema = z.object({
  slug: text, name: text, latitude, longitude, timeZone: timezone,
  cellIndex: index, gridIndex: index, distanceKm: finite,
  launchElevationM: nullableNumber, modelElevationM: nullableNumber,
  facingDeg: optionalNumber, windArcHalfWidthDeg: optionalNumber,
  windMinMph: optionalNumber, windMaxMph: optionalNumber, gustMaxMph: optionalNumber,
  models: z.record(z.string(), seriesSchema),
});
const stationSchema = z.object({ id: text, name: text, distanceKm: finite, elevationM: finite });
const launchesSchema = z.object({
  caseId: text.optional(), model: text.optional(), launches: z.array(launchSchema),
  raob: z.object({ station: stationSchema, soundings: z.array(z.object({ validAt: timestamp })) }).nullish(),
  nwsOffice: z.object({ office: text, products: z.object({ afd: z.object({ issuanceTime: timestamp, text: z.string() }).nullish() }) }).nullish(),
});
export type LaunchModelHour = z.infer<typeof launchHourSchema>;
export type LaunchModelSeries = z.infer<typeof seriesSchema>;
export type LaunchEntry = z.infer<typeof launchSchema>;
export type LaunchesDoc = z.infer<typeof launchesSchema>;

const nodeSchema = z.object({
  nodeIndex: index, distanceKm: finite.nonnegative(), latitude, longitude,
  cellIndex: index, gridIndex: index, modelElevationM: nullableNumber,
  waypointLabel: z.string().nullable(), launchElevationM: nullableNumber,
});
const crossSectionSchema = z.object({
  caseId: text.optional(), model: text.optional(), title: z.string(), totalDistanceKm: finite.nonnegative(),
  nodes: z.array(nodeSchema).min(2),
});
export type TransectNode = z.infer<typeof nodeSchema>;
export type CrossSectionDoc = z.infer<typeof crossSectionSchema>;

const matchedPairSchema = z.object({
  model: text, siteSlug: text, siteName: text, regime: text, region: text, station: stationSchema,
  modelElevationM: nullableNumber, elevationDeltaM: nullableNumber,
  soundingValidAt: timestamp, forecastValidAt: timestamp, leadTimeBucket: text,
  metrics: z.object({ levelsCompared: index, temperatureMaeC: nullableNumber,
    temperatureBiasC: nullableNumber, dewPointMaeC: nullableNumber, windVectorRmseMps: nullableNumber }),
});
const rejectedSchema = z.object({
  id: text, stationId: text, siteSlug: text, matchStatus: text, distanceKm: finite, timeDeltaMinutes: finite, reason: text,
});
export type MatchedRaobPair = z.infer<typeof matchedPairSchema>;
export type RejectedComparison = z.infer<typeof rejectedSchema>;

const verificationSchema = z.object({
  evaluatedAt: timestamp.optional(),
  hrrrWrfprsInventory: z.object({
    totalGribRecordsPerHour: index, availablePressureLevelsCount: index,
    availableSub925PressureLevelsHpa: z.array(finite), explicitCloudAndStabilityFields: z.array(z.string()),
  }).optional(),
  lifecycleAudit: z.array(z.object({
    slug: text, catalogueSunset: text, officialTransition: text, successor: text, status: text,
  })).optional(),
  observationVerificationSkill: z.object({
    note: z.string(), matchedCount: index, matchedPairs: z.array(matchedPairSchema),
    rejectedMismatchedComparisons: z.array(rejectedSchema).optional(),
  }).optional(),
  kuilRaobComparison: z.object({
    station: stationSchema, soundingValidAt: timestamp,
    levelComparisons: z.array(z.object({
      pressureHpa: finite, kuilObsTempC: finite, kuilObsDewPointC: finite,
      kuilObsWindSpeedMps: nullableNumber, kuilObsWindDirDeg: nullableNumber,
      hrrrBlynF14TempC: finite, hrrrBlynF14DewPointC: finite,
      hrrrBlynF14WindSpeedMps: finite, hrrrBlynF14WindDirDeg: finite, tempDeltaC: finite,
    })),
  }).optional(),
  wrfPilotDomain: z.object({
    modelSlug: text, label: text, wrfRelease: text,
    domains: z.array(z.object({ id: text, dxM: finite.positive(), eWe: index, eSn: index, eVert: index })),
    physics: z.object({ blPblPhysics: text, mpPhysics: text }),
  }).optional(),
});
export type VerificationDoc = z.infer<typeof verificationSchema>;

/** Validate grid geometry and cell indexes; throw if the grid or expected cell count is invalid. */
export function validateReplayGrid(raw: unknown, expectedCellCount?: number): Grid {
  const grid = checked(gridSchema, raw);
  if (!grid) throw new Error('Invalid regional grid GeoJSON');
  if (expectedCellCount !== undefined && grid.features.length !== expectedCellCount) {
    throw new Error(`Regional grid feature count (${grid.features.length}) does not match manifest (${expectedCellCount})`);
  }
  return grid;
}

/** Validate a regional audit document, throwing when required fields are missing or malformed. */
export function validateReplayAudit(raw: unknown): Audit {
  const audit = checked(auditSchema, raw);
  if (!audit) throw new Error('Invalid regional audit document');
  return audit;
}

/** Optional sidecars return null when absent or malformed. */
export function validateLaunchesDoc(raw: unknown): LaunchesDoc | null { return checked(launchesSchema, raw); }
export function validateCrossSectionDoc(raw: unknown): CrossSectionDoc | null { return checked(crossSectionSchema, raw); }
export function validateVerificationDoc(raw: unknown): VerificationDoc | null { return checked(verificationSchema, raw); }

export { replayModel, validateRegionCatalogue, validateReplayManifest, validateReplayHour } from './regional-types.js';
export type { Quality, LevelArrays, ReplayHour, ReplayManifest, RegionDescriptor, RegionCatalogue } from './regional-types.js';
