/** Apply the common request limit before an adapter starts acquisition. */
export function requestedForecastHours(schedule: readonly number[], maxSteps: number | undefined): number[] {
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) throw new Error('maxSteps must be a positive integer');
  return schedule.slice(0, maxSteps ?? schedule.length);
}
