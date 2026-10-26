import { reconstructRegionalCellProfile } from '@windgrams/data-client/dataset';
import { fieldDefinition } from '@windgrams/contracts/fields';
import { convertQuantity, feetToMetres, formatQuantity, getUnitSystem, mphToMps, unitLabel, type QuantityKind, type UnitSystem } from './units.ts';
import type { SiteForecast } from '@azohra/meteo.briefing/contract';
import { containsPolygon, distanceKm, validPosition as validCoordinates } from '@windgrams/geography';
import type { Grid } from '@windgrams/contracts/regional';
import { replayModel as explicitReplayModel, type Quality, type ReplayHour, type ReplayManifest, type RegionDescriptor, type RegionCatalogue } from '@windgrams/contracts/regional';
import legacyReplayModels from '../../../forecasts/soaring/legacy-replay-models.json' with { type: 'json' };
import { defaultSoaringRegion } from './forecast-capabilities.ts';
export type { Grid, Cell, Quality, LevelArrays, ReplayHour, ReplayManifest, RegionDescriptor, RegionCatalogue } from '@windgrams/contracts/regional';

export function legacyReplayModel(caseId: string): string | undefined {
  return Object.hasOwn(legacyReplayModels, caseId)
    ? legacyReplayModels[caseId as keyof typeof legacyReplayModels] : undefined;
}

/** Give archives published before model metadata an explicit identity at the host boundary. */
export function normalizeReplayManifest(manifest: ReplayManifest): ReplayManifest {
  if (manifest.model || manifest.case.model) return manifest;
  const model = legacyReplayModel(manifest.case.id);
  return model ? { ...manifest, model } : manifest;
}

