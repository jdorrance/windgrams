// Track 3: Matched Observation Verification & Cross-Model Spread Scorer.
//
// Enforces strict spatial (<= 60 km, preferred <= 50 km) and temporal
// (exact validAt match, or explicit +60 min f01 initialization step when f00 is not in profile)
// matching rules, stratifies skill by lead time and weather regime, and strictly separates
// observation verification skill from cross-model forecast spread.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_ROLLING_RUNS,
  OBSERVATION_MATCHING_RULES,
  PROMOTION_GATES,
  evaluateRaobMatch,
  vectorWindErrorMps,
} from './history.mjs';
import { postprocessPointForecast } from '../soaring/point-postprocess.mjs';

const finite = n => typeof n === 'number' && Number.isFinite(n);
const round2 = n => (finite(n) ? Math.round(n * 100) / 100 : null);
const round1 = n => (finite(n) ? Math.round(n * 10) / 10 : null);

export const MATCHED_RAOB_SITE_PAIRS = Object.freeze([
  {
    siteSlug: 'or-woodrat-mountain',
    siteName: 'Woodrat Mountain, OR',
    stationId: 'KMFR',
    stationName: 'Medford',
    regime: 'valley-inversion-break',
    region: 'Rogue Valley, OR',
  },
  {
    siteSlug: 'or-poodle',
    siteName: 'Poodle Mountain, OR',
    stationId: 'KMFR',
    stationName: 'Medford',
    regime: 'valley-inversion-break',
    region: 'Rogue Valley, OR',
  },
  {
    siteSlug: 'or-peterson-butte',
    siteName: 'Peterson Butte, OR',
    stationId: 'KSLE',
    stationName: 'Salem',
    regime: 'willamette-lowland',
    region: 'Willamette Valley, OR',
  },
  {
    siteSlug: 'va-eagle-rock',
    siteName: 'Eagle Rock, VA',
    stationId: 'KRNK',
    stationName: 'Roanoke / Blacksburg',
    regime: 'appalachian-ridge-thermal',
    region: 'Shenandoah / Blue Ridge, VA',
  },
]);

