import type { WindgramView } from './windgram-view.ts';
import type { WindgramSvgOptions } from './scene-types.ts';
import { chartStyles, diagnosticStyles } from './generated/styles.ts';
import { renderWindgramSvg as svg, renderWindgramHeightAxisSvg as axis, renderWindgramDiagnosticsSvg as diagnostics } from './windgram-chart.ts';
export { renderWindgramKey } from './windgram-chart.ts';
export function renderWindgramSvg(view: WindgramView, options: WindgramSvgOptions = {}): string {
  return svg(view, { ...options, stylesheet: chartStyles });
}
export function renderWindgramHeightAxisSvg(view: WindgramView, options: WindgramSvgOptions = {}): string {
  return axis(view, { ...options, stylesheet: chartStyles });
}
export function renderWindgramDiagnosticsSvg(view: WindgramView, options: WindgramSvgOptions = {}): string {
  return diagnostics(view, { ...options, stylesheet: diagnosticStyles });
}