export function replayModel(manifest: ReplayManifest): string {
  return explicitReplayModel(normalizeReplayManifest(manifest));
}

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
  id: Layer; group: string; stops: number[]; colors: string[];
  kind?: QuantityKind; unit?: string; note: string;
};
const thermalColors = ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'];
const cloudColors = ['#f4f8fa', '#d1dde6', '#9fb4c7', '#6c849c', '#3c4f66'];
const verticalColors = ['#3b6998', '#a8c6df', '#f4f8fa', '#e8bc52', '#c44935'];
const cloudBaseColors = ['#7c689c', '#6999b3', '#289b9c', '#e8bc52', '#c44935'];
const topStops = [0, 1000, 2000, 5000, 10000].map(feetToMetres);
const depthStops = [0, 1500, 3000, 6000, 10000].map(feetToMetres);
const cloudStops = [500, 2000, 4000, 7000, 11000].map(feetToMetres);
const windStops = [0, 5, 12, 20, 30].map(mphToMps);
const definitions: LayerDefinition[] = [
  { id: 'thermalVelocityV2Mps', group: 'Thermals', kind: 'lift', stops: [0,.5,1,2,3], colors: thermalColors, note: 'Thermal strength (w*) calculated over the estimated thermal depth.' },
  { id: 'usableLiftTopV2M', group: 'Thermals', kind: 'elevation', stops: topStops, colors: thermalColors, note: 'Sink threshold: ' },
  { id: 'hcritWxtoflyM', group: 'Thermals', kind: 'elevation', stops: topStops, colors: thermalColors, note: 'WxToFly sink threshold: ' },
  { id: 'dryHcritM', group: 'Thermals', kind: 'elevation', stops: topStops, colors: thermalColors, note: 'Dry parcel estimate.' },
  { id: 'resolvedThermalTopM', group: 'Thermals', kind: 'elevation', stops: depthStops, colors: thermalColors, note: 'Estimated top of the buoyant thermal layer.' },
  { id: 'thermalVelocityMps', group: 'Thermals', kind: 'lift', stops: [0,.5,1,2,3], colors: thermalColors, note: 'Earlier parcel method.' },
  { id: 'usableLiftTopM', group: 'Thermals', kind: 'elevation', stops: topStops, colors: thermalColors, note: 'Sink threshold: ' },
  { id: 'boundaryLayerTopM', group: 'Thermals', kind: 'elevation', stops: depthStops, colors: thermalColors, note: 'Earlier parcel method.' },
  { id: 'pblHeightM', group: 'Thermals', kind: 'elevation', stops: [0,250,500,1000,2000], colors: thermalColors, note: 'Model boundary-layer depth.' },
  { id: 'sensibleHeatFluxWm2', group: 'Thermals', unit: 'W/m²', stops: [-30,0,50,150,300], colors: ['#6b8ea4','#f4f8fa','#c3e1e9','#e8bc52','#c44935'], note: 'Positive values show heating; negative values show cooling.' },
  { id: 'surfaceLclM', group: 'Clouds / rain', kind: 'elevation', stops: cloudStops, colors: cloudBaseColors, note: 'Height where a rising parcel of surface air would reach saturation.' },
  { id: 'effectiveCloudLimitM', group: 'Clouds / rain', kind: 'elevation', stops: cloudStops, colors: cloudBaseColors, note: 'Estimated cloud limit from nearly saturated model layers.' },
  { id: 'mixedLayerLclM', group: 'Clouds / rain', kind: 'elevation', stops: cloudStops, colors: cloudBaseColors, note: 'Condensation height after mixing air through the lower layer.' },
  { id: 'cuPotentialM', group: 'Clouds / rain', kind: 'elevation', stops: [-1500,-500,0,300,1000], colors: ['#e5d9bd','#c3e1e9','#f4f8fa','#289b9c','#1a5f7a'], note: 'Thermal top minus surface condensation height. Positive values suggest cumulus may form.' },
  { id: 'odPotentialM', group: 'Clouds / rain', kind: 'elevation', stops: [-1500,-500,0,300,1000], colors: ['#e5d9bd','#c3e1e9','#f4f8fa','#7c689c','#4a356b'], note: 'Thermal top minus mixed-layer condensation height. Positive values suggest cloud may spread out.' },
  { id: 'cloudCoverPercent', group: 'Clouds / rain', unit: '%', stops: [0,25,50,75,100], colors: cloudColors, note: 'Total cloud fraction.' },
  { id: 'lowCloudPercent', group: 'Clouds / rain', unit: '%', stops: [0,25,50,75,100], colors: cloudColors, note: 'Low-level cloud fraction.' },
  { id: 'precipitationMmHr', group: 'Clouds / rain', kind: 'rainRate', stops: [0,.2,1,3,8], colors: ['#f4f8fa','#b3cde3','#6497b1','#005b96','#03396c'], note: 'Precipitation rate.' },
  { id: 'capeJkg', group: 'Clouds / rain', unit: 'J/kg', stops: [0,50,200,500,1000], colors: thermalColors, note: 'Energy available to a buoyant rising parcel.' },
  { id: 'wind10mSpeedMps', group: 'Wind', kind: 'wind', stops: windStops, colors: thermalColors, note: 'Wind at model surface.' },
  { id: 'blMeanWindSpeedMps', group: 'Wind', kind: 'wind', stops: windStops, colors: thermalColors, note: 'Boundary-layer mean wind.' },
  { id: 'blWindShearMps', group: 'Wind', kind: 'wind', stops: [0,2,4,7,12], colors: thermalColors, note: 'Vector wind change across the boundary layer.' },
  { id: 'buoyancyShearRatio', group: 'Wind', stops: [0,.15,.35,.7,1.2], colors: ['#c44935','#e8bc52','#c3e1e9','#289b9c','#1b6d6e'], note: 'w* divided by vector shear.' },
  { id: 'w925Mps', group: 'Lift / convergence', kind: 'lift', stops: [-.3,-.1,0,.1,.3], colors: verticalColors, note: 'Pressure level: ' },
  { id: 'convergence10mX1e5', group: 'Lift / convergence', unit: '×10⁻⁵ s⁻¹', stops: [-100,-30,0,30,100], colors: verticalColors, note: 'Blue: divergence · gold/red: convergence.' },
];