export function verifyModelAgainstRaob(dataRoot, modelSlug, pair, targetSoundingValidAt = '2026-10-21T00:00:00Z') {
  const raobPath = join(dataRoot, 'raob', 'sites', `${pair.siteSlug}.json`);
  const modelPath = join(dataRoot, modelSlug, 'sites', `${pair.siteSlug}.json`);
  if (!existsSync(raobPath) || !existsSync(modelPath)) return null;

  const raobDoc = JSON.parse(readFileSync(raobPath, 'utf8'));
  const modelDoc = JSON.parse(readFileSync(modelPath, 'utf8'));
  const sounding = (raobDoc.soundings ?? []).find(s => s.validAt === targetSoundingValidAt);
  if (!sounding) return null;

  const referenceTime = modelDoc.run?.referenceTime ?? null;
  let matchedHour = (modelDoc.hours ?? []).find(h => h.validAt === targetSoundingValidAt);
  if (!matchedHour) {
    matchedHour = (modelDoc.hours ?? []).find(h => {
      const dtMin = Math.abs(Date.parse(h.validAt) - Date.parse(targetSoundingValidAt)) / 60000;
      return dtMin <= OBSERVATION_MATCHING_RULES.raobNearInitMaxTimeDeltaMinutes;
    });
  }
  if (!matchedHour) return null;

  const matchEval = evaluateRaobMatch({
    distanceKm: raobDoc.station?.distanceKm ?? 999,
    soundingValidAt: sounding.validAt,
    forecastValidAt: matchedHour.validAt,
    referenceTime,
  });

  const obsByP = new Map((sounding.levels ?? []).map(l => [l.pressureHpa, l]));
  const fcstByP = new Map((matchedHour.levels ?? []).map(l => [l.pressureHpa, l]));

  const levelComparisons = [];
  for (const p of OBSERVATION_MATCHING_RULES.pressureLevelsEvaluatedHpa) {
    const o = obsByP.get(p);
    const f = fcstByP.get(p);
    if (!o || !f) continue;
    const tempErrorC = finite(f.temperatureC) && finite(o.temperatureC) ? round2(f.temperatureC - o.temperatureC) : null;
    const dewPointErrorC = finite(f.dewPointC) && finite(o.dewPointC) ? round2(f.dewPointC - o.dewPointC) : null;
    const windSpeedErrorMps = finite(f.windSpeedMps) && finite(o.windSpeedMps) ? round2(f.windSpeedMps - o.windSpeedMps) : null;
    const windVectorErrMps = finite(f.windSpeedMps) && finite(f.windDirectionDeg) && finite(o.windSpeedMps) && finite(o.windDirectionDeg)
      ? round2(vectorWindErrorMps(f.windSpeedMps, f.windDirectionDeg, o.windSpeedMps, o.windDirectionDeg))
      : null;
    levelComparisons.push({
      pressureHpa: p,
      obsTempC: o.temperatureC,
      fcstTempC: f.temperatureC,
      tempErrorC,
      obsDewPointC: o.dewPointC,
      fcstDewPointC: f.dewPointC,
      dewPointErrorC,
      obsWindSpeedMps: o.windSpeedMps,
      obsWindDirDeg: o.windDirectionDeg,
      fcstWindSpeedMps: f.windSpeedMps,
      fcstWindDirDeg: f.windDirectionDeg,
      windSpeedErrorMps,
      windVectorErrorMps: windVectorErrMps,
    });
  }

  const tempErrors = levelComparisons.map(l => l.tempErrorC).filter(finite);
  const dewErrors = levelComparisons.map(l => l.dewPointErrorC).filter(finite);
  const vecErrors = levelComparisons.map(l => l.windVectorErrorMps).filter(finite);
  const spdErrors = levelComparisons.map(l => l.windSpeedErrorMps).filter(finite);

  return {
    model: modelSlug,
    siteSlug: pair.siteSlug,
    siteName: pair.siteName,
    regime: pair.regime,
    region: pair.region,
    station: raobDoc.station,
    modelElevationM: modelDoc.site?.modelElevationM ?? null,
    elevationDeltaM: finite(modelDoc.site?.modelElevationM) && finite(raobDoc.station?.elevationM)
      ? round1(modelDoc.site.modelElevationM - raobDoc.station.elevationM)
      : null,
    referenceTime,
    soundingValidAt: sounding.validAt,
    forecastValidAt: matchedHour.validAt,
    ...matchEval,
    metrics: {
      levelsCompared: levelComparisons.length,
      temperatureMaeC: tempErrors.length ? round2(tempErrors.reduce((a, b) => a + Math.abs(b), 0) / tempErrors.length) : null,
      temperatureBiasC: tempErrors.length ? round2(tempErrors.reduce((a, b) => a + b, 0) / tempErrors.length) : null,
      dewPointMaeC: dewErrors.length ? round2(dewErrors.reduce((a, b) => a + Math.abs(b), 0) / dewErrors.length) : null,
      windVectorRmseMps: vecErrors.length ? round2(Math.sqrt(vecErrors.reduce((a, b) => a + b * b, 0) / vecErrors.length)) : null,
      windSpeedBiasMps: spdErrors.length ? round2(spdErrors.reduce((a, b) => a + b, 0) / spdErrors.length) : null,
    },
    levelComparisons,
  };
}

