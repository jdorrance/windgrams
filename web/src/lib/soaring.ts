import { convertQuantity, formatQuantity, unitLabel, type QuantityKind } from './units.ts';
import type { SiteForecast } from '@azohra/meteo.briefing/contract';

export const DEFAULT_CASE = 'north-sound-20261021-00z';
export type Layer =
  | 'thermalVelocityV2Mps'
  | 'usableLiftTopV2M'
  | 'hcritWxtoflyM'
  | 'dryHcritM'
  | 'resolvedThermalTopM'
  | 'thermalVelocityMps'
  | 'usableLiftTopM'
  | 'boundaryLayerTopM'
  | 'pblHeightM'
  | 'surfaceLclM'
  | 'effectiveCloudLimitM'
  | 'mixedLayerLclM'
  | 'cuPotentialM'
  | 'odPotentialM'
  | 'wind10mSpeedMps'
  | 'blMeanWindSpeedMps'
  | 'blWindShearMps'
  | 'buoyancyShearRatio'
  | 'w925Mps'
  | 'convergence10mX1e5'
  | 'sensibleHeatFluxWm2'
  | 'cloudCoverPercent'
  | 'lowCloudPercent'
  | 'precipitationMmHr'
  | 'capeJkg';

export type Quality = 'valid' | 'missing' | 'insufficient-levels';

export interface LevelArrays {
  h: (number | null)[];
  t: (number | null)[];
  td: (number | null)[];
  ws: (number | null)[];
  wd: (number | null)[];
  vv: (number | null)[];
}

export interface ReplayHour {
  forecastHour: number;
  validAt: string;
  soaringContractVersion?: string;
  thermalVelocityMps: (number | null)[];
  usableLiftTopM: (number | null)[];
  boundaryLayerTopM: (number | null)[];
  cloudBaseM: (number | null)[];
  pblHeightM: (number | null)[];
  resolvedThermalTopM?: (number | null)[];
  thermalTopPlus1CM?: (number | null)[];
  thermalVelocityV2Mps?: (number | null)[];
  usableLiftTopV2M?: (number | null)[];
  hcritWxtoflyM?: (number | null)[];
  dryHcritM?: (number | null)[];
  surfaceLclM?: (number | null)[];
  effectiveCloudLimitM?: (number | null)[];
  mixedLayerLclM?: (number | null)[];
  cuPotentialM?: (number | null)[];
  odPotentialM?: (number | null)[];
  blMeanWindSpeedMps?: (number | null)[];
  blMeanWindDirDeg?: (number | null)[];
  blTopWindSpeedMps?: (number | null)[];
  blTopWindDirDeg?: (number | null)[];
  blWindShearMps?: (number | null)[];
  buoyancyShearRatio?: (number | null)[];
  wind10mSpeedMps?: (number | null)[];
  wind10mDirDeg?: (number | null)[];
  wind80mSpeedMps?: (number | null)[];
  wind80mDirDeg?: (number | null)[];
  windGustMps?: (number | null)[];
  wind925SpeedMps?: (number | null)[];
  wind925DirDeg?: (number | null)[];
  wind850SpeedMps?: (number | null)[];
  wind850DirDeg?: (number | null)[];
  maxUpwardVelocityMps?: (number | null)[];
  minDownwardVelocityMps?: (number | null)[];
  w925Mps?: (number | null)[];
  w850Mps?: (number | null)[];
  convergence10mX1e5?: (number | null)[];
  convergence925X1e5?: (number | null)[];
  sensibleHeatFluxWm2?: (number | null)[];
  latentHeatFluxWm2?: (number | null)[];
  cloudCoverPercent?: (number | null)[];
  lowCloudPercent?: (number | null)[];
  midCloudPercent?: (number | null)[];
  highCloudPercent?: (number | null)[];
  precipitationMmHr?: (number | null)[];
  capeJkg?: (number | null)[];
  cinJkg?: (number | null)[];
  sfcT?: (number | null)[];
  sfcTd?: (number | null)[];
  mslp?: (number | null)[];
  levelsByPressure?: Record<string, LevelArrays>;
  status: Quality[];
  levelCount: number[];
  ceilingReached: boolean[];
}

