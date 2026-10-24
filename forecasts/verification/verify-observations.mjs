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
import { summarizeModelWindowSpread } from '../soaring/model-comparison.mjs';

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

/**
 * Computes the UTC [windowStartMs, windowEndMs] corresponding to local daytime hours
 * (`startHourLocal`..`endHourLocal` inclusive, default 07:00–20:00 local time) on `localDate`
 * in `timeZone`, respecting DST transitions instead of assuming a universal 14Z–03Z window.
 */
export function localDaytimeWindowMs(
  localDate = '2026-10-21',
  timeZone = 'America/Los_Angeles',
  { startHourLocal = 7, endHourLocal = 20 } = {},
) {
  const anchorMs = Date.parse(`${localDate}T12:00:00Z`);
  if (!Number.isFinite(anchorMs)) throw new Error(`Invalid localDate: ${localDate}`);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    hourCycle: 'h23',
  });
  let startMs = null;
  let endMs = null;
  for (let offsetHours = -18; offsetHours <= 30; offsetHours += 1) {
    const t = anchorMs + offsetHours * 3600000;
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map(p => [p.type, p.value]));
    const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
    const hourNum = Number(parts.hour);
    if (dateStr === localDate && hourNum >= startHourLocal && hourNum <= endHourLocal) {
      if (startMs === null || t < startMs) startMs = t;
      if (endMs === null || t > endMs) endMs = t;
    }
  }
  if (startMs === null || endMs === null) {
    throw new Error(`Could not resolve local daytime window for ${localDate} in ${timeZone}`);
  }
  return {
    localDate,
    timeZone,
    startHourLocal,
    endHourLocal,
    windowStartIso: new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    windowEndIso: new Date(endMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    windowStartMs: startMs,
    windowEndMs: endMs,
  };
}

function findMatchingHour(hours, soundingValidAt) {
  let matched = (hours ?? []).find(h => h.validAt === soundingValidAt);
  if (!matched) {
    matched = (hours ?? []).find(h => {
      const dtMin = Math.abs(Date.parse(h.validAt) - Date.parse(soundingValidAt)) / 60000;
      return dtMin <= OBSERVATION_MATCHING_RULES.raobNearInitMaxTimeDeltaMinutes;
    });
  }
  return matched ?? null;
}

export function verifyModelAgainstRaob(dataRoot, modelSlug, pair, targetSoundingValidAt = '2026-10-21T00:00:00Z') {
  const raobPath = join(dataRoot, 'raob', 'sites', `${pair.siteSlug}.json`);
  const modelPath = join(dataRoot, modelSlug, 'sites', `${pair.siteSlug}.json`);
  if (!existsSync(raobPath) || !existsSync(modelPath)) return null;

  const raobDoc = JSON.parse(readFileSync(raobPath, 'utf8'));
  const modelDoc = JSON.parse(readFileSync(modelPath, 'utf8'));
  const soundingsNewestFirst = [...(raobDoc.soundings ?? [])]
    .filter(s => Number.isFinite(Date.parse(s?.validAt)))
    .sort((a, b) => Date.parse(b.validAt) - Date.parse(a.validAt));
  if (soundingsNewestFirst.length === 0) return null;

  let sounding = null;
  let matchedHour = null;
  if (targetSoundingValidAt) {
    sounding = soundingsNewestFirst.find(s => s.validAt === targetSoundingValidAt) ?? null;
    if (!sounding) return null;
    matchedHour = findMatchingHour(modelDoc.hours, sounding.validAt);
  } else {
    // Select the latest eligible observation that matches a forecast hour in the run
    for (const candidate of soundingsNewestFirst) {
      const hour = findMatchingHour(modelDoc.hours, candidate.validAt);
      if (hour) {
        sounding = candidate;
        matchedHour = hour;
        break;
      }
    }
  }
  if (!sounding || !matchedHour) return null;

  const referenceTime = modelDoc.run?.referenceTime ?? null;

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

export function buildBlanchardCrossModelSpread(
  dataRoot,
  {
    localDate = '2026-10-21',
    timeZone = 'America/Los_Angeles',
    windowStartIso = null,
    windowEndIso = null,
  } = {},
) {
  const models = ['hrrr-conus', 'rrfs', 'hrdps-continental', 'rdps', 'gdps', 'gfs', 'geps', 'ecmwf', 'nws'];
  const daytime = windowStartIso && windowEndIso
    ? {
        localDate,
        timeZone,
        windowStartIso,
        windowEndIso,
        windowStartMs: Date.parse(windowStartIso),
        windowEndMs: Date.parse(windowEndIso),
      }
    : localDaytimeWindowMs(localDate, timeZone);
  const { windowStartMs: windowStart, windowEndMs: windowEnd } = daytime;
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
    rows.push(summarizeModelWindowSpread(model, doc, windowHours));
  }
  return rows;
}

export function buildSkillReport(
  dataRoot,
  {
    targetSoundingValidAt = '2026-10-21T00:00:00Z',
    evaluatedAt = '2026-10-22T12:00:00Z',
    localDate = '2026-10-21',
    timeZone = 'America/Los_Angeles',
  } = {},
) {
  const modelsToVerify = ['hrrr-conus', 'rrfs', 'rdps'];
  const matchedPairVerifications = [];

  for (const pair of MATCHED_RAOB_SITE_PAIRS) {
    for (const model of modelsToVerify) {
      const res = verifyModelAgainstRaob(dataRoot, model, pair, targetSoundingValidAt);
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

  const daytimeWindow = localDaytimeWindowMs(localDate, timeZone);

  return {
    schemaVersion: 2,
    evaluatedAt,
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
      targetSoundingValidAt,
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
      note: `Cross-model spread measures inter-model disagreement and grid-elevation smoothing differences across Wa-Blanchard (${daytimeWindow.localDate} ${daytimeWindow.startHourLocal}:00–${daytimeWindow.endHourLocal}:00 ${daytimeWindow.timeZone}, ${daytimeWindow.windowStartIso}–${daytimeWindow.windowEndIso}), NOT observation verification skill. Unsupported ECMWF and NWS W* and usable-lift fields remain explicitly null, and empty comparison windows report null rather than 0.`,
      daytimeWindow,
      blanchardMultiModelComparison: buildBlanchardCrossModelSpread(dataRoot, { localDate, timeZone }),
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataRoot = resolve(process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'data'));
  const report = buildSkillReport(dataRoot);
  const outPath = fileURLToPath(new URL('./skill-report.json', import.meta.url));
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Wrote matched observation verification report (${report.observationVerificationSkill.matchedCount} matched pairs) to ${outPath}`);
}
