import { formatQuantity } from './units.ts';
import type { SiteForecast } from '@azohra/meteo.briefing/contract';
import { localHourOfDay } from '@azohra/meteo.briefing/derive';
import { publishedLift } from './published-lift.ts';
import { compassPoint, inArc, windWindow, type LaunchDetails } from './launches.ts';

type Hour = SiteForecast['hours'][number];
export function scalar(value: unknown): number | null {
  const number = typeof value === 'number' ? value : value && typeof value === 'object' && 'p50' in value ? value.p50 : null;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}
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

/** Model surface weather and published lift; no reconstructed launch winds or new physics. */
export function launchConditions(hour: Hour, settings: LaunchDetails, launchElevationM: number | null) {
  const speed = scalar(hour.surface.windSpeedMps), direction = scalar(hour.surface.windDirectionDeg);
  const gust = scalar(hour.surface.windGustMps), lift = publishedLift(hour);
  const strength = scalar(lift.thermalVelocityMps), top = scalar(lift.usableLiftTopM), base = scalar(lift.cloudBaseM);
  const feet = (v: number) => `${formatQuantity(v, 'elevation')} MSL`;
  const issues: string[] = [];
  if (speed !== null && speed > 0.5 && direction !== null && !inArc(direction, windWindow(settings))) issues.push('Wind outside launch direction');
  if (speed !== null && speed * 2.23693629 > settings.windMaxMph) issues.push('Wind above saved limit');
  if (gust !== null && gust * 2.23693629 > settings.gustMaxMph) issues.push('Gusts above saved limit');
  if (top !== null && launchElevationM !== null && top <= launchElevationM) issues.push('Usable lift below launch');
  return {
    values: [
      ['Surface wind', speed === null ? 'Unavailable' : speed < 0.5 ? 'Light / calm' : `${direction === null ? '' : compassPoint(direction) + ' '}${formatQuantity(speed, 'wind')}`],
      ['Gusts', gust === null ? 'Unavailable' : `${formatQuantity(gust, 'wind')}`],
      ['Usable lift top', strength === null ? 'Unavailable' : top === null ? 'Below sink threshold' : feet(top)],
      ['Potential cloud base', base === null ? 'Unavailable' : feet(base)],
      ['Thermal strength', strength === null ? 'Unavailable' : formatQuantity(strength, 'lift')],
    ],
    issues,
  };
}
