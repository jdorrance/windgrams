/** Adapt one AV native cell to the published Windgrams profile contract. */
import { componentsToWind } from '@azohra/meteo.briefing/derive';
import { parseForecastManifest, type ForecastManifest } from '@azohra/meteo.briefing/contract';
import { parsePublishedProfileJson, type PublishedSiteForecast } from '@windgrams/contracts/published-lift';
import type { AvProfile, AvPoint, AvManifest } from './av-wire.ts';

export interface AvSite extends AvPoint {
  slug: string;
  name: string;
  timeZone: string;
}
const scalar = (frame: AvProfile['frames'][number], layer: string) =>
  frame.layers[layer]?.status === 'valid' ? frame.layers[layer].value : null;
function wind(
  u: number | null,
  v: number | null,
): { windSpeedMps: number | null; windDirectionDeg: number | null } {
  if (u === null || v === null) return { windSpeedMps: null, windDirectionDeg: null };
  const { speedMps, directionDeg } = componentsToWind(u, v);
  return { windSpeedMps: speedMps, windDirectionDeg: speedMps === 0 ? null : directionDeg };
}

/** Retain independent measurements; a published point needs known native model terrain. */
export function avProfileToPublishedSiteForecast(profile: AvProfile, site: AvSite): PublishedSiteForecast {
  if (profile.lat !== site.lat || profile.lon !== site.lon || !profile.cell)
    throw new Error('AV profile does not cover requested site');
  const terrain = profile.frames.find((frame) => frame.profile.modelTerrainM !== null)?.profile.modelTerrainM;
  if (terrain === null || terrain === undefined) throw new Error('AV profile has no native model terrain');
  const hours = profile.frames.map((frame) => {
    const get = (layer: string) => scalar(frame, layer),
      derived = frame.derived;
    const surfaceWind = wind(get('wind-10m-u'), get('wind-10m-v'));
    if (frame.profile.modelTerrainM !== null && frame.profile.modelTerrainM !== terrain)
      throw new Error('AV atmospheric profile is unavailable or changes native terrain');
    return {
      validAt: frame.validTime,
      surface: {
        seaLevelPressureHpa: get('mslp-hpa'),
        temperatureC: get('sfc-temp-c'),
        dewPointC: get('sfc-dewpoint-c'),
        ...surfaceWind,
        cloudCoverPercent: get('cloud-cover-total'),
        precipitationMmHr: get('precip-rate'),
        sensibleHeatFluxWm2: get('sensible-heat-flux'),
        latentHeatFluxWm2: get('latent-heat-flux'),
        windGustMps: get('wind-gust-10m'),
        capeJkg: get('cape-jkg'),
        pblHeightM: get('pbl-height-agl'),
        lowCloudPercent: get('cloud-cover-low'),
        surfacePressureHpa: frame.profile.surfacePressureHpa,
        ...(profile.model === 'icon-eu' ? { convectiveParcel: 'mixed-layer' } : { convectiveParcel: 'surface' }),
      },
      levels: frame.profile.levels.map((level) => ({
        pressureHpa: level.pressureHpa,
        heightM: level.heightM,
        temperatureC: level.temperatureC,
        dewPointC: level.dewPointC,
        ...wind(level.uWindMps, level.vWindMps),
        verticalVelocityPaS: level.omegaPaS,
      })),
      derived: {
        boundaryLayerTopM: get('thermal-top-msl'),
        thermalVelocityMps: get('thermal-velocity'),
        cloudBaseM: derived.effectiveCloudLimitM,
        usableLiftTopM: derived.usableLiftTopV2M,
      },
      soaring: {
        cumulus: derived.cumulus,
        overdeveloped: derived.overdeveloped,
        cloudCapped: derived.cloudCapped,
        thermalVelocityV2Mps: get('thermal-velocity'),
        resolvedThermalTopM: get('thermal-top-msl'),
        usableLiftTopV2M: derived.usableLiftTopV2M,
        hcritWxtoflyM: derived.hcritWxtoflyM,
        surfaceLclM: get('surface-lcl-msl'),
        mixedLayerLclM: derived.mixedLayerLclM,
        effectiveCloudLimitM: derived.effectiveCloudLimitM,
        blMeanWindSpeedMps: derived.blMeanWindSpeedMps,
        blMeanWindDirDeg: derived.blMeanWindDirDeg,
        blTopWindSpeedMps: derived.blTopWindSpeedMps,
        blTopWindDirDeg: derived.blTopWindDirDeg,
        blWindShearMps: derived.blWindShearMps,
        buoyancyShearRatio: derived.buoyancyShearRatio,
        verticalResolution: {
          nativeLevelCount: frame.profile.levels.length,
          aboveGroundLevelCount: frame.profile.levels.filter((level) => level.heightM !== null && level.heightM > terrain + 20).length,
          isSparseProfile: frame.profile.levels.length < 3,
          hasSub925Levels: frame.profile.levels.some((level) => level.pressureHpa !== null && level.pressureHpa > 925),
          hasUpperAirAbove600Levels: frame.profile.levels.some((level) => level.pressureHpa !== null && level.pressureHpa < 600),
          has80mWind: false,
          synthesizedLevels: 0,
        },
      },
    };
  });
  const document = parsePublishedProfileJson(
    JSON.stringify({
      schemaVersion: 2,
      model: profile.model,
      run: { referenceTime: profile.cycle, generatedAt: profile.createdAt },
      site: {
        id: site.slug,
        name: site.name,
        latitude: profile.cell.lat,
        longitude: profile.cell.lon,
        modelElevationM: terrain,
        timeZone: site.timeZone,
      },
      semantics: { precipitation: 'windowMeanRate', ...(profile.model === 'icon-eu' ? {} : { gust: 'instant' }) },
      hours,
    }),
  );
  if (!document) throw new Error('AV profile cannot satisfy the published Windgrams surface/level contract');
  return document;
}

export function avPublishedManifest(build: AvManifest, sites: readonly AvSite[]): ForecastManifest {
  const hours = build.frames.map((frame) => (Date.parse(frame.validTime) - Date.parse(build.cycle)) / 3600000);
  const manifest = parseForecastManifest({
    schemaVersion: 1,
    model: build.model,
    referenceTime: build.cycle,
    generatedAt: build.createdAt,
    firstForecastHour: Math.min(...hours),
    lastForecastHour: Math.max(...hours),
    forecastHours: hours.length,
    sites: sites.map((site) => ({ slug: site.slug, name: site.name })),
    stats: { downloads: 0, downloadBytes: 0, retries: 0, durationMs: 0 },
  });
  if (!manifest) throw new Error('AV profile has invalid published forecast times');
  return manifest;
}