export function buildBlanchardCrossModelSpread(dataRoot) {
  const models = ['hrrr-conus', 'hrdps-continental', 'rdps', 'gdps', 'gfs', 'geps', 'ecmwf', 'nws'];
  const windowStart = Date.parse('2026-10-21T14:00:00Z');
  const windowEnd = Date.parse('2026-10-22T03:00:00Z');
  const rows = [];

  for (const model of models) {
    const filePath = join(dataRoot, model, 'sites', 'wa-blanchard.json');
    if (!existsSync(filePath)) continue;
    const rawDoc = JSON.parse(readFileSync(filePath, 'utf8'));
    const doc = postprocessPointForecast(rawDoc, { modelSlug: model, launchElevationM: 378.5 });
    const windowHours = (doc.hours ?? []).filter(h => {
      const t = Date.parse(h.validAt);
      return t >= windowStart && t <= windowEnd;
    });

    if (model === 'geps') {
      const wstars = windowHours.map(h => h.derived?.thermalVelocityMps?.p50).filter(finite);
      const uTops = windowHours.map(h => h.derived?.usableLiftTopM?.p50).filter(finite);
      const winds = windowHours.map(h => h.surface?.windSpeedMps?.p50).filter(finite);
      const temps = windowHours.map(h => h.surface?.temperatureC?.p50).filter(finite);
      rows.push({
        model,
        modelKind: 'ensemble-percentiles',
        derivationRule: 'per-member-before-percentiles',
        referenceTime: doc.run?.referenceTime ?? null,
        modelElevationM: doc.site?.modelElevationM ?? null,
        peakWstarV2Mps: wstars.length ? round2(Math.max(...wstars)) : null,
        peakUsableLiftTopV2M: uTops.length ? round1(Math.max(...uTops)) : null,
        meanWindSpeedMps: winds.length ? round2(winds.reduce((a, b) => a + b, 0) / winds.length) : null,
        maxTempC: temps.length ? round1(Math.max(...temps)) : null,
      });
      continue;
    }

    if (model === 'ecmwf' || model === 'nws') {
      const winds = windowHours.map(h => h.windSpeedMps).filter(finite);
      const temps = windowHours.map(h => h.temperatureC).filter(finite);
      const lcls = windowHours.map(h => h.soaring?.surfaceLclM).filter(finite);
      rows.push({
        model,
        modelKind: 'surface-or-sparse-adapter',
        referenceTime: doc.models?.surface?.run ?? doc.updateTime ?? doc.generatedAt ?? null,
        modelElevationM: doc.site?.gridElevationM ?? doc.grid?.elevationM ?? null,
        peakWstarV2Mps: null,
        peakUsableLiftTopV2M: null,
        minSurfaceLclM: lcls.length ? round1(Math.min(...lcls)) : null,
        meanWindSpeedMps: winds.length ? round2(winds.reduce((a, b) => a + b, 0) / winds.length) : null,
        maxTempC: temps.length ? round1(Math.max(...temps)) : null,
        unsupportedReason: doc.soaringMeta?.unsupportedReason ?? null,
      });
      continue;
    }

    const wstarsV2 = windowHours.map(h => h.soaring?.thermalVelocityV2Mps).filter(finite);
    const uTopsV2 = windowHours.map(h => h.soaring?.usableLiftTopV2M).filter(finite);
    const rTopsV2 = windowHours.map(h => h.soaring?.resolvedThermalTopM).filter(finite);
    const winds = windowHours.map(h => h.surface?.windSpeedMps).filter(finite);
    const temps = windowHours.map(h => h.surface?.temperatureC).filter(finite);

    rows.push({
      model,
      modelKind: 'deterministic-column',
      contractVersion: doc.soaringMeta?.contractVersion ?? '2.0.0',
      referenceTime: doc.run?.referenceTime ?? null,
      modelElevationM: doc.site?.modelElevationM ?? null,
      peakWstarV2Mps: wstarsV2.length ? round2(Math.max(...wstarsV2)) : 0,
      peakUsableLiftTopV2M: uTopsV2.length ? round1(Math.max(...uTopsV2)) : null,
      peakResolvedThermalTopM: rTopsV2.length ? round1(Math.max(...rTopsV2)) : null,
      meanWindSpeedMps: winds.length ? round2(winds.reduce((a, b) => a + b, 0) / winds.length) : null,
      maxTempC: temps.length ? round1(Math.max(...temps)) : null,
    });
  }
  return rows;
}

