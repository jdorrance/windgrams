/** Model update cadence, usually read from its published catalogue. Durations are hours. */
export interface FreshnessPolicy {
  runIntervalHours: number;
  typicalPublicationLagHours: number;
  currentIntervals?: number;
  staleAfterIntervals?: number;
}
export interface ForecastFreshnessInput {
  /** Time of the assessment in ISO UTC. Run age is measured from referenceTime. */
  now: string;
  referenceTime?: string | null;
  /** Last valid time actually present in the forecast, in ISO UTC. */
  validUntil?: string | null;
  policy?: FreshnessPolicy | null;
  consistent?: boolean;
  historical?: boolean;
}
export type ForecastFreshnessStatus = 'current' | 'delayed' | 'stale' | 'expired' | 'inconsistent' | 'unknown' | 'historical';
export interface ForecastFreshness {
  status: ForecastFreshnessStatus;
  reason: string;
  /** Reassess at this ISO UTC time. With null, the status can change only when the inputs change. */
  nextCheckAt: string | null;
}

/** Assess forecast age and remaining coverage using the supplied clock and update cadence. */
export function assessForecastFreshness(input: ForecastFreshnessInput): ForecastFreshness {
  const result = (status: ForecastFreshnessStatus, reason: string, nextCheckAt: number | null = null): ForecastFreshness => ({
    status, reason, nextCheckAt: nextCheckAt === null ? null : new Date(nextCheckAt).toISOString(),
  });
  if (input.consistent === false) return result('inconsistent', 'Forecast mismatch · reload');
  if (input.historical) return result('historical', 'Historical forecast');
  const now = Date.parse(input.now), reference = Date.parse(input.referenceTime ?? ''), end = Date.parse(input.validUntil ?? '');
  if (!Number.isFinite(now) || !Number.isFinite(reference) || reference > now || !Number.isFinite(end) || end < reference) {
    return result('unknown', 'Forecast age unavailable');
  }
  if (now > end) return result('expired', 'Forecast ended · reload for update');
  const policy = input.policy;
  const current = policy?.currentIntervals ?? 1, stale = policy?.staleAfterIntervals ?? 3;
  if (!policy || !Number.isFinite(policy.runIntervalHours) || policy.runIntervalHours <= 0
    || !Number.isFinite(policy.typicalPublicationLagHours) || policy.typicalPublicationLagHours < 0
    || !Number.isFinite(current) || current < 0 || !Number.isFinite(stale) || stale < current) {
    return result('unknown', 'Forecast age unavailable', end + 1);
  }
  const delayedAt = reference + (current * policy.runIntervalHours + policy.typicalPublicationLagHours) * 3_600_000 + 1;
  const staleAt = reference + (stale * policy.runIntervalHours + policy.typicalPublicationLagHours) * 3_600_000 + 1;
  if (now >= staleAt) return result('stale', 'Old forecast · reload for update', end + 1);
  if (now >= delayedAt) return result('delayed', 'Update delayed', Math.min(staleAt, end + 1));
  return result('current', '', Math.min(delayedAt, end + 1));
}