/** Display scales convert together; their physical color thresholds stay fixed. */
export const LAYER_SPECS = Object.defineProperties({}, Object.fromEntries(definitions.map(def => [def.id, {
  enumerable: true,
  get(): LayerSpec {
    const scale = def.kind ? convertQuantity(1, def.kind)! : 1;
    const unit = def.kind ? unitLabel(def.kind) : def.unit;
    const definition = fieldDefinition(def.id);
    const datum = definition.heightReference === 'model-AGL' ? 'AGL' : definition.heightReference;
    const suffix = datum ? ` ${datum}` : '';
    const note = ['usableLiftTopV2M', 'usableLiftTopM'].includes(def.id) ? formatQuantity(1, 'lift')
      : def.id === 'hcritWxtoflyM' ? formatQuantity(1.143, 'lift')
      : def.id === 'w925Mps' ? formatQuantity(925, 'pressure') : '';
    return { id: def.id, label: `${definition.label}${unit ? ` · ${unit}${suffix}` : ''}`, group: def.group,
      scale, stops: def.stops.map(value => value * scale), colors: def.colors, legend: def.note + note,
      format: value => (def.kind ? formatQuantity(value, def.kind) : `${value.toLocaleString('en-US', {maximumFractionDigits: 2})}${unit ? ` ${unit}` : ''}`) + suffix };
  },
}]))) as Record<Layer, LayerSpec>;

export const PRIMARY_LAYERS: Layer[] = [
  'thermalVelocityV2Mps', 'usableLiftTopV2M', 'surfaceLclM',
  'wind10mSpeedMps', 'blMeanWindSpeedMps', 'cloudCoverPercent',
  'lowCloudPercent', 'precipitationMmHr', 'convergence10mX1e5',
];

/** Missing extraction fields stay out of the picker; real zeroes remain useful. */
export function availableReplayLayers(hours: ReplayHour[]): Layer[] {
  return (Object.keys(LAYER_SPECS) as Layer[]).filter(layer => hours.some(hour =>
    hour[layer]?.some(value => typeof value === 'number' && Number.isFinite(value))));
}

/** Replace server-rendered captions with the browser's persisted unit preference. */
export function refreshReplayLayerLabels(options: Iterable<{ value: string; textContent: string | null }>) {
  for (const option of options) {
    const spec = LAYER_SPECS[option.value as Layer];
    if (spec) option.textContent = spec.label;
  }
}

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

/** One height scale across the transect's forecast horizon, including high terrain. */
export function crossSectionHeightScale(
  nodes: readonly { cellIndex: number; modelElevationM: number | null; launchElevationM?: number | null }[],
  hours: readonly ReplayHour[],
  system: UnitSystem = getUnitSystem(),
) {
  let highestM = 0;
  const include = (value: number | null | undefined) => {
    if (typeof value === 'number' && Number.isFinite(value)) highestM = Math.max(highestM, value);
  };
  for (const node of nodes) {
    include(node.modelElevationM);
    include(node.launchElevationM);
    for (const hour of hours) {
      include((hour.resolvedThermalTopM ?? hour.boundaryLayerTopM)?.[node.cellIndex]);
      include((hour.usableLiftTopV2M ?? hour.usableLiftTopM)?.[node.cellIndex]);
      include((hour.surfaceLclM ?? hour.cloudBaseM)?.[node.cellIndex]);
    }
  }
  // Keep the familiar lowland range and leave room above the highest plotted line.
  const maxAltM = Math.max(3600, Math.ceil((highestM + Math.max(150, highestM * 0.04)) / 500) * 500);
  const unitsPerM = convertQuantity(1, 'elevation', system)!;
  const maxDisplay = maxAltM * unitsPerM;
  const rawStep = maxDisplay / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 3, 5, 10].find(value => value * magnitude >= rawStep)! * magnitude;
  const ticksM = Array.from({ length: Math.floor(maxDisplay / step) + 1 }, (_, index) => index * step / unitsPerM);
  return { maxAltM, ticksM };
}

