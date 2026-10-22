import { roundDocument } from '@azohra/meteo.forecast';
import { parseSiteForecast } from '@azohra/meteo.briefing/contract';
import {
  DRY_ADIABATIC_LAPSE_C_PER_M,
  buoyancyShearRatio,
  normalizeDegrees,
  surfaceToBoundaryLayerShearMps,
  usableLiftTopM,
  windToComponents,
} from '@azohra/meteo.briefing/derive';
import { deriveSiteForecast } from './vendor/derive-0.6.0.mjs';
import { wind } from './grid.mjs';
import { semantics, validAt } from './common.mjs';

export const metrics = ['thermalVelocityMps','usableLiftTopM','boundaryLayerTopM','cloudBaseM','pblHeightM'];
export const WXTOFLY_SINK_MPS = 225 * 0.00508; // 225 ft/min = 1.143 m/s (WxToFly windgram specification)
export const v2LayerMetrics = [
  'resolvedThermalTopM',
  'thermalTopPlus1CM',
  'hcritWxtoflyM',
  'dryHcritM',
  'surfaceLclM',
  'mixedLayerLclM',
  'cuPotentialM',
  'odPotentialM',
  'blMeanWindSpeedMps',
  'blMeanWindDirDeg',
  'blTopWindSpeedMps',
  'blTopWindDirDeg',
  'blWindShearMps',
  'buoyancyShearRatio',
  'wind10mSpeedMps',
  'wind10mDirDeg',
  'windGustMps',
  'wind925SpeedMps',
  'wind925DirDeg',
  'wind850SpeedMps',
  'wind850DirDeg',
  'maxUpwardVelocityMps',
  'minDownwardVelocityMps',
  'w925Mps',
  'w850Mps',
  'convergence10mX1e5',
  'convergence925X1e5',
  'sensibleHeatFluxWm2',
  'latentHeatFluxWm2',
  'cloudCoverPercent',
  'lowCloudPercent',
  'midCloudPercent',
  'highCloudPercent',
  'precipitationMmHr',
  'capeJkg',
  'cinJkg',
];

const RD_J_PER_KG_K = 287.05;
const GRAVITY_MPS2 = 9.80665;
const SATURATED_DEPRESSION_C = 0.5;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const round1 = n => (finite(n) ? Math.round(n * 10) / 10 : null);
const round2 = n => (finite(n) ? Math.round(n * 100) / 100 : null);
const optional = ['windGustMps','capeJkg','cinJkg','pblHeightM','lowCloudPercent','midCloudPercent','highCloudPercent'];

export function geometricWFromOmegaMps(omegaPaS, pressureHpa, temperatureC) {
  if (!finite(omegaPaS) || !finite(pressureHpa) || !finite(temperatureC) || pressureHpa <= 0) return null;
  const temperatureK = temperatureC + 273.15;
  const densityKgM3 = (pressureHpa * 100) / (RD_J_PER_KG_K * temperatureK);
  return -omegaPaS / (densityKgM3 * GRAVITY_MPS2);
}

export function parcelLclAglM(temperatureC, dewPointC) {
  if (!finite(temperatureC) || !finite(dewPointC)) return null;
  if (dewPointC >= temperatureC) return 0;
  const temperatureK = temperatureC + 273.15;
  const dewPointK = dewPointC + 273.15;
  const lclTemperatureK = 1 / (1 / (dewPointK - 56) + Math.log(temperatureK / dewPointK) / 800) + 56;
  return Math.max(0, (temperatureK - lclTemperatureK) / DRY_ADIABATIC_LAPSE_C_PER_M);
}

