import { parseAtmosphericColumn, type SiteForecast } from "@windgrams/contracts";
import type { CompatibilityDocument, CompatibilityHour, DiagnosticOptions, EnsembleMetric, EnsembleSoaringDiagnostics, MemberColumn, PostprocessOptions, PostprocessedDocument, PostprocessedSiteForecast, SoaringMetadata, SparseSoaringDiagnostics } from "./types.js";
import { SOARING_CONTRACT_VERSION, deriveDiagnosticsV2 } from './diagnostics.js';
import { computeExperimentalTerrainAdjustment } from './terrain-adjustment.js';
import { parcelLclAglM } from '@windgrams/meteorology/thermodynamics';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const round1 = (n: unknown): number | null => (finite(n) ? Math.round(n * 10) / 10 : null);
const round2 = (n: unknown): number | null => (finite(n) ? Math.round(n * 100) / 100 : null);

export const DETERMINISTIC_COLUMN_MODELS = Object.freeze([
  'hrrr-conus',
  'hrdps-continental',
  'hrdps-west',
  'rrfs',
  'icon-eu',
  'rdps',
  'nam',
  'nam-conus-nest',
  'gfs',
  'gdps',
]);

export const ENSEMBLE_PERCENTILE_MODELS = Object.freeze(['geps']);
export const SPARSE_ADAPTER_MODELS = Object.freeze(['ecmwf', 'nws']);

export function isEnsembleScalar(value: unknown) {
  return Boolean(value && typeof value === 'object' && ('p50' in value || 'members' in value));
}

export function isEnsembleDocument(doc: CompatibilityDocument | null | undefined) {
  if (!doc) return false;
  if (ENSEMBLE_PERCENTILE_MODELS.includes(doc.model ?? "")) return true;
  if ((doc.run?.members ?? 0) > 1) return true;
  const firstHour = doc.hours?.[0];
  return Boolean(firstHour?.surface && isEnsembleScalar(firstHour.surface.temperatureC));
}

/**
 * Linear interpolation percentile helper matching @azohra/meteo.forecast ensemble aggregation.
 */
function interpolatePercentile(sortedValues: number[], p: number) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] + weight * (sortedValues[upper] - sortedValues[lower]);
}

export function aggregateEnsembleMetric(memberValues: readonly unknown[], { roundFn = round2, ceiledFlags = null }: {
    roundFn?: (value: number | null) => number | null;
    ceiledFlags?: readonly boolean[] | null;
} = {}) {
  const valid = memberValues.filter(finite).sort((a, b) => a - b);
  const block: EnsembleMetric = {
    members: valid.length,
    p10: roundFn(interpolatePercentile(valid, 10)),
    p25: roundFn(interpolatePercentile(valid, 25)),
    p50: roundFn(interpolatePercentile(valid, 50)),
    p75: roundFn(interpolatePercentile(valid, 75)),
    p90: roundFn(interpolatePercentile(valid, 90)),
  };
  if (Array.isArray(ceiledFlags)) {
    block.ceiledMembers = ceiledFlags.filter(Boolean).length;
  }
  return block;
}

/**
 * Derive nonlinear diagnostics per member, then aggregate percentiles.
 */
export function deriveEnsembleSoaringDiagnostics(memberColumns: readonly MemberColumn[], terrainM: number, options: DiagnosticOptions = {}): EnsembleSoaringDiagnostics | null {
  if (!Array.isArray(memberColumns) || memberColumns.length === 0 || !finite(terrainM)) {
    throw new Error('deriveEnsembleSoaringDiagnostics requires non-empty memberColumns and finite terrainM');
  }
  const memberResults = memberColumns.map(({ source, v1Hour }) =>
    deriveDiagnosticsV2(terrainM, source, v1Hour, options),
  ).filter(result => result !== null);

  if (memberResults.length === 0) return null;

  const heightKeys = ['resolvedThermalTopM', 'thermalTopPlus1CM', 'usableLiftTopV2M', 'hcritWxtoflyM', 'dryHcritM', 'surfaceLclM', 'effectiveCloudLimitM', 'mixedLayerLclM', 'cuPotentialM', 'odPotentialM'] as const;
  const speedKeys = ['thermalVelocityV2Mps', 'blMeanWindSpeedMps', 'blTopWindSpeedMps', 'blWindShearMps', 'buoyancyShearRatio'] as const;

  // The key tuples cover the declared ensemble metrics; compute each after member physics.
  const aggregate = <K extends typeof heightKeys[number] | typeof speedKeys[number]>(keys: readonly K[], roundFn: typeof round1): Record<K, EnsembleMetric> =>
    Object.fromEntries(keys.map(key => [key, aggregateEnsembleMetric(memberResults.map(result => result[key]), { roundFn })])) as Record<K, EnsembleMetric>;
  return {
    contractVersion: SOARING_CONTRACT_VERSION,
    modelKind: 'ensemble-percentiles',
    derivationRule: 'per-member-before-percentiles',
    memberCount: memberResults.length,
    ...aggregate(heightKeys, round1),
    ...aggregate(speedKeys, round2),
  };
}

