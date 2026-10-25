// Operator readiness entry point; regional briefing defaults remain app-owned.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FEED_AVAILABILITY_SPECS, selectTargetCycles, probeCycleReadiness as probe } from '@windgrams/providers/readiness';
export { FEED_AVAILABILITY_SPECS, selectTargetCycles };
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

export async function probeCycleReadiness(model, options = {}) {
  const result = await probe(model, options);
  const now = options.now ?? (() => options.nowMs ?? Date.now());
  return { ...result, regionalFreshness: result.selectedCycle ? evaluateRegionalFreshness(result.selectedCycle.referenceTime, now()) : [] };
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