export interface ReplayManifest {
  schemaVersion: number;
  model?: string;
  semantics?: SiteForecast['semantics'];
  soaringContractVersion?: string;
  capturedAt: string;
  cellCount: number;
  files?: Record<string, string>;
  siteCell: number;
  case: {
    id: string;
    model?: string;
    referenceTime: string;
    bbox: [number, number, number, number];
    sinkMps: number;
    pressureLevels?: number[];
    site: { slug?: string; name: string; latitude: number; longitude: number; timeZone: string };
    launchElevation: { elevationM: number };
  };
  versions: { algorithm: string };
  hours: { forecastHour: number; validAt: string; file: string }[];
}

export interface RegionDescriptor {
  id: string;
  name: string;
  status: string;
  caseId: string;
  expandedCaseId?: string;
  nativeModels?: { model: string; caseId: string; expandedCaseId?: string }[];
  timeZone: string;
  morningBriefingLocalHour: number;
  bbox: [number, number, number, number];
  primarySite: string;
  matchedRaobStation?: string;
  launches: string[];
  deterministicModels: string[];
  ensembleModels: string[];
  sparseAdapters: string[];
}

export interface RegionCatalogue {
  schemaVersion: number;
  soaringContractVersion: string;
  generatedAt: string;
  trialRegionId: string;
  regions: RegionDescriptor[];
}

export interface LayerSpec {
  id: Layer;
  label: string;
  group: string;
  scale: number;
  stops: number[];
  colors: string[];
  legend: string;
  format: (v: number) => string;
}

