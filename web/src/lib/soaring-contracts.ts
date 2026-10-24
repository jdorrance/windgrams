// Owned regional bundle, sidecar, and verification contracts with bounded
// download-boundary validators. Validates required identities and dimensions
// once per load without re-validating during interactive rendering.

export interface Cell {
  cellIndex: number;
  id: string;
  gridIndex: number;
  latitude: number;
  longitude: number;
  modelElevationM: number | null;
}

export interface Grid {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    id: string;
    properties: Cell;
    geometry: { type: 'Polygon'; coordinates: number[][][] };
  }[];
}

export interface Audit {
  sampledCell: { distanceKm: number };
  terrain: {
    modelElevationM: number;
    launch: { elevationM: number };
    differenceM?: number;
    rawMslHeightsPreserved?: boolean;
  };
  mapProfileAgreement: { exact: boolean; hours: number; valuesChecked: number };
  publishedProfileComparison?: { applicable?: boolean; exact: boolean | null; differences: unknown[] };
  limitations: string[];
}

export interface ExperimentalTerrain {
  experimental: boolean;
  launchElevationM: number;
  modelElevationM: number;
  terrainDeltaM: number;
  bracketsLaunchAltitude: boolean;
  launchWindSpeedMps: number | null;
  launchWindDirectionDeg: number | null;
  rawMslHeightsPreserved: boolean;
  assumptions: string[];
}

export interface PercentileSpread {
  p10: number | null;
  p90: number | null;
}

export interface LaunchModelHour {
  validAt: string;
  tempC?: number | null;
  tempSpreadC?: PercentileSpread | null;
  dewPointC?: number | null;
  windSpeedMps?: number | null;
  windSpeedSpreadMps?: PercentileSpread | null;
  windDirectionDeg?: number | null;
  windGustMps?: number | null;
  cloudCoverPct?: number | null;
  pblHeightM?: number | null;
  sensibleHeatWm2?: number | null;
  wstarMps?: number | null;
  wstarLegacySpreadMps?: PercentileSpread | null;
  usableLiftTopM?: number | null;
  usableLiftLegacySpreadM?: PercentileSpread | null;
  wstarV2Mps?: number | null;
  wstarSpreadMps?: PercentileSpread | null;
  usableLiftTopV2M?: number | null;
  usableLiftSpreadM?: PercentileSpread | null;
  hcritWxtoflyM?: number | null;
  resolvedThermalTopM?: number | null;
  thermalTopSpreadM?: PercentileSpread | null;
  surfaceLclM?: number | null;
  effectiveCloudLimitM?: number | null;
  cloudLimitSpreadM?: PercentileSpread | null;
  mixedLayerLclM?: number | null;
  experimentalTerrain?: ExperimentalTerrain | null;
  blTopM?: number | null;
  blTopLegacySpreadM?: PercentileSpread | null;
  cloudBaseM?: number | null;
}

export interface LaunchModelSeries {
  referenceTime?: string | null;
  modelElevationM?: number | null;
  hours: LaunchModelHour[];
}

export interface LaunchEntry {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
  timeZone: string;
  cellIndex: number;
  gridIndex: number;
  distanceKm: number;
  launchElevationM: number | null;
  modelElevationM: number | null;
  facingDeg?: number | null;
  windArcHalfWidthDeg?: number | null;
  windMinMph?: number | null;
  windMaxMph?: number | null;
  gustMaxMph?: number | null;
  models: Record<string, LaunchModelSeries>;
}

export interface LaunchesDoc {
  caseId?: string;
  model?: string;
  launches: LaunchEntry[];
  raob?: {
    station: { id: string; name: string; distanceKm: number; elevationM: number };
    soundings: { validAt: string }[];
  };
  nwsOffice?: {
    office: string;
    products: { afd?: { issuanceTime: string; text: string } | null };
  } | null;
}

export interface TransectNode {
  nodeIndex: number;
  distanceKm: number;
  latitude: number;
  longitude: number;
  cellIndex: number;
  gridIndex: number;
  modelElevationM: number | null;
  waypointLabel: string | null;
  launchElevationM: number | null;
}

