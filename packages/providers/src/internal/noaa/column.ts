import type { AtmosphericColumn, AtmosphericLevel, FieldSemantics, NormalizedColumnRecord } from '@windgrams/contracts';
import { dewPointC, dewPointDepressionC } from '@azohra/meteo.briefing/derive';
import { parseNormalizedColumnRecord } from '@windgrams/contracts';
import type { NoaaColumnOptions, NoaaGrid, NoaaCell, NoaaAcquireOptions } from './types.ts';
import { wind } from './grid.ts';
import { pressureLevelsFor } from './fields.ts';
import { validAt } from './intervals.ts';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const modelFor = (c: NoaaColumnOptions) => c.model ?? 'hrrr-conus';
const optional = ['windGustMps', 'capeJkg', 'cinJkg', 'pblHeightM', 'lowCloudPercent', 'midCloudPercent', 'highCloudPercent'] as const;

export function cellSource(c: NoaaColumnOptions, grid: NoaaGrid, cell: { longitude: number }, hour: number, raw: Readonly<Record<string, number | null | undefined>>): AtmosphericColumn | null {
  const surfaceWind = wind(grid, cell.longitude, raw.u, raw.v);
  const required = ['temperature', 'dewpoint', 'cloudCoverPercent', 'latentHeatFluxWm2', 'sensibleHeatFluxWm2', 'precipitationMm', 'seaLevelPressureHpa'];
  if (!surfaceWind || !required.every(k => finite(raw[k]))) return null;
  const source: AtmosphericColumn & { levels: AtmosphericLevel[] } = {
    validAt: validAt(c.referenceTime, hour),
    temperatureC: raw.temperature! - 273.15,
    dewPointDepressionC: raw.temperature! - raw.dewpoint!,
    ...surfaceWind,
    cloudCoverPercent: raw.cloudCoverPercent,
    latentHeatFluxWm2: raw.latentHeatFluxWm2,
    sensibleHeatFluxWm2: raw.sensibleHeatFluxWm2,
    precipitationMm: raw.precipitationMm! * (modelFor(c) === 'hrrr-conus' ? 3600 : 1),
    seaLevelPressureHpa: raw.seaLevelPressureHpa! / 100,
    levels: [],
  };
  for (const key of optional) if (finite(raw[key])) source[key] = raw[key]!;
  if (finite(raw.u80m) && finite(raw.v80m)) {
    const w80 = wind(grid, cell.longitude, raw.u80m, raw.v80m);
    if (w80) {
      source.wind80mSpeedMps = w80.windSpeedMps;
      source.wind80mDirectionDeg = w80.windDirectionDeg;
    }
  }
  for (const extKey of ['nativeCloudCeilingM', 'nativeCloudBaseM', 'nativeCloudTopM', 'nativeAdiabaticLclM', 'nativeLfcM', 'nativeEquilibriumLevelM'] as const) {
    if (finite(raw[extKey])) source[extKey] = raw[extKey]!;
  }
  if (['smoke.surfaceUgm3', 'smoke.columnMgm2', 'smoke.aot'].every(k => finite(raw[k]))) {
    source.smoke = { surfaceUgm3: raw['smoke.surfaceUgm3']! * 1e9, columnMgm2: raw['smoke.columnMgm2']! * 1e6, aot: raw['smoke.aot']! };
  }
  for (const p of c.pressureLevels ?? pressureLevelsFor(modelFor(c))) {
    const get = (key: string) => raw[`${p}.${key}`];
    const w = wind(grid, cell.longitude, get('UGRD'), get('VGRD'));
    if (!w || !['TMP', 'DPT', 'HGT'].every(k => finite(get(k)))) continue;
    const level: AtmosphericLevel = {
      pressureHpa: p,
      heightM: get('HGT')!,
      temperatureC: get('TMP')! - 273.15,
      dewPointDepressionC: modelFor(c) === 'gfs' ? dewPointDepressionC(get('TMP')! - 273.15, dewPointC(get('TMP')! - 273.15, get('DPT')!)) : get('TMP')! - get('DPT')!,
      ...w,
    };
    if (finite(get('VVEL')!)) level.verticalVelocityPaS = modelFor(c) === 'rrfs'
      ? -(p * 100 * 9.80665 * get('VVEL')!) / (287.05 * get('TMP')!)
      : get('VVEL')!;
    if (finite(get('TCDC'))) level.cloudFractionPercent = get('TCDC')!;
    source.levels.push(level);
  }
  if (finite(raw.surfacePressureHpa)) source.surfacePressureHpa = raw.surfacePressureHpa / 100;
  return source;
}


