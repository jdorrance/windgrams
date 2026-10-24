// Model-aware soaring post-processing for point forecasts (Track 2 & Feedback 1-5).
//
// Core scientific guarantees:
// 1. No synthetic pressure levels: sparse 9-level profiles remain 9 levels (`synthesizedLevels: 0`).
// 2. Deterministic column models (`hrrr-conus`, `hrdps-continental`, `rrfs`, `rdps`, `nam`, `gfs`, `gdps`)
//    retain their v1 `hour.derived` block unchanged for public contract compatibility and attach
//    a versioned `hour.soaring` (`contractVersion: "2.1.0"`) block with consistent v2 thermal top,
//    W* (`thermalVelocityV2Mps`), `usableLiftTopV2M`, `hcritWxtoflyM`, `dryHcritM`, physical
//    `mixedLayerLclM` (without the legacy 0.85 multiplier), and isolated `experimental.terrainAdjustment`.
// 3. Ensemble models (`geps`) must derive nonlinear soaring diagnostics per member BEFORE
//    calculating percentiles (`deriveEnsembleSoaringDiagnostics`). Post-processing an already-aggregated
//    percentile document refuses to run single-column physics on `p50` medians.
// 4. Surface / sparse-level adapters (`ecmwf`, `nws`) compute only supported diagnostics (`surfaceLclM`
//    and available wind/transport-wind summaries) while keeping `thermalVelocityMps` (W*) and
//    `usableLiftTopM` explicitly `null`.

import {
  SOARING_CONTRACT_VERSION,
  computeExperimentalTerrainAdjustment,
  deriveDiagnosticsV2,
  parcelLclAglM,
} from './science.mjs';

const finite = n => typeof n === 'number' && Number.isFinite(n);
const round1 = n => (finite(n) ? Math.round(n * 10) / 10 : null);
const round2 = n => (finite(n) ? Math.round(n * 100) / 100 : null);

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

export function isEnsembleScalar(value) {
  return Boolean(value && typeof value === 'object' && ('p50' in value || 'members' in value));
}

export function isEnsembleDocument(doc) {
  if (!doc) return false;
  if (ENSEMBLE_PERCENTILE_MODELS.includes(doc.model)) return true;
  if ((doc.run?.members ?? 0) > 1) return true;
  const firstHour = doc.hours?.[0];
  return Boolean(firstHour?.surface && isEnsembleScalar(firstHour.surface.temperatureC));
}

/**
 * Linear interpolation percentile helper matching @azohra/meteo.forecast ensemble aggregation.
 */
function interpolatePercentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] + weight * (sortedValues[upper] - sortedValues[lower]);
}

export function aggregateEnsembleMetric(memberValues, { roundFn = round2, ceiledFlags = null } = {}) {
  const valid = memberValues.filter(finite).sort((a, b) => a - b);
  const block = {
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
 * Derives nonlinear v2 soaring diagnostics per ensemble member column FIRST,
 * then aggregates percentiles across members. Never runs nonlinear physics on medians.
 */
export function deriveEnsembleSoaringDiagnostics(memberColumns, terrainM, options = {}) {
  if (!Array.isArray(memberColumns) || memberColumns.length === 0 || !finite(terrainM)) {
    throw new Error('deriveEnsembleSoaringDiagnostics requires non-empty memberColumns and finite terrainM');
  }
  const memberResults = memberColumns.map(({ source, v1Hour }) =>
    deriveDiagnosticsV2(terrainM, source, v1Hour, options),
  ).filter(Boolean);

  if (memberResults.length === 0) return null;

  const heightKeys = ['resolvedThermalTopM', 'thermalTopPlus1CM', 'usableLiftTopV2M', 'hcritWxtoflyM', 'dryHcritM', 'surfaceLclM', 'effectiveCloudLimitM', 'mixedLayerLclM', 'cuPotentialM', 'odPotentialM'];
  const speedKeys = ['thermalVelocityV2Mps', 'blMeanWindSpeedMps', 'blTopWindSpeedMps', 'blWindShearMps', 'buoyancyShearRatio'];

  const aggregated = {
    contractVersion: SOARING_CONTRACT_VERSION,
    modelKind: 'ensemble-percentiles',
    derivationRule: 'per-member-before-percentiles',
    memberCount: memberResults.length,
  };

  for (const key of heightKeys) {
    aggregated[key] = aggregateEnsembleMetric(
      memberResults.map(r => r[key]),
      { roundFn: round1 },
    );
  }
  for (const key of speedKeys) {
    aggregated[key] = aggregateEnsembleMetric(
      memberResults.map(r => r[key]),
      { roundFn: round2 },
    );
  }
  return aggregated;
}

/**
 * Reconstructs the raw `source` input expected by `deriveDiagnosticsV2` from a
 * published deterministic `SiteForecast` hour without synthesizing any levels.
 */
export function sourceFromPublishedDeterministicHour(hour) {
  if (!hour?.surface || !Array.isArray(hour.levels)) return null;
  const s = hour.surface;
  if (!finite(s.temperatureC) || !finite(s.dewPointC) || !finite(s.windSpeedMps) || !finite(s.windDirectionDeg)) {
    return null;
  }
  return {
    validAt: hour.validAt,
    temperatureC: s.temperatureC,
    dewPointC: s.dewPointC,
    dewPointDepressionC: s.temperatureC - s.dewPointC,
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
    levels: hour.levels.map(l => ({
      pressureHpa: l.pressureHpa,
      heightM: l.heightM,
      temperatureC: l.temperatureC,
      dewPointC: l.dewPointC,
      dewPointDepressionC: l.temperatureC - l.dewPointC,
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
export function postprocessSparseAdapterDocument(doc, { modelSlug, launchElevationM = null } = {}) {
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
      },
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
    },
    hours,
  };
}

/**
 * Model-aware post-processor for any point forecast document in `forecasts/data/<model>/sites/<slug>.json`.
 */
export function postprocessPointForecast(doc, { modelSlug = null, launchElevationM = null } = {}) {
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
      },
    };
  }

  const terrainM = doc.site?.modelElevationM;
  if (!finite(terrainM)) return doc;

  let sparseHoursCount = 0;
  const hours = (doc.hours ?? []).map(hour => {
    const source = sourceFromPublishedDeterministicHour(hour);
    const v2 = source ? deriveDiagnosticsV2(terrainM, source, hour, { launchElevationM }) : null;
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
    },
    hours,
  };
}
