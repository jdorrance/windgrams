import type { ModelCapabilities } from '@azohra/meteo.briefing/contract';
import type { UnitSystem } from './format.ts';

export const windgramScene = Symbol('WindgramView');
export interface WindgramHour {
  readonly validAt: string;
  readonly label: string;
  readonly x: number;
  /** Published lift ceiling, metres MSL. */
  readonly usableLiftTopM: number | null;
  readonly thermalVelocityMps: number | null;
}
/** Create with buildWindgramView; retain the returned object for rendering and inspection. */
export interface WindgramLayout {
  readonly unitSystem: UnitSystem;
  readonly timeZone: string;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly bottom: number;
  readonly columnWidth: number;
  readonly floorM: number;
  readonly topM: number;
  readonly compact: boolean;
  readonly ground: { readonly elevationM: number; readonly source: 'launch' | 'model' };
  /** Selected hour from which keyboard inspection begins. */
  selectedHourIndex: number;
}
export interface WindgramView extends WindgramLayout {
  readonly [windgramScene]: true;
  readonly hours: readonly WindgramHour[];
}
export interface WindgramHourFilterOptions {
  timeZone: string;
  hours?: readonly { validAt: string }[] | { timeZone: string; dateKey: string };
}
export interface WindgramOptions extends WindgramHourFilterOptions {
  unitSystem: UnitSystem;
  widthPx?: number;
  compact?: boolean;
  /** Vertical extent; single-day charts retain sunrise through sunset. */
  heightRange?: 'soaring' | 'full';
  /** Site elevation, metres MSL, supplies the AGL reference. */
  launch?: { name?: string; elevationM: number } | null;
  /** Acceptable wind directions, measured clockwise from true north as bearings the wind comes from. */
  launchWindows?: readonly { fromDeg: number; toDeg: number }[];
  capabilities?: ModelCapabilities;
}
export interface WindgramReading {
  hourIndex: number;
  validAt: string;
  heightM: number;
  heightAglM: number;
  temperatureF: number | null;
  speedKt: number | null;
  directionDeg: number | null;
  interpolated: boolean;
  gustKt: number | null;
  cloud: 'model' | 'humidity' | 'potential' | null;
}
export interface WindgramSvgOptions { idPrefix?: string }