export interface CrossSectionDoc {
  caseId?: string;
  model?: string;
  title: string;
  totalDistanceKm: number;
  nodes: TransectNode[];
}

export interface MatchedRaobPair {
  model: string;
  siteSlug: string;
  siteName: string;
  regime: string;
  region: string;
  station: { id: string; name: string; distanceKm: number; elevationM: number };
  modelElevationM: number | null;
  elevationDeltaM: number | null;
  soundingValidAt: string;
  forecastValidAt: string;
  leadTimeBucket: string;
  metrics: {
    levelsCompared: number;
    temperatureMaeC: number | null;
    temperatureBiasC: number | null;
    dewPointMaeC: number | null;
    windVectorRmseMps: number | null;
  };
}

export interface RejectedComparison {
  id: string;
  stationId: string;
  siteSlug: string;
  matchStatus: string;
  distanceKm: number;
  timeDeltaMinutes: number;
  reason: string;
}

export interface VerificationDoc {
  evaluatedAt?: string;
  hrrrWrfprsInventory?: {
    totalGribRecordsPerHour: number;
    availablePressureLevelsCount: number;
    availableSub925PressureLevelsHpa: number[];
    explicitCloudAndStabilityFields: string[];
  };
  lifecycleAudit?: {
    slug: string;
    catalogueSunset: string;
    officialTransition: string;
    successor: string;
    status: string;
  }[];
  observationVerificationSkill?: {
    note: string;
    matchedCount: number;
    matchedPairs: MatchedRaobPair[];
    rejectedMismatchedComparisons?: RejectedComparison[];
  };
  kuilRaobComparison?: {
    station: { id: string; name: string; distanceKm: number; elevationM: number };
    soundingValidAt: string;
    levelComparisons: {
      pressureHpa: number;
      kuilObsTempC: number;
      kuilObsDewPointC: number;
      kuilObsWindSpeedMps: number;
      kuilObsWindDirDeg: number;
      hrrrBlynF14TempC: number;
      hrrrBlynF14DewPointC: number;
      hrrrBlynF14WindSpeedMps: number;
      hrrrBlynF14WindDirDeg: number;
      tempDeltaC: number;
    }[];
  };
  wrfPilotDomain?: {
    modelSlug: string;
    label: string;
    wrfRelease: string;
    domains: { id: string; dxM: number; eWe: number; eSn: number; eVert: number }[];
    physics: { blPblPhysics: string; mpPhysics: string };
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isIndex = (v: unknown): v is number => isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
const isNullableNumber = (v: unknown): boolean => v === null || isFiniteNumber(v);
const isOptionalNumber = (v: unknown): boolean => v === undefined || isNullableNumber(v);
const isOptionalString = (v: unknown): boolean => v == null || typeof v === 'string';
const hasCoordinates = (v: Record<string, unknown>): boolean =>
  isFiniteNumber(v.latitude) && Math.abs(v.latitude) <= 90
  && isFiniteNumber(v.longitude) && Math.abs(v.longitude) <= 180;

// Only fields consumed by the comparison readers are checked; additional
// provider metadata remains available without requiring a new schema version.
const comparisonNumbers: readonly (keyof LaunchModelHour)[] = [
  'tempC', 'dewPointC', 'windSpeedMps', 'windDirectionDeg', 'windGustMps', 'cloudCoverPct',
  'pblHeightM', 'sensibleHeatWm2', 'wstarMps', 'usableLiftTopM', 'wstarV2Mps',
  'usableLiftTopV2M', 'hcritWxtoflyM', 'resolvedThermalTopM', 'surfaceLclM',
  'effectiveCloudLimitM', 'mixedLayerLclM', 'blTopM', 'cloudBaseM',
];
const comparisonSpreads: readonly (keyof LaunchModelHour)[] = [
  'tempSpreadC', 'windSpeedSpreadMps', 'wstarLegacySpreadMps', 'usableLiftLegacySpreadM',
  'blTopLegacySpreadM', 'wstarSpreadMps', 'usableLiftSpreadM', 'thermalTopSpreadM', 'cloudLimitSpreadM',
];

function validComparisonHour(raw: unknown): boolean {
  if (!isRecord(raw) || typeof raw.validAt !== 'string'
    || !comparisonNumbers.every(key => isOptionalNumber(raw[key]))) return false;
  for (const key of comparisonSpreads) {
    const spread = raw[key];
    if (spread != null && (!isRecord(spread) || !isOptionalNumber(spread.p10) || !isOptionalNumber(spread.p90))) return false;
  }
  const terrain = raw.experimentalTerrain;
  if (terrain != null && (!isRecord(terrain) || typeof terrain.bracketsLaunchAltitude !== 'boolean'
    || !isFiniteNumber(terrain.launchElevationM) || !isOptionalNumber(terrain.launchWindSpeedMps)
    || !isOptionalNumber(terrain.launchWindDirectionDeg))) return false;
  return true;
}

/**
 * Validates a regional GeoJSON grid at the download boundary against expected `cellCount`.
 */
export function validateReplayGrid(raw: unknown, expectedCellCount?: number): Grid {
  if (!isRecord(raw) || raw.type !== 'FeatureCollection' || !Array.isArray(raw.features) || raw.features.length === 0) {
    throw new Error('Invalid regional grid GeoJSON');
  }
  if (expectedCellCount !== undefined && raw.features.length !== expectedCellCount) {
    throw new Error(`Regional grid feature count (${raw.features.length}) does not match manifest (${expectedCellCount})`);
  }
  for (const [index, feature] of raw.features.entries()) {
    if (!isRecord(feature) || feature.type !== 'Feature' || !isRecord(feature.properties)) {
      throw new Error(`Invalid regional grid feature ${index}`);
    }
    const cell = feature.properties;
    if (cell.cellIndex !== index || !isIndex(cell.gridIndex) || typeof cell.id !== 'string'
      || !isFiniteNumber(cell.latitude) || !isFiniteNumber(cell.longitude)
      || !isNullableNumber(cell.modelElevationM)) {
      throw new Error(`Invalid regional grid feature properties at ${index}`);
    }
    const geometry = feature.geometry;
    if (!isRecord(geometry) || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)
      || !geometry.coordinates.length || !geometry.coordinates.every(ring => Array.isArray(ring) && ring.length >= 4
        && ring.every(point => Array.isArray(point) && point.length >= 2 && isFiniteNumber(point[0]) && isFiniteNumber(point[1])))) {
      throw new Error(`Invalid regional grid geometry at ${index}`);
    }
  }
  return raw as unknown as Grid;
}

/**
 * Validates `audit.json` at the download boundary.
 */
export function validateReplayAudit(raw: unknown): Audit {
  if (!isRecord(raw) || !isRecord(raw.mapProfileAgreement) || !isRecord(raw.sampledCell) || !isRecord(raw.terrain)) {
    throw new Error('Invalid regional audit document');
  }
  if (!isFiniteNumber(raw.mapProfileAgreement.valuesChecked) || !isFiniteNumber(raw.mapProfileAgreement.hours)) {
    throw new Error('Invalid regional audit agreement metrics');
  }
  if (typeof raw.mapProfileAgreement.exact !== 'boolean' || !isFiniteNumber(raw.sampledCell.distanceKm)
    || !isFiniteNumber(raw.terrain.modelElevationM) || !isRecord(raw.terrain.launch)
    || !isFiniteNumber(raw.terrain.launch.elevationM) || !Array.isArray(raw.limitations)
    || !raw.limitations.every(item => typeof item === 'string')) {
    throw new Error('Invalid regional audit terrain or metadata');
  }
  return raw as unknown as Audit;
}

/**
 * Bounded validator for optional `launches.json` sidecar. Returns `null` if absent or malformed.
 */
export function validateLaunchesDoc(raw: unknown): LaunchesDoc | null {
  if (!isRecord(raw) || !Array.isArray(raw.launches)) return null;
  for (const item of raw.launches) {
    if (!isRecord(item) || typeof item.slug !== 'string' || typeof item.name !== 'string'
      || !isIndex(item.cellIndex) || !hasCoordinates(item) || !isRecord(item.models)
      || !isOptionalNumber(item.launchElevationM) || !isOptionalNumber(item.modelElevationM)) {
      return null;
    }
    for (const model of Object.values(item.models)) {
      if (!isRecord(model) || !Array.isArray(model.hours) || !model.hours.every(validComparisonHour)
        || !isOptionalString(model.referenceTime) || !isOptionalNumber(model.modelElevationM)) return null;
    }
  }
  const office = raw.nwsOffice;
  if (office != null) {
    if (!isRecord(office) || !isOptionalString(office.office)) return null;
    if (office.products != null) {
      if (!isRecord(office.products)) return null;
      const afd = office.products.afd;
      if (afd != null && (!isRecord(afd) || typeof afd.text !== 'string')) return null;
    }
  }
  return raw as unknown as LaunchesDoc;
}

/**
 * Bounded validator for optional `cross-section.json` sidecar. Returns `null` if absent or malformed.
 */
export function validateCrossSectionDoc(raw: unknown): CrossSectionDoc | null {
  if (!isRecord(raw) || !isFiniteNumber(raw.totalDistanceKm) || raw.totalDistanceKm < 0
    || !Array.isArray(raw.nodes) || raw.nodes.length < 2) {
    return null;
  }
  for (const node of raw.nodes) {
    if (!isRecord(node) || !isFiniteNumber(node.distanceKm) || node.distanceKm < 0
      || !isIndex(node.cellIndex) || !hasCoordinates(node)
      || !isOptionalNumber(node.modelElevationM) || !isOptionalNumber(node.launchElevationM)
      || !isOptionalString(node.waypointLabel)) return null;
  }
  return raw as unknown as CrossSectionDoc;
}

/**
 * Bounded validator for optional `verification.json` sidecar. Returns `null` if absent or malformed.
 */
export function validateVerificationDoc(raw: unknown): VerificationDoc | null {
  if (!isRecord(raw)) return null;
  const inventory = raw.hrrrWrfprsInventory;
  if (inventory != null && (!isRecord(inventory) || !isIndex(inventory.availablePressureLevelsCount))) return null;
  const wrf = raw.wrfPilotDomain;
  if (wrf != null && (!isRecord(wrf) || !Array.isArray(wrf.domains)
    || !wrf.domains.every(domain => isRecord(domain) && isFiniteNumber(domain.dxM) && domain.dxM > 0))) return null;
  if (raw.observationVerificationSkill !== undefined) {
    const skill = raw.observationVerificationSkill;
    if (!isRecord(skill) || typeof skill.note !== 'string' || !isIndex(skill.matchedCount) || !Array.isArray(skill.matchedPairs)) return null;
    for (const pair of skill.matchedPairs) {
      if (!isRecord(pair) || !isRecord(pair.station) || !isRecord(pair.metrics)
        || !['model', 'siteSlug', 'siteName', 'regime', 'region', 'soundingValidAt', 'forecastValidAt', 'leadTimeBucket'].every(key => typeof pair[key] === 'string')
        || typeof pair.station.id !== 'string' || typeof pair.station.name !== 'string'
        || !isFiniteNumber(pair.station.distanceKm) || !isFiniteNumber(pair.station.elevationM)
        || !isNullableNumber(pair.modelElevationM) || !isNullableNumber(pair.elevationDeltaM)
        || !isIndex(pair.metrics.levelsCompared)
        || !['temperatureMaeC', 'temperatureBiasC', 'dewPointMaeC', 'windVectorRmseMps'].every(key => isNullableNumber((pair.metrics as Record<string, unknown>)[key]))) return null;
    }
    const rejected = skill.rejectedMismatchedComparisons;
    if (rejected != null && (!Array.isArray(rejected) || !rejected.every(pair => isRecord(pair)
      && typeof pair.stationId === 'string' && isFiniteNumber(pair.distanceKm) && isFiniteNumber(pair.timeDeltaMinutes)))) return null;
  }
  return raw as unknown as VerificationDoc;
}
