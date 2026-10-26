import type { IdxRecord } from '@azohra/meteo.grib';
import type { AtmosphericColumn, AtmosphericLevel } from '@windgrams/contracts';
import type { LambertGrid } from '@azohra/meteo.grib';
import type { NoaaSelection } from './types.ts';
import { wind } from './grid.ts';
import { specificHumidityDewpointC } from '../thermodynamics.ts';

// Verified operational HRRR wrfnat inventory: 50 model levels, numbered 1..50.
export const HRRR_NATIVE_LEVEL_COUNT = 50;

/** Require complete, contiguous native-level fields. Missing inventory never falls back silently. */
export function selectNativeRecords(records: readonly IdxRecord[], hour: number): NoaaSelection[] {
  const levels = [...new Set(records.filter(r => r.variable === 'PRES' && /^\d+ hybrid level$/.test(r.level) && r.forecast === `${hour} hour fcst`).map(r => Number(r.level.split(' ')[0])))].sort((a, b) => a - b);
  if (levels.length !== HRRR_NATIVE_LEVEL_COUNT || levels[0] !== 1 || levels.some((level, i) => level !== i + 1)) throw new Error('HRRR native inventory requires all 50 contiguous PRES hybrid levels beginning at 1');
  return levels.flatMap(level => ['PRES', 'HGT', 'TMP', 'SPFH', 'UGRD', 'VGRD', 'VVEL'].map(variable => {
    const matches = records.filter(r => r.variable === variable && r.level === `${level} hybrid level` && r.forecast === `${hour} hour fcst`);
    if (matches.length > 1 || (matches.length === 0 && variable !== 'VVEL')) throw new Error(`Incomplete/ambiguous HRRR native inventory: ${level}.${variable}`);
    const record = matches[0] ?? null;
    if (record && (!Number.isInteger(record.length) || record.length! <= 0)) throw new Error('Native field requires a closed byte range');
    return { key: `native.${level}.${variable}`, variable, level: `${level} hybrid level`, required: variable !== 'VVEL', conversion: variable === 'SPFH' ? 'specific humidity kg/kg and pressure Pa → vapor pressure → dewpoint °C' : 'native units normalized after decoding', product: 'wrfnat', record };
  }));
}

/** Uses supplied PRES and HGT: no guessed hybrid coefficients or synthesized vertical levels. */
export function nativeColumn(surface: AtmosphericColumn, grid: LambertGrid, longitude: number, terrainM: number, raw: Readonly<Record<string, number | null | undefined>>, selections: readonly NoaaSelection[]): AtmosphericColumn | null {
  const identifiers = selections.filter(s => s.variable === 'PRES').map(s => Number(s.level.split(' ')[0]));
  const levels: AtmosphericLevel[] = [];
  for (const modelLevel of identifiers) {
    const get = (key: string) => raw[`native.${modelLevel}.${key}`];
    const pressure = get('PRES'), height = get('HGT'), temperature = get('TMP'), q = get('SPFH');
    if (typeof pressure !== 'number' || typeof height !== 'number' || typeof temperature !== 'number' || typeof q !== 'number' || ![pressure, height, temperature, q].every(Number.isFinite)) return null;
    if (height <= terrainM || (surface.surfacePressureHpa != null && pressure > surface.surfacePressureHpa * 100)) continue;
    const vector = wind(grid, longitude, get('UGRD'), get('VGRD')), dewPointC = specificHumidityDewpointC(q, pressure);
    if (!vector || dewPointC === null || temperature <= 0) return null;
    const omega = get('VVEL');
    levels.push({ modelLevel, pressureHpa: pressure / 100, heightM: height, temperatureC: temperature - 273.15, dewPointC, ...vector, ...(typeof omega === 'number' && Number.isFinite(omega) ? { verticalVelocityPaS: omega } : {}) });
  }
  levels.sort((a, b) => a.heightM - b.heightM);
  if (levels.length < 2 || levels.some((level, i) => i > 0 && (level.heightM <= levels[i - 1].heightM || level.pressureHpa >= levels[i - 1].pressureHpa))) return null;
  return { ...surface, levels };
}
