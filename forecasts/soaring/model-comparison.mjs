// Pure model-hour normalizer and metadata accessors shared by regional launch
// sidecar publication and cross-model spread verification.
//
// Preserves ensemble dropout semantics (members === 0 -> all-null percentiles),
// scalar circular-median wind direction on GEPS, distinct legacy vs V2 diagnostic
// families, and explicit null unsupported fields on ECMWF and NWS sparse adapters.

import { SOARING_CONTRACT_VERSION } from './diagnostics.mjs';
import { finite, round1, round2 } from './thermodynamics.mjs';

export const COMPARISON_MODEL_ORDER = Object.freeze([
  'hrrr-conus',
  'rrfs',
  'icon-eu',
  'hrdps-continental',
  'rdps',
  'gdps',
  'gfs',
  'geps',
  'ecmwf',
  'nws',
]);

/**
 * Extracts a finite scalar value or ensemble median (`p50`), respecting zero-member dropout.
 * @param { unknown } value
 * @returns { number | null }
 */
export function extractEnsembleMedian(value) {
  if (finite(value)) return value;
  if (value && typeof value === 'object' && 'p50' in value) {
    const dist = /** @type {{ members?: number; p50?: unknown }} */ (value);
    if (typeof dist.members === 'number' && dist.members <= 0) return null;
    return finite(dist.p50) ? dist.p50 : null;
  }
  return null;
}

/**
 * Extracts the p10–p90 ensemble spread when at least one bound is finite and member count is positive.
 * @param { unknown } value
 * @returns { { p10: number | null; p90: number | null } | null }
 */
export function extractEnsembleSpread(value) {
  if (!value || typeof value !== 'object') return null;
  const dist = /** @type {{ members?: number; p10?: unknown; p90?: unknown }} */ (value);
  if (typeof dist.members === 'number' && dist.members <= 0) return null;
  const p10 = finite(dist.p10) ? dist.p10 : null;
  const p90 = finite(dist.p90) ? dist.p90 : null;
  return p10 !== null || p90 !== null ? { p10, p90 } : null;
}

/**
 * Extracts run reference timestamp and model terrain elevation (m MSL) from any model document.
 * @param { Record<string, any> | null | undefined } doc
 * @param { string } [modelSlug]
 * @returns { { modelKind: 'ensemble-percentiles' | 'surface-or-sparse-adapter' | 'deterministic-column'; contractVersion: string; referenceTime: string | null; modelElevationM: number | null; unsupportedReason: string | null } }
 */
export function extractModelMetadata(doc, modelSlug = '') {
  const slug = modelSlug || doc?.model || '';
  if (slug === 'geps' || doc?.soaringMeta?.modelKind === 'ensemble-percentiles') {
    return {
      modelKind: 'ensemble-percentiles',
      contractVersion: doc?.soaringMeta?.contractVersion ?? SOARING_CONTRACT_VERSION,
      referenceTime: doc?.run?.referenceTime ?? null,
      modelElevationM: finite(doc?.site?.modelElevationM) ? doc.site.modelElevationM : null,
      unsupportedReason: null,
    };
  }
  if (slug === 'ecmwf' || slug === 'nws' || doc?.soaringMeta?.modelKind === 'surface-or-sparse-adapter') {
    const elev = finite(doc?.site?.gridElevationM)
      ? doc.site.gridElevationM
      : (finite(doc?.grid?.elevationM) ? doc.grid.elevationM : null);
    return {
      modelKind: 'surface-or-sparse-adapter',
      contractVersion: doc?.soaringMeta?.contractVersion ?? SOARING_CONTRACT_VERSION,
      referenceTime: doc?.models?.surface?.run ?? doc?.updateTime ?? doc?.generatedAt ?? null,
      modelElevationM: elev,
      unsupportedReason: doc?.soaringMeta?.unsupportedReason ?? null,
    };
  }
  return {
    modelKind: 'deterministic-column',
    contractVersion: doc?.soaringMeta?.contractVersion ?? SOARING_CONTRACT_VERSION,
    referenceTime: doc?.run?.referenceTime ?? null,
    modelElevationM: finite(doc?.site?.modelElevationM) ? doc.site.modelElevationM : null,
    unsupportedReason: null,
  };
}

