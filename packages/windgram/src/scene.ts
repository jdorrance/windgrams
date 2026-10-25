import type { SiteForecast } from '@azohra/meteo.briefing/contract';
import type { WindgramView, WindgramOptions, WindgramReading, WindgramHourFilterOptions } from './scene-types.ts';
export type { WindgramView, WindgramOptions, WindgramReading, WindgramHour, WindgramHourFilterOptions } from './scene-types.ts';
import { publishScene, sceneData } from './scene-store.ts';
import { buildWindgramView as buildView } from './windgram-view.ts';
import { readWindgram as readView } from './windgram-inspector.ts';
import { heightToY as projectHeight, yToHeight as unprojectHeight } from './windgram-scale.ts';
import { windgramHours as filterHours, windgramDayHours as dayHours } from './windgram-time-axis.ts';
import { windgramPresentationKey as presentationKey } from './windgram-presentation.ts';

/** Build from a validated forecast. Retain the original scene handle for rendering and inspection. */
export function buildWindgramView(profile: SiteForecast, options: WindgramOptions): WindgramView {
  return publishScene(buildView(profile, options));
}
/** Read at metres MSL; output field names specify units and missing weather remains null. */
export function readWindgram(view: WindgramView, hourIndex: number, heightM: number): WindgramReading {
  return readView(sceneData(view), hourIndex, heightM);
}
export function heightToY(view: WindgramView, heightM: number): number {
  return projectHeight(sceneData(view), heightM);
}
export function yToHeight(view: WindgramView, y: number): number {
  return unprojectHeight(sceneData(view), y);
}
export function windgramHours(profile: SiteForecast, options: WindgramHourFilterOptions): SiteForecast['hours'] {
  return filterHours(profile, options);
}
export function windgramDayHours(profile: SiteForecast, validAt: string, timeZone: string): SiteForecast['hours'] {
  return dayHours(profile, validAt, timeZone);
}
/** Cache layout by width and compact mode, independently of scrolling and viewport height. */
export function windgramPresentationKey(options: { widthPx?: number; compact: boolean }): string {
  return presentationKey(options);
}