export function resolvedParcelDepthM(surfaceTemperatureC, sensibleHeatFluxWm2, latentHeatFluxWm2, pblHeightM, modelElevationM, levels, deltaTC = 0) {
  const parcelSurfaceTC = surfaceTemperatureC + deltaTC;
  const surfaceTemperatureK = surfaceTemperatureC + 273.15;
  const virtualHeatFlux = (sensibleHeatFluxWm2 ?? 0) + 245268e-9 * surfaceTemperatureK * (latentHeatFluxWm2 ?? 0);
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    const altitudeAglM = level.heightM - modelElevationM;
    if (parcelSurfaceTC - altitudeAglM * DRY_ADIABATIC_LAPSE_C_PER_M > level.temperatureC) continue;
    if (index === 0) {
      // Fix v1 index===0 jump: when the surface parcel is already cooler than the
      // dry adiabat at the first pressure level (e.g. 925 hPa), do not jump to 925 hPa.
      if (virtualHeatFlux <= 0 && deltaTC <= 0) return 0;
      if (finite(pblHeightM) && pblHeightM > 0) {
        const capM = Math.max(0, altitudeAglM);
        const sensBoostM = deltaTC > 0 ? Math.min(250 * deltaTC, Math.max(0, capM - pblHeightM)) : 0;
        return Math.min(capM, Math.max(0, pblHeightM + sensBoostM));
      }
      const superadiabaticExcessC = Math.max(0, deltaTC + Math.min(1.5, Math.max(0, sensibleHeatFluxWm2 ?? 0) * 0.012));
      const envLapse = (level.temperatureC - surfaceTemperatureC) / Math.max(1, altitudeAglM);
      const denom = DRY_ADIABATIC_LAPSE_C_PER_M + envLapse;
      if (denom <= 1e-5) return 0;
      return Math.min(altitudeAglM, Math.max(0, superadiabaticExcessC / denom));
    }
    const previous = levels[index - 1];
    const previousAglM = previous.heightM - modelElevationM;
    const lapse = (level.temperatureC - previous.temperatureC) / (level.heightM - previous.heightM);
    const denominator = DRY_ADIABATIC_LAPSE_C_PER_M + lapse;
    if (Math.abs(denominator) < 1e-5) return Math.max(0, previousAglM);
    return Math.max(0, (parcelSurfaceTC - previous.temperatureC + lapse * previousAglM) / denominator);
  }
  if (levels.length > 0) return Math.max(0, levels[levels.length - 1].heightM - modelElevationM);
  return 0;
}