export function replayLocation(search: string, dataBase: string) {
  const query = new URLSearchParams(search), caseId = query.get('case') ?? DEFAULT_CASE;
  // Published catalogues can introduce regions without a web release. Explicit
  // historical links remain addressable; the fetched manifest verifies identity.
  if (!/^[a-z0-9][a-z0-9-]{0,159}$/.test(caseId)) throw new Error(`Unknown replay case: ${caseId}`);
  const hour = Number(query.get('hour') ?? 20);
  return {
    caseId,
    hour: Number.isSafeInteger(hour) && hour >= 0 ? hour : 20,
    root: `${dataBase.replace(/\/$/, '')}/soaring/v1/${caseId}`,
  };
}

export function hourIndex(hours: { forecastHour: number }[], requested: number) {
  if (!hours.length) return 0;
  const found = hours.findIndex(h => h.forecastHour === requested);
  if (found >= 0) return found;
  if (!Number.isFinite(requested)) return 0;
  return hours.reduce((best, hour, index) =>
    Math.abs(hour.forecastHour - requested) < Math.abs(hours[best].forecastHour - requested)
      || (Math.abs(hour.forecastHour - requested) === Math.abs(hours[best].forecastHour - requested)
        && hour.forecastHour < hours[best].forecastHour) ? index : best, 0);
}

export function forecastHourAtValidTime(hours: { forecastHour: number; validAt: string }[], validAt: string | null) {
  const target = validAt ? Date.parse(validAt) : NaN;
  if (!Number.isFinite(target) || !hours.length) return null;
  return hours.reduce((best, hour) => Math.abs(Date.parse(hour.validAt) - target) < Math.abs(Date.parse(best.validAt) - target) ? hour : best).forecastHour;
}

interface ReplayCellLocation { cellIndex: number; latitude: number; longitude: number }
interface ReplayLaunchLocation extends ReplayCellLocation { slug: string }
export interface ReplaySelection extends ReplayCellLocation { launchSlug?: string }

