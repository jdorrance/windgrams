// HRRR selection and conversions frozen from meteo.forecast 0.6.0's NOAA builder.
// Keys identify raw quantities; conversions happen only after decoding.
const spec = (key, variable, level, required = true, conversion = 'identity') => ({ key, variable, level, required, conversion });
// GRIB2 discipline 0, HRRR/NCEP parameter and fixed-surface codes. Checked
// against the captured indices and decoded product definitions independently.
export const parameters = { TMP: [0,0], DPT: [0,6], UGRD: [2,2], VGRD: [2,3], HGT: [3,5], VVEL: [2,8],
  TCDC: [6,1], LHTFL: [0,10], SHTFL: [0,11], PRATE: [1,7], MSLMA: [3,198], GUST: [2,22],
  CAPE: [7,6], CIN: [7,7], HPBL: [3,18], LCDC: [6,3], MCDC: [6,4], HCDC: [6,5], MASSDEN: [20,0], COLMD: [20,1], AOTK: [20,102] };
export function fixedSurface(level) {
  if (level.endsWith(' mb')) return [100, Number(level.split(' ')[0]) * 100];
  if (level.endsWith('m above ground')) return [103, Number(level.split(' ')[0])];
  return [{ surface: 1, 'mean sea level': 101, 'entire atmosphere': 10,
    'entire atmosphere (considered as a single layer)': 200, 'low cloud layer': 214,
    'middle cloud layer': 224, 'high cloud layer': 234 }[level], 0];
}
export function fields(c, hour) {
  if (hour === c.terrainForecastHour) return [spec('terrain', 'HGT', 'surface')];
  return [
    spec('temperature', 'TMP', '2 m above ground', true, 'K → °C: subtract 273.15'),
    spec('dewpoint', 'DPT', '2 m above ground', true, 'K → °C: subtract 273.15'),
    spec('u', 'UGRD', '10 m above ground'), spec('v', 'VGRD', '10 m above ground'),
    spec('cloudCoverPercent', 'TCDC', 'entire atmosphere'),
    spec('latentHeatFluxWm2', 'LHTFL', 'surface'),
    spec('sensibleHeatFluxWm2', 'SHTFL', 'surface'),
    spec('precipitationMm', 'PRATE', 'surface', true, 'kg m⁻² s⁻¹ → mm/hr: ×3600'),
    spec('seaLevelPressureHpa', 'MSLMA', 'mean sea level', true, 'Pa → hPa: ÷100'),
    ...[['windGustMps','GUST','surface'], ['capeJkg','CAPE','surface'], ['cinJkg','CIN','surface'],
      ['pblHeightM','HPBL','surface'], ['lowCloudPercent','LCDC','low cloud layer'],
      ['midCloudPercent','MCDC','middle cloud layer'], ['highCloudPercent','HCDC','high cloud layer']]
      .map(([key, variable, level]) => spec(key, variable, level, false)),
    spec('smoke.surfaceUgm3', 'MASSDEN', '8 m above ground', false, 'kg/m³ → µg/m³: ×1e9'),
    spec('smoke.columnMgm2', 'COLMD', 'entire atmosphere (considered as a single layer)', false, 'kg/m² → mg/m²: ×1e6'),
    spec('smoke.aot', 'AOTK', 'entire atmosphere (considered as a single layer)', false),
    ...c.pressureLevels.flatMap(p => ['TMP','DPT','HGT','UGRD','VGRD','VVEL'].map(v =>
      spec(`${p}.${v}`, v, `${p} mb`, v !== 'VVEL', ['TMP','DPT'].includes(v) ? 'K → °C: subtract 273.15' : v === 'VVEL' ? 'omega, Pa/s (no geometric conversion)' : 'identity'))),
  ];
}

export function selectRecords(records, c, hour) {
  return fields(c, hour).map(field => {
    const matches = records.filter(r => r.variable === field.variable && r.level === field.level && r.forecast === `${hour} hour fcst`);
    if (!matches.length && field.required) throw new Error(`Missing required record f${hour} ${field.key}`);
    if (matches.length > 1) throw new Error(`Ambiguous record f${hour} ${field.key}`);
    const record = matches[0];
    if (record && (!Number.isInteger(record.length) || record.length <= 0)) throw new Error(`Unsupported open/paired range: ${field.key}`);
    return { ...field, record: record ?? null };
  });
}
