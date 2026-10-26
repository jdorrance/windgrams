import { finiteScalar as scalar, formatQuantity } from './units.ts';
import type { SiteForecast } from '@azohra/meteo.briefing/contract';
import { localHourOfDay } from '@azohra/meteo.briefing/derive';
import { publishedLift } from './published-lift.ts';
import { compassPoint, inArc, windWindow, type LaunchDetails } from './launches.ts';

type Hour = SiteForecast['hours'][number];
export { scalar };
export function validDateKey(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}
export function peakLiftIndex(hours: Hour[], timeZone: string) {
  let best = -1, strength = 0;
  for (const [i, hour] of hours.entries()) {
    const w = scalar(publishedLift(hour).thermalVelocityMps);
    if (w !== null && w > strength) { best = i; strength = w; }
  }
  if (best >= 0) return best;
  const afternoon = hours.findIndex(h => localHourOfDay(h.validAt, timeZone) >= 14);
  return Math.max(0, afternoon);
}
export function matchingHourIndex(hours: Hour[], wanted: string | null, timeZone: string) {
  const time = wanted ? Date.parse(wanted) : NaN;
  if (!Number.isFinite(time)) return peakLiftIndex(hours, timeZone);
  return hours.reduce((best, h, i) => Math.abs(Date.parse(h.validAt) - time) < Math.abs(Date.parse(hours[best].validAt) - time) ? i : best, 0);
}

/** Model surface weather and published lift; elevations are metres MSL. */
export function launchConditions(hour: Hour, settings: LaunchDetails, launchElevationM: number | null, modelElevationM: number | null = null) {
  const speed = scalar(hour.surface.windSpeedMps), direction = scalar(hour.surface.windDirectionDeg);
  const gust = scalar(hour.surface.windGustMps), lift = publishedLift(hour);
  const strength = scalar(lift.thermalVelocityMps), top = scalar(lift.usableLiftTopM), base = scalar(lift.cloudBaseM);
  const feet = (v: number) => `${formatQuantity(v, 'elevation')} MSL`;
  const issues: string[] = [];
  const window = windWindow(settings);
  if (window !== null && (speed === null || direction === null)) issues.push('Model surface wind direction comparison unavailable');
  if (speed !== null && speed >= 0.5 && direction !== null && window !== null && !inArc(direction, window)) issues.push('Model surface wind outside saved direction window');
  if (settings.windMaxMph !== null && speed === null) issues.push('Model surface speed comparison unavailable');
  if (settings.windMaxMph !== null && speed !== null && speed * 2.23693629 > settings.windMaxMph) issues.push('Model surface wind above saved speed limit');
  if (settings.gustMaxMph !== null && gust === null) issues.push('Model surface gust comparison unavailable');
  if (settings.gustMaxMph !== null && gust !== null && gust * 2.23693629 > settings.gustMaxMph) issues.push('Model surface gust above saved limit');
  if (top !== null && launchElevationM !== null && top <= launchElevationM) issues.push('Usable lift below launch');
  const terrain = scalar(modelElevationM), launch = scalar(launchElevationM);
  const delta = terrain === null || launch === null ? null : terrain - launch;
  const signedDelta = delta === null ? 'unknown' : `${delta < 0 ? '−' : delta > 0 ? '+' : ''}${formatQuantity(Math.abs(delta), 'elevation')}`;
  return {
    windBasis: `Wind is 10 m above model ground. Model ground: ${terrain === null ? 'unknown' : feet(terrain)} · Launch: ${launch === null ? 'unknown' : feet(launch)} · Model − launch: ${signedDelta}. Saved-limit comparisons use this model surface forecast; local launch wind may differ.`,
    values: [
      ['Model surface wind', speed === null ? 'Unavailable' : speed < 0.5 ? 'Light / calm' : `${direction === null ? 'Direction unavailable · ' : compassPoint(direction) + ' '}${formatQuantity(speed, 'wind')}`],
      ['Model surface gusts', gust === null ? 'Unavailable' : `${formatQuantity(gust, 'wind')}`],
      ['Usable lift top', strength === null ? 'Unavailable' : top === null ? 'Below sink threshold' : feet(top)],
      ['Potential cloud base', base === null ? 'Unavailable' : feet(base)],
      ['Thermal strength', strength === null ? 'Unavailable' : formatQuantity(strength, 'lift')],
    ] satisfies [string, string][],
    issues,
  };
}