export function deriveDiagnosticsV2(terrain, source, v1Hour) {
  if (!source || !finite(terrain) || !v1Hour) return null;
  const levels = source.levels
    .filter(l => finite(l.heightM) && l.heightM > terrain + 20)
    .sort((a, b) => a.heightM - b.heightM);
  if (levels.length < 3) return null;

  const surfaceDewPointC = source.temperatureC - source.dewPointDepressionC;
  const sfcLclAgl = parcelLclAglM(source.temperatureC, surfaceDewPointC);
  const surfaceLclM = sfcLclAgl == null ? null : Math.max(terrain, terrain + sfcLclAgl);

  const resolvedDepthM = resolvedParcelDepthM(
    source.temperatureC,
    source.sensibleHeatFluxWm2,
    source.latentHeatFluxWm2,
    source.pblHeightM,
    terrain,
    levels,
    0,
  );
  const resolvedThermalTopM = resolvedDepthM > 0 ? terrain + resolvedDepthM : null;

  const plus1DepthM = resolvedParcelDepthM(
    source.temperatureC,
    source.sensibleHeatFluxWm2,
    source.latentHeatFluxWm2,
    source.pblHeightM,
    terrain,
    levels,
    1.0,
  );
  const thermalTopPlus1CM = plus1DepthM > 0 ? terrain + plus1DepthM : null;

  // Mixed-layer LCL (zblcl): average potential temperature & dew point depression across BL levels
  const blTopForMixM = resolvedThermalTopM ?? v1Hour.derived.boundaryLayerTopM ?? (terrain + (source.pblHeightM ?? 300));
  const blLevels = levels.filter(l => l.heightM <= blTopForMixM + 150);
  const sampleLevels = blLevels.length > 0 ? blLevels : [levels[0]];
  const meanDepressionC = (source.dewPointDepressionC + sampleLevels.reduce((acc, l) => acc + l.dewPointDepressionC, 0)) / (1 + sampleLevels.length);
  const mixedLclAgl = parcelLclAglM(source.temperatureC, source.temperatureC - meanDepressionC * 0.85);
  const mixedLayerLclM = mixedLclAgl == null ? null : Math.max(terrain, terrain + mixedLclAgl);

  const cuPotentialM = resolvedThermalTopM != null && surfaceLclM != null ? resolvedThermalTopM - surfaceLclM : null;
  const odPotentialM = resolvedThermalTopM != null && mixedLayerLclM != null ? resolvedThermalTopM - mixedLayerLclM : null;

  const hcritWxtoflyM = usableLiftTopM({
    modelElevationM: terrain,
    boundaryLayerTopM: v1Hour.derived.boundaryLayerTopM,
    thermalVelocityMps: v1Hour.derived.thermalVelocityMps,
    cloudBaseM: v1Hour.derived.cloudBaseM,
    levels,
  }, WXTOFLY_SINK_MPS);

  const dryHcritM = usableLiftTopM({
    modelElevationM: terrain,
    boundaryLayerTopM: v1Hour.derived.boundaryLayerTopM,
    thermalVelocityMps: v1Hour.derived.thermalVelocityMps,
    cloudBaseM: 99999,
    levels,
  }, 1.0);

  // Boundary-layer mean wind & BL top wind & vector shear
  const windNodes = [
    { heightM: terrain, ...windToComponents(source.windSpeedMps, source.windDirectionDeg) },
    ...levels.map(l => ({ heightM: l.heightM, ...windToComponents(l.windSpeedMps, l.windDirectionDeg) })),
  ];
  const targetTopM = resolvedThermalTopM ?? v1Hour.derived.boundaryLayerTopM ?? (terrain + (source.pblHeightM ?? 0));
  let sumU = windNodes[0].uMps;
  let sumV = windNodes[0].vMps;
  let countW = 1;
  for (const node of windNodes.slice(1)) {
    if (node.heightM <= Math.max(targetTopM, levels[0].heightM)) {
      sumU += node.uMps;
      sumV += node.vMps;
      countW += 1;
    }
  }
  const meanU = sumU / countW;
  const meanV = sumV / countW;
  const blMeanWindSpeedMps = Math.hypot(meanU, meanV);
  const blMeanWindDirDeg = normalizeDegrees((Math.atan2(-meanU, -meanV) * 180) / Math.PI);

  // Interpolate wind at targetTopM
  let topU = windNodes[windNodes.length - 1].uMps;
  let topV = windNodes[windNodes.length - 1].vMps;
  if (targetTopM <= windNodes[0].heightM) {
    topU = windNodes[0].uMps;
    topV = windNodes[0].vMps;
  } else {
    for (let k = 0; k < windNodes.length - 1; k++) {
      if (targetTopM <= windNodes[k + 1].heightM) {
        const frac = (targetTopM - windNodes[k].heightM) / Math.max(1, windNodes[k + 1].heightM - windNodes[k].heightM);
        topU = windNodes[k].uMps + frac * (windNodes[k + 1].uMps - windNodes[k].uMps);
        topV = windNodes[k].vMps + frac * (windNodes[k + 1].vMps - windNodes[k].vMps);
        break;
      }
    }
  }
  const blTopWindSpeedMps = Math.hypot(topU, topV);
  const blTopWindDirDeg = normalizeDegrees((Math.atan2(-topU, -topV) * 180) / Math.PI);
  const blWindShearMps = surfaceToBoundaryLayerShearMps({
    modelElevationM: terrain,
    boundaryLayerTopM: targetTopM > terrain ? targetTopM : levels[0].heightM,
    surfaceWind: { windSpeedMps: source.windSpeedMps, windDirectionDeg: source.windDirectionDeg },
    levels,
  });
  const bsRatioRaw = blWindShearMps != null ? buoyancyShearRatio(v1Hour.derived.thermalVelocityMps, Math.max(0.2, blWindShearMps)) : null;

  // Vertical velocities in geometric m/s
  let maxUpwardVelocityMps = null;
  let minDownwardVelocityMps = null;
  const wByPressure = {};
  for (const l of source.levels) {
    const w = geometricWFromOmegaMps(l.verticalVelocityPaS, l.pressureHpa, l.temperatureC);
    if (w != null) {
      wByPressure[l.pressureHpa] = w;
      if (l.heightM > terrain + 20) {
        if (maxUpwardVelocityMps === null || w > maxUpwardVelocityMps) maxUpwardVelocityMps = w;
        if (minDownwardVelocityMps === null || w < minDownwardVelocityMps) minDownwardVelocityMps = w;
      }
    }
  }

  const l925 = source.levels.find(l => l.pressureHpa === 925);
  const l850 = source.levels.find(l => l.pressureHpa === 850);

  return {
    resolvedThermalTopM: round1(resolvedThermalTopM),
    thermalTopPlus1CM: round1(thermalTopPlus1CM),
    hcritWxtoflyM: round1(hcritWxtoflyM),
    dryHcritM: round1(dryHcritM),
    surfaceLclM: round1(surfaceLclM),
    mixedLayerLclM: round1(mixedLayerLclM),
    cuPotentialM: round1(cuPotentialM),
    odPotentialM: round1(odPotentialM),
    blMeanWindSpeedMps: round2(blMeanWindSpeedMps),
    blMeanWindDirDeg: round1(blMeanWindDirDeg),
    blTopWindSpeedMps: round2(blTopWindSpeedMps),
    blTopWindDirDeg: round1(blTopWindDirDeg),
    blWindShearMps: round2(blWindShearMps),
    buoyancyShearRatio: round2(bsRatioRaw),
    wind10mSpeedMps: round2(source.windSpeedMps),
    wind10mDirDeg: round1(source.windDirectionDeg),
    windGustMps: round2(source.windGustMps ?? null),
    wind925SpeedMps: round2(l925?.windSpeedMps ?? null),
    wind925DirDeg: round1(l925?.windDirectionDeg ?? null),
    wind850SpeedMps: round2(l850?.windSpeedMps ?? null),
    wind850DirDeg: round1(l850?.windDirectionDeg ?? null),
    maxUpwardVelocityMps: round2(maxUpwardVelocityMps),
    minDownwardVelocityMps: round2(minDownwardVelocityMps),
    w925Mps: round2(wByPressure[925] ?? null),
    w850Mps: round2(wByPressure[850] ?? null),
    sensibleHeatFluxWm2: round1(source.sensibleHeatFluxWm2),
    latentHeatFluxWm2: round1(source.latentHeatFluxWm2),
    cloudCoverPercent: round1(source.cloudCoverPercent),
    lowCloudPercent: round1(source.lowCloudPercent ?? null),
    midCloudPercent: round1(source.midCloudPercent ?? null),
    highCloudPercent: round1(source.highCloudPercent ?? null),
    precipitationMmHr: round2(source.precipitationMm),
    capeJkg: round1(source.capeJkg ?? null),
    cinJkg: round1(source.cinJkg ?? null),
  };
}