type LayerDefinition = {
  id: Layer; name: string; group: string; stops: number[]; colors: string[];
  kind?: QuantityKind; datum?: string; unit?: string; note: string;
};
const thermalColors = ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'];
const cloudColors = ['#f4f8fa', '#d1dde6', '#9fb4c7', '#6c849c', '#3c4f66'];
const verticalColors = ['#3b6998', '#a8c6df', '#f4f8fa', '#e8bc52', '#c44935'];
const cloudBaseColors = ['#7c689c', '#6999b3', '#289b9c', '#e8bc52', '#c44935'];
const topStops = [0, 1000, 2000, 5000, 10000].map(ft => ft * .3048);
const depthStops = [0, 1500, 3000, 6000, 10000].map(ft => ft * .3048);
const cloudStops = [500, 2000, 4000, 7000, 11000].map(ft => ft * .3048);
const windStops = [0, 5, 12, 20, 30].map(mph => mph * .44704);
const definitions: LayerDefinition[] = [
  { id: 'thermalVelocityV2Mps', name: 'Thermal strength', group: 'Thermals', kind: 'lift', stops: [0,.5,1,2,3], colors: thermalColors, note: 'Convective velocity w* · resolved thermal depth.' },
  { id: 'usableLiftTopV2M', name: 'Usable lift top', group: 'Thermals', kind: 'elevation', datum: 'MSL', stops: topStops, colors: thermalColors, note: 'Sink threshold: ' },
  { id: 'hcritWxtoflyM', name: 'Paraglider ceiling', group: 'Thermals', kind: 'elevation', datum: 'MSL', stops: topStops, colors: thermalColors, note: 'WxToFly sink threshold: ' },
  { id: 'dryHcritM', name: 'Dry thermal lift top', group: 'Thermals', kind: 'elevation', datum: 'MSL', stops: topStops, colors: thermalColors, note: 'Dry parcel estimate.' },
  { id: 'resolvedThermalTopM', name: 'Thermal top', group: 'Thermals', kind: 'elevation', datum: 'MSL', stops: depthStops, colors: thermalColors, note: 'Resolved thermal depth.' },
  { id: 'thermalVelocityMps', name: 'Thermal strength · legacy', group: 'Thermals', kind: 'lift', stops: [0,.5,1,2,3], colors: thermalColors, note: 'Earlier parcel method.' },
  { id: 'usableLiftTopM', name: 'Usable lift top · legacy', group: 'Thermals', kind: 'elevation', datum: 'MSL', stops: topStops, colors: thermalColors, note: 'Sink threshold: ' },
  { id: 'boundaryLayerTopM', name: 'Parcel top · legacy', group: 'Thermals', kind: 'elevation', datum: 'MSL', stops: depthStops, colors: thermalColors, note: 'Earlier parcel method.' },
  { id: 'pblHeightM', name: 'Mixing depth', group: 'Thermals', kind: 'elevation', datum: 'AGL', stops: [0,250,500,1000,2000], colors: thermalColors, note: 'Model boundary-layer depth.' },
  { id: 'sensibleHeatFluxWm2', name: 'Surface heating', group: 'Thermals', unit: 'W/m²', stops: [-30,0,50,150,300], colors: ['#6b8ea4','#f4f8fa','#c3e1e9','#e8bc52','#c44935'], note: 'Negative: cooling · positive: heating.' },
  { id: 'surfaceLclM', name: 'Potential cloud base', group: 'Clouds / rain', kind: 'elevation', datum: 'MSL', stops: cloudStops, colors: cloudBaseColors, note: 'Surface-parcel condensation level.' },
  { id: 'effectiveCloudLimitM', name: 'Effective cloud limit', group: 'Clouds / rain', kind: 'elevation', datum: 'MSL', stops: cloudStops, colors: cloudBaseColors, note: 'Model-derived near-saturation ceiling proxy.' },
  { id: 'mixedLayerLclM', name: 'Mixed-layer cloud base', group: 'Clouds / rain', kind: 'elevation', datum: 'MSL', stops: cloudStops, colors: cloudBaseColors, note: 'Mixed-parcel condensation level.' },
  { id: 'cuPotentialM', name: 'Cumulus potential', group: 'Clouds / rain', kind: 'elevation', stops: [-1500,-500,0,300,1000], colors: ['#e5d9bd','#c3e1e9','#f4f8fa','#289b9c','#1a5f7a'], note: 'Thermal top minus surface LCL · positive: Cu potential.' },
  { id: 'odPotentialM', name: 'Spreadout potential', group: 'Clouds / rain', kind: 'elevation', stops: [-1500,-500,0,300,1000], colors: ['#e5d9bd','#c3e1e9','#f4f8fa','#7c689c','#4a356b'], note: 'Thermal top minus mixed LCL · positive: spreadout potential.' },
  { id: 'cloudCoverPercent', name: 'Cloud cover', group: 'Clouds / rain', unit: '%', stops: [0,25,50,75,100], colors: cloudColors, note: 'Total cloud fraction.' },
  { id: 'lowCloudPercent', name: 'Low cloud', group: 'Clouds / rain', unit: '%', stops: [0,25,50,75,100], colors: cloudColors, note: 'Low-level cloud fraction.' },
  { id: 'precipitationMmHr', name: 'Rain', group: 'Clouds / rain', kind: 'rainRate', stops: [0,.2,1,3,8], colors: ['#f4f8fa','#b3cde3','#6497b1','#005b96','#03396c'], note: 'Precipitation rate.' },
  { id: 'capeJkg', name: 'CAPE', group: 'Clouds / rain', unit: 'J/kg', stops: [0,50,200,500,1000], colors: thermalColors, note: 'Convective energy.' },
  { id: 'wind10mSpeedMps', name: 'Surface wind', group: 'Wind', kind: 'wind', stops: windStops, colors: thermalColors, note: 'Wind at model surface.' },
  { id: 'blMeanWindSpeedMps', name: 'Average boundary-layer wind', group: 'Wind', kind: 'wind', stops: windStops, colors: thermalColors, note: 'Boundary-layer mean wind.' },
  { id: 'blWindShearMps', name: 'Wind shear', group: 'Wind', kind: 'wind', stops: [0,2,4,7,12], colors: thermalColors, note: 'Vector wind change across the boundary layer.' },
  { id: 'buoyancyShearRatio', name: 'Thermal strength / shear', group: 'Wind', stops: [0,.15,.35,.7,1.2], colors: ['#c44935','#e8bc52','#c3e1e9','#289b9c','#1b6d6e'], note: 'w* divided by vector shear.' },
  { id: 'w925Mps', name: 'Vertical air motion', group: 'Lift / convergence', kind: 'lift', stops: [-.3,-.1,0,.1,.3], colors: verticalColors, note: 'Pressure level: ' },
  { id: 'convergence10mX1e5', name: 'Surface convergence', group: 'Lift / convergence', unit: '×10⁻⁵ s⁻¹', stops: [-100,-30,0,30,100], colors: verticalColors, note: 'Blue: divergence · gold/red: convergence.' },
];

