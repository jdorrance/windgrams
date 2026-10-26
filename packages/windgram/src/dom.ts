import type { WindgramView } from './scene.ts';
import { sceneData } from './scene-store.ts';
import { mountWindgram as mount, mountWindgramInspector as inspect } from './windgram-dom.ts';
export interface WindgramMountOptions {
  view: WindgramView;
  /** Unique among charts in the host document. */
  idPrefix: string;
  readout?: HTMLElement | null;
  onSelectHour?: (validAt: string) => void;
  selectedValidAt?: string | null;
  /** Defaults to the published lift ceiling; height mode follows pointer altitude. */
  inspectionMode?: 'lift' | 'height';
}
export type WindgramInspector = (() => void) & {
  /** Show an hour, or clear inspection with null. */
  select(hourIndex: number | null): void;
};
export interface WindgramMount {
  /** Replace the view after the container width, forecast or display units change. */
  update(view: WindgramView): void;
  select(validAt: string | null): void;
  /** Release event listeners when removing the chart. */
  dispose(): void;
}
/** Mount an interactive chart. Load @windgrams/windgram/styles.css first. */
export function mountWindgram(host: HTMLElement, options: WindgramMountOptions): WindgramMount {
  const chart = mount(host, { ...options, view: sceneData(options.view) });
  return { update: view => chart.update(sceneData(view)), select: chart.select, dispose: chart.dispose };
}
export function mountWindgramInspector(host: HTMLElement, readout: HTMLElement | null, view: WindgramView, onSelectHour?: (validAt: string) => void, options: { mode?: 'lift' | 'height' } = {}): WindgramInspector {
  return inspect(host, readout, sceneData(view), onSelectHour, undefined, options);
}