/** Cell indexes belong to one model grid. Carry geography across runs instead. */
export function replaySelection(
  query: URLSearchParams,
  cells: readonly ReplayCellLocation[],
  launches: readonly ReplayLaunchLocation[],
  fallbackCell: number,
  grid?: Pick<Grid, 'features'>,
): ReplaySelection {
  const validCells = cells.filter(cell => Number.isInteger(cell.cellIndex) && cell.cellIndex >= 0 && validCoordinates(cell));
  const footprints = grid ? new Map(grid.features.map(feature => [feature.properties.cellIndex, feature.geometry.coordinates])) : null;
  const nearest = (point: { latitude: number; longitude: number }) => {
    if (!validCoordinates(point) || !validCells.length) return undefined;
    const candidates = footprints
      ? validCells.filter(cell => {
          const polygon = footprints.get(cell.cellIndex);
          return polygon ? containsPolygon(polygon, point) : false;
        })
      : validCells;
    if (!candidates.length) return undefined;
    const cell = candidates.reduce((best, candidate) => distanceKm(candidate, point) < distanceKm(best, point) ? candidate : best);
    if (grid) return cell;
    // Compatibility for callers with centres only. Production readers supply the
    // native polygons; this fallback derives reach from this grid's spacing.
    const spacing = validCells.filter(candidate => candidate.cellIndex !== cell.cellIndex)
      .map(candidate => distanceKm(candidate, cell)).filter(value => value > 0);
    const reach = spacing.length ? Math.min(...spacing) / Math.SQRT2 : 0;
    return distanceKm(cell, point) <= reach ? cell : undefined;
  };
  const launch = launches.find(entry => entry.slug === query.get('launch'));
  if (launch && validCoordinates(launch)) {
    const cell = nearest(launch);
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
  const fallbackLaunch = launches.find(entry => entry.cellIndex === fallback.cellIndex && validCoordinates(entry)
    && nearest(entry)?.cellIndex === fallback.cellIndex);
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

export function modelLabel(model: string) {
  return ({ 'hrrr-conus': 'HRRR', rrfs: 'RRFS', 'icon-eu': 'ICON-EU', unknown: 'Unknown model' } as Record<string, string>)[model] ?? model;
}

export function nativeModels(region: RegionDescriptor) {
  if (region.nativeModels?.length) return region.nativeModels;
  const legacyModel = legacyReplayModel(region.caseId);
  return legacyModel ? [{ model: legacyModel, caseId: region.caseId, expandedCaseId: region.expandedCaseId }] : [];
}

export function regionForCase(regions: RegionDescriptor[], caseId: string) {
  return regions.find(region => region.caseId === caseId || region.expandedCaseId === caseId
    || nativeModels(region).some(entry => entry.caseId === caseId || entry.expandedCaseId === caseId));
}

/** Explicit archived links always retain their original case, even with a model parameter. */
export function defaultReplayQuery(search: string, catalogue: RegionCatalogue | null) {
  const query = new URLSearchParams(search);
  if (query.has('case')) return query;
  const country = query.get('country');
  const requestedRegion = query.get('region') ?? (country ? defaultSoaringRegion(country) : undefined);
  if (country && country !== 'US' && !requestedRegion) throw new Error('Regional forecast is unavailable.');
  const requested = requestedRegion ? catalogue?.regions.find(r => r.id === requestedRegion && r.status === 'active-verified-trial') : undefined;
  if (requestedRegion && !requested) throw new Error('Regional forecast is unavailable.');
  const available = catalogue?.regions.filter(r => r.status === 'active-verified-trial' && nativeModels(r).length) ?? [];
  const region = requested ?? available.find(r => r.id === catalogue?.trialRegionId) ?? available[0];
  if (region) {
    const requestedModel = query.get('model');
    const selected = nativeModels(region).find(entry => requestedModel ? entry.model === requestedModel : entry.caseId === region.caseId);
    if (requestedModel && !selected) throw new Error(`${modelLabel(requestedModel)} regional forecast is unavailable.`);
    if (!nativeModels(region).length) throw new Error('Regional forecast model is unavailable.');
    query.set('case', selected?.caseId ?? nativeModels(region)[0].caseId);
  } else if (catalogue) {
    throw new Error('Regional forecast is unavailable.');
  } else if (query.has('model') && query.get('model') !== 'hrrr-conus') {
    throw new Error(`${modelLabel(query.get('model')!)} regional forecast is unavailable.`);
  }
  return query;
}

export function historicalLabel(referenceTime: string, rolling = false, model = 'unknown') {
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

export function displayMetric(value: number | null | undefined, layer: Layer, status: Quality = 'valid', system: UnitSystem = getUnitSystem()) {
  if (status === 'missing') return 'Unavailable';
  if (status === 'insufficient-levels') return 'Insufficient vertical coverage';
  if (value === undefined) return 'Unavailable';
  if (value === null) return 'Unavailable';
  const definition = definitions.find(def => def.id === layer);
  if (!definition) return String(value);
  if (!definition.kind) return LAYER_SPECS[layer].format(value);
  const reference = fieldDefinition(layer).heightReference;
  return formatQuantity(value, definition.kind, undefined, system) + (reference ? ` ${reference === 'model-AGL' ? 'AGL' : reference}` : '');
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

/** Adapt historical model identity at the application boundary. */
export function buildCellSiteForecast(
  manifest: ReplayManifest, hours: ReplayHour[], cellIndex: number,
  cellProps: { id: string; gridIndex: number; latitude: number; longitude: number; modelElevationM: number | null },
  customName?: string,
): SiteForecast | null {
  return reconstructRegionalCellProfile(normalizeReplayManifest(manifest), hours, cellIndex, cellProps, customName);
}
