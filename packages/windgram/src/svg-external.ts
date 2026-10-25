import type { WindgramView } from './scene.ts';
import { sceneData } from './scene-store.ts';
import type { WindgramSvgOptions } from './scene-types.ts';
export type { WindgramSvgOptions } from './scene-types.ts';
import { renderWindgramSvg as renderSvg, renderWindgramHeightAxisSvg as renderAxis, renderWindgramDiagnosticsSvg as renderDiagnostics } from './windgram-chart.ts';
export { renderWindgramKey } from './windgram-chart.ts';
export { barbPaths } from './wind-barb.ts';
export function renderWindgramSvg(view: WindgramView, options: WindgramSvgOptions = {}): string {
  return renderSvg(sceneData(view), options);
}
export function renderWindgramHeightAxisSvg(view: WindgramView, options: WindgramSvgOptions = {}): string {
  return renderAxis(sceneData(view), options);
}
export function renderWindgramDiagnosticsSvg(view: WindgramView, options: WindgramSvgOptions = {}): string {
  return renderDiagnostics(sceneData(view), options);
}