/**
 * Computes horizontal convergence (-du/dx - dv/dy) in units of 10^-5 s^-1
 * on the native 3 km Lambert grid before display reprojection.
 */
export function computeNativeGridConvergence(grid, cells, uGridArray, vGridArray) {
  const byGridIJ = new Map();
  const ni = grid.ni;
  for (let idx = 0; idx < cells.length; idx++) {
    const gIdx = cells[idx].index;
    const i = gIdx % ni;
    const j = Math.floor(gIdx / ni);
    byGridIJ.set(`${i},${j}`, idx);
  }
  const dx = grid.dxM || 3000;
  const dy = grid.dyM || 3000;
  return cells.map(cell => {
    const gIdx = cell.index;
    const i = gIdx % ni;
    const j = Math.floor(gIdx / ni);
    const cIdx = byGridIJ.get(`${i},${j}`);
    const eIdx = byGridIJ.get(`${i + 1},${j}`) ?? cIdx;
    const wIdx = byGridIJ.get(`${i - 1},${j}`) ?? cIdx;
    const nIdx = byGridIJ.get(`${i},${j + 1}`) ?? cIdx;
    const sIdx = byGridIJ.get(`${i},${j - 1}`) ?? cIdx;
    const spanX = (eIdx !== cIdx ? 1 : 0) + (wIdx !== cIdx ? 1 : 0);
    const spanY = (nIdx !== cIdx ? 1 : 0) + (sIdx !== cIdx ? 1 : 0);
    if (!spanX || !spanY) return null;
    const uE = uGridArray[eIdx], uW = uGridArray[wIdx];
    const vN = vGridArray[nIdx], vS = vGridArray[sIdx];
    if (![uE, uW, vN, vS].every(finite)) return null;
    const dudx = (uE - uW) / (spanX * dx);
    const dvdy = (vN - vS) / (spanY * dy);
    const convergencePerSec = -(dudx + dvdy);
    return round2(convergencePerSec * 1e5);
  });
}

