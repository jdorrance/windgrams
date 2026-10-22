import type { SiteForecast } from '@azohra/meteo.briefing/contract';

export const DEFAULT_CASE = 'north-sound-20261021-00z';
export type Layer =
  | 'thermalVelocityMps'
  | 'usableLiftTopM'
  | 'hcritWxtoflyM'
  | 'dryHcritM'
  | 'resolvedThermalTopM'
  | 'boundaryLayerTopM'
  | 'pblHeightM'
  | 'surfaceLclM'
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

export type Quality = 'valid' | 'missing' | 'insufficient-levels';

export interface LevelArrays {
  h: (number | null)[];
  t: (number | null)[];
  td: (number | null)[];
  ws: (number | null)[];
  wd: (number | null)[];
  vv: (number | null)[];
}

export interface ReplayHour {
  forecastHour: number;
  validAt: string;
  thermalVelocityMps: (number | null)[];
  usableLiftTopM: (number | null)[];
  boundaryLayerTopM: (number | null)[];
  cloudBaseM: (number | null)[];
  pblHeightM: (number | null)[];
  resolvedThermalTopM?: (number | null)[];
  thermalTopPlus1CM?: (number | null)[];
  hcritWxtoflyM?: (number | null)[];
  dryHcritM?: (number | null)[];
  surfaceLclM?: (number | null)[];
  mixedLayerLclM?: (number | null)[];
  cuPotentialM?: (number | null)[];
  odPotentialM?: (number | null)[];
  blMeanWindSpeedMps?: (number | null)[];
  blMeanWindDirDeg?: (number | null)[];
  blTopWindSpeedMps?: (number | null)[];
  blTopWindDirDeg?: (number | null)[];
  blWindShearMps?: (number | null)[];
  buoyancyShearRatio?: (number | null)[];
  wind10mSpeedMps?: (number | null)[];
  wind10mDirDeg?: (number | null)[];
  windGustMps?: (number | null)[];
  wind925SpeedMps?: (number | null)[];
  wind925DirDeg?: (number | null)[];
  wind850SpeedMps?: (number | null)[];
  wind850DirDeg?: (number | null)[];
  maxUpwardVelocityMps?: (number | null)[];
  minDownwardVelocityMps?: (number | null)[];
  w925Mps?: (number | null)[];
  w850Mps?: (number | null)[];
  convergence10mX1e5?: (number | null)[];
  convergence925X1e5?: (number | null)[];
  sensibleHeatFluxWm2?: (number | null)[];
  latentHeatFluxWm2?: (number | null)[];
  cloudCoverPercent?: (number | null)[];
  lowCloudPercent?: (number | null)[];
  midCloudPercent?: (number | null)[];
  highCloudPercent?: (number | null)[];
  precipitationMmHr?: (number | null)[];
  capeJkg?: (number | null)[];
  cinJkg?: (number | null)[];
  sfcT?: (number | null)[];
  sfcTd?: (number | null)[];
  mslp?: (number | null)[];
  levelsByPressure?: Record<string, LevelArrays>;
  status: Quality[];
  levelCount: number[];
  ceilingReached: boolean[];
}

export interface ReplayManifest {
  schemaVersion: number;
  capturedAt: string;
  cellCount: number;
  siteCell: number;
  case: {
    id: string;
    referenceTime: string;
    bbox: [number, number, number, number];
    sinkMps: number;
    pressureLevels?: number[];
    site: { slug?: string; name: string; latitude: number; longitude: number; timeZone: string };
    launchElevation: { elevationM: number };
  };
  versions: { algorithm: string };
  hours: { forecastHour: number; validAt: string; file: string }[];
}

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

const M_TO_FT = 3.280839895;
const MPS_TO_MPH = 2.23693629;
const MPS_TO_FPM = 196.850394;

