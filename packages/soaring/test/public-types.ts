import { parseAtmosphericColumn, type AtmosphericColumn, type AtmosphericLevel, type SiteForecast } from '@windgrams/contracts';
import { computeBoundaryLayerWind, parcelLclAglM, type BoundaryLayerWind } from '@windgrams/meteorology';
import { deriveDiagnosticsV2, computeThermalVelocityMps, type SoaringDiagnostics } from '@windgrams/soaring';
import { postprocessPointForecast, sourceFromPublishedDeterministicHour, normalizeLaunchComparisonHour, deriveEnsembleSoaringDiagnostics } from '@windgrams/soaring/compatibility';

declare const raw: unknown;
const level: AtmosphericLevel = { pressureHpa: 900, heightM: 1000, temperatureC: 10, dewPointDepressionC: 5, windSpeedMps: 2, windDirectionDeg: 270 };
const column: AtmosphericColumn = { validAt: '2026-10-24T12:00:00Z', temperatureC: 20, dewPointC: 10, windSpeedMps: 2, windDirectionDeg: 270, levels: [level] };
// @ts-expect-error normalized columns require a moisture representation
const dryInput: AtmosphericColumn = { validAt: '2026-10-24T12:00:00Z', temperatureC: 20, windSpeedMps: 2, windDirectionDeg: 270, levels: [] };
const parsed: AtmosphericColumn | null = parseAtmosphericColumn(raw);
const wind: BoundaryLayerWind | null = computeBoundaryLayerWind(100, column, column.levels, 1000);
const lcl: number | null = parcelLclAglM(column.temperatureC, column.dewPointC);
const diagnostics: SoaringDiagnostics | null = deriveDiagnosticsV2(100, column, { derived: { cloudBaseM: 1500 } });
if (diagnostics) {
  const velocity: number = diagnostics.thermalVelocityV2Mps;
  const top: number | null = diagnostics.usableLiftTopV2M;
  // @ts-expect-error diagnostic scalars are numeric, never arbitrary dictionaries
  diagnostics.thermalVelocityV2Mps.toUpperCase();
  // @ts-expect-error undocumented diagnostic names are not part of the contract
  diagnostics.unpublishedMetric;
}
// @ts-expect-error state needs the complete normalized input contract
deriveDiagnosticsV2(100, { temperatureC: 20 }, {});
// @ts-expect-error core convective calculation uses unit-bearing object input
computeThermalVelocityMps(20);
computeThermalVelocityMps({ surfaceTemperatureC: 20, sensibleHeatFluxWm2: 150, latentHeatFluxWm2: 20, boundaryLayerDepthM: 1000, surfacePressureHpa: 950 });
deriveEnsembleSoaringDiagnostics([{ source: column, v1Hour: {} }] as const, 100);
declare const profile: SiteForecast;
const processed = postprocessPointForecast(profile);
processed.hours[0].validAt.toUpperCase();
normalizeLaunchComparisonHour('gfs', profile.hours[0]);
const reconstructed = sourceFromPublishedDeterministicHour(profile.hours[0]);
if (reconstructed) {
  // @ts-expect-error upstream optional distributions are not guaranteed scalar columns
  const unchecked: AtmosphericColumn = reconstructed;
  const checked = parseAtmosphericColumn(reconstructed);
  if (checked) deriveDiagnosticsV2(100, checked, {});
}
const sparse = postprocessPointForecast({ model: 'nws', grid: { office: 'SEW' }, hours: [{ validAt: '2026-10-24T12:00:00Z', temperatureC: 20, dewpointC: 10 }] });
sparse.hours[0].validAt.toUpperCase();
void [parsed, wind, lcl, dryInput];
