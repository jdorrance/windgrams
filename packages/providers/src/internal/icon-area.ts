import type { AtmosphericColumn } from '@windgrams/contracts';
import { containsPoint, validBounds, validPosition, type Bounds } from '@windgrams/geography';
import { iconColumnRecord } from '../icon.ts';
import type { AreaAcquisitionRequest, AreaAcquisitionResult, IconAreaResult } from '../area-types.ts';
import type { ModelDescriptor } from '../registry.ts';
import type { IconAcquisition } from './icon-types.ts';
import { ICON_BASE, iconBounds, iconReferenceTime } from './icon-native.ts';

export const iconAreaFields: readonly (keyof AtmosphericColumn)[] = Object.freeze([
  'validAt', 'temperatureC', 'dewPointDepressionC', 'windSpeedMps', 'windDirectionDeg',
  'windGustMps', 'cloudCoverPercent', 'lowCloudPercent', 'midCloudPercent', 'highCloudPercent',
  'precipitationMm', 'sensibleHeatFluxWm2', 'latentHeatFluxWm2', 'seaLevelPressureHpa',
  'capeJkg', 'cinJkg', 'pblHeightM', 'levels',
]);

type Selection = Omit<AreaAcquisitionRequest, 'fields' | 'forecastHours'> & { forecastHours: number[] };

/** Own the request values before asynchronous acquisition begins. */
export function prepareIconArea(request: AreaAcquisitionRequest, model: ModelDescriptor): Selection {
  const { signal, cacheDir } = request;
  signal?.throwIfAborted();
  const run = { ...request.run };
  if (run.provider !== model.provider || run.model !== model.id || !model.sourceProducts.includes(run.product)) {
    throw new Error('Requested source does not match ICON area adapter');
  }
  run.referenceTime = iconReferenceTime(run.referenceTime);
  if (!validBounds(request.bounds)) throw new Error('Invalid ICON bounding box');
  const box = iconBounds(request.bounds)!;
  const bounds: Bounds = [box.west, box.south, box.east, box.north];
  const corners = [{ latitude: box.south, longitude: box.west }, { latitude: box.north, longitude: box.east }];
  const coverage = model.coverage;
  if (coverage !== 'global' && corners.some(corner => !containsPoint(coverage, corner))) {
    throw new Error('Requested area is outside ICON-EU coverage');
  }
  if (!cacheDir) throw new Error('ICON area acquisition requires an explicit cache directory');
  const forecastHours = [...request.forecastHours];
  if (!forecastHours.length || forecastHours.some((hour, i) => !model.forecastHours.includes(hour) || i > 0 && hour <= forecastHours[i - 1])) {
    throw new Error('ICON area forecast hours must be unique ascending integers from 1 to 78');
  }
  for (const field of request.fields ?? []) {
    if (!iconAreaFields.includes(field)) throw new Error(`Unsupported ICON area field: ${field}`);
  }
  return { run, bounds, forecastHours, cacheDir, signal };
}

function cellIndices(native: IconAcquisition, bounds: Bounds): number[] {
  const indices: number[] = [];
  const seen = new Set<number>();
  for (const [i, cell] of native.cells.entries()) {
    if (!validPosition(cell) || cell.cellIndex !== i || !Number.isSafeInteger(cell.index)
      || cell.index < 0 || cell.index >= native.grid.pointCount || seen.has(cell.index)
      || !Number.isFinite(cell.terrainM) || cell.corners.length < 3
      || cell.corners.some(([longitude, latitude]) => !validPosition({ longitude, latitude }))) {
      throw new Error('Invalid ICON area cell geometry');
    }
    seen.add(cell.index);
    if (containsPoint(bounds, cell)) indices.push(i);
  }
  if (!indices.length) throw new Error('Requested area contains no acquired ICON cells');
  return indices;
}

export function selectIconArea(native: IconAcquisition, selection: Selection, model: ModelDescriptor): IconAreaResult {
  const { run, bounds, forecastHours } = selection;
  if (native.model !== model.id || native.provenance.provider !== model.provider
    || native.provenance.accessProduct !== ICON_BASE || Date.parse(native.referenceTime) !== Date.parse(run.referenceTime)) {
    throw new Error('ICON area acquisition returned a different source or run');
  }
  if (native.hours.length !== forecastHours.length || native.hours.some((hour, i) => hour.forecastHour !== forecastHours[i])) {
    throw new Error('ICON area acquisition returned a different forecast horizon');
  }
  const { uuid, type, pointCount, geometrySource } = native.grid;
  if (!uuid || uuid !== geometrySource.uuid || !Number.isSafeInteger(pointCount) || pointCount < 1) {
    throw new Error('Invalid ICON area grid identity');
  }
  const indices = cellIndices(native, bounds);
  let normalizedHours: AreaAcquisitionResult['hours'] | undefined;
  return {
    kind: 'normalized-area',
    run: { ...run, referenceTime: native.referenceTime },
    bounds,
    grid: { id: uuid, type, pointCount },
    cells: indices.map((index, cellIndex) => {
      const cell = native.cells[index];
      return {
        cellIndex, gridIndex: cell.index, id: cell.id,
        latitude: cell.latitude, longitude: cell.longitude,
        modelElevationM: cell.terrainM, corners: cell.corners,
      };
    }),
    get hours() {
      return normalizedHours ??= native.hours.map((hour, hourIndex) => ({
        forecastHour: hour.forecastHour,
        validAt: hour.validAt,
        columns: indices.map(index => iconColumnRecord(native, hourIndex, index)),
      }));
    },
    native,
  };
}
