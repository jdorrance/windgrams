// Review quantities: these are comparison hypotheses, not claims of equal algorithms.
import { number } from './html.mjs';
import { CONVERGENCE_DISTINCTION } from '../definitions.mjs';
export const GUIDE = 'http://wxtofly.net/windgramexplain.html';
export const PARAMETERS = 'http://www.drjack.info/RASP/INFO/parameters.html';
const define = (id, label, unit, wx, ours, scale = 1, offset = 0, qualification = null) => ({
  id,
  label,
  unit,
  wx,
  ours,
  scale,
  offset,
  qualification,
  heightReference: /MSL/.test(label)
    ? 'MSL'
    : /AGL/.test(label)
      ? 'each-model AGL'
      : /10 m/.test(label)
        ? '10 m AGL'
        : /2 m/.test(label)
          ? '2 m AGL'
          : 'diagnostic layer or scalar',
  interval: 'valid-time diagnostic; heat-flux interval unresolved and excluded',
  missing: 'blank, dash or invalid text → null; zero retained',
  originalWxUnit:
    scale === 0.3048 ? 'ft' : scale === 0.00508 ? 'ft/min' : scale === 1852 / 3600 ? 'kt' : offset !== 0 ? '°F' : unit,
  precision: 'preserve printed source text; no precision inferred beyond published digits',
  status: qualification ? 'qualified' : 'comparable',
  source: GUIDE,
});
export const FIELDS = [
  define('wind10m', '10 m wind speed', 'm/s', '10M_Wind_Sp_Kt', 'surface.windSpeedMps', 1852 / 3600),
  define('wind10mDirection', '10 m wind direction', '°', '10M_Wind_Dir', 'surface.windDirectionDeg'),
  define('temperature2m', '2 m temperature', '°C', 'Temp@2m', 'surface.temperatureC', 5 / 9, (-32 * 5) / 9),
  define('dewPoint2m', '2 m dew point', '°C', 'DewPt@2m', 'surface.dewPointC', 5 / 9, (-32 * 5) / 9),
  define(
    'thermalVelocity',
    'Convective velocity W*',
    'm/s',
    'Up_Velocity fpm',
    'soaring.thermalVelocityV2Mps',
    0.00508,
    0,
    'Different model fluxes and convective-depth definitions; W* is not glider net climb.',
  ),
  define(
    'thermalTop',
    'Thermal top (MSL)',
    'm',
    'BL_Top_TI=0',
    'soaring.resolvedThermalTopM',
    0.3048,
    0,
    'WxToFly thermal-index top and our resolved parcel top are method-dependent proxies.',
  ),
  define(
    'thermalDepth',
    'Resolved convective depth (model AGL)',
    'm',
    'BL_Depth_AGL',
    'resolvedDepthM',
    0.3048,
    0,
    'Derived depth; kept separate from native model PBL depth.',
  ),
  define(
    'lift225',
    'Glider ceiling at nominal 225 ft/min sink (MSL)',
    'm',
    'MaxSoar1.1m/s',
    'soaring.hcritWxtoflyM',
    0.3048,
    0,
    'Guide specifies 225 ft/min; row abbreviates 1.1 m/s. Ground-coded no-lift values are classified separately.',
  ),
  define(
    'surfaceLcl',
    'Surface parcel LCL (MSL)',
    'm',
    'CUbase_LCL',
    'soaring.surfaceLclM',
    0.3048,
    0,
    'Potential condensation level, not proof of cloud or usable lift.',
  ),
  define(
    'mixedLcl',
    'Mixed-layer LCL (MSL)',
    'm',
    'ODbase_allclds',
    'soaring.mixedLayerLclM',
    0.3048,
    0,
    'Layer definition and parcel averaging differ by forecast method.',
  ),
  define(
    'odPotential',
    'Overdevelopment potential',
    'm',
    'ODpot_if_cu',
    'soaring.odPotentialM',
    0.3048,
    0,
    'Method-dependent thermal top minus mixed-layer LCL; not cloud probability.',
  ),
  define(
    'blWind',
    'Boundary-layer mean wind speed',
    'm/s',
    'Avg_BLWindSpd',
    'soaring.blMeanWindSpeedMps',
    1852 / 3600,
    0,
    'Layer depth and averaging weights can differ.',
  ),
  define(
    'blDirection',
    'Boundary-layer mean wind direction',
    '°',
    'Avg_BlWindDir',
    'soaring.blMeanWindDirDeg',
    1,
    0,
    'Layer depth and averaging weights can differ.',
  ),
  define(
    'shear',
    'Boundary-layer wind shear',
    'm/s',
    'Wind_Shear',
    'soaring.blWindShearMps',
    1852 / 3600,
    0,
    'Numeric row often absent; layer boundaries differ and legacy row units need confirmation before scoring.',
  ),
  define(
    'blTopWind',
    'Boundary-layer top wind speed',
    'm/s',
    'BLTop_WdSp',
    'soaring.blTopWindSpeedMps',
    1852 / 3600,
    0,
    'Layer boundary differs; legacy row units need confirmation before scoring.',
  ),
  define(
    'buoyancyShear',
    'Buoyancy/shear ratio',
    '1',
    'Bouy/Shr_Ratio',
    'soaring.buoyancyShearRatio',
    1,
    0,
    'Different shear/depth definitions and denominator floors.',
  ),
  define(
    'cape',
    'CAPE',
    'J/kg',
    'CAPE_TSpoten',
    'surface.capeJkg',
    1,
    0,
    'Parcel selection may differ; compare as qualified CAPE guidance.',
  ),
  define(
    'sensibleHeat',
    'Surface sensible heating',
    'W/m²',
    'Sfc_Heating',
    'surface.sensibleHeatFluxWm2',
    1,
    0,
    'Averaging interval is not declared by the legacy table; retain as contextual, not interval-matched.',
  ),
];
// These fields cannot be made equivalent by merely changing units or labels.
export const EXCLUSIONS = {
  Sfc_Wind_Sp_Kt: 'Surface diagnostic height unspecified; use explicitly labelled 10 m winds.',
  Treetop_WSp_Kt: 'Treetop height unspecified; not equivalent to our 80 m wind.',
  Lev_Abv_WSp_Kt: 'Vertical level unspecified.',
  'cm/s_ Convergence': CONVERGENCE_DISTINCTION,
  MaxSoar_AGL: 'Used to identify no-lift at model ground; not an independent MSL ceiling.',
  MaxSoar_clds: 'Cloud-capping definition unresolved; do not alias to the 1 m/s ceiling.',
  'BL_Cloud_%': 'Boundary-layer cloud fraction is not total or low-cloud fraction.',
  msl_pressure: 'Legacy row unit unconfirmed and observed values absent.',
  '1hr_rain_acc':
    'One-hour accumulation cannot be scored against instantaneous rain rate; require explicit compatible intervals and units.',
  Hgt_Variab_: 'Terrain-height variability has no shared published equivalent.',
  BLTopWDir: 'Legacy row speed/height support absent; direction alone is not scored.',
};
export const REQUIRED_FAMILIES = [
  'surface wind',
  'upper-air wind',
  'temperature',
  'moisture',
  'lapse rate',
  'inversion',
  'freezing level',
  'precipitation',
  'cloud indicators',
  'heat flux',
  'CAPE',
  'native PBL depth',
  'thermal depth',
  'W*',
  'lift ceilings',
  'LCL',
  'layer wind',
  'shear',
  'vertical motion',
  'horizontal convergence',
];
export const scalar = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? v : v && typeof v === 'object' && Number.isFinite(v.p50) ? v.p50 : null;
export function ourValue(hour, field, terrainM) {
  if (field.ours === 'resolvedDepthM') {
    const top = scalar(hour.soaring?.resolvedThermalTopM);
    return top !== null && Number.isFinite(terrainM) ? top - terrainM : null;
  }
  const [group, key] = field.ours.split('.');
  return scalar(hour[group]?.[key]);
}
export function wxValue(hour, field) {
  const v = number(hour.raw[field.wx] ?? '');
  return v === null ? null : v * field.scale + field.offset;
}
export function windVector(speed, direction) {
  if (![speed, direction].every(Number.isFinite)) return null;
  const rad = (direction * Math.PI) / 180;
  return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
}
export function circularDifference(a, b) {
  return ((a - b + 540) % 360) - 180;
}
/** Bracketed vertical sampling; no below-ground samples, extrapolation or invented moisture. */
export function sampleProfile(levels, heightM, terrainM) {
  if (!Number.isFinite(heightM) || !Number.isFinite(terrainM) || heightM < terrainM) return null;
  const list = levels
    .filter((l) => Number.isFinite(l.heightM) && l.heightM >= terrainM)
    .sort((a, b) => a.heightM - b.heightM);
  const exact = list.find((l) => l.heightM === heightM);
  if (exact) return { ...exact, interpolated: false };
  const i = list.findIndex((l) => l.heightM > heightM);
  if (i < 1) return null;
  const a = list[i - 1],
    b = list[i],
    t = (heightM - a.heightM) / (b.heightM - a.heightM),
    out = { heightM, interpolated: true, bracketM: [a.heightM, b.heightM] };
  for (const key of ['temperatureC', 'dewPointC', 'pressureHpa'])
    out[key] = [a[key], b[key]].every(Number.isFinite) ? a[key] + t * (b[key] - a[key]) : null;
  const wa = windVector(a.windSpeedMps, a.windDirectionDeg),
    wb = windVector(b.windSpeedMps, b.windDirectionDeg);
  if (wa && wb) {
    const u = wa.u + t * (wb.u - wa.u),
      v = wa.v + t * (wb.v - wa.v);
    out.windSpeedMps = Math.hypot(u, v);
    out.windDirectionDeg = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
  } else {
    out.windSpeedMps = null;
    out.windDirectionDeg = null;
  }
  return out;
}
