// Availability-aware upstream readiness probe & regional timezone freshness validator (Track 5 / Feedback 7).
//
// Schedules and probes around documented complete-run availability rather than cycle initialization time:
// - HRRR f01..f48 complete-run availability: ~107 min (1h 47m) after cycle initialization (max ~150 min)
// - RRFS f01..f84 complete-run availability: ~165-210 min after cycle initialization
// - RDPS f01..f84 complete-run availability: ~210-240 min after cycle initialization
// - HRDPS-Continental f01..f48 complete-run availability: ~240-270 min after cycle initialization
// - GFS f003..f384 complete-run availability: ~300-330 min after cycle initialization
// - GDPS f003..f240 complete-run availability: ~330-360 min after cycle initialization
// - GEPS f003..f384 complete-run availability: ~360-390 min after cycle initialization

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rrfsBase } from './lib/model-feeds.mjs';

export const FEED_AVAILABILITY_SPECS = Object.freeze({
  'hrrr-conus': {
    slug: 'hrrr-conus',
    provider: 'NOAA NOMADS / AWS Open Data (noaa-hrrr-bdp-pds)',
    cyclesUtc: [0, 6, 12, 18],
    horizonHours: 48,
    completeRunAvailabilityMinutes: 107,
    typicalMaxLagMinutes: 150,
    completionProbeTemplate: 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.{YYYYMMDD}/conus/hrrr.t{HH}z.wrfprsf48.grib2.idx',
  },
  rrfs: {
    slug: 'rrfs',
    provider: 'NOAA AWS Open Data (noaa-rrfs-ops-pds)',
    cyclesUtc: [0, 6, 12, 18],
    horizonHours: 84,
    completeRunAvailabilityMinutes: 185,
    typicalMaxLagMinutes: 225,
    completionProbeTemplates: ['prslev', '2dfld'].map(product =>
      `{RRFS_BASE}/rrfs.{YYYYMMDD}/{HH}/rrfs.t{HH}z.${product}.3km.f084.conus.grib2.idx`),
  },
  rdps: {
    slug: 'rdps',
    provider: 'ECCC MSC Datamart',
    cyclesUtc: [0, 6, 12, 18],
    horizonHours: 84,
    completeRunAvailabilityMinutes: 220,
    typicalMaxLagMinutes: 255,
    completionProbeTemplate: 'https://dd.weather.gc.ca/{YYYYMMDD}/WXO-DD/model_rdps/10km/{HH}/084/',
  },
  'hrdps-continental': {
    slug: 'hrdps-continental',
    provider: 'ECCC MSC Datamart',
    cyclesUtc: [0, 6, 12, 18],
    horizonHours: 48,
    completeRunAvailabilityMinutes: 250,
    typicalMaxLagMinutes: 285,
    completionProbeTemplate: 'https://dd.weather.gc.ca/{YYYYMMDD}/WXO-DD/model_hrdps/continental/2.5km/{HH}/048/',
  },
  gfs: {
    slug: 'gfs',
    provider: 'NOAA AWS Open Data (noaa-gfs-bdp-pds)',
    cyclesUtc: [0, 6, 12, 18],
    horizonHours: 384,
    completeRunAvailabilityMinutes: 315,
    typicalMaxLagMinutes: 360,
    completionProbeTemplate: 'https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{YYYYMMDD}/{HH}/atmos/gfs.t{HH}z.pgrb2.0p25.f384.idx',
  },
  gdps: {
    slug: 'gdps',
    provider: 'ECCC MSC Datamart',
    cyclesUtc: [0, 12],
    horizonHours: 240,
    completeRunAvailabilityMinutes: 345,
    typicalMaxLagMinutes: 380,
    completionProbeTemplate: 'https://dd.weather.gc.ca/{YYYYMMDD}/WXO-DD/model_gem_global/15km/grib2/lat_lon/{HH}/240/',
  },
  geps: {
    slug: 'geps',
    provider: 'ECCC MSC Datamart',
    cyclesUtc: [0, 12],
    horizonHours: 384,
    completeRunAvailabilityMinutes: 375,
    typicalMaxLagMinutes: 420,
    completionProbeTemplate: 'https://dd.weather.gc.ca/{YYYYMMDD}/WXO-DD/ensemble/geps/grib2/raw/{HH}/384/',
  },
});

