import { ICON_BASE, acquireIcon } from './internal/icon-native.ts';
import type { IconBounds, IconCell, IconObjectSource, IconFieldMetadata, IconFieldRecord, IconSourceObject, IconGrid, IconCaptureProvenance, IconExtractRecord, IconExtractBase, IconAcquisition, IconAcquireOptions, IconExtract } from './internal/icon-types.ts';
export type { IconBounds, IconCell, IconObjectSource, IconFieldMetadata, IconFieldRecord, IconSourceObject, IconGrid, IconCaptureProvenance, IconExtractRecord, IconExtractBase, IconAcquisition, IconAcquireOptions, IconExtract } from './internal/icon-types.ts';
export { ICON_BASE, ICON_MODEL_LEVELS, ICON_FORECAST_HOURS, ICON_SEMANTICS, discoverIconRun, normalizeIconExtract, writeIconAcquisition, readIconAcquisition, acquireIcon } from './internal/icon-native.ts';
import type { AtmosphericColumn, NormalizedColumnRecord, FieldSemantics } from '@windgrams/contracts';
import { parseNormalizedColumnRecord } from '@windgrams/contracts';
import { modelDescriptor } from './registry.ts';
import type { SiteLocation } from './registry.ts';
import type { Bounds, Position } from '@windgrams/geography';
import type { AcquisitionAdapter, NormalizedColumnsResult } from './types.ts';
import { requestedForecastHours } from './internal/acquisition.ts';
/** Pair a native ICON column with its source, grid and field metadata. Return null for a missing cell or hour. */
export function iconColumnRecord(acquired: IconAcquisition, hourIndex: number, cellIndex: number): NormalizedColumnRecord | null {
  const hour = acquired.hours[hourIndex], cell = acquired.cells[cellIndex], column = hour?.sources[cellIndex];
  if (!column || !cell) return null;
  const id = `DWD:icon-eu:${acquired.referenceTime}`;
  const fieldSemantics: Record<string, FieldSemantics> = {};
  const start = new Date(Date.parse(hour.validAt) - 3_600_000).toISOString();
  const fields: Record<string, [string, string, 'instant' | 'mean' | 'accumulation' | 'maximum']> = {
    temperatureC: ['T_2M', 'degC', 'instant'], dewPointDepressionC: ['T_2M/TD_2M', 'degC', 'instant'],
    windSpeedMps: ['U_10M/V_10M', 'm/s', 'instant'], windDirectionDeg: ['U_10M/V_10M', 'degree', 'instant'],
    windGustMps: ['VMAX_10M', 'm/s', 'maximum'], sensibleHeatFluxWm2: ['ASHFL_S', 'W/m2', 'mean'],
    latentHeatFluxWm2: ['ALHFL_S', 'W/m2', 'mean'], precipitationMm: ['TOT_PREC', 'mm', 'accumulation'],
    pblHeightM: ['MH', 'm', 'instant'], levels: ['P/T/QV/U/V/HHL', 'native-levels', 'instant'],
  };
  for (const [key, [sourceField, unit, kind]] of Object.entries(fields)) {
    fieldSemantics[key] = { sourceRunId: id, sourceField, unit, sampling: key === 'levels' ? 'native' : 'derived',
      timeSupport: kind === 'instant' ? { kind, validAt: hour.validAt } : { kind, start, end: hour.validAt },
      ...(key.endsWith('HeatFluxWm2') ? { positiveDirection: 'upward' as const, normalization: 'Successive run means converted to preceding-hour upward mean' } : {}),
      ...(key === 'pblHeightM' ? { heightDatum: 'AGL' as const } : key === 'levels' ? { heightDatum: 'MSL' as const } : {}) };
  }
  const record: NormalizedColumnRecord = { schemaVersion: 1, column, modelElevationM: cell.terrainM, provenance: {
    sources: [{ id, provider: 'DWD', product: ICON_BASE, model: 'icon-eu', referenceTime: acquired.referenceTime, acquiredAt: acquired.provenance.capturedAt, gridId: acquired.grid.uuid }],
    fieldSemantics, gridCell: { id: String(cell.index), latitude: cell.latitude, longitude: cell.longitude, gridIndex: cell.index },
    capabilities: { verticalCoordinates: 'model-levels', ensemble: 'deterministic', fields: { temperature: 'available', wind: 'available', heatFluxes: 'available', verticalVelocity: 'unsupported', cloudProfile: 'unsupported' } },
  } };
  if (!parseNormalizedColumnRecord(record)) throw new Error('Invalid normalized ICON column');
  return record;
}
export interface IconAdapterResult extends NormalizedColumnsResult { native: IconAcquisition }
export function createIconAdapter(options: Omit<IconAcquireOptions, 'referenceTime' | 'sites' | 'cacheDir'> & { acquire?: typeof acquireIcon } = {}): AcquisitionAdapter<IconAdapterResult> {
  const model = modelDescriptor('icon-eu');
  return { model, async acquire(request) {
    if (request.run.model !== 'icon-eu' || request.run.provider !== 'DWD') throw new Error('Requested source does not match ICON adapter');
    if (!request.cacheDir) throw new Error('ICON requires an explicit cache directory');
    if (!request.sites.length) throw new Error('Acquisition requires at least one site');
    const forecastHours = requestedForecastHours(options.forecastHours ?? model.forecastHours, request.maxSteps);
    const native = await (options.acquire ?? acquireIcon)({ ...options, forecastHours, sites: request.sites, referenceTime: request.run.referenceTime, cacheDir: request.cacheDir });
    if (Date.parse(native.referenceTime) !== Date.parse(request.run.referenceTime)) throw new Error('ICON acquisition returned a different run');
    if (native.hours.length !== forecastHours.length || native.hours.some((hour, index) =>
      hour.forecastHour !== forecastHours[index] || Date.parse(hour.validAt) !== Date.parse(request.run.referenceTime) + forecastHours[index] * 3_600_000)) {
      throw new Error('ICON acquisition returned a different forecast horizon');
    }
    const indices = [...new Set(request.sites.map(site => native.siteCells[site.slug]))];
    if (indices.some(index => !Number.isInteger(index))) throw new Error('ICON acquisition is missing a requested site');
    const columns = native.hours.flatMap((_, hour) => indices.map(index => {
      const record = iconColumnRecord(native, hour, index);
      if (!record) throw new Error(`ICON acquisition has a missing selected column: hour ${hour}, cell ${index}`);
      return record;
    }));
    return { kind: 'normalized-columns', stage: 'normalized', run: request.run, columns, native };
  } };
}
