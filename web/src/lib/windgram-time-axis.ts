// Calendar, daylight windowing, and time-axis layout for Windgram charts.
// Keeps `timeAxis` (which includes unavailable daylight ticks) distinct from
// `hours` and `sampling` (which contain real forecast source data).

import type { SiteForecast } from "@azohra/meteo.briefing/contract";
import { localDateKey, localInstantMs } from "@azohra/meteo.briefing/derive";
import type { MeteogramOptions } from "@azohra/meteo.briefing/meteogram";
import { sunriseSunset } from "./sun.ts";
import { resolveWindgramPresentation, WINDGRAM_PRESENTATION, type WindgramPresentation } from "./windgram-presentation.ts";

type ProfileHour = SiteForecast["hours"][number];

export interface WindgramTimeTick {
  validAt: string;
  label: string;
  x: number;
  hourIndex: number | null;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Hourly and normal three-hour forecasts both occur in the catalogue. */
export function timeGaps(hours: readonly { validAt: string }[]): Set<number> {
  const steps = hours.slice(1).map((h, i) => Date.parse(h.validAt) - Date.parse(hours[i].validAt)).filter((n) => n > 0);
  const limit = (steps.length ? median(steps) : 3_600_000) * 1.5;
  return new Set(hours.flatMap((h, i) => i && Date.parse(h.validAt) - Date.parse(hours[i - 1].validAt) > limit ? [i] : []));
}

/** Thin only display marks, keeping both ends of the complete forecast visible. */
export function visibleWindgramHourIndices(
  view: { hours: readonly { x: number }[]; compact: boolean },
  minimumSpacingPx = WINDGRAM_PRESENTATION.glyphs.minimumHorizontalSpacing,
): number[] {
  const selected: number[] = [];
  for (const [i, hour] of view.hours.entries()) {
    if (!selected.length || hour.x - view.hours[selected.at(-1)!].x >= minimumSpacingPx) selected.push(i);
  }
  const lastIndex = view.hours.length - 1;
  if (selected.length > 1 && selected.at(-1) !== lastIndex) selected[selected.length - 1] = lastIndex;
  return selected;
}

export function daylightSpan(
  profile: SiteForecast,
  hours: readonly ProfileHour[],
  timeZone: string,
): { sunrise: number; sunset: number } | null {
  const { latitude, longitude } = profile.site;
  if (
    !hours.length ||
    hours.some(hour => !Number.isFinite(Date.parse(hour.validAt))) ||
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90 ||
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }
  const daylight = (validAt: string) => daylightForDate(profile, localDateKey(validAt, timeZone), timeZone);
  const firstDay = daylight(hours[0].validAt);
  const lastDay =
    localDateKey(hours[0].validAt, timeZone) === localDateKey(hours.at(-1)!.validAt, timeZone)
      ? firstDay
      : daylight(hours.at(-1)!.validAt);
  return firstDay && lastDay ? { sunrise: firstDay.sunrise, sunset: lastDay.sunset } : null;
}

function daylightForDate(profile: SiteForecast, dateKey: string, timeZone: string) {
  const { latitude, longitude } = profile.site;
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  // Resolve both midnights locally: DST days can have 23 or 25 hours.
  return sunriseSunset(localInstantMs(dateKey, 0, timeZone), localInstantMs(dateKey, 24, timeZone), latitude, longitude);
}

function spansLocalDates(hours: readonly ProfileHour[], timeZone: string): boolean {
  return hours.length > 1 && localDateKey(hours[0].validAt, timeZone) !== localDateKey(hours.at(-1)!.validAt, timeZone);
}

export type WindgramHourFilterOptions = Pick<MeteogramOptions, "timeZone" | "hours" | "launch"> & {
  compact?: boolean;
  heightRange?: "soaring" | "full";
};

/** Sunrise through sunset, bracketed by available forecast samples.
 * A multi-day profile stays contiguous so its controls retain their time indices.
 * Explicit dates with only nighttime data retain an empty daylight frame.
 * Polar days/nights and undated forecasts outside daylight retain their hours.
 */
export function windgramHours(profile: SiteForecast, options: WindgramHourFilterOptions): ProfileHour[] {
  const window = options.hours;
  const selected = Array.isArray(window) ? new Set(window.map((h) => h.validAt)) : null;
  const dayWindow = window && !Array.isArray(window) && "dateKey" in window ? window : null;
  const hours = profile.hours.filter(
    (h) => (!selected || selected.has(h.validAt)) && (!dayWindow || localDateKey(h.validAt, dayWindow.timeZone) === dayWindow.dateKey),
  );
  if (!hours.length) return hours;
  const times = hours.map(hour => Date.parse(hour.validAt));
  const timeZone = dayWindow?.timeZone ?? options.timeZone;
  if (!dayWindow && spansLocalDates(hours, timeZone)) return hours;
  const daylight = dayWindow ? daylightForDate(profile, dayWindow.dateKey, timeZone) : daylightSpan(profile, hours, timeZone);
  if (!daylight) return hours;
  const start = daylight.sunrise, end = daylight.sunset;
  if (times.at(-1)! < start || times[0] > end) return dayWindow ? [] : hours;
  const first = Math.max(0, times.findLastIndex(time => time <= start));
  const last = times.findIndex(time => time >= end);
  return hours.slice(first, last < 0 ? hours.length : last + 1);
}

/** Regional maps retain many days; each chart shows the selected local day's daylight. */
export function windgramDayHours(profile: SiteForecast, validAt: string, timeZone: string): ProfileHour[] {
  return windgramHours(profile, { timeZone, compact: true, hours: { dateKey: localDateKey(validAt, timeZone), timeZone } });
}

export function formatWindgramHourLabel(validAtOrMs: string | number, labelTime: Intl.DateTimeFormat): string {
  return labelTime.format(new Date(validAtOrMs)).replace(/\s/g, "").replace("AM", "a").replace("PM", "p");
}

/**
 * Computes daylight-aware horizontal layout and `timeAxis` ticks (including empty pre/post
 * daylight columns outside the run's coverage at every screen width).
 */
export function buildWindgramTimeLayout(
  profile: SiteForecast,
  hours: readonly ProfileHour[],
  options: { timeZone: string; hours?: MeteogramOptions["hours"]; compact: boolean; widthPx?: number; presentation?: WindgramPresentation },
) {
  const { compact } = options;
  const dayWindow = options.hours && !Array.isArray(options.hours) && "dateKey" in options.hours ? options.hours : null;
  const daylight = dayWindow
    ? daylightForDate(profile, dayWindow.dateKey, dayWindow.timeZone)
    : spansLocalDates(hours, options.timeZone) ? null : daylightSpan(profile, hours, options.timeZone);
  const steps = profile.hours
    .slice(1)
    .map((hour, i) => Date.parse(hour.validAt) - Date.parse(profile.hours[i].validAt))
    .filter(step => step > 0);
  const cadence = steps.length ? median(steps) : 3_600_000;
  const firstTime = Date.parse(hours[0]?.validAt ?? "");
  const lastTime = Date.parse(hours.at(-1)?.validAt ?? "");
  const overlapsDaylight = Boolean(daylight && firstTime <= daylight.sunset && lastTime >= daylight.sunrise);
  const before = overlapsDaylight && daylight ? Math.max(0, Math.ceil((firstTime - daylight.sunrise) / cadence)) : 0;
  const after = overlapsDaylight && daylight ? Math.max(0, Math.ceil((daylight.sunset - lastTime) / cadence)) : 0;
  const emptyTimes: number[] = [];
  if (!hours.length && daylight && dayWindow) {
    const sourceTime = Date.parse(profile.hours[0]?.validAt ?? "");
    const alignment = Number.isFinite(sourceTime) ? sourceTime : 0;
    const start = alignment + Math.floor((daylight.sunrise - alignment) / cadence) * cadence;
    const end = alignment + Math.ceil((daylight.sunset - alignment) / cadence) * cadence;
    for (let time = start; time <= end; time += cadence) emptyTimes.push(time);
  }
  const columnCount = Math.max(1, emptyTimes.length, before + hours.length + after);
  const { left, right, top, plotWidth } = options.presentation ?? resolveWindgramPresentation({ compact, widthPx: options.widthPx });
  const columnWidth = plotWidth / columnCount;
  const dataLeft = left + before * columnWidth;

  return {
    left,
    right,
    top,
    columnCount,
    columnWidth,
    plotWidth,
    dataLeft,
    before,
    after,
    cadence,
    firstTime,
    lastTime,
    emptyTimes,
  };
}
