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
    provider: 'NOAA AWS Open Data (noaa-rrfs-pds)',
    cyclesUtc: [0, 6, 12, 18],
    horizonHours: 84,
    completeRunAvailabilityMinutes: 185,
    typicalMaxLagMinutes: 225,
    completionProbeTemplate: 'https://noaa-rrfs-pds.s3.amazonaws.com/rrfs_a/rrfs.{YYYYMMDD}/{HH}/rrfs.t{HH}z.prslev.3km.f084.na.grib2.idx',
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
export function selectTargetCycles(modelSlug, nowMs = Date.now()) {
  const spec = FEED_AVAILABILITY_SPECS[modelSlug];
  if (!spec) throw new Error(`Unknown model feed: ${modelSlug}`);

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
        const probeUrl = spec.completionProbeTemplate
          .replaceAll('{YYYYMMDD}', yyyymmdd)
          .replaceAll('{HH}', hh);
        candidates.push({
          referenceTime: dt.toISOString().replace('.000Z', 'Z'),
          cycleHourUtc: cycleHour,
          elapsedMinutes: Math.round(elapsedMinutes),
          expectedAvailableAtMinutes: spec.completeRunAvailabilityMinutes,
          probeUrl,
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
  nowMs = Date.now(),
  maxAttempts = 3,
  retryDelayMs = 5_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const selection = selectTargetCycles(modelSlug, nowMs);
  for (const candidate of [selection.primaryCandidate, selection.fallbackCandidate].filter(Boolean)) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(candidate.probeUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          return {
            ready: true,
            model: modelSlug,
            selectedCycle: candidate,
            attempts: attempt,
            regionalFreshness: evaluateRegionalFreshness(candidate.referenceTime, nowMs),
          };
        }
      } catch {
        // Retry bounded times before falling back to prior cycle
      }
      if (attempt < maxAttempts && retryDelayMs > 0) {
        await new Promise(r => setTimeout(r, retryDelayMs * attempt));
      }
    }
  }
  return {
    ready: false,
    model: modelSlug,
    selectedCycle: selection.fallbackCandidate ?? selection.primaryCandidate,
    attempts: maxAttempts,
    regionalFreshness: selection.primaryCandidate
      ? evaluateRegionalFreshness(selection.primaryCandidate.referenceTime, nowMs)
      : [],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', default: 'hrrr-conus' },
      offline: { type: 'boolean', default: false },
    },
  });
  const selection = selectTargetCycles(values.model);
  if (values.offline) {
    console.log(JSON.stringify({
      ...selection,
      regionalFreshness: selection.primaryCandidate
        ? evaluateRegionalFreshness(selection.primaryCandidate.referenceTime)
        : [],
    }, null, 2));
  } else {
    probeCycleReadiness(values.model, { maxAttempts: 2, retryDelayMs: 1000 }).then(res => {
      console.log(JSON.stringify(res, null, 2));
    });
  }
}