export function buildSkillReport(dataRoot) {
  const modelsToVerify = ['hrrr-conus', 'rdps'];
  const matchedPairVerifications = [];

  for (const pair of MATCHED_RAOB_SITE_PAIRS) {
    for (const model of modelsToVerify) {
      const res = verifyModelAgainstRaob(dataRoot, model, pair, '2026-10-21T00:00:00Z');
      if (res && res.matched) matchedPairVerifications.push(res);
    }
  }

  const byRegime = {};
  const byLeadTimeBucket = {};
  for (const item of matchedPairVerifications) {
    const rBucket = (byRegime[item.regime] ??= { count: 0, tempMaeSum: 0, windVecRmseSum: 0, models: new Set() });
    const lBucket = (byLeadTimeBucket[item.leadTimeBucket] ??= { count: 0, tempMaeSum: 0, windVecRmseSum: 0, models: new Set() });
    if (finite(item.metrics.temperatureMaeC) && finite(item.metrics.windVectorRmseMps)) {
      rBucket.count += 1;
      rBucket.tempMaeSum += item.metrics.temperatureMaeC;
      rBucket.windVecRmseSum += item.metrics.windVectorRmseMps;
      rBucket.models.add(item.model);

      lBucket.count += 1;
      lBucket.tempMaeSum += item.metrics.temperatureMaeC;
      lBucket.windVecRmseSum += item.metrics.windVectorRmseMps;
      lBucket.models.add(item.model);
    }
  }

  const summarizeBuckets = obj => Object.fromEntries(
    Object.entries(obj).map(([key, stats]) => [
      key,
      {
        comparisons: stats.count,
        models: [...stats.models],
        meanTemperatureMaeC: stats.count ? round2(stats.tempMaeSum / stats.count) : null,
        meanWindVectorRmseMps: stats.count ? round2(stats.windVecRmseSum / stats.count) : null,
      },
    ]),
  );

  const rejectedLegacyKuilBlynF14 = evaluateRaobMatch({
    distanceKm: 113.0,
    soundingValidAt: '2026-10-21T00:00:00Z',
    forecastValidAt: '2026-10-21T14:00:00Z',
    referenceTime: '2026-10-21T00:00:00Z',
  });

  const rejectedKuilSpatialOnly = evaluateRaobMatch({
    distanceKm: 170.0,
    soundingValidAt: '2026-10-21T00:00:00Z',
    forecastValidAt: '2026-10-21T01:00:00Z',
    referenceTime: '2026-10-21T00:00:00Z',
  });

  return {
    schemaVersion: 2,
    evaluatedAt: '2026-10-22T12:00:00Z',
    matchingRules: OBSERVATION_MATCHING_RULES,
    promotionGates: {
      ...PROMOTION_GATES,
      wrfPromotionStatus: 'experimental-pending-30-day-prospective-sample',
    },
    historyRetention: {
      maxRollingRuns: DEFAULT_MAX_ROLLING_RUNS,
      cyclesPerDay: 4,
      retainedDaysCapacity: 30,
      meetsProspectiveGateCapacity: true,
    },
    observationVerificationSkill: {
      note: 'True observation verification skill requires matched valid times and station-to-launch proximity <= 60 km. Model agreement alone is not skill.',
      matchedCount: matchedPairVerifications.length,
      byLeadTimeBucket: summarizeBuckets(byLeadTimeBucket),
      byRegime: summarizeBuckets(byRegime),
      matchedPairs: matchedPairVerifications,
      rejectedMismatchedComparisons: [
        {
          id: 'legacy-kuil-00z-vs-blyn-f14',
          stationId: 'KUIL',
          siteSlug: 'wa-blyn',
          ...rejectedLegacyKuilBlynF14,
          reason: 'Rejected: 14-hour temporal mismatch (00Z sounding vs 14Z forecast) and 113 km coastal-to-strait spatial separation.',
        },
        {
          id: 'kuil-00z-vs-blanchard-f01',
          stationId: 'KUIL',
          siteSlug: 'wa-blanchard',
          ...rejectedKuilSpatialOnly,
          reason: 'Rejected for local site skill: 170 km separation between coastal Quillayute RAOB and inland North Sound ridge exceeds 60 km spatial gate; retained only as synoptic upstream boundary context.',
        },
      ],
    },
    crossModelSpreadSummary: {
      note: 'Cross-model spread measures inter-model disagreement and grid-elevation smoothing differences across Wa-Blanchard (2026-10-21 14Z–27Z), NOT observation verification skill. Unsupported ECMWF and NWS W* and usable-lift fields remain explicitly null.',
      blanchardMultiModelComparison: buildBlanchardCrossModelSpread(dataRoot),
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataRoot = resolve(process.argv[2] ?? join( fileURLToPath(new URL('..', import.meta.url)), 'data'));
  const report = buildSkillReport(dataRoot);
  const outPath = fileURLToPath(new URL('./skill-report.json', import.meta.url));
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Wrote matched observation verification report (${report.observationVerificationSkill.matchedCount} matched pairs) to ${outPath}`);
}
