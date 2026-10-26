import { formatQuantity } from './units.ts';
import type { ForecastManifest, SiteForecast } from '@azohra/meteo.briefing/contract';
import { localDateKey, localHourOfDay, localInstantMs } from '@azohra/meteo.briefing/derive';
import { sunriseSunset } from '@windgrams/meteorology/sun';
import { publishedLift } from './published-lift.ts';
import { compassPoint, inArc, windWindow, type LaunchDetails, type SiteEntry } from './launches.ts';

type Hour = SiteForecast['hours'][number];
type Location = Pick<SiteEntry, 'latitude' | 'longitude' | 'timeZone'>;

/** Local daylight, or the complete local day when sunrise/sunset do not both occur. */
export function launchDayWindow(site: Location, dateKey: string) {
  const startMs = localInstantMs(dateKey, 0, site.timeZone);
  const endMs = localInstantMs(dateKey, 24, site.timeZone);
  const sun = sunriseSunset(startMs, endMs, site.latitude, site.longitude);
  return sun ? { startMs: sun.sunrise, endMs: sun.sunset } : { startMs, endMs };
}

/** Open tomorrow after sunset; UTC date boundaries do not change the launch's day. */
export function initialForecastDay(site: Location, nowMs = Date.now()) {
  const today = localDateKey(new Date(nowMs).toISOString(), site.timeZone);
  return nowMs > launchDayWindow(site, today).endMs
    ? localDateKey(new Date(localInstantMs(today, 24, site.timeZone)).toISOString(), site.timeZone)
    : today;
}

export function forecastCoversWindow(manifest: Pick<ForecastManifest, 'referenceTime' | 'firstForecastHour' | 'lastForecastHour'>, window: { startMs: number; endMs: number }) {
  const reference = Date.parse(manifest.referenceTime);
  return reference + manifest.firstForecastHour * 3_600_000 <= window.endMs
    && reference + manifest.lastForecastHour * 3_600_000 >= window.startMs;
}

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
  if (speed !== null && speed > 0.5 && direction !== null && windWindow(settings) !== null && !inArc(direction, windWindow(settings))) issues.push('Wind outside launch direction');
  if (settings.windMaxMph !== null && speed !== null && speed * 2.23693629 > settings.windMaxMph) issues.push('Wind above saved limit');
  if (settings.gustMaxMph !== null && gust !== null && gust * 2.23693629 > settings.gustMaxMph) issues.push('Gusts above saved limit');
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