export const LAYER_SPECS: Record<Layer, LayerSpec> = {
  thermalVelocityMps: {
    id: 'thermalVelocityMps',
    label: 'Thermal strength W* · m/s (ft/min)',
    group: 'Thermal Opportunity',
    scale: 1,
    stops: [0, 0.5, 1, 2, 3],
    colors: ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'],
    legend: 'W* m/s: 0 ◻ · 0.5 pale blue (100 fpm) · 1.0 teal (200 fpm) · 2.0 gold (400 fpm) · 3.0+ red',
    format: v => `${v.toFixed(2)} m/s (${Math.round(v * MPS_TO_FPM)} ft/min)`,
  },
  usableLiftTopM: {
    id: 'usableLiftTopM',
    label: 'Usable-lift top (1.0 m/s sink) · ft MSL',
    group: 'Thermal Opportunity',
    scale: M_TO_FT,
    stops: [0, 1000, 2000, 5000, 10000],
    colors: ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'],
    legend: 'Usable top (1.0 m/s sink) ft MSL: 0 pale blue · 2,000 teal · 5,000 gold · 10,000+ red',
    format: v => `${Math.round(v * M_TO_FT).toLocaleString('en-US')} ft MSL (${v.toFixed(0)} m)`,
  },
  hcritWxtoflyM: {
    id: 'hcritWxtoflyM',
    label: 'WxToFly Hcrit (225 ft/min = 1.14 m/s sink) · ft MSL',
    group: 'Thermal Opportunity',
    scale: M_TO_FT,
    stops: [0, 1000, 2000, 5000, 10000],
    colors: ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'],
    legend: 'WxToFly Hcrit (225 ft/min sink) ft MSL: 0 pale blue · 2,000 teal · 5,000 gold · 10,000+ red',
    format: v => `${Math.round(v * M_TO_FT).toLocaleString('en-US')} ft MSL (${v.toFixed(0)} m)`,
  },
  dryHcritM: {
    id: 'dryHcritM',
    label: 'Dry Hcrit (unclipped by cloud base) · ft MSL',
    group: 'Thermal Opportunity',
    scale: M_TO_FT,
    stops: [0, 1000, 2000, 5000, 10000],
    colors: ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'],
    legend: 'Dry Hcrit ft MSL: 0 pale blue · 2,000 teal · 5,000 gold · 10,000+ red',
    format: v => `${Math.round(v * M_TO_FT).toLocaleString('en-US')} ft MSL (${v.toFixed(0)} m)`,
  },
  resolvedThermalTopM: {
    id: 'resolvedThermalTopM',
    label: 'Resolved thermal top (v2 sub-925 hPa) · ft MSL',
    group: 'Thermal Opportunity',
    scale: M_TO_FT,
    stops: [0, 1500, 3000, 6000, 10000],
    colors: ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'],
    legend: 'Resolved thermal top (v2) ft MSL: 0 pale blue · 3,000 teal · 6,000 gold · 10,000+ red',
    format: v => `${Math.round(v * M_TO_FT).toLocaleString('en-US')} ft MSL (${v.toFixed(0)} m)`,
  },
  boundaryLayerTopM: {
    id: 'boundaryLayerTopM',
    label: 'Baseline parcel top (v1) · ft MSL',
    group: 'Thermal Opportunity',
    scale: M_TO_FT,
    stops: [0, 1500, 3000, 6000, 10000],
    colors: ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'],
    legend: 'Baseline v1 parcel top ft MSL: 0 pale blue · 3,000 teal · 6,000 gold · 10,000+ red',
    format: v => `${Math.round(v * M_TO_FT).toLocaleString('en-US')} ft MSL (${v.toFixed(0)} m)`,
  },
  pblHeightM: {
    id: 'pblHeightM',
    label: 'HRRR model PBL depth (HPBL) · m AGL',
    group: 'Thermal Opportunity',
    scale: 1,
    stops: [0, 250, 500, 1000, 2000],
    colors: ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'],
    legend: 'HRRR HPBL depth m AGL: 0 pale · 250 blue · 500 teal · 1,000 gold · 2,000+ red',
    format: v => `${v.toFixed(0)} m AGL (${Math.round(v * M_TO_FT).toLocaleString('en-US')} ft AGL)`,
  },
  sensibleHeatFluxWm2: {
    id: 'sensibleHeatFluxWm2',
    label: 'Surface sensible heating · W/m²',
    group: 'Thermal Opportunity',
    scale: 1,
    stops: [-30, 0, 50, 150, 300],
    colors: ['#6b8ea4', '#f4f8fa', '#c3e1e9', '#e8bc52', '#c44935'],
    legend: 'Sensible heat flux W/m²: <0 cooling (slate) · 50 pale blue · 150 gold · 300+ red',
    format: v => `${v.toFixed(0)} W/m²`,
  },
  surfaceLclM: {
    id: 'surfaceLclM',
    label: 'Cu cloud base (Surface LCL / zsfclcl) · ft MSL',
    group: 'Clouds & Precipitation',
    scale: M_TO_FT,
    stops: [500, 2000, 4000, 7000, 11000],
    colors: ['#7c689c', '#6999b3', '#289b9c', '#e8bc52', '#c44935'],
    legend: 'Surface LCL ft MSL: 500 purple · 2,000 blue · 4,000 teal · 7,000 gold · 11,000+ red',
    format: v => `${Math.round(v * M_TO_FT).toLocaleString('en-US')} ft MSL (${v.toFixed(0)} m)`,
  },
  mixedLayerLclM: {
    id: 'mixedLayerLclM',
    label: 'Mixed-layer LCL (zblcl) · ft MSL',
    group: 'Clouds & Precipitation',
    scale: M_TO_FT,
    stops: [500, 2000, 4000, 7000, 11000],
    colors: ['#7c689c', '#6999b3', '#289b9c', '#e8bc52', '#c44935'],
    legend: 'Mixed-layer LCL ft MSL: 500 purple · 2,000 blue · 4,000 teal · 7,000 gold · 11,000+ red',
    format: v => `${Math.round(v * M_TO_FT).toLocaleString('en-US')} ft MSL (${v.toFixed(0)} m)`,
  },
  cuPotentialM: {
    id: 'cuPotentialM',
    label: 'Cumulus potential (zsfclcldif) · m',
    group: 'Clouds & Precipitation',
    scale: 1,
    stops: [-1500, -500, 0, 300, 1000],
    colors: ['#e5d9bd', '#c3e1e9', '#f4f8fa', '#289b9c', '#1a5f7a'],
    legend: 'Cu potential (BL top − sfc LCL): <0 blue thermals (beige/light blue) · >0 cumulus likely (teal/deep blue)',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(0)} m (${Math.round(v * M_TO_FT)} ft)`,
  },
  odPotentialM: {
    id: 'odPotentialM',
    label: 'Overcast-development potential (zblcldif) · m',
    group: 'Clouds & Precipitation',
    scale: 1,
    stops: [-1500, -500, 0, 300, 1000],
    colors: ['#e5d9bd', '#c3e1e9', '#f4f8fa', '#7c689c', '#4a356b'],
    legend: 'OD potential (BL top − mixed LCL): <0 no spreadout · >0 stratocumulus / overcast spreadout (purple)',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(0)} m (${Math.round(v * M_TO_FT)} ft)`,
  },
  cloudCoverPercent: {
    id: 'cloudCoverPercent',
    label: 'Total cloud cover · %',
    group: 'Clouds & Precipitation',
    scale: 1,
    stops: [0, 25, 50, 75, 100],
    colors: ['#f4f8fa', '#d1dde6', '#9fb4c7', '#6c849c', '#3c4f66'],
    legend: 'Total cloud cover %: 0 clear · 50 scattered · 100 overcast slate',
    format: v => `${v.toFixed(0)}%`,
  },
  lowCloudPercent: {
    id: 'lowCloudPercent',
    label: 'Low cloud cover · %',
    group: 'Clouds & Precipitation',
    scale: 1,
    stops: [0, 25, 50, 75, 100],
    colors: ['#f4f8fa', '#d1dde6', '#9fb4c7', '#6c849c', '#3c4f66'],
    legend: 'Low cloud cover %: 0 clear · 50 scattered · 100 low overcast',
    format: v => `${v.toFixed(0)}%`,
  },
  precipitationMmHr: {
    id: 'precipitationMmHr',
    label: 'Hourly rain rate · mm/hr',
    group: 'Clouds & Precipitation',
    scale: 1,
    stops: [0, 0.2, 1, 3, 8],
    colors: ['#f4f8fa', '#b3cde3', '#6497b1', '#005b96', '#03396c'],
    legend: 'Precipitation rate mm/hr: 0 dry · 0.2 trace · 1 light · 3+ moderate/heavy rain',
    format: v => `${v.toFixed(2)} mm/hr`,
  },
  capeJkg: {
    id: 'capeJkg',
    label: 'Surface CAPE · J/kg',
    group: 'Clouds & Precipitation',
    scale: 1,
    stops: [0, 50, 200, 500, 1000],
    colors: ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'],
    legend: 'CAPE J/kg: 0 none · 50 weak · 200 moderate · 500+ strong convective instability',
    format: v => `${v.toFixed(0)} J/kg`,
  },
  wind10mSpeedMps: {
    id: 'wind10mSpeedMps',
    label: '10 m surface wind · mph (m/s)',
    group: 'Winds & Shear',
    scale: MPS_TO_MPH,
    stops: [0, 5, 12, 20, 30],
    colors: ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'],
    legend: '10 m wind mph: 0 calm · 5 light · 12 moderate (teal) · 20 strong (gold) · 30+ gale (red)',
    format: v => `${(v * MPS_TO_MPH).toFixed(1)} mph (${v.toFixed(1)} m/s)`,
  },
  blMeanWindSpeedMps: {
    id: 'blMeanWindSpeedMps',
    label: 'Boundary-layer mean wind (blwind) · mph (m/s)',
    group: 'Winds & Shear',
    scale: MPS_TO_MPH,
    stops: [0, 5, 12, 20, 30],
    colors: ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'],
    legend: 'BL mean wind mph: 0 calm · 5 light · 12 moderate (teal) · 20 strong (gold) · 30+ gale (red)',
    format: v => `${(v * MPS_TO_MPH).toFixed(1)} mph (${v.toFixed(1)} m/s)`,
  },
  blWindShearMps: {
    id: 'blWindShearMps',
    label: 'Boundary-layer vector wind shear · m/s',
    group: 'Winds & Shear',
    scale: 1,
    stops: [0, 2, 4, 7, 12],
    colors: ['#f4f8fa', '#c3e1e9', '#289b9c', '#e8bc52', '#c44935'],
    legend: 'BL vector wind shear m/s: 0–2 low · 4 moderate · 7 sheared thermals · 12+ severe shear',
    format: v => `${v.toFixed(1)} m/s (${(v * MPS_TO_MPH).toFixed(1)} mph)`,
  },
  buoyancyShearRatio: {
    id: 'buoyancyShearRatio',
    label: 'Buoyancy / Shear ratio (W* / ΔV)',
    group: 'Winds & Shear',
    scale: 1,
    stops: [0, 0.15, 0.35, 0.7, 1.2],
    colors: ['#c44935', '#e8bc52', '#c3e1e9', '#289b9c', '#1b6d6e'],
    legend: 'Buoyancy/Shear ratio: <0.2 sheared/broken (red/gold) · >0.35 workable · >0.7 well-organized thermals (teal)',
    format: v => `${v.toFixed(2)}`,
  },
  w925Mps: {
    id: 'w925Mps',
    label: '925 hPa vertical velocity w · m/s',
    group: 'Lift & Convergence',
    scale: 1,
    stops: [-0.3, -0.1, 0, 0.1, 0.3],
    colors: ['#3b6998', '#a8c6df', '#f4f8fa', '#e8bc52', '#c44935'],
    legend: 'Geometric vertical velocity w (m/s at 925 hPa): blue = sink (<0) · white = 0 · gold/red = rising air (>0)',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(2)} m/s (${Math.round(v * MPS_TO_FPM)} ft/min)`,
  },
  convergence10mX1e5: {
    id: 'convergence10mX1e5',
    label: '10 m horizontal convergence (−∇·V) · ×10⁻⁵ s⁻¹',
    group: 'Lift & Convergence',
    scale: 1,
    stops: [-100, -30, 0, 30, 100],
    colors: ['#3b6998', '#a8c6df', '#f4f8fa', '#e8bc52', '#c44935'],
    legend: 'Horizontal convergence (×10⁻⁵ s⁻¹ on native 3 km Lambert grid): blue = divergence (<0) · gold/red = convergence (>0)',
    format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} ×10⁻⁵ s⁻¹`,
  },
};

