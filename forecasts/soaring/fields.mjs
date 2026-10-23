// HRRR selection and conversions frozen from meteo.forecast 0.6.0's NOAA builder,
// plus optional extended real pressure levels (1000..400 hPa), 80 m AGL winds,
// and native HRRR cloud/LCL/convective records from the wrfprs inventory.
// Keys identify raw quantities; conversions happen only after decoding.
const spec = (key, variable, level, required = true, conversion = 'identity') => ({ key, variable, level, required, conversion });

export const LEGACY_V1_PRESSURE_LEVELS = Object.freeze([925, 900, 875, 850, 800, 750, 700, 650, 600]);
export const EXTENDED_HRRR_PRESSURE_LEVELS = Object.freeze([
  1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 700, 650, 600, 550, 500, 450, 400,
]);

// GRIB2 discipline 0, HRRR/NCEP parameter and fixed-surface codes. Checked
// against the captured indices and decoded product definitions independently.
export const parameters = {
  TMP: [0, 0], DPT: [0, 6], UGRD: [2, 2], VGRD: [2, 3], HGT: [3, 5], VVEL: [2, 8],
  TCDC: [6, 1], LHTFL: [0, 10], SHTFL: [0, 11], PRATE: [1, 7], MSLMA: [3, 198], GUST: [2, 22],
  CAPE: [7, 6], CIN: [7, 7], HPBL: [3, 18], LCDC: [6, 3], MCDC: [6, 4], HCDC: [6, 5],
  MASSDEN: [20, 0], COLMD: [20, 1], AOTK: [20, 102],
  MAXUVV: [2, 220], MAXDVV: [2, 221],
};

export function fixedSurface(level) {
  if (level.endsWith(' mb') && !level.includes('-')) return [100, Number(level.split(' ')[0]) * 100];
  if (level.endsWith('m above ground')) return [103, Number(level.split(' ')[0])];
  return [{
    surface: 1,
    'cloud base': 2,
    'cloud top': 3,
    '0C isotherm': 4,
    'level of adiabatic condensation from sfc': 5,
    'level of free convection': 7,
    'entire atmosphere': 10,
    'mean sea level': 101,
    'entire atmosphere (considered as a single layer)': 200,
    'low cloud layer': 214,
    'cloud ceiling': 215,
    'middle cloud layer': 224,
    'high cloud layer': 234,
    'equilibrium level': 247,
  }[level], 0];
}

export const EXTENDED_BOUNDARY_LAYER_SPECS = Object.freeze([
  spec('u80m', 'UGRD', '80 m above ground', false),
  spec('v80m', 'VGRD', '80 m above ground', false),
  spec('nativeCloudCeilingM', 'HGT', 'cloud ceiling', false),
  spec('nativeCloudBaseM', 'HGT', 'cloud base', false),
  spec('nativeCloudTopM', 'HGT', 'cloud top', false),
  spec('nativeAdiabaticLclM', 'HGT', 'level of adiabatic condensation from sfc', false),
  spec('nativeLfcM', 'HGT', 'level of free convection', false),
  spec('nativeEquilibriumLevelM', 'HGT', 'equilibrium level', false),
]);

export function fields(c, hour) {
  if (hour === c.terrainForecastHour) return [spec('terrain', 'HGT', 'surface')];
  const base = [
    spec('temperature', 'TMP', '2 m above ground', true, 'K → °C: subtract 273.15'),
    spec('dewpoint', 'DPT', '2 m above ground', true, 'K → °C: subtract 273.15'),
    spec('u', 'UGRD', '10 m above ground'), spec('v', 'VGRD', '10 m above ground'),
    spec('cloudCoverPercent', 'TCDC', 'entire atmosphere'),
    spec('latentHeatFluxWm2', 'LHTFL', 'surface'),
    spec('sensibleHeatFluxWm2', 'SHTFL', 'surface'),
    spec('precipitationMm', 'PRATE', 'surface', true, 'kg m⁻² s⁻¹ → mm/hr: ×3600'),
    spec('seaLevelPressureHpa', 'MSLMA', 'mean sea level', true, 'Pa → hPa: ÷100'),
    ...[['windGustMps', 'GUST', 'surface'], ['capeJkg', 'CAPE', 'surface'], ['cinJkg', 'CIN', 'surface'],
      ['pblHeightM', 'HPBL', 'surface'], ['lowCloudPercent', 'LCDC', 'low cloud layer'],
      ['midCloudPercent', 'MCDC', 'middle cloud layer'], ['highCloudPercent', 'HCDC', 'high cloud layer']]
      .map(([key, variable, level]) => spec(key, variable, level, false)),
    spec('smoke.surfaceUgm3', 'MASSDEN', '8 m above ground', false, 'kg/m³ → µg/m³: ×1e9'),
    spec('smoke.columnMgm2', 'COLMD', 'entire atmosphere (considered as a single layer)', false, 'kg/m² → mg/m²: ×1e6'),
    spec('smoke.aot', 'AOTK', 'entire atmosphere (considered as a single layer)', false),
  ];
  if (c.includeExtendedFields) base.push(...EXTENDED_BOUNDARY_LAYER_SPECS);
  const levels = c.pressureLevels ?? LEGACY_V1_PRESSURE_LEVELS;
  base.push(
    ...levels.flatMap(p => ['TMP', 'DPT', 'HGT', 'UGRD', 'VGRD', 'VVEL'].map(v =>
      spec(`${p}.${v}`, v, `${p} mb`, v !== 'VVEL', ['TMP', 'DPT'].includes(v) ? 'K → °C: subtract 273.15' : v === 'VVEL' ? 'omega, Pa/s (converted to geometric w in v2)' : 'identity'))),
  );
  return base;
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
