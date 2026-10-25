import type { SiteForecast } from '@azohra/meteo.briefing/contract';
import { replayModel, type ReplayHour, type ReplayManifest } from '@windgrams/contracts/regional';

type ProfileHour = SiteForecast['hours'][number];
type ProfileLevel = ProfileHour['levels'][number] & { heightM: number };

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function levelsAt(manifest: ReplayManifest, hour: ReplayHour, index: number, elevationM: number): ProfileLevel[] {
  const columns = hour.levelsByModel
    ? Object.values(hour.levelsByModel).map(arrays => ({ pressure: arrays.p[index], arrays }))
    : (manifest.case.pressureLevels ?? Object.keys(hour.levelsByPressure ?? {}).map(Number))
      .flatMap(pressure => {
        const arrays = hour.levelsByPressure?.[String(pressure)];
        return arrays ? [{ pressure, arrays }] : [];
      });
  const levels: ProfileLevel[] = [];
  for (const { pressure, arrays } of columns) {
    const height = arrays.h[index];
    const temperature = arrays.t[index];
    const dewPoint = arrays.td[index];
    const windSpeed = arrays.ws[index];
    const windDirection = arrays.wd[index];
    if (!finite(pressure) || pressure <= 0 || !finite(height) || height <= elevationM + 20
      || !finite(temperature) || !finite(dewPoint) || !finite(windSpeed) || !finite(windDirection)) continue;
    const level: ProfileLevel = {
      pressureHpa: pressure, heightM: height, temperatureC: temperature,
      dewPointC: dewPoint, windSpeedMps: windSpeed, windDirectionDeg: windDirection,
    };
    const verticalVelocity = arrays.vv?.[index];
    if (finite(verticalVelocity)) level.verticalVelocityPaS = verticalVelocity;
    levels.push(level);
  }
  return levels.sort((a, b) => a.heightM - b.heightM);
}

function surfaceAt(hour: ReplayHour, index: number): ProfileHour['surface'] | null {
  const seaLevelPressureHpa = hour.mslp?.[index];
  const temperatureC = hour.sfcT?.[index];
  const dewPointC = hour.sfcTd?.[index];
  const windSpeedMps = hour.wind10mSpeedMps?.[index];
  const windDirectionDeg = hour.wind10mDirDeg?.[index];
  const cloudCoverPercent = hour.cloudCoverPercent?.[index];
  const precipitationMmHr = hour.precipitationMmHr?.[index];
  const sensibleHeatFluxWm2 = hour.sensibleHeatFluxWm2?.[index];
  const latentHeatFluxWm2 = hour.latentHeatFluxWm2?.[index];
  if (!finite(seaLevelPressureHpa) || !finite(temperatureC) || !finite(dewPointC)
    || !finite(windSpeedMps) || !finite(windDirectionDeg) || !finite(cloudCoverPercent)
    || !finite(precipitationMmHr) || !finite(sensibleHeatFluxWm2) || !finite(latentHeatFluxWm2)) return null;
  const surface: ProfileHour['surface'] = {
    seaLevelPressureHpa, temperatureC, dewPointC, windSpeedMps, windDirectionDeg,
    cloudCoverPercent, precipitationMmHr, sensibleHeatFluxWm2, latentHeatFluxWm2,
  };
  const optional = {
    windGustMps: hour.windGustMps?.[index], capeJkg: hour.capeJkg?.[index], cinJkg: hour.cinJkg?.[index],
    pblHeightM: hour.pblHeightM[index], lowCloudPercent: hour.lowCloudPercent?.[index],
    midCloudPercent: hour.midCloudPercent?.[index], highCloudPercent: hour.highCloudPercent?.[index],
  };
  for (const key of Object.keys(optional) as (keyof typeof optional)[]) {
    const value = optional[key];
    if (value != null) surface[key] = value;
  }
  return surface;
}

/** Reconstruct published values only. Incomplete columns return null. */
export function reconstructRegionalCellProfile(
  manifest: ReplayManifest,
  hours: readonly ReplayHour[],
  cellIndex: number,
  cellProps: { id: string; gridIndex: number; latitude: number; longitude: number; modelElevationM: number | null },
  customName?: string,
): SiteForecast | null {
  const elevationM = cellProps.modelElevationM;
  if (elevationM === null) return null;
  const profileHours: ProfileHour[] = [];
  for (const hour of hours) {
    if (hour.status[cellIndex] !== 'valid') return null;
    const levels = levelsAt(manifest, hour, cellIndex, elevationM);
    const surface = surfaceAt(hour, cellIndex);
    const thermalVelocityMps = hour.thermalVelocityMps[cellIndex];
    const cloudBaseM = hour.cloudBaseM[cellIndex];
    if (!surface || levels.length < 2 || thermalVelocityMps == null || cloudBaseM == null) return null;
    const soaring = hour.thermalVelocityV2Mps ? {
      thermalVelocityV2Mps: hour.thermalVelocityV2Mps[cellIndex],
      usableLiftTopV2M: hour.usableLiftTopV2M?.[cellIndex] ?? null,
      hcritWxtoflyM: hour.hcritWxtoflyM?.[cellIndex] ?? null,
      resolvedThermalTopM: hour.resolvedThermalTopM?.[cellIndex] ?? null,
      surfaceLclM: hour.surfaceLclM?.[cellIndex] ?? null,
      effectiveCloudLimitM: hour.effectiveCloudLimitM?.[cellIndex] ?? cloudBaseM,
      mixedLayerLclM: hour.mixedLayerLclM?.[cellIndex] ?? null,
    } : undefined;
    profileHours.push({
      ...(soaring ? { soaring } : {}),
      validAt: hour.validAt, surface, levels,
      derived: {
        boundaryLayerTopM: hour.boundaryLayerTopM[cellIndex], thermalVelocityMps,
        cloudBaseM, usableLiftTopM: hour.usableLiftTopM[cellIndex],
      },
    });
  }
  const model = replayModel(manifest);
  // Only these archived products predate explicit interval semantics.
  const legacySemantics: Partial<Record<string, SiteForecast['semantics']>> = {
    rrfs: { gust: 'instant', precipitation: 'windowMeanRate' },
    'icon-eu': { gust: 'instant', precipitation: 'windowMeanRate' },
    'hrrr-conus': { gust: 'instant', precipitation: 'instantRate', smoke: 'radiativelyCoupled' },
  };
  const semantics = manifest.semantics ?? legacySemantics[model];
  if (!semantics) return null;
  return {
    schemaVersion: 2, model,
    run: { referenceTime: manifest.case.referenceTime, generatedAt: manifest.capturedAt },
    site: {
      id: `cell-${cellProps.gridIndex}`, name: customName ?? `Cell ${cellProps.gridIndex}`,
      latitude: cellProps.latitude, longitude: cellProps.longitude,
      modelElevationM: elevationM, timeZone: manifest.case.site.timeZone,
    },
    semantics, hours: profileHours,
  };
}