/** Display scales convert together; their physical color thresholds stay fixed. */
export const LAYER_SPECS = Object.defineProperties({}, Object.fromEntries(definitions.map(def => [def.id, {
  enumerable: true,
  get(): LayerSpec {
    const scale = def.kind ? convertQuantity(1, def.kind)! : 1;
    const unit = def.kind ? unitLabel(def.kind) : def.unit;
    const suffix = def.datum ? ` ${def.datum}` : '';
    const note = ['usableLiftTopV2M', 'usableLiftTopM'].includes(def.id) ? formatQuantity(1, 'lift')
      : def.id === 'hcritWxtoflyM' ? formatQuantity(1.143, 'lift')
      : def.id === 'w925Mps' ? formatQuantity(925, 'pressure') : '';
    return { id: def.id, label: `${def.name}${unit ? ` · ${unit}${suffix}` : ''}`, group: def.group,
      scale, stops: def.stops.map(value => value * scale), colors: def.colors, legend: def.note + note,
      format: value => (def.kind ? formatQuantity(value, def.kind) : `${value.toLocaleString('en-US', {maximumFractionDigits: 2})}${unit ? ` ${unit}` : ''}`) + suffix };
  },
}]))) as Record<Layer, LayerSpec>;

export const PRIMARY_LAYERS: Layer[] = [
  'thermalVelocityV2Mps', 'usableLiftTopV2M', 'surfaceLclM',
  'wind10mSpeedMps', 'blMeanWindSpeedMps', 'cloudCoverPercent',
  'lowCloudPercent', 'precipitationMmHr', 'convergence10mX1e5',
];

export const SUPPORTED_CASES = new Set([
  'north-sound-20261021-00z',
  'north-sound-expanded-v2',
  'shenandoah-blue-ridge-20261021-00z',
  'shenandoah-massanutten-20261021-06z',
  'tiger-puget-trough-20261021-06z',
  'columbia-gorge-gap-flow-20261021-06z',
  'rogue-valley-woodrat-20261021-06z',
  'intermountain-idaho-utah-v2',
]);

/**
 * Builds an SVG path string for a cross-section line series using the node array's
 * iteration position (never `node.nodeIndex`), so sparse or reordered node identifiers
 * cannot misalign vertices with position-indexed `vals`.
 */
export function buildCrossSectionLinePath(
  nodes: readonly { distanceKm: number; nodeIndex?: number }[],
  vals: readonly (number | null | undefined)[],
  xOf: (km: number) => number,
  yOf: (m: number) => number,
): string {
  let d = '';
  let connected = false;
  nodes.forEach((n, idx) => {
    const v = vals[idx];
    if (v == null || !Number.isFinite(v)) {
      connected = false;
      return;
    }
    d += `${connected ? 'L' : 'M'}${xOf(n.distanceKm).toFixed(1)},${yOf(v).toFixed(1)}`;
    connected = true;
  });
  return d;
}

export function replayLocation(search: string, dataBase: string) {
  const query = new URLSearchParams(search), caseId = query.get('case') ?? DEFAULT_CASE;
  if (!SUPPORTED_CASES.has(caseId.replace(/-(?:rrfs-)?live$/, ''))) throw new Error(`Unknown replay case: ${caseId}`);
  const hour = Number(query.get('hour') ?? 20);
  return {
    caseId,
    hour: Number.isInteger(hour) && hour >= 1 && hour <= 84 ? hour : 20,
    root: `${dataBase.replace(/\/$/, '')}/soaring/v1/${caseId}`,
  };
}

export function hourIndex(hours: { forecastHour: number }[], requested: number) {
  const found = hours.findIndex(h => h.forecastHour === requested);
  if (found >= 0) return found;
  return hours.length > 6 ? 6 : 0;
}

export function forecastHourAtValidTime(hours: { forecastHour: number; validAt: string }[], validAt: string | null) {
  const target = validAt ? Date.parse(validAt) : NaN;
  if (!Number.isFinite(target) || !hours.length) return null;
  return hours.reduce((best, hour) => Math.abs(Date.parse(hour.validAt) - target) < Math.abs(Date.parse(best.validAt) - target) ? hour : best).forecastHour;
}

interface ReplayCellLocation { cellIndex: number; latitude: number; longitude: number }
interface ReplayLaunchLocation extends ReplayCellLocation { slug: string }
export interface ReplaySelection extends ReplayCellLocation { launchSlug?: string }