/**
 * Normalizes a single model hour into the published `launches.json` comparison shape.
 * Preserves legacy vs V2 diagnostic family separation and scalar GEPS circular-median wind direction.
 *
 * @param { string } modelSlug
 * @param { Record<string, any> } mh
 * @returns { Record<string, any> }
 */
export function normalizeLaunchComparisonHour(modelSlug, mh) {
  if (modelSlug === 'geps') {
    const s = mh.soaring ?? null;
    const d = mh.derived ?? {};
    const rawWindDir = mh.surface?.windDirectionDeg;
    const windDirectionDeg = extractEnsembleMedian(rawWindDir);
    const effCloudDist = s?.effectiveCloudLimitM ?? d.cloudBaseM;
    return {
      validAt: mh.validAt,
      tempC: extractEnsembleMedian(mh.surface?.temperatureC),
      tempSpreadC: extractEnsembleSpread(mh.surface?.temperatureC),
      dewPointC: extractEnsembleMedian(mh.surface?.dewPointC),
      windSpeedMps: extractEnsembleMedian(mh.surface?.windSpeedMps),
      windSpeedSpreadMps: extractEnsembleSpread(mh.surface?.windSpeedMps),
      windDirectionDeg,
      windGustMps: extractEnsembleMedian(mh.surface?.windGustMps),
      cloudCoverPct: extractEnsembleMedian(mh.surface?.cloudCoverPercent),
      pblHeightM: null,
      sensibleHeatWm2: extractEnsembleMedian(mh.surface?.sensibleHeatFluxWm2),
      // Preserve legacy GEPS member-derived diagnostics distinctly from V2 fields
      wstarMps: extractEnsembleMedian(d.thermalVelocityMps),
      wstarLegacySpreadMps: extractEnsembleSpread(d.thermalVelocityMps),
      usableLiftTopM: extractEnsembleMedian(d.usableLiftTopM),
      usableLiftLegacySpreadM: extractEnsembleSpread(d.usableLiftTopM),
      blTopM: extractEnsembleMedian(d.boundaryLayerTopM),
      blTopLegacySpreadM: extractEnsembleSpread(d.boundaryLayerTopM),
      // Populate V2 fields only when member-level V2 diagnostics were derived
      wstarV2Mps: extractEnsembleMedian(s?.thermalVelocityV2Mps),
      wstarSpreadMps: extractEnsembleSpread(s?.thermalVelocityV2Mps),
      usableLiftTopV2M: extractEnsembleMedian(s?.usableLiftTopV2M),
      usableLiftSpreadM: extractEnsembleSpread(s?.usableLiftTopV2M),
      resolvedThermalTopM: extractEnsembleMedian(s?.resolvedThermalTopM),
      thermalTopSpreadM: extractEnsembleSpread(s?.resolvedThermalTopM),
      surfaceLclM: extractEnsembleMedian(s?.surfaceLclM),
      effectiveCloudLimitM: extractEnsembleMedian(effCloudDist),
      cloudLimitSpreadM: extractEnsembleSpread(effCloudDist),
      cloudBaseM: extractEnsembleMedian(d.cloudBaseM),
    };
  }

  if (modelSlug === 'ecmwf' || modelSlug === 'nws') {
    return {
      validAt: mh.validAt,
      tempC: finite(mh.temperatureC) ? mh.temperatureC : null,
      dewPointC: finite(mh.dewPointC) ? mh.dewPointC : (finite(mh.dewpointC) ? mh.dewpointC : null),
      windSpeedMps: finite(mh.windSpeedMps) ? mh.windSpeedMps : null,
      windDirectionDeg: finite(mh.windDirectionDeg) ? mh.windDirectionDeg : null,
      windGustMps: finite(mh.windGustMps) ? mh.windGustMps : null,
      cloudCoverPct: finite(mh.cloudCoverPercent) ? mh.cloudCoverPercent : (finite(mh.skyCoverPct) ? mh.skyCoverPct : null),
      pblHeightM: finite(mh.boundaryLayerHeightM) ? mh.boundaryLayerHeightM : (finite(mh.mixingHeightM) ? mh.mixingHeightM : null),
      sensibleHeatWm2: null,
      wstarMps: null,
      usableLiftTopM: null,
      blTopM: finite(mh.soaring?.modelBlTopM) ? mh.soaring.modelBlTopM : null,
      surfaceLclM: finite(mh.soaring?.surfaceLclM) ? mh.soaring.surfaceLclM : null,
      effectiveCloudLimitM: null,
      cloudBaseM: finite(mh.soaring?.surfaceLclM) ? mh.soaring.surfaceLclM : null,
    };
  }

  const s = mh.soaring ?? {};
  const hasV2 = Boolean(mh.soaring && Object.hasOwn(s, 'thermalVelocityV2Mps'));
  return {
    validAt: mh.validAt,
    tempC: finite(mh.surface?.temperatureC) ? mh.surface.temperatureC : null,
    dewPointC: finite(mh.surface?.dewPointC) ? mh.surface.dewPointC : null,
    windSpeedMps: finite(mh.surface?.windSpeedMps) ? mh.surface.windSpeedMps : null,
    windDirectionDeg: finite(mh.surface?.windDirectionDeg) ? mh.surface.windDirectionDeg : null,
    windGustMps: finite(mh.surface?.windGustMps) ? mh.surface.windGustMps : null,
    cloudCoverPct: finite(mh.surface?.cloudCoverPercent) ? mh.surface.cloudCoverPercent : null,
    pblHeightM: finite(mh.surface?.pblHeightM) ? mh.surface.pblHeightM : null,
    sensibleHeatWm2: finite(mh.surface?.sensibleHeatFluxWm2) ? mh.surface.sensibleHeatFluxWm2 : null,
    wstarMps: finite(mh.derived?.thermalVelocityMps) ? mh.derived.thermalVelocityMps : null,
    usableLiftTopM: finite(mh.derived?.usableLiftTopM) ? mh.derived.usableLiftTopM : null,
    ...(hasV2
      ? {
          wstarV2Mps: finite(s.thermalVelocityV2Mps) ? s.thermalVelocityV2Mps : null,
          usableLiftTopV2M: finite(s.usableLiftTopV2M) ? s.usableLiftTopV2M : null,
          resolvedThermalTopM: finite(s.resolvedThermalTopM) ? s.resolvedThermalTopM : null,
        }
      : {}),
    hcritWxtoflyM: finite(s.hcritWxtoflyM) ? s.hcritWxtoflyM : null,
    surfaceLclM: finite(s.surfaceLclM) ? s.surfaceLclM : null,
    effectiveCloudLimitM: finite(s.effectiveCloudLimitM)
      ? s.effectiveCloudLimitM
      : (finite(mh.derived?.cloudBaseM) ? mh.derived.cloudBaseM : null),
    mixedLayerLclM: finite(s.mixedLayerLclM) ? s.mixedLayerLclM : null,
    experimentalTerrain: s.experimental?.terrainAdjustment ?? null,
    blTopM: finite(mh.derived?.boundaryLayerTopM) ? mh.derived.boundaryLayerTopM : null,
    cloudBaseM: finite(s.surfaceLclM)
      ? s.surfaceLclM
      : (finite(mh.derived?.cloudBaseM) ? mh.derived.cloudBaseM : null),
  };
}