export function cellSource(c, grid, cell, hour, raw) {
  const surfaceWind = wind(grid, cell.longitude, raw.u, raw.v);
  const required = ['temperature','dewpoint','cloudCoverPercent','latentHeatFluxWm2','sensibleHeatFluxWm2','precipitationMm','seaLevelPressureHpa'];
  if (!surfaceWind || !required.every(k => finite(raw[k]))) return null;
  const source = { validAt: validAt(c, hour), temperatureC: raw.temperature - 273.15,
    dewPointDepressionC: raw.temperature - raw.dewpoint, ...surfaceWind,
    cloudCoverPercent: raw.cloudCoverPercent, latentHeatFluxWm2: raw.latentHeatFluxWm2,
    sensibleHeatFluxWm2: raw.sensibleHeatFluxWm2, precipitationMm: raw.precipitationMm * 3600,
    seaLevelPressureHpa: raw.seaLevelPressureHpa / 100, levels: [] };
  for (const key of optional) if (finite(raw[key])) source[key] = raw[key];
  if (['smoke.surfaceUgm3','smoke.columnMgm2','smoke.aot'].every(k => finite(raw[k]))) {
    source.smoke = { surfaceUgm3: raw['smoke.surfaceUgm3'] * 1e9, columnMgm2: raw['smoke.columnMgm2'] * 1e6, aot: raw['smoke.aot'] };
  }
  for (const p of c.pressureLevels) {
    const get = key => raw[`${p}.${key}`];
    const w = wind(grid, cell.longitude, get('UGRD'), get('VGRD'));
    if (!w || !['TMP','DPT','HGT'].every(k => finite(get(k)))) continue;
    const level = { pressureHpa: p, heightM: get('HGT'), temperatureC: get('TMP') - 273.15,
      dewPointDepressionC: get('TMP') - get('DPT'), ...w };
    if (finite(get('VVEL'))) level.verticalVelocityPaS = get('VVEL');
    source.levels.push(level);
  }
  return source;
}
export function deriveCell(c, terrain, source, capturedAt) {
  const levels = source?.levels.filter(l => l.heightM > terrain + 20).sort((a,b) => a.heightM - b.heightM) ?? [];
  const status = !source || !finite(terrain) ? 'missing' : levels.length < c.minimumAboveGroundLevels ? 'insufficient-levels' : 'valid';
  const ceilingReached = status === 'valid' && levels.every(l => source.temperatureC - (l.heightM - terrain) * DRY_ADIABATIC_LAPSE_C_PER_M > l.temperatureC);
  if (status !== 'valid') return { status, levelCount: levels.length, ceilingReached: false, hour: null, v2: null };
  const profile = roundDocument(deriveSiteForecast({ ...c.site, siteId: c.site.slug, siteName: c.site.name,
    siteTimeZone: c.site.timeZone, modelElevationM: terrain, referenceTime: c.referenceTime,
    generatedAt: capturedAt, hours: [source] }, 'hrrr-conus', semantics));
  const v2 = deriveDiagnosticsV2(terrain, source, profile.hours[0]);
  return { status, levelCount: levels.length, ceilingReached, hour: profile.hours[0], site: profile.site, v2 };
}
export function profileFor(c, site, hours, capturedAt) {
  const profile = { schemaVersion: 2, model: 'hrrr-conus', run: { referenceTime: c.referenceTime, generatedAt: capturedAt }, site, semantics, hours };
  if (!parseSiteForecast(profile)) throw new Error('Blanchard profile failed the public SiteForecast contract');
  return profile;
}
export function metric(hour, key) { return (key === 'pblHeightM' ? hour?.surface[key] : hour?.derived[key]) ?? null; }
export function assertAgreement(profile, hourly, siteCell) {
  if (profile.hours.length !== hourly.length) throw new Error('Map/profile hour count mismatch');
  for (let i = 0; i < hourly.length; i++) {
    if (profile.hours[i].validAt !== hourly[i].validAt) throw new Error('Map/profile time mismatch');
    for (const key of metrics) if (metric(profile.hours[i], key) !== hourly[i][key][siteCell]) throw new Error(`Map/profile mismatch: ${i} ${key}`);
  }
  return { exact: true, hours: hourly.length, valuesChecked: hourly.length * metrics.length };
}
export function differences(actual, expected, path = '') {
  if (path === 'run.generatedAt') return [];
  if (actual === expected) return [];
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    return [...new Set([...Object.keys(actual), ...Object.keys(expected)])].flatMap(k => differences(actual[k], expected[k], path ? `${path}.${k}` : k));
  }
  return [{ path, replay: actual ?? null, published: expected ?? null,
    ...(finite(actual) && finite(expected) ? { delta: actual - expected } : {}) }];
}
