// Format inspector readings; DOM interaction lives in windgram-dom.ts.
import { fahrenheitToCelsius, formatQuantity, gustNoun, knotsToMps, type UnitSystem } from './windgram-format.ts';
import type { WindgramView } from './windgram-view.ts';
import type { WindgramReading } from './scene-types.ts';

const barbSpeed = (knots: number, system: UnitSystem) => formatQuantity(knotsToMps(knots), 'barbWind', undefined, system);
const degrees = (direction: number) => `${["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(direction / 22.5) % 16]} ${Math.round(direction) % 360}°`;
const windSources = {
  'surface-10m': 'Native 10 m wind', 'surface-80m': 'Native 80 m wind',
  'model-level': 'Model level', interpolated: 'Interpolated',
};
const cloudLabels = {
  model: 'Model cloud layer', humidity: 'Likely cloud layer from humidity >94%',
  effective: 'Effective cloud limit', potential: 'Potential cloud base',
};

function surfaceDetails(view: WindgramView, reading: WindgramReading): string[] {
  const system = view.unitSystem;
  const rainLabel = view.precipitationSemantics === 'instantRate' ? 'Rain rate sample'
    : view.precipitationSemantics === 'windowMeanRate' ? 'Mean rain rate (preceding interval)' : 'Rain rate (timing unspecified)';
  const layer = reading.publishedLayerWind;
  const wind = (speed: number | null, direction: number | null) => speed === null ? 'unavailable'
    : `${formatQuantity(speed, 'wind', undefined, system)}${direction === null || speed === 0 ? '' : ` from ${degrees(direction)}`}`;
  return [
    `Model surface wind ${wind(reading.surfaceWindSpeedMps, reading.surfaceWindDirectionDeg)}`,
    reading.gustKt === null ? null : `Surface ${gustNoun(view.gustSemantics)} ${barbSpeed(reading.gustKt, system)}`,
    reading.precipitationMmHr === null ? 'Rain rate unavailable' : `${rainLabel} ${formatQuantity(reading.precipitationMmHr, 'rainRate', undefined, system)}`,
    `CAPE ${reading.capeJkg === null ? 'unavailable' : `${Math.round(reading.capeJkg)} J/kg`}`,
    `CIN ${reading.cinJkg === null ? 'unavailable' : `${Math.round(reading.cinJkg)} J/kg`}`,
    `CAPE/CIN parcel: ${reading.convectiveParcel === 'mixed-layer' ? 'mixed layer' : reading.convectiveParcel ?? 'unspecified'}`,
    reading.cloudBaseM === null ? null : `${reading.cloudBaseKind === 'potential' ? 'Potential cloud base (surface LCL)' : 'Effective cloud limit (v1)'} ${formatQuantity(reading.cloudBaseM, 'elevation', undefined, system)} MSL`,
    reading.cloudBaseKind === 'potential' && reading.effectiveCloudLimitM !== null ? `Effective cloud limit ${formatQuantity(reading.effectiveCloudLimitM, 'elevation', undefined, system)} MSL${reading.cloudCapped ? ' · limits usable lift' : ''}` : null,
    ...([['Model boundary-layer top', reading.modelPblTopM], ['Model cloud base', reading.nativeCloudBaseM],
      ['Model cloud ceiling', reading.nativeCloudCeilingM], ['Model cloud top', reading.nativeCloudTopM],
      ['Model adiabatic LCL', reading.nativeAdiabaticLclM], ['Model LFC', reading.nativeLfcM],
      ['Model equilibrium level', reading.nativeEquilibriumLevelM]] as const)
      .map(([label, height]) => height === null ? null : `${label} ${formatQuantity(height, 'elevation', undefined, system)} MSL`),
    ...(layer ? [`Layer mean wind ${wind(layer.meanSpeedMps, layer.meanDirectionDeg)}`,
      `Layer top wind ${wind(layer.topSpeedMps, layer.topDirectionDeg)}`,
      `Surface-to-layer-top shear ${layer.surfaceToTopShearMps === null ? 'unavailable' : formatQuantity(layer.surfaceToTopShearMps, 'wind', undefined, system)}`] : []),
  ].filter((text): text is string => text !== null);
}

export function formatWindgramReading(view: WindgramView, reading: WindgramReading, scope: 'surface' | 'height'): string[] {
  if (scope === 'surface') return surfaceDetails(view, reading);
  const system = view.unitSystem;
  return [
    reading.temperatureF == null ? "Temperature unavailable" : `${formatQuantity(fahrenheitToCelsius(reading.temperatureF), "temperature", 1, system)}`,
    reading.speedKt == null
      ? "Wind unavailable"
      : reading.speedKt < 0.1
        ? "Calm"
        : `${barbSpeed(reading.speedKt, system)}${reading.directionDeg == null ? "" : ` from ${degrees(reading.directionDeg)}`}`,
    reading.windSource === null ? null : windSources[reading.windSource],
    reading.windShear === null ? 'Layer wind shear unavailable' : `Layer wind shear ${reading.windShear.perKmMps.toFixed(1)} m/s per km (${formatQuantity(reading.windShear.lowerM, 'elevation', undefined, system)}–${formatQuantity(reading.windShear.upperM, 'elevation', undefined, system)} MSL)`,
    reading.dewPointC === null ? 'Dew point unavailable' : `Dew point ${formatQuantity(reading.dewPointC, 'temperature', 1, system)}`,
    reading.relativeHumidityPercent === null ? 'RH unavailable' : `RH ${Math.round(reading.relativeHumidityPercent)}%`,
    reading.verticalVelocityPaS === null ? reading.verticalVelocityUnavailableReason : `Vertical motion ${reading.verticalVelocityPaS.toFixed(2)} Pa/s (${reading.verticalVelocityPaS < 0 ? 'ascent' : reading.verticalVelocityPaS > 0 ? 'descent' : 'neutral'}; ${reading.verticalVelocitySource === 'model-level' ? 'model level' : 'interpolated'})`,
    reading.cloud === null ? null : cloudLabels[reading.cloud],
    view.ensemble ? "Ensemble median" : null,
    view.hours[reading.hourIndex]?.liftFamily === "v1-legacy" ? "Earlier lift method (v1)" : null,
    ...surfaceDetails(view, reading),
  ].filter((value): value is string => value !== null);
}
