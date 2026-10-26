/** Opt-in normalized NOAA columns. Production builders retain their existing adapter. */
import type { AtmosphericColumn } from '@windgrams/contracts';
import type { AcquisitionAdapter, NormalizedColumnsResult, SelectedRun } from './types.ts';
import type { AreaAcquisitionAdapter, AreaAcquisitionResult } from './area-types.ts';
import type { NoaaAcquireOptions, NoaaAcquisition, NoaaModel } from './internal/noaa/types.ts';
import { acquireNoaa } from './internal/noaa/acquire.ts';
import { pressureLevelsFor } from './internal/noaa/fields.ts';
import { requestedForecastHours } from './internal/acquisition.ts';
import { modelDescriptor } from './registry.ts';

export { acquireNoaa };
export type {
  NoaaModel, NoaaGrid, NoaaVerticalMode, NoaaAcquireOptions, NoaaAcquisition,
  NoaaCell, NoaaSourceAsset, NoaaColumnOptions, NoaaField, NoaaSelection,
} from './internal/noaa/types.ts';
// Regional replay shares these checked identities and conversions.
export {
  LEGACY_V1_PRESSURE_LEVELS, LEGACY_GFS_PRESSURE_LEVELS, EXTENDED_GFS_PRESSURE_LEVELS,
  EXTENDED_HRRR_PRESSURE_LEVELS, EXTENDED_BOUNDARY_LAYER_SPECS,
  fields, selectRecords, fixedSurface, parameters,
} from './internal/noaa/fields.ts';
export { cellSource } from './internal/noaa/column.ts';
export { projection, storageCoordinates, storageIndex, wind, selectGridCells } from './internal/noaa/grid.ts';

export interface NoaaAdapterResult extends NormalizedColumnsResult { native: NoaaAcquisition }
export interface NoaaAreaResult extends AreaAcquisitionResult { native: NoaaAcquisition }
export interface NoaaAdapterOptions extends Omit<NoaaAcquireOptions, 'model' | 'referenceTime' | 'sites' | 'cacheDir' | 'forecastHours'> {
  forecastHours?: readonly number[];
}

function noaaDescriptor(modelId: NoaaModel, mode: NoaaAcquireOptions['verticalMode']) {
  const original = modelDescriptor(modelId);
  return {
    ...original,
    product: 'normalized-columns' as const,
    sourceProducts: mode === 'hrrr-native' ? ['hrrr/conus/wrfnat+wrfprs'] : original.sourceProducts,
    sourceCapabilities: {
      ...original.sourceCapabilities,
      verticalCoordinates: mode === 'hrrr-native' ? 'model-levels' as const : 'pressure-levels' as const,
    },
    catalogue: {
      ...original.catalogue,
      capabilities: { ...original.catalogue.capabilities, pressureLevels: pressureLevelsFor(modelId, mode) },
    },
  };
}

function assertRun(run: SelectedRun, model: ReturnType<typeof noaaDescriptor>) {
  if (run.model !== model.id || run.provider !== model.provider || !model.sourceProducts.includes(run.product)) {
    throw new Error('Requested source does not match NOAA adapter');
  }
}

/** Point support cells retain the same identity used by regional acquisition. */
export function createNoaaAdapter(modelId: NoaaModel, options: NoaaAdapterOptions = {}): AcquisitionAdapter<NoaaAdapterResult> {
  const model = noaaDescriptor(modelId, options.verticalMode);
  return {
    model,
    async acquire(request) {
      assertRun(request.run, model);
      if (!request.cacheDir || !request.sites.length) throw new Error('NOAA point adapter requires cacheDir and sites');
      const native = await acquireNoaa({
        ...options,
        model: modelId,
        referenceTime: request.run.referenceTime,
        forecastHours: requestedForecastHours(options.forecastHours ?? model.forecastHours, request.maxSteps),
        sites: request.sites,
        cacheDir: request.cacheDir,
      });
      const indices = [...new Set(request.sites.map(site => native.siteCells[site.slug]))];
      const columns = native.hours.flatMap(hour => indices.map(index => {
        const column = hour.columns[index];
        if (!column) throw new Error(`Missing NOAA point column at f${hour.forecastHour}, cell ${index}`);
        return column;
      }));
      return { kind: 'normalized-columns', run: request.run, stage: 'normalized', native, columns };
    },
  };
}

const areaFields: readonly (keyof AtmosphericColumn)[] = [
  'temperatureC', 'dewPointDepressionC', 'windSpeedMps', 'windDirectionDeg', 'levels',
  'sensibleHeatFluxWm2', 'latentHeatFluxWm2', 'precipitationMm',
];
export function createNoaaAreaAdapter(modelId: NoaaModel, options: Omit<NoaaAdapterOptions, 'bounds' | 'forecastHours'> = {}): AreaAcquisitionAdapter<NoaaAreaResult> {
  const model = noaaDescriptor(modelId, options.verticalMode);
  return {
    model,
    fields: areaFields,
    async acquire(request) {
      assertRun(request.run, model);
      if (request.fields?.some(field => !areaFields.includes(field))) throw new Error('Unsupported NOAA area required capability');
      const native = await acquireNoaa({
        ...options,
        model: modelId,
        referenceTime: request.run.referenceTime,
        forecastHours: request.forecastHours,
        bounds: request.bounds,
        cacheDir: request.cacheDir,
        signal: request.signal,
      });
      return {
        kind: 'normalized-area',
        run: request.run,
        bounds: request.bounds,
        grid: { id: native.grid.gridKey, type: native.grid.kind, pointCount: native.grid.numberOfDataPoints },
        cells: native.cells.map(({ index: gridIndex, ...cell }, cellIndex) => ({ ...cell, cellIndex, gridIndex })),
        hours: native.hours,
        native,
      };
    },
  };
}