const validCoordinates = (point: { latitude: number; longitude: number }) =>
  Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90
  && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;

function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = Math.PI / 180;
  const h = Math.sin((a.latitude - b.latitude) * rad / 2) ** 2
    + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin((a.longitude - b.longitude) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

/** Cell indexes belong to one model grid. Carry geography across runs instead. */
export function replaySelection(
  query: URLSearchParams,
  cells: readonly ReplayCellLocation[],
  launches: readonly ReplayLaunchLocation[],
  fallbackCell: number,
): ReplaySelection {
  const validCells = cells.filter(cell => Number.isInteger(cell.cellIndex) && cell.cellIndex >= 0 && validCoordinates(cell));
  const nearest = (point: { latitude: number; longitude: number }) => {
    if (!validCoordinates(point) || !validCells.length) return undefined;
    const cell = validCells.reduce((best, candidate) => distanceKm(candidate, point) < distanceKm(best, point) ? candidate : best);
    // The regional products use 3 km grids; do not snap an out-of-region link to a distant edge.
    return distanceKm(cell, point) <= 5 ? cell : undefined;
  };
  const launch = launches.find(entry => entry.slug === query.get('launch'));
  if (launch && validCoordinates(launch)) {
    const mapped = validCells.find(cell => cell.cellIndex === launch.cellIndex && distanceKm(cell, launch) <= 5);
    const cell = mapped ?? nearest(launch);
    if (cell) return { cellIndex: cell.cellIndex, latitude: launch.latitude, longitude: launch.longitude, launchSlug: launch.slug };
  }
  const latitude = query.get('lat'), longitude = query.get('lon');
  if (latitude?.trim() && longitude?.trim()) {
    const point = { latitude: Number(latitude), longitude: Number(longitude) };
    const cell = nearest(point);
    // Keep the original anchor so switching back and forth cannot drift between grid centres.
    if (cell) return { cellIndex: cell.cellIndex, ...point };
  }
  const fallback = validCells.find(cell => cell.cellIndex === fallbackCell) ?? validCells[0];
  if (!fallback) throw new Error('Regional forecast has no valid grid locations');
  const fallbackLaunch = launches.find(entry => entry.cellIndex === fallback.cellIndex && validCoordinates(entry) && distanceKm(entry, fallback) <= 5);
  return fallbackLaunch
    ? { cellIndex: fallback.cellIndex, latitude: fallbackLaunch.latitude, longitude: fallbackLaunch.longitude, launchSlug: fallbackLaunch.slug }
    : { cellIndex: fallback.cellIndex, latitude: fallback.latitude, longitude: fallback.longitude };
}

export function setReplaySelectionQuery(query: URLSearchParams, selection: ReplaySelection) {
  query.set('lat', String(selection.latitude));
  query.set('lon', String(selection.longitude));
  if (selection.launchSlug) query.set('launch', selection.launchSlug);
  else query.delete('launch');
}

export function replayModel(manifest: ReplayManifest) {
  return manifest.model ?? manifest.case.model ?? 'hrrr-conus';
}

export function modelLabel(model: string) {
  return ({ 'hrrr-conus': 'HRRR', rrfs: 'RRFS' } as Record<string, string>)[model] ?? model;
}

export function nativeModels(region: RegionDescriptor) {
  return region.nativeModels?.length ? region.nativeModels : [{ model: 'hrrr-conus', caseId: region.caseId, expandedCaseId: region.expandedCaseId }];
}

export function regionForCase(regions: RegionDescriptor[], caseId: string) {
  return regions.find(region => region.caseId === caseId || region.expandedCaseId === caseId
    || nativeModels(region).some(entry => entry.caseId === caseId || entry.expandedCaseId === caseId));
}

/** Explicit archived links always retain their original case, even with a model parameter. */
export function defaultReplayQuery(search: string, catalogue: RegionCatalogue | null) {
  const query = new URLSearchParams(search);
  if (query.has('case')) return query;
  const region = catalogue?.regions.find(r => r.status === 'active-verified-trial' && r.caseId.startsWith('north-sound-')
    && nativeModels(r).some(entry => entry.caseId.endsWith('-live')));
  if (region) {
    const requestedModel = query.get('model');
    const selected = nativeModels(region).find(entry => requestedModel ? entry.model === requestedModel : entry.caseId === region.caseId);
    if (requestedModel && !selected) throw new Error(`${modelLabel(requestedModel)} regional forecast is unavailable.`);
    query.set('case', selected?.caseId ?? region.caseId);
  } else if (query.has('model') && query.get('model') !== 'hrrr-conus') {
    throw new Error(`${modelLabel(query.get('model')!)} regional forecast is unavailable.`);
  }
  return query;
}

export function historicalLabel(referenceTime: string, rolling = false, model = 'hrrr-conus') {
  return `${rolling ? 'Forecast run' : 'Historical forecast'} · ${modelLabel(model)} ${referenceTime.slice(0, 10)} · ${referenceTime.slice(11, 16)} UTC`;
}

export function localTime(validAt: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(validAt));
}