/**
 * Summarizes a window of postprocessed model hours for cross-model spread reporting.
 * @param { string } modelSlug
 * @param { Record<string, any> } doc
 * @param { readonly Record<string, any>[] } windowHours
 * @returns { Record<string, any> }
 */
export function summarizeModelWindowSpread(modelSlug, doc, windowHours) {
  const meta = extractModelMetadata(doc, modelSlug);
  const coverageSamples = windowHours.length;
  const timestamps = windowHours
    .map(h => Date.parse(h.validAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const coverageSpanHours = timestamps.length >= 2
    ? round1((timestamps[timestamps.length - 1] - timestamps[0]) / 3600000)
    : 0;
  const status = coverageSamples > 0 ? 'available' : 'unavailable';
  const normalized = windowHours.map(h => normalizeLaunchComparisonHour(modelSlug, h));

  if (meta.modelKind === 'ensemble-percentiles') {
    const v2Wstars = normalized.map(h => h.wstarV2Mps).filter(finite);
    const v2UTops = normalized.map(h => h.usableLiftTopV2M).filter(finite);
    const legacyWstars = normalized.map(h => h.wstarMps).filter(finite);
    const legacyUTops = normalized.map(h => h.usableLiftTopM).filter(finite);
    const winds = normalized.map(h => h.windSpeedMps).filter(finite);
    const temps = normalized.map(h => h.tempC).filter(finite);
    const effClouds = normalized.map(h => h.effectiveCloudLimitM ?? h.cloudBaseM).filter(finite);
    return {
      model: modelSlug,
      modelKind: 'ensemble-percentiles',
      derivationRule: 'per-member-before-percentiles',
      referenceTime: meta.referenceTime,
      modelElevationM: meta.modelElevationM,
      coverageSamples,
      coverageSpanHours,
      status,
      peakWstarV2Mps: coverageSamples > 0 && v2Wstars.length ? round2(Math.max(...v2Wstars)) : null,
      peakUsableLiftTopV2M: coverageSamples > 0 && v2UTops.length ? round1(Math.max(...v2UTops)) : null,
      peakLegacyWstarMps: coverageSamples > 0 && legacyWstars.length ? round2(Math.max(...legacyWstars)) : null,
      peakLegacyUsableLiftTopM: coverageSamples > 0 && legacyUTops.length ? round1(Math.max(...legacyUTops)) : null,
      minEffectiveCloudLimitM: coverageSamples > 0 && effClouds.length ? round1(Math.min(...effClouds)) : null,
      meanWindSpeedMps: coverageSamples > 0 && winds.length ? round2(winds.reduce((a, b) => a + b, 0) / winds.length) : null,
      maxTempC: coverageSamples > 0 && temps.length ? round1(Math.max(...temps)) : null,
    };
  }

  if (meta.modelKind === 'surface-or-sparse-adapter') {
    const winds = normalized.map(h => h.windSpeedMps).filter(finite);
    const temps = normalized.map(h => h.tempC).filter(finite);
    const lcls = normalized.map(h => h.surfaceLclM).filter(finite);
    return {
      model: modelSlug,
      modelKind: 'surface-or-sparse-adapter',
      referenceTime: meta.referenceTime,
      modelElevationM: meta.modelElevationM,
      coverageSamples,
      coverageSpanHours,
      status,
      peakWstarV2Mps: null,
      peakUsableLiftTopV2M: null,
      minSurfaceLclM: coverageSamples > 0 && lcls.length ? round1(Math.min(...lcls)) : null,
      meanWindSpeedMps: coverageSamples > 0 && winds.length ? round2(winds.reduce((a, b) => a + b, 0) / winds.length) : null,
      maxTempC: coverageSamples > 0 && temps.length ? round1(Math.max(...temps)) : null,
      unsupportedReason: meta.unsupportedReason,
    };
  }

  const wstarsV2 = normalized.map(h => h.wstarV2Mps).filter(finite);
  const uTopsV2 = normalized.map(h => h.usableLiftTopV2M).filter(finite);
  const rTopsV2 = normalized.map(h => h.resolvedThermalTopM).filter(finite);
  const lcls = normalized.map(h => h.surfaceLclM).filter(finite);
  const effClouds = normalized.map(h => h.effectiveCloudLimitM ?? h.cloudBaseM).filter(finite);
  const winds = normalized.map(h => h.windSpeedMps).filter(finite);
  const temps = normalized.map(h => h.tempC).filter(finite);

  return {
    model: modelSlug,
    modelKind: 'deterministic-column',
    contractVersion: meta.contractVersion,
    referenceTime: meta.referenceTime,
    modelElevationM: meta.modelElevationM,
    coverageSamples,
    coverageSpanHours,
    status,
    peakWstarV2Mps: coverageSamples > 0 && wstarsV2.length ? round2(Math.max(...wstarsV2)) : null,
    peakUsableLiftTopV2M: coverageSamples > 0 && uTopsV2.length ? round1(Math.max(...uTopsV2)) : null,
    peakResolvedThermalTopM: coverageSamples > 0 && rTopsV2.length ? round1(Math.max(...rTopsV2)) : null,
    minSurfaceLclM: coverageSamples > 0 && lcls.length ? round1(Math.min(...lcls)) : null,
    minEffectiveCloudLimitM: coverageSamples > 0 && effClouds.length ? round1(Math.min(...effClouds)) : null,
    meanWindSpeedMps: coverageSamples > 0 && winds.length ? round2(winds.reduce((a, b) => a + b, 0) / winds.length) : null,
    maxTempC: coverageSamples > 0 && temps.length ? round1(Math.max(...temps)) : null,
  };
}