export const REGIONAL_FRESHNESS_DEADLINES = Object.freeze([
  {
    regionId: 'north-sound',
    name: 'North Sound & Olympic Peninsula, WA',
    timeZone: 'America/Los_Angeles',
    morningBriefingLocalHour: 8,
    maxAllowedRunAgeHoursAtBriefing: 10,
    preferredMorningHrrrCycleUtc: 12,
    fallbackMorningHrrrCycleUtc: 6,
  },
  {
    regionId: 'central-puget-tiger',
    name: 'Central Puget Sound & Issaquah Alps, WA',
    timeZone: 'America/Los_Angeles',
    morningBriefingLocalHour: 8,
    maxAllowedRunAgeHoursAtBriefing: 10,
    preferredMorningHrrrCycleUtc: 12,
    fallbackMorningHrrrCycleUtc: 6,
  },
  {
    regionId: 'columbia-gorge-eastern-wa',
    name: 'Columbia Gorge & East Cascades, WA/OR',
    timeZone: 'America/Los_Angeles',
    morningBriefingLocalHour: 8,
    maxAllowedRunAgeHoursAtBriefing: 10,
    preferredMorningHrrrCycleUtc: 12,
    fallbackMorningHrrrCycleUtc: 6,
  },
  {
    regionId: 'rogue-oregon-outback',
    name: 'Rogue Valley & Oregon Outback, OR',
    timeZone: 'America/Los_Angeles',
    morningBriefingLocalHour: 8,
    maxAllowedRunAgeHoursAtBriefing: 10,
    preferredMorningHrrrCycleUtc: 12,
    fallbackMorningHrrrCycleUtc: 6,
  },
  {
    regionId: 'intermountain-idaho-utah',
    name: 'Boise / King Hill & Wasatch Front, ID/UT',
    timeZone: 'America/Boise',
    morningBriefingLocalHour: 8,
    maxAllowedRunAgeHoursAtBriefing: 10,
    preferredMorningHrrrCycleUtc: 12,
    fallbackMorningHrrrCycleUtc: 6,
  },
  {
    regionId: 'shenandoah-blue-ridge',
    name: 'Shenandoah & Blue Ridge, VA/NC',
    timeZone: 'America/New_York',
    morningBriefingLocalHour: 8,
    maxAllowedRunAgeHoursAtBriefing: 10,
    preferredMorningHrrrCycleUtc: 6,
    fallbackMorningHrrrCycleUtc: 0,
  },
]);

/**
 * Selects the newest cycle for `modelSlug` whose complete-run availability window
 * has elapsed as of `nowMs`, plus the previous fallback cycle.
 */
export function selectTargetCycles(modelSlug, nowMs = Date.now(), env = process.env) {
  const spec = FEED_AVAILABILITY_SPECS[modelSlug];
  if (!spec) throw new Error(`Unknown model feed: ${modelSlug}`);
  if (!Number.isFinite(nowMs)) throw new Error('Readiness clock must be a valid timestamp');

  const candidates = [];
  const baseDayMs = Math.floor(nowMs / 86_400_000) * 86_400_000;
  for (const dayOffset of [-1, 0]) {
    for (const cycleHour of spec.cyclesUtc) {
      const refMs = baseDayMs + dayOffset * 86_400_000 + cycleHour * 3_600_000;
      const elapsedMinutes = (nowMs - refMs) / 60_000;
      if (elapsedMinutes >= spec.completeRunAvailabilityMinutes) {
        const dt = new Date(refMs);
        const yyyymmdd = dt.toISOString().slice(0, 10).replace(/-/g, '');
        const hh = String(cycleHour).padStart(2, '0');
        const probeUrls = (spec.completionProbeTemplates ?? [spec.completionProbeTemplate]).map(template => template
          .replaceAll('{RRFS_BASE}', rrfsBase(env))
          .replaceAll('{YYYYMMDD}', yyyymmdd)
          .replaceAll('{HH}', hh));
        candidates.push({
          referenceTime: dt.toISOString().replace('.000Z', 'Z'),
          cycleHourUtc: cycleHour,
          elapsedMinutes: Math.round(elapsedMinutes),
          expectedAvailableAtMinutes: spec.completeRunAvailabilityMinutes,
          probeUrl: probeUrls[0],
          probeUrls,
        });
      }
    }
  }
  candidates.sort((a, b) => Date.parse(b.referenceTime) - Date.parse(a.referenceTime));
  return {
    model: modelSlug,
    evaluatedAt: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    completeRunAvailabilityMinutes: spec.completeRunAvailabilityMinutes,
    primaryCandidate: candidates[0] ?? null,
    fallbackCandidate: candidates[1] ?? null,
  };
}