export function displayMetric(value: number | null | undefined, layer: Layer, status: Quality = 'valid') {
  if (status === 'missing') return 'Unavailable';
  if (status === 'insufficient-levels') return 'Insufficient vertical coverage';
  if (value === undefined) return 'Unavailable';
  if (value === null) {
    if (layer === 'usableLiftTopM' || layer === 'usableLiftTopV2M') return `Below ${formatQuantity(1, 'lift')} sink threshold`;
    if (layer === 'hcritWxtoflyM') return `Below ${formatQuantity(1.143, 'lift')} sink threshold`;
    if (layer === 'resolvedThermalTopM') return 'Stable';
    return 'Unavailable';
  }
  return LAYER_SPECS[layer]?.format(value) ?? String(value);
}

export function selectedState(manifest: ReplayManifest, hours: ReplayHour[], requested: number) {
  const index = hourIndex(manifest.hours, requested), hour = hours[index];
  if (!hour || hour.validAt !== manifest.hours[index].validAt) throw new Error('Replay hour does not match manifest');
  const v2Strength = hour.thermalVelocityV2Mps ? hour.thermalVelocityV2Mps[manifest.siteCell] : hour.thermalVelocityMps[manifest.siteCell];
  const v2Top = hour.usableLiftTopV2M ? hour.usableLiftTopV2M[manifest.siteCell] : hour.usableLiftTopM[manifest.siteCell];
  return {
    index,
    hour,
    validLabel: localTime(hour.validAt, manifest.case.site.timeZone),
    siteStrength: displayMetric(hour.thermalVelocityMps[manifest.siteCell], 'thermalVelocityMps', hour.status[manifest.siteCell]),
    siteTop: displayMetric(hour.usableLiftTopM[manifest.siteCell], 'usableLiftTopM', hour.status[manifest.siteCell]),
    siteStrengthV2: displayMetric(v2Strength, 'thermalVelocityV2Mps', hour.status[manifest.siteCell]),
    siteTopV2: displayMetric(v2Top, 'usableLiftTopV2M', hour.status[manifest.siteCell]),
  };
}

/**
 * Reconstructs a profile from published cell arrays, without deriving new physics.
 * An incomplete column is unavailable; never substitute another location or invented weather.
 */