/** Attach the source and measurement support to a normalized column; no diagnostics are derived here. */
export function columnRecord(column: NormalizedColumnRecord['column'], cell: NoaaCell, options: NoaaAcquireOptions, capturedAt: string, gridId: string): NormalizedColumnRecord {
  const mode = options.verticalMode ?? 'legacy-pressure', sourceId = `NOAA:${options.model}:${options.referenceTime}:${mode}`;
  const fieldSemantics: Record<string, FieldSemantics> = {};
  const intervalFields = ['precipitationMm', 'sensibleHeatFluxWm2', 'latentHeatFluxWm2'];
  const metadata: Record<string, [string, string]> = {
    temperatureC: ['TMP:2 m above ground', 'degC'], dewPointDepressionC: ['TMP/DPT:2 m above ground', 'degC'],
    windSpeedMps: ['UGRD/VGRD:10 m above ground', 'm/s'], windDirectionDeg: ['UGRD/VGRD:10 m above ground', 'degree'],
    wind80mSpeedMps: ['UGRD/VGRD:80 m above ground', 'm/s'], wind80mDirectionDeg: ['UGRD/VGRD:80 m above ground', 'degree'],
    surfacePressureHpa: ['PRES:surface', 'hPa'], seaLevelPressureHpa: [options.model === 'rrfs' ? 'MSLET:mean sea level' : options.model === 'gfs' ? 'PRMSL:mean sea level' : 'MSLMA:mean sea level', 'hPa'],
    sensibleHeatFluxWm2: ['SHTFL:surface', 'W/m2'], latentHeatFluxWm2: ['LHTFL:surface', 'W/m2'],
    precipitationMm: [options.model !== 'hrrr-conus' ? 'APCP:surface' : 'PRATE:surface', 'mm/h'],
    pblHeightM: ['HPBL:surface', 'm'], levels: [mode === 'hrrr-native' ? 'PRES/HGT/TMP/SPFH/UGRD/VGRD:hybrid level' : options.model === 'gfs' ? 'HGT/TMP/RH/UGRD/VGRD/TCDC:isobaric' : 'HGT/TMP/DPT/UGRD/VGRD:isobaric', mode === 'hrrr-native' ? 'model-levels' : 'pressure-levels'],
    cloudCoverPercent: [options.model === 'rrfs' ? 'TCDC:entire atmosphere (considered as a single layer)' : 'TCDC:entire atmosphere', '%'], lowCloudPercent: ['LCDC:low cloud layer', '%'], midCloudPercent: ['MCDC:middle cloud layer', '%'], highCloudPercent: ['HCDC:high cloud layer', '%'],
    capeJkg: ['CAPE:surface', 'J/kg'], cinJkg: ['CIN:surface', 'J/kg'], windGustMps: ['GUST:surface', 'm/s'],
    nativeCloudCeilingM: ['HGT:cloud ceiling', 'm'], nativeCloudBaseM: ['HGT:cloud base', 'm'], nativeCloudTopM: ['HGT:cloud top', 'm'], nativeAdiabaticLclM: ['HGT:level of adiabatic condensation from sfc', 'm'], nativeLfcM: ['HGT:level of free convection', 'm'], nativeEquilibriumLevelM: ['HGT:equilibrium level', 'm'],
    smoke: ['MASSDEN/COLMD/AOTK', 'ug/m3; mg/m2; dimensionless'],
  };
  for (const [key, [sourceField, unit]] of Object.entries(metadata)) {
    if (column[key as keyof typeof column] == null) continue;
    const gfsInterval = options.model === 'gfs' && intervalFields.includes(key);
    const rrfsRain = options.model === 'rrfs' && key === 'precipitationMm';
    const intervalHours = gfsInterval ? 3 : rrfsRain ? 1 : 0;
    const normalization = ['noaa-columns-1', 'SI normalization'];
    if (rrfsRain) normalization.push('raw preceding-hour accumulation divided by one hour to mm/h');
    if (key === 'levels') normalization.push('supplied HGT geopotential height retained in the model MSL convention (no geometric/geoid adjustment)');
    normalization.push('grid-relative wind rotated once when required', 'no vertical extrapolation');
    if (gfsInterval) normalization.push('six-hour boundary windows recovered using verified companion three-hour fields');
    const heightDatum = key === 'pblHeightM' ? 'AGL' : key === 'levels' || key.startsWith('native') ? 'MSL' : undefined;
    fieldSemantics[key] = {
      sourceRunId: sourceId, sourceField, unit,
      timeSupport: intervalHours
        ? { kind: 'mean', start: new Date(Date.parse(column.validAt) - intervalHours * 3_600_000).toISOString(), end: column.validAt }
        : { kind: 'instant', validAt: column.validAt },
      sampling: key === 'levels' ? mode === 'hrrr-native' ? 'native' : 'interpolated' : 'derived',
      ...(heightDatum ? { heightDatum } : {}),
      ...(key.endsWith('HeatFluxWm2') ? { positiveDirection: 'upward' as const } : {}),
      normalization: normalization.join('; '),
    };
  }
  const product = mode === 'hrrr-native' ? 'hrrr/conus/wrfnat+wrfprs'
    : options.model === 'rrfs' ? 'rrfs/prslev+2dfld.3km.conus'
    : options.model === 'gfs' ? 'gfs/atmos/pgrb2.0p25' : 'hrrr/conus/wrfprs';
  const cloudProfile = options.model !== 'gfs' ? 'unsupported'
    : column.levels.some(level => level.cloudFractionPercent != null) ? 'available' : 'unknown';
  const record: NormalizedColumnRecord = {
    schemaVersion: 1, column, modelElevationM: cell.modelElevationM,
    provenance: {
      sources: [{ id: sourceId, provider: 'NOAA', model: options.model, product,
        referenceTime: options.referenceTime, acquiredAt: capturedAt, gridId }],
      fieldSemantics,
      gridCell: { id: cell.id, latitude: cell.latitude, longitude: cell.longitude, gridIndex: cell.index },
      capabilities: {
        verticalCoordinates: mode === 'hrrr-native' ? 'model-levels' : 'pressure-levels',
        ensemble: 'deterministic',
        fields: {
          levels: 'available', wind: 'available', temperature: 'available', heatFluxes: 'available', cloudProfile,
          surfacePressure: column.surfacePressureHpa == null ? 'unknown' : 'available',
        },
      },
    },
  };
  if (!parseNormalizedColumnRecord(record)) throw new Error('NOAA normalization violated its column contract');
  return record;
}

