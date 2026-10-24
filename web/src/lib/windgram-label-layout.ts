// Label collision avoidance and compact wind-barb thinning for Windgram charts.
// Consumes structured `ContourComponent` geometry directly rather than regex-parsing SVG strings.

import { convertQuantity, fahrenheitToCelsius, type UnitSystem } from "./units.ts";
import { contourComponents, type TemperatureContour } from "./windgram-geometry.ts";
import type { WindgramBarb, WindgramCloud, WindgramView } from "./windgram-view.ts";

export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const overlaps = (a: LabelBox, b: LabelBox, padding = 0): boolean =>
  a.x < b.x + b.width + padding &&
  a.x + a.width > b.x - padding &&
  a.y < b.y + b.height + padding &&
  a.y + a.height > b.y - padding;

export interface PlacedTemperatureLabel {
  temperatureF: number;
  valueText: string;
  box: LabelBox;
  textX: number;
  textY: number;
  freezing: boolean;
}

/**
 * Computes non-overlapping label placements for each connected temperature contour component.
 */
export function placeTemperatureLabels(
  view: Pick<
    WindgramView,
    "contours" | "clouds" | "barbs" | "compact" | "columnWidth" | "left" | "top" | "bottom" | "plotWidth" | "unitSystem"
  >,
  cloudScale: number,
  clouds: readonly WindgramCloud[] = view.clouds,
  barbs: readonly WindgramBarb[] = view.barbs,
  system: UnitSystem = view.unitSystem,
): PlacedTemperatureLabel[] {
  const occupied: LabelBox[] = clouds.map((c) => ({
    x: c.x - 29 * cloudScale,
    y: c.y - 25 * cloudScale,
    width: 58 * cloudScale,
    height: 27 * cloudScale,
  }));
  const winds: LabelBox[] = barbs.map((b) => {
    const direction = (b.directionDeg * Math.PI) / 180;
    const tipX = b.x + Math.sin(direction) * 22, tipY = b.y - Math.cos(direction) * 22;
    return {
      x: Math.min(b.x, tipX) - 7,
      y: Math.min(b.y, tipY) - 7,
      width: Math.abs(b.x - tipX) + 14,
      height: Math.abs(b.y - tipY) + 14,
    };
  });
  const placed: PlacedTemperatureLabel[] = [];
  const displayTemp = (f: number) => convertQuantity(fahrenheitToCelsius(f), "temperature", system)!;

  for (const contour of view.contours as readonly TemperatureContour[]) {
    for (const component of contourComponents(contour)) {
      const valueText = `${Math.round(displayTemp(contour.temperatureF))}°`;
      const width = view.compact ? Math.max(24, valueText.length * 7 + 6) : Math.max(28, valueText.length * 8 + 10);
      const height = view.compact ? 19 : 22;
      const middleX = (component.minX + component.maxX) / 2, middleY = (component.minY + component.maxY) / 2;
      // Geometry candidates cover short branches between source-hour labels and
      // provide another place on the line when the central candidate is cloudy.
      const stride = Math.max(1, Math.ceil(component.segments.length / 40));
      const anchors = [
        ...component.candidates,
        ...component.segments
          .filter((_, i) => i % stride === 0)
          .map((segment) => ({ x: (segment.x1 + segment.x2) / 2, y: (segment.y1 + segment.y2) / 2 })),
      ];
      const positions = anchors.flatMap((point) =>
        [0, -view.columnWidth * 0.24, view.columnWidth * 0.24].flatMap((offset) => {
          if (offset === 0) return [point];
          const x = point.x + offset;
          const crossings = component.segments
            .filter((segment) => segment.x1 !== segment.x2 && x >= Math.min(segment.x1, segment.x2) && x <= Math.max(segment.x1, segment.x2))
            .map((segment) => segment.y1 + ((segment.y2 - segment.y1) * (x - segment.x1)) / (segment.x2 - segment.x1))
            .sort((a, b) => Math.abs(a - point.y) - Math.abs(b - point.y));
          return crossings.length && Math.abs(crossings[0] - point.y) < 24 ? [{ x, y: crossings[0] }] : [];
        }),
      );
      positions.sort(
        (a, b) => Math.abs(a.x - middleX) + Math.abs(a.y - middleY) * 0.15 - (Math.abs(b.x - middleX) + Math.abs(b.y - middleY) * 0.15),
      );
      const boxes = positions
        .map((position) => ({ x: position.x - width / 2, y: position.y - height / 2, width, height }))
        .filter(
          (box) =>
            box.x >= view.left + 3 &&
            box.x + width <= view.left + view.plotWidth - 3 &&
            box.y >= view.top + 3 &&
            box.y + height <= view.bottom - 3 &&
            !occupied.some((other) => overlaps(box, other, 4)),
        );
      if (!boxes.length) continue;
      const box = boxes.find((candidate) => !winds.some((wind) => overlaps(candidate, wind, 1))) ?? boxes[0];
      occupied.push(box);
      placed.push({
        temperatureF: contour.temperatureF,
        valueText,
        box,
        textX: box.x + width / 2,
        textY: box.y + (view.compact ? 14 : 16),
        freezing: contour.temperatureF === 32,
      });
    }
  }
  return placed;
}

/** Avoid colliding wind feathers at small screen sizes without changing samples. */
export function displayedBarbs(
  view: Pick<WindgramView, "barbs" | "compact" | "top">,
  hourIndices: ReadonlySet<number>,
): WindgramBarb[] {
  if (!view.compact) return [...view.barbs];
  const visible: WindgramBarb[] = [];
  for (const hourIndex of hourIndices) {
    const native = view.barbs
      .filter((barb) => barb.hourIndex === hourIndex && !barb.interpolated && barb.y >= view.top + 20)
      .sort((a, b) => b.y - a.y);
    const selected: WindgramBarb[] = [];
    for (const barb of native) {
      if (!selected.length || selected.at(-1)!.y - barb.y >= 23) selected.push(barb);
    }
    const top = native.at(-1);
    if (top && selected.length > 1 && selected.at(-1) !== top) selected[selected.length - 1] = top;
    visible.push(...selected);
  }
  return visible;
}
