import { finiteScalar as scalar, formatQuantity, gustNoun, type GustSemantics } from './units.ts';
import type { ForecastManifest, SiteForecast } from '@azohra/meteo.briefing/contract';
import { localDateKey, localHourOfDay, localInstantMs } from '@azohra/meteo.briefing/derive';
import { sunriseSunset } from '@windgrams/meteorology/sun';
import { publishedLift, publishedLiftFamily } from './published-lift.ts';
import { compassPoint, inArc, windLimitsLabel, windWindow, type LaunchDetails, type SiteEntry } from './launches.ts';

type Hour = SiteForecast['hours'][number];
export { scalar };
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

/**
 * Model surface weather and published lift; elevations are metres MSL.
 * `gustSemantics` is the document's declared gust class (`profile.semantics.gust`); it only names the
 * reading, and both classes are compared against the same `gustMaxMph` limit.
 */
export function launchConditions(hour: Hour, settings: LaunchDetails, launchElevationM: number | null, modelElevationM: number | null = null, gustSemantics: GustSemantics | null = null) {
  const speed = scalar(hour.surface.windSpeedMps), direction = scalar(hour.surface.windDirectionDeg);
  const gust = scalar(hour.surface.windGustMps), lift = publishedLift(hour), gustWord = gustNoun(gustSemantics);
  const strength = scalar(lift.thermalVelocityMps), top = scalar(lift.usableLiftTopM), base = scalar(lift.cloudBaseM);
  // Earlier-method (v1) values are labelled like the comparison table; the numbers are not interchangeable with v2.
  const family = publishedLiftFamily(hour) === 'v1-legacy' ? 'v1: ' : '';
  const feet = (v: number) => `${formatQuantity(v, 'elevation')} MSL`;
  // Display rounding only: published diagnostic values keep their stored precision.
  // Soaring heights are shown to the nearest 50 m and thermal strength to 0.1 m/s,
  // which is the resolution these estimates can support; terrain stays exact.
  const displayHeight = (v: number) => `${formatQuantity(Math.round(v / 50) * 50, 'elevation')} MSL`;
  const displayLift = (v: number) => formatQuantity(Math.round(v * 10) / 10, 'lift');
  const limitWord = windLimitsLabel(settings) ?? 'saved';
  const issues: string[] = [];
  const window = windWindow(settings);
  if (window !== null && (speed === null || direction === null)) issues.push('Model surface wind direction comparison unavailable');
  if (speed !== null && speed >= 0.5 && direction !== null && window !== null && !inArc(direction, window)) issues.push(`Model surface wind outside ${limitWord} direction window`);
  if (settings.windMaxMph !== null && speed === null) issues.push('Model surface speed comparison unavailable');
  if (settings.windMaxMph !== null && speed !== null && speed * 2.23693629 > settings.windMaxMph) issues.push(`Model surface wind above ${limitWord} speed limit`);
  if (settings.gustMaxMph !== null && gust === null) issues.push(`Model surface ${gustWord} comparison unavailable`);
  if (settings.gustMaxMph !== null && gust !== null && gust * 2.23693629 > settings.gustMaxMph) issues.push(`Model surface ${gustWord} above ${limitWord} limit`);
  if (top !== null && launchElevationM !== null && top <= launchElevationM) issues.push('Usable lift below launch');
  const terrain = scalar(modelElevationM), launch = scalar(launchElevationM);
  const delta = terrain === null || launch === null ? null : terrain - launch;
  const signedDelta = delta === null ? 'unknown' : `${delta < 0 ? '−' : delta > 0 ? '+' : ''}${formatQuantity(Math.abs(delta), 'elevation')}`;
  return {
    windBasis: `Wind is 10 m above model ground. Model ground: ${terrain === null ? 'unknown' : feet(terrain)} · Launch: ${launch === null ? 'unknown' : feet(launch)} · Model − launch: ${signedDelta}. ${limitWord === 'default' ? 'Wind limits are unsourced defaults, not launch-specific. ' : ''}Limit comparisons use this model surface forecast; local launch wind may differ.`,
    values: [
      ['Model surface wind', speed === null ? 'Unavailable' : speed < 0.5 ? 'Light / calm' : `${direction === null ? 'Direction unavailable · ' : compassPoint(direction) + ' '}${formatQuantity(speed, 'wind')}`],
      [`Model surface ${gustWord}`, gust === null ? 'Unavailable' : `${formatQuantity(gust, 'wind')}`],
      ['Usable lift top', strength === null ? 'Unavailable' : top === null ? `${family}Below sink threshold` : family + displayHeight(top)],
      ['Potential cloud base', base === null ? 'Unavailable' : family + displayHeight(base)],
      ['Thermal strength', strength === null ? 'Unavailable' : family + displayLift(strength)],
    ] satisfies [string, string][],
    issues,
  };
}