export function buildCellSiteForecast(
  manifest: ReplayManifest,
  hours: ReplayHour[],
  cellIndex: number,
  cellProps: { id: string; gridIndex: number; latitude: number; longitude: number; modelElevationM: number | null },
  customName?: string,
): SiteForecast | null {
  const elev = cellProps.modelElevationM;
  if (elev === null) return null;
  const pList = manifest.case.pressureLevels ?? [925, 900, 875, 850, 800, 750, 700, 650, 600];
  const siteHours: SiteForecast['hours'] = [];
  for (const h of hours) {
    if (h.status[cellIndex] !== 'valid') return null;
    const levels: (SiteForecast['hours'][number]['levels'][number] & { heightM: number })[] = [];
    if (h.levelsByPressure) {
      for (const p of pList) {
        const la = h.levelsByPressure[String(p)];
        if (!la) continue;
        const hm = la.h[cellIndex], tc = la.t[cellIndex], tdc = la.td[cellIndex], ws = la.ws[cellIndex], wd = la.wd[cellIndex];
        if (hm == null || tc == null || tdc == null || ws == null || wd == null) continue;
        if (hm <= elev + 20) continue;
        const lv: (typeof levels)[number] = {
          pressureHpa: p,
          heightM: hm,
          temperatureC: tc,
          dewPointC: tdc,
          windSpeedMps: ws,
          windDirectionDeg: wd,
        };
        const vv = la.vv?.[cellIndex];
        if (vv != null) lv.verticalVelocityPaS = vv;
        levels.push(lv);
      }
      levels.sort((a, b) => a.heightM - b.heightM);
    }
    const surfaceKeys = {
      seaLevelPressureHpa: 'mslp', temperatureC: 'sfcT', dewPointC: 'sfcTd',
      windSpeedMps: 'wind10mSpeedMps', windDirectionDeg: 'wind10mDirDeg',
      cloudCoverPercent: 'cloudCoverPercent', precipitationMmHr: 'precipitationMmHr',
      sensibleHeatFluxWm2: 'sensibleHeatFluxWm2', latentHeatFluxWm2: 'latentHeatFluxWm2',
    } as const;
    const entries = Object.entries(surfaceKeys).map(([key, source]) => [key, h[source]?.[cellIndex]] as const);
    if (entries.some(([, value]) => value == null || !Number.isFinite(value)) || levels.length < 2
        || h.thermalVelocityMps[cellIndex] == null || h.cloudBaseM[cellIndex] == null) return null;
    const surface = Object.fromEntries(entries) as SiteForecast['hours'][number]['surface'];
    if (h.windGustMps?.[cellIndex] != null) surface.windGustMps = h.windGustMps[cellIndex]!;
    if (h.capeJkg?.[cellIndex] != null) surface.capeJkg = h.capeJkg[cellIndex]!;
    if (h.cinJkg?.[cellIndex] != null) surface.cinJkg = h.cinJkg[cellIndex]!;
    if (h.pblHeightM[cellIndex] != null) surface.pblHeightM = h.pblHeightM[cellIndex]!;
    if (h.lowCloudPercent?.[cellIndex] != null) surface.lowCloudPercent = h.lowCloudPercent[cellIndex]!;
    if (h.midCloudPercent?.[cellIndex] != null) surface.midCloudPercent = h.midCloudPercent[cellIndex]!;
    if (h.highCloudPercent?.[cellIndex] != null) surface.highCloudPercent = h.highCloudPercent[cellIndex]!;

    const soaring = h.thermalVelocityV2Mps ? {
      thermalVelocityV2Mps: h.thermalVelocityV2Mps[cellIndex],
      usableLiftTopV2M: h.usableLiftTopV2M?.[cellIndex] ?? null,
      hcritWxtoflyM: h.hcritWxtoflyM?.[cellIndex] ?? null,
      resolvedThermalTopM: h.resolvedThermalTopM?.[cellIndex] ?? null,
      surfaceLclM: h.surfaceLclM?.[cellIndex] ?? null,
      effectiveCloudLimitM: h.effectiveCloudLimitM?.[cellIndex] ?? h.cloudBaseM[cellIndex] ?? null,
      mixedLayerLclM: h.mixedLayerLclM?.[cellIndex] ?? null,
    } : undefined;
    siteHours.push({
      ...(soaring ? { soaring } : {}),
      validAt: h.validAt,
      surface,
      levels,
      derived: {
        boundaryLayerTopM: h.boundaryLayerTopM[cellIndex],
        thermalVelocityMps: h.thermalVelocityMps[cellIndex]!,
        cloudBaseM: h.cloudBaseM[cellIndex]!,
        usableLiftTopM: h.usableLiftTopM[cellIndex],
      },
    });
  }
  return {
    schemaVersion: 2,
    model: replayModel(manifest),
    run: { referenceTime: manifest.case.referenceTime, generatedAt: manifest.capturedAt },
    site: {
      id: `cell-${cellProps.gridIndex}`,
      name: customName ?? `Cell ${cellProps.gridIndex}`,
      latitude: cellProps.latitude,
      longitude: cellProps.longitude,
      modelElevationM: elev,
      timeZone: manifest.case.site.timeZone,
    },
    semantics: manifest.semantics ?? (replayModel(manifest) === 'rrfs'
      ? { gust: 'instant', precipitation: 'windowMeanRate' }
      : { gust: 'instant', precipitation: 'instantRate', smoke: 'radiativelyCoupled' }),
    hours: siteHours,
  };
}
