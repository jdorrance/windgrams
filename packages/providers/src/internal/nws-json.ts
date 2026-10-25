import { object } from './json.ts';
import type { NwsPointResponse, NwsGridResponse, NwsHourlyResponse, NwsPeriodsResponse } from './nws-types.ts';
const text = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: unknown) => value == null || text(value);
const number = (value: unknown): value is number => typeof value === 'number';

export function parsePoint(raw: unknown): NwsPointResponse {
  if (!object(raw) || !object(raw.properties)) throw new Error('Invalid NWS point response');
  const p = raw.properties;
  if (!['gridId', 'forecastGridData', 'forecastHourly', 'forecast'].every(key => text(p[key]))
    || !number(p.gridX) || !number(p.gridY)) throw new Error('Invalid NWS point coordinates or endpoints');
  return raw as unknown as NwsPointResponse;
}

export function parseGrid(raw: unknown): NwsGridResponse {
  if (!object(raw) || !object(raw.properties)) throw new Error('Invalid NWS grid response');
  const p = raw.properties;
  if (!optionalText(p.updateTime)) throw new Error('Invalid NWS grid update time');
  if (p.elevation !== undefined && (!object(p.elevation) || !text(p.elevation.unitCode)
    || !(p.elevation.value === null || number(p.elevation.value)))) throw new Error('Invalid NWS grid elevation');
  for (const key of ['temperature', 'dewpoint', 'relativeHumidity', 'skyCover', 'windDirection', 'windSpeed', 'windGust',
    'probabilityOfPrecipitation', 'probabilityOfThunder', 'lightningActivityLevel', 'mixingHeight', 'transportWindDirection',
    'transportWindSpeed', 'ceilingHeight', 'visibility', 'weather']) {
    const layer = p[key];
    if (layer === undefined) continue;
    if (!object(layer) || !optionalText(layer.uom) || !Array.isArray(layer.values)
      || !layer.values.every(item => object(item) && text(item.validTime) && (item.value === null || (key === 'weather'
        ? Array.isArray(item.value) && item.value.every(condition => object(condition)
          && ['coverage', 'intensity', 'weather'].every(field => condition[field] == null || text(condition[field])))
        : number(item.value))))) throw new Error(`Invalid NWS ${key} layer`);
  }
  return raw as unknown as NwsGridResponse;
}

export function parseHourly(raw: unknown): NwsHourlyResponse | null {
  if (raw === null) return null;
  if (!object(raw) || !object(raw.properties) || !optionalText(raw.properties.updateTime)
    || !Array.isArray(raw.properties.periods) || !raw.properties.periods.every(period => object(period)
      && text(period.startTime) && (period.shortForecast == null || text(period.shortForecast)))) throw new Error('Invalid NWS hourly response');
  return raw as unknown as NwsHourlyResponse;
}

export function parsePeriods(raw: unknown): NwsPeriodsResponse | null {
  if (raw === null) return null;
  if (!object(raw) || !object(raw.properties) || !optionalText(raw.properties.updateTime)
    || !Array.isArray(raw.properties.periods) || !raw.properties.periods.every(period => object(period)
      && ['name', 'startTime', 'endTime', 'shortForecast', 'detailedForecast'].every(key => text(period[key]))
      && typeof period.isDaytime === 'boolean')) throw new Error('Invalid NWS text forecast response');
  return raw as unknown as NwsPeriodsResponse;
}