/**
 * Evaluates regional freshness against each region's local morning briefing deadline.
 */
export function evaluateRegionalFreshness(referenceTimeIso, nowMs = Date.now()) {
  const refMs = Date.parse(referenceTimeIso);
  const runAgeHours = Number.isFinite(refMs) ? Math.round(((nowMs - refMs) / 3_600_000) * 10) / 10 : null;
  return REGIONAL_FRESHNESS_DEADLINES.map(region => {
    const localHourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: region.timeZone,
      hour: 'numeric',
      hour12: false,
    }).format(new Date(nowMs));
    const localHour = Number(localHourStr) % 24;
    const meetsFreshnessDeadline = runAgeHours !== null && runAgeHours <= region.maxAllowedRunAgeHoursAtBriefing;
    return {
      ...region,
      localHourAtEvaluation: localHour,
      referenceTime: referenceTimeIso,
      runAgeHours,
      meetsFreshnessDeadline,
    };
  });
}

/**
 * Probes upstream completion URL with bounded retries before launching heavy GRIB builds.
 */
export async function probeCycleReadiness(modelSlug, {
  nowMs,
  now = nowMs === undefined ? Date.now : () => nowMs,
  maxAttempts = 3,
  retryDelayMs = 5_000,
  fetchImpl = globalThis.fetch,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  env = process.env,
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new Error('retryDelayMs must be nonnegative');
  const isReady = async candidate => {
    if (!candidate) return false;
    const probes = await Promise.allSettled(candidate.probeUrls.map(url =>
        fetchImpl(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(15_000),
        })));
    return probes.every(result => result.status === 'fulfilled' && result.value.ok);
  };
  const readyResult = (candidate, attempts, fallback) => ({
    ready: true, model: modelSlug, selectedCycle: candidate, attempts, fallback,
    regionalFreshness: evaluateRegionalFreshness(candidate.referenceTime, now()),
  });
  let selection;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Re-evaluate after waiting: a newly eligible cycle or UTC day boundary must
    // never leave the heavy builder pinned to an obsolete readiness decision.
    selection = selectTargetCycles(modelSlug, now(), env);
    if (await isReady(selection.primaryCandidate)) return readyResult(selection.primaryCandidate, attempt, false);
    if (attempt < maxAttempts && retryDelayMs > 0) await sleep(retryDelayMs);
  }
  if (await isReady(selection.fallbackCandidate)) {
    return readyResult(selection.fallbackCandidate, maxAttempts, true);
  }
  return {
    ready: false, model: modelSlug, selectedCycle: null, attempts: maxAttempts,
    regionalFreshness: [],
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', default: 'hrrr-conus' },
      offline: { type: 'boolean', default: false },
      now: { type: 'string' },
      attempts: { type: 'string', default: '3' },
      'retry-delay-ms': { type: 'string', default: '5000' },
      'reference-time-only': { type: 'boolean', default: false },
    }
  });
  const now = values.now === undefined ? Date.now : () => Date.parse(values.now);
  const selection = selectTargetCycles(values.model, now());
  if (values.offline) {
    console.log(JSON.stringify({
      ...selection,
      regionalFreshness: selection.primaryCandidate
        ? evaluateRegionalFreshness(selection.primaryCandidate.referenceTime, now())
        : [],
    }, null, 2));
  } else {
    const result = await probeCycleReadiness(values.model, {
      now, maxAttempts: Number(values.attempts), retryDelayMs: Number(values['retry-delay-ms']),
    });
    if (values['reference-time-only']) {
      if (result.ready) console.log(result.selectedCycle.referenceTime);
      else console.error(`${values.model}: no complete upstream run after ${result.attempts} readiness attempt(s); retaining last-good output`);
    } else console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`error: ${error.message}`); process.exitCode = 1; });
}