/**
 * Reconstructs the raw `source` input expected by `deriveDiagnosticsV2` from a
 * published deterministic `SiteForecast` hour without synthesizing any levels.
 */
export function sourceFromPublishedDeterministicHour(hour: CompatibilityHour | null | undefined) {
  if (!hour?.surface || !Array.isArray(hour.levels)) return null;
  const s = hour.surface;
  const dewPointC = finite(s.dewPointC) ? s.dewPointC
    : finite(s.temperatureC) && finite(s.dewPointDepressionC) ? s.temperatureC - s.dewPointDepressionC : null;
  if (!finite(s.temperatureC) || !finite(dewPointC) || !finite(s.windSpeedMps) || !finite(s.windDirectionDeg)) {
    return null;
  }
  return {
    validAt: hour.validAt,
    temperatureC: s.temperatureC,
    dewPointC,
    dewPointDepressionC: s.temperatureC - dewPointC,
    windSpeedMps: s.windSpeedMps,
    windDirectionDeg: s.windDirectionDeg,
    wind80mSpeedMps: s.wind80mSpeedMps ?? null,
    wind80mDirectionDeg: s.wind80mDirectionDeg ?? null,
    windGustMps: s.windGustMps ?? null,
    cloudCoverPercent: s.cloudCoverPercent ?? 0,
    lowCloudPercent: s.lowCloudPercent ?? null,
    midCloudPercent: s.midCloudPercent ?? null,
    highCloudPercent: s.highCloudPercent ?? null,
    precipitationMm: s.precipitationMmHr ?? 0,
    sensibleHeatFluxWm2: s.sensibleHeatFluxWm2 ?? 0,
    latentHeatFluxWm2: s.latentHeatFluxWm2 ?? 0,
    seaLevelPressureHpa: s.seaLevelPressureHpa ?? 1013.25,
    capeJkg: s.capeJkg ?? null,
    cinJkg: s.cinJkg ?? null,
    pblHeightM: s.pblHeightM ?? null,
    levels: hour.levels.map((l: NonNullable<CompatibilityHour["levels"]>[number]) => ({
      pressureHpa: l.pressureHpa,
      heightM: l.heightM,
      temperatureC: l.temperatureC,
      dewPointC: l.dewPointC,
      dewPointDepressionC: finite(l.temperatureC) && finite(l.dewPointC) ? l.temperatureC - l.dewPointC
        : 'dewPointDepressionC' in l ? l.dewPointDepressionC : NaN,
      windSpeedMps: l.windSpeedMps,
      windDirectionDeg: l.windDirectionDeg,
      verticalVelocityPaS: l.verticalVelocityPaS,
      cloudFractionPercent: l.cloudFractionPercent,
    })),
  };
}

/**
 * Post-processes an ECMWF (`ecmwf`) or NWS (`nws`) document, computing only supported
 * surface LCL and wind diagnostics while keeping unsupported W* and usable-lift fields `null`.
 */
export function postprocessSparseAdapterDocument<T extends CompatibilityDocument>(doc: T, { modelSlug, launchElevationM = null }: PostprocessOptions = {}) {
  const slug = modelSlug ?? (doc.grid?.office ? 'nws' : 'ecmwf');
  const gridElevationM = slug === 'nws'
    ? (finite(doc.grid?.elevationM) && doc.grid.elevationM > 0 ? doc.grid.elevationM : (finite(launchElevationM) ? launchElevationM : 0))
    : (finite(doc.site?.gridElevationM) ? doc.site.gridElevationM : (finite(launchElevationM) ? launchElevationM : 0));

  const hours = (doc.hours ?? []).map(h => {
    const tempC = h.temperatureC ?? null;
    const dewC = (slug === 'nws' ? h.dewpointC : h.dewPointC) ?? null;
    const lclAglM = finite(tempC) && finite(dewC) ? parcelLclAglM(tempC, dewC) : null;
    const surfaceLclM = lclAglM == null ? null : round1(gridElevationM + lclAglM);
    const aglBlHeight = slug === 'nws' ? (h.mixingHeightM ?? null) : (h.boundaryLayerHeightM ?? null);
    const modelBlTopM = finite(aglBlHeight) && aglBlHeight > 0 ? round1(gridElevationM + aglBlHeight) : null;

    return {
      ...h,
      soaring: {
        contractVersion: SOARING_CONTRACT_VERSION,
        modelKind: 'surface-or-sparse-adapter',
        surfaceLclM,
        modelBlTopM,
        blMeanWindSpeedMps: slug === 'nws' ? (h.transportWindSpeedMps ?? null) : null,
        blMeanWindDirDeg: slug === 'nws' ? (h.transportWindDirectionDeg ?? null) : null,
        thermalVelocityV2Mps: null,
        usableLiftTopV2M: null,
        hcritWxtoflyM: null,
        dryHcritM: null,
        mixedLayerLclM: null,
        unsupportedDiagnostics: ['thermalVelocityV2Mps', 'usableLiftTopV2M', 'hcritWxtoflyM', 'dryHcritM', 'mixedLayerLclM'],
        unsupportedReason: 'Adapter lacks surface sensible/latent heat fluxes and dense vertical thermodynamic profile required for Deardorff W* and usable-lift derivation.',
      } satisfies SparseSoaringDiagnostics,
    };
  });

  return {
    ...doc,
    soaringMeta: {
      contractVersion: SOARING_CONTRACT_VERSION,
      model: slug,
      modelKind: 'surface-or-sparse-adapter',
      supportedDiagnostics: slug === 'nws'
        ? ['surfaceLclM', 'modelBlTopM', 'blMeanWindSpeedMps', 'blMeanWindDirDeg']
        : ['surfaceLclM', 'modelBlTopM'],
      unsupportedDiagnostics: ['thermalVelocityV2Mps', 'usableLiftTopV2M', 'hcritWxtoflyM', 'dryHcritM', 'mixedLayerLclM'],
      unsupportedReason: 'Missing surface sensible/latent heat fluxes and dense vertical profile levels.',
      synthesizedLevels: 0,
    } satisfies SoaringMetadata,
    hours,
  };
}

