// Physical readings at an hour and height, with published diagnostic context.

import { componentsToWind, relativeHumidityPercent } from "@azohra/meteo.briefing/derive";
import { publishedCloudBaseKind, publishedEffectiveCloudLimit, publishedLift, publishedLiftFamily } from '@windgrams/contracts/published-lift';
import {
  celsiusToFahrenheit,
  legacyMpsToKnots,
  finiteScalar,
} from "./windgram-format.ts";
import { sampleHeight } from "./windgram-sampling.ts";
import type { WindgramView } from "./windgram-view.ts";

import type { WindgramReading } from './scene-types.ts';
export type { WindgramReading } from './scene-types.ts';

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
function windShearAtHeight(sample: WindgramView['sampling'][number] | undefined, heightM: number): WindgramReading['windShear'] {
  if (!sample || sample.windU.length < 2 || heightM < sample.windU[0].altitudeM || heightM > sample.windU.at(-1)!.altitudeM) return null;
  const upper = sample.windU.findIndex(node => node.altitudeM > heightM);
  const index = upper < 0 ? sample.windU.length - 2 : upper - 1;
  const a = sample.windU[index], b = sample.windU[index + 1], av = sample.windV[index], bv = sample.windV[index + 1];
  if (!a || !b || !av || !bv || b.altitudeM <= a.altitudeM || ![a.value, b.value, av.value, bv.value].every(Number.isFinite)) return null;
  const vectorChangeMps = Math.hypot(b.value - a.value, bv.value - av.value);
  return { lowerM: a.altitudeM, upperM: b.altitudeM, vectorChangeMps, perKmMps: vectorChangeMps * 1000 / (b.altitudeM - a.altitudeM) };
}
export function readWindgram(view: WindgramView, hourIndex: number, heightM: number): WindgramReading {
  const index = clamp(Math.round(hourIndex), 0, view.hours.length - 1);
  const sample = view.sampling[index];
  const z = clamp(heightM, view.floorM, view.topM);
  const t = sample ? sampleHeight(sample.temperatureC, z) : null;
  const dewPointC = sample ? sampleHeight(sample.dewPointC, z) : null;
  const u = sample ? sampleHeight(sample.windU, z) : null, v = sample ? sampleHeight(sample.windV, z) : null;
  const wind = u !== null && v !== null ? componentsToWind(u, v) : null;
  const cloud = view.clouds.find(
    (c) => c.hourIndex === index && (c.kind === "potential" || c.kind === "effective" ? Math.abs(z - c.baseM) < 25 : z >= c.baseM && z <= c.topM),
  );
  const source = view.sourceHours[index];
  const omegaReason = view.omegaUnavailableReasons[index] ?? null;
  const omega = sample && !omegaReason ? sampleHeight(sample.verticalVelocityPaS, z) : null;
  const nativeWind = Boolean(wind && sample?.windU.some(n => Math.abs(n.altitudeM - z) < .00001 && Number.isFinite(n.value)));
  const surface = source?.surface;
  const has80m = surface?.wind80mSpeedMps != null || surface?.wind80mDirectionDeg != null;
  const pblDepthM = finiteScalar(surface?.pblHeightM);
  // The parser retains published layer diagnostics; use their stored values.
  const soaring = source && publishedLiftFamily(source) === 'v2' ? source.soaring : null;
  return {
    hourIndex: index,
    validAt: view.hours[index]?.validAt ?? "",
    heightM: z,
    heightAglM: z - view.ground.elevationM,
    temperatureF: t === null ? null : celsiusToFahrenheit(t),
    speedKt: wind === null ? null : legacyMpsToKnots(wind.speedMps),
    directionDeg: wind && wind.speedMps > 0 ? wind.directionDeg : null,
    interpolated: !nativeWind,
    gustKt: view.hours[index]?.gustKt ?? null,
    cloud: cloud?.kind ?? null,
    dewPointC,
    relativeHumidityPercent: t === null || dewPointC === null ? null : relativeHumidityPercent(t, dewPointC),
    verticalVelocityPaS: omega,
    windSource: !wind ? null : !nativeWind ? 'interpolated' : Math.abs(z - view.modelElevationM - 10) < .00001 ? 'surface-10m'
      : has80m && Math.abs(z - view.modelElevationM - 80) < .00001 ? 'surface-80m' : 'model-level',
    windShear: windShearAtHeight(sample, z),
    verticalVelocitySource: omega === null ? null : sample?.verticalVelocityPaS.some(n => Math.abs(n.altitudeM - z) < .00001) ? 'model-level' : 'interpolated',
    verticalVelocityUnavailableReason: omega === null ? omegaReason ?? 'Vertical motion unavailable at this height.' : null,
    surfaceWindSpeedMps: finiteScalar(surface?.windSpeedMps),
    surfaceWindDirectionDeg: finiteScalar(surface?.windDirectionDeg),
    precipitationMmHr: finiteScalar(surface?.precipitationMmHr),
    capeJkg: finiteScalar(surface?.capeJkg),
    cinJkg: finiteScalar(surface?.cinJkg),
    convectiveParcel: surface?.convectiveParcel === 'surface' || surface?.convectiveParcel === 'mixed-layer' ? surface.convectiveParcel : null,
    cloudBaseM: source ? finiteScalar(publishedLift(source).cloudBaseM) : null,
    cloudBaseKind: source ? publishedCloudBaseKind(source) : 'effective',
    effectiveCloudLimitM: source ? finiteScalar(publishedEffectiveCloudLimit(source)) : null,
    cloudCapped: sample?.cloudCapped ?? null,
    modelPblTopM: pblDepthM === null ? null : view.modelElevationM + pblDepthM,
    nativeCloudBaseM: finiteScalar(surface?.nativeCloudBaseM),
    nativeCloudCeilingM: finiteScalar(surface?.nativeCloudCeilingM),
    nativeCloudTopM: finiteScalar(surface?.nativeCloudTopM),
    nativeAdiabaticLclM: finiteScalar(surface?.nativeAdiabaticLclM),
    nativeLfcM: finiteScalar(surface?.nativeLfcM),
    nativeEquilibriumLevelM: finiteScalar(surface?.nativeEquilibriumLevelM),
    publishedLayerWind: soaring ? {
      meanSpeedMps: finiteScalar(soaring.blMeanWindSpeedMps), meanDirectionDeg: finiteScalar(soaring.blMeanWindDirDeg),
      topSpeedMps: finiteScalar(soaring.blTopWindSpeedMps), topDirectionDeg: finiteScalar(soaring.blTopWindDirDeg),
      surfaceToTopShearMps: finiteScalar(soaring.blWindShearMps), buoyancyShearRatio: finiteScalar(soaring.buoyancyShearRatio),
    } : null,
  };
}