export function replayLocation(search: string, dataBase: string) {
  const query = new URLSearchParams(search), caseId = query.get('case') ?? DEFAULT_CASE;
  if (caseId !== DEFAULT_CASE) throw new Error(`Unknown replay case: ${caseId}`);
  const hour = Number(query.get('hour') ?? 20);
  return {
    caseId,
    hour: Number.isInteger(hour) && hour >= 14 && hour <= 27 ? hour : 20,
    root: `${dataBase.replace(/\/$/, '')}/soaring/v1/${caseId}`,
  };
}

export function hourIndex(hours: { forecastHour: number }[], requested: number) {
  const found = hours.findIndex(h => h.forecastHour === requested);
  return found < 0 ? 0 : found;
}

export function historicalLabel(referenceTime: string) {
  return `Historical HRRR · initialized ${referenceTime.slice(0, 10)} at ${referenceTime.slice(11, 16)} UTC`;
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

export function displayMetric(value: number | null | undefined, layer: Layer, status: Quality = 'valid') {
  if (status === 'missing') return 'Unavailable';
  if (status === 'insufficient-levels') return 'Insufficient vertical coverage';
  if (value === null || value === undefined) {
    if (layer === 'usableLiftTopM') return 'No lift above 1.0 m/s threshold';
    if (layer === 'hcritWxtoflyM') return 'No lift above 225 ft/min (1.14 m/s)';
    if (layer === 'resolvedThermalTopM') return 'Stable / no convective thermal top';
    return 'Unavailable';
  }
  if (layer === 'thermalVelocityMps') return `${value.toFixed(2)} m/s`;
  if (layer === 'usableLiftTopM') return `${Math.round(value * M_TO_FT).toLocaleString('en-US')} ft MSL`;
  return LAYER_SPECS[layer]?.format(value) ?? String(value);
}

export function selectedState(manifest: ReplayManifest, hours: ReplayHour[], requested: number) {
  const index = hourIndex(manifest.hours, requested), hour = hours[index];
  if (!hour || hour.validAt !== manifest.hours[index].validAt) throw new Error('Replay hour does not match manifest');
  return {
    index,
    hour,
    validLabel: localTime(hour.validAt, manifest.case.site.timeZone),
    siteStrength: displayMetric(hour.thermalVelocityMps[manifest.siteCell], 'thermalVelocityMps', hour.status[manifest.siteCell]),
    siteTop: displayMetric(hour.usableLiftTopM[manifest.siteCell], 'usableLiftTopM', hour.status[manifest.siteCell]),
  };
}

/**
 * Reconstructs a complete 14-hour SiteForecast for any of the 2,259 grid cells
 * from the per-hour numerical arrays so clicking any cell on the map updates
 * both the Windgram and the Skew-T sounding immediately.
 */
export function buildCellSiteForecast(
  manifest: ReplayManifest,
  hours: ReplayHour[],
  cellIndex: number,
  cellProps: { id: string; gridIndex: number; latitude: number; longitude: number; modelElevationM: number | null },
  customName?: string,
): SiteForecast | null {
  const elev = cellProps.modelElevationM;
  if (elev === null) return null;
  const pList = manifest.case.pressureLevels ?? [925, 900, 875, 850, 800, 750, 700, 650, 600];
  const siteHours: SiteForecast['hours'] = [];
  for (const h of hours) {
    if (h.status[cellIndex] !== 'valid') return null;
    const levels: SiteForecast['hours'][number]['levels'] = [];
    if (h.levelsByPressure) {
      for (const p of pList) {
        const la = h.levelsByPressure[String(p)];
        if (!la) continue;
        const hm = la.h[cellIndex], tc = la.t[cellIndex], tdc = la.td[cellIndex], ws = la.ws[cellIndex], wd = la.wd[cellIndex];
        if (hm == null || tc == null || tdc == null || ws == null || wd == null) continue;
        if (hm <= elev + 20) continue;
        const lv: SiteForecast['hours'][number]['levels'][number] = {
          pressureHpa: p,
          heightM: hm,
          temperatureC: tc,
          dewPointC: tdc,
          windSpeedMps: ws,
          windDirectionDeg: wd,
        };
        const vv = la.vv?.[cellIndex];
        if (vv != null) lv.verticalVelocityPaS = vv;
        levels.push(lv);
      }
      levels.sort((a, b) => a.heightM - b.heightM);
    }
    const surface: SiteForecast['hours'][number]['surface'] = {
      seaLevelPressureHpa: h.mslp?.[cellIndex] ?? 1015,
      temperatureC: h.sfcT?.[cellIndex] ?? 15,
      dewPointC: h.sfcTd?.[cellIndex] ?? 10,
      windSpeedMps: h.wind10mSpeedMps?.[cellIndex] ?? 0,
      windDirectionDeg: h.wind10mDirDeg?.[cellIndex] ?? 0,
      cloudCoverPercent: h.cloudCoverPercent?.[cellIndex] ?? 0,
      precipitationMmHr: h.precipitationMmHr?.[cellIndex] ?? 0,
      sensibleHeatFluxWm2: h.sensibleHeatFluxWm2?.[cellIndex] ?? 0,
      latentHeatFluxWm2: h.latentHeatFluxWm2?.[cellIndex] ?? 0,
    };
    if (h.windGustMps?.[cellIndex] != null) surface.windGustMps = h.windGustMps[cellIndex]!;
    if (h.capeJkg?.[cellIndex] != null) surface.capeJkg = h.capeJkg[cellIndex]!;
    if (h.cinJkg?.[cellIndex] != null) surface.cinJkg = h.cinJkg[cellIndex]!;
    if (h.pblHeightM[cellIndex] != null) surface.pblHeightM = h.pblHeightM[cellIndex]!;
    if (h.lowCloudPercent?.[cellIndex] != null) surface.lowCloudPercent = h.lowCloudPercent[cellIndex]!;
    if (h.midCloudPercent?.[cellIndex] != null) surface.midCloudPercent = h.midCloudPercent[cellIndex]!;
    if (h.highCloudPercent?.[cellIndex] != null) surface.highCloudPercent = h.highCloudPercent[cellIndex]!;

    siteHours.push({
      validAt: h.validAt,
      surface,
      levels,
      derived: {
        boundaryLayerTopM: h.boundaryLayerTopM[cellIndex],
        thermalVelocityMps: h.thermalVelocityMps[cellIndex] ?? 0,
        cloudBaseM: h.cloudBaseM[cellIndex] ?? elev,
        usableLiftTopM: h.usableLiftTopM[cellIndex],
      },
    });
  }
  return {
    schemaVersion: 2,
    model: 'hrrr-conus',
    run: { referenceTime: manifest.case.referenceTime, generatedAt: manifest.capturedAt },
    site: {
      id: `cell-${cellProps.gridIndex}`,
      name: customName ?? `Cell ${cellProps.gridIndex}`,
      latitude: cellProps.latitude,
      longitude: cellProps.longitude,
      modelElevationM: elev,
      timeZone: manifest.case.site.timeZone,
    },
    semantics: { gust: 'instant', precipitation: 'instantRate', smoke: 'radiativelyCoupled' },
    hours: siteHours,
  };
}
