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
}
export interface WindgramMount {
  /** Replace the view after the container width, forecast or display units change. */
  update(view: WindgramView): void;
  select(validAt: string | null): void;
  /** Release event listeners when removing the chart. */
  dispose(): void;
}
/** Mount an interactive chart. Load @windgrams/windgram/styles.css first; inspection snaps to the published lift ceiling. */
export function mountWindgram(host: HTMLElement, options: WindgramMountOptions): WindgramMount {
  const chart = mount(host, { ...options, view: sceneData(options.view) });
  return { update: view => chart.update(sceneData(view)), select: chart.select, dispose: chart.dispose };
}
export function mountWindgramInspector(host: HTMLElement, readout: HTMLElement | null, view: WindgramView, onSelectHour?: (validAt: string) => void): () => void {
  return inspect(host, readout, sceneData(view), onSelectHour);
}