/**
 * Add diagnostics supported by the model, preserving its baseline forecast fields.
 */
export function postprocessPointForecast(doc: SiteForecast, options?: PostprocessOptions): PostprocessedSiteForecast;
export function postprocessPointForecast<T extends CompatibilityDocument>(doc: T, options?: PostprocessOptions): PostprocessedDocument<T>;
export function postprocessPointForecast(doc: CompatibilityDocument, { modelSlug = null, launchElevationM = null }: PostprocessOptions = {}) {
  if (!doc || typeof doc !== 'object') throw new Error('Invalid forecast document');
  const slug = modelSlug ?? doc.model ?? (doc.grid?.office ? 'nws' : doc.models?.surface ? 'ecmwf' : 'unknown');

  if (SPARSE_ADAPTER_MODELS.includes(slug) || doc.grid?.office || doc.models?.surface) {
    return postprocessSparseAdapterDocument(doc, { modelSlug: slug, launchElevationM });
  }

  if (isEnsembleDocument(doc)) {
    return {
      ...doc,
      soaringMeta: {
        contractVersion: SOARING_CONTRACT_VERSION,
        model: slug,
        modelKind: 'ensemble-percentiles',
        members: doc.run?.members ?? 21,
        derivationRule: 'per-member-before-percentiles',
        postprocessAction: 'retained-upstream-member-percentiles',
        nonlinearMedianPostprocessRefused: true,
        synthesizedLevels: 0,
        reason: 'Published GEPS values are ensemble percentiles, not scalar atmospheric columns. Nonlinear diagnostics must be derived per member before calculating percentiles; processing independently selected medians loses temperature-moisture-wind covariance.',
      } satisfies SoaringMetadata,
    };
  }

  const terrainM = doc.site?.modelElevationM;
  if (!finite(terrainM)) return doc;

  let sparseHoursCount = 0;
  const hours = (doc.hours ?? []).map(hour => {
    const source = parseAtmosphericColumn(sourceFromPublishedDeterministicHour(hour));
    const baseline = { derived: { cloudBaseM: finite(hour.derived?.cloudBaseM) ? hour.derived.cloudBaseM : null } };
    const v2 = source ? deriveDiagnosticsV2(terrainM, source, baseline, { launchElevationM }) : null;
    if (v2?.verticalResolution?.isSparseProfile) sparseHoursCount += 1;
    return {
      ...hour,
      // Baseline hour.derived is preserved unchanged for @azohra/meteo.briefing contract compatibility.
      soaring: v2,
    };
  });

  const sampleLevelCount = doc.hours?.[0]?.levels?.length ?? 0;
  return {
    ...doc,
    soaringMeta: {
      contractVersion: SOARING_CONTRACT_VERSION,
      model: slug,
      modelKind: 'deterministic-column',
      baselineDerivedRetained: true,
      nativeLevelCount: sampleLevelCount,
      isSparseProfile: sampleLevelCount <= 9 || sparseHoursCount > 0,
      synthesizedLevels: 0,
      launchElevationM: finite(launchElevationM) ? round1(launchElevationM) : null,
      terrainDeltaM: finite(launchElevationM) ? round1(launchElevationM - terrainM) : null,
      rawMslHeightsPreserved: true,
    } satisfies SoaringMetadata,
    hours,
  };
}
