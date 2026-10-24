import { convertQuantity, formatQuantity, getUnitSystem } from "./units.ts";
import { publishedEffectiveCloudLimit, publishedLift, publishedWxtoflyLiftTop } from "./published-lift.ts";
import type { SiteForecast } from "@azohra/meteo.briefing/contract";
import { componentsToWind, lapseRateCPer1000Ft, localDateKey, localInstantMs, relativeHumidityPercent, windToComponents } from "@azohra/meteo.briefing/derive";
import { buildMeteogramScene, type FieldNode, type HourSampling, type MeteogramOptions, type MetricStrip } from "@azohra/meteo.briefing/meteogram";
import { WINDGRAM_STABILITY } from "./windgram-stability.ts";
import { sunriseSunset } from "./sun.ts";

export interface HeightAnchor { heightM: number; y: number; pressureHpa: number | null }
export interface WindgramBarb {
  x: number; y: number; heightM: number; hourIndex: number;
  speedKt: number; directionDeg: number; interpolated: boolean; surface: boolean;
}
export type CloudEvidence = "model" | "humidity" | "potential";
export interface WindgramCloud {
  hourIndex: number; x: number; y: number; baseM: number; topM: number;
  kind: CloudEvidence; coverPercent: number | null;
}
export interface TemperatureContour {
  temperatureF: number; path: string; labels: { x: number; y: number }[];
}
export interface WindgramSeries {
  key: string; label: string; color: string; dash: string | null;
  path: string; bandPath: string | null;
}
export interface WindgramHour {
  validAt: string; label: string; x: number; temperatureF: number | null;
  /** Published ceiling in metres MSL, shared by the blue line and its readout. */
  usableLiftTopM: number | null;
  thermalVelocityMps: number | null; gustKt: number | null; inWindWindow: boolean | null;
}
export interface WindgramView {
  width: number; height: number; left: number; top: number; plotWidth: number;
  plotHeight: number; bottom: number; columnWidth: number; floorM: number; topM: number;
  timeZone: string; anchors: HeightAnchor[]; hours: WindgramHour[];
  fields: { className: string; path: string }[];
  contours: TemperatureContour[]; barbs: WindgramBarb[]; clouds: WindgramCloud[];
  cloudBands: { x: number; y: number; width: number; height: number; kind: CloudEvidence; coverPercent: number | null }[];
  freezing: { x: number; y: number; hourIndex: number }[];
  wings: { x: number; y: number; heightM: number; hourIndex: number }[]; series: WindgramSeries[];
  launch: { y: number; heightM: number; label: string } | null;
  /** Ground reference for AGL readings, independent of the displayed height range. */
  ground: { elevationM: number; source: "launch" | "model" };
  diagnostics: readonly MetricStrip[]; diagnosticLeft: number; diagnosticColumnWidth: number;
  sampling: readonly HourSampling[]; selectedHourIndex: number;
  compact: boolean; ensemble: boolean; sourceNote: string | null;
  displayInterpolationNote: string;
}
export type WindgramOptions = Pick<MeteogramOptions, "timeZone" | "hours" | "launch" | "launchWindows" | "capabilities" | "widthPx"> & {
  compact?: boolean;
  /** Vertical extent only; both compact views use daylight hours. Desktop keeps all heights. */
  heightRange?: "soaring" | "full";
  /** Available viewport height; compact charts reserve room for page controls. */
  heightPx?: number;
  /** Total height available below page controls, including the chart's axes. */
  maxHeightPx?: number;
};
export interface WindgramReading {
  hourIndex: number; validAt: string; heightM: number;
  heightAglM: number;
  temperatureF: number | null; speedKt: number | null; directionDeg: number | null;
  interpolated: boolean; gustKt: number | null; cloud: CloudEvidence | null;
}

const KT = 1.9438444924406;
const finite = (n: number | null): n is number => n !== null && Number.isFinite(n);
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const fahrenheit = (c: number) => c * 9 / 5 + 32;
const round = (n: number) => Math.round(n * 100) / 100;
type ProfileHour = SiteForecast["hours"][number];
type Point = { x: number; y: number };

/** Hourly and normal three-hour forecasts both occur in the catalogue. */
function timeGaps(hours: readonly { validAt: string }[]) {
  const steps = hours.slice(1).map((h, i) => Date.parse(h.validAt) - Date.parse(hours[i].validAt)).filter((n) => n > 0);
  const limit = (steps.length ? median(steps) : 3_600_000) * 1.5;
  return new Set(hours.flatMap((h, i) => i && Date.parse(h.validAt) - Date.parse(hours[i - 1].validAt) > limit ? [i] : []));
}

/** Missing ensemble medians stay missing; NaN nodes intentionally break interpolation. */
function scalar(value: unknown): number | null {
  const n = typeof value === "number" ? value : value && typeof value === "object" && "p50" in value ? value.p50 : null;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Linear interpolation in physical height. Never bridge an explicitly missing level. */
export function sampleHeight(nodes: readonly FieldNode[], heightM: number): number | null {
  if (!nodes.length || heightM < nodes[0].altitudeM || heightM > nodes[nodes.length - 1].altitudeM) return null;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (Math.abs(a.altitudeM - heightM) < 0.00001) {
      if (Number.isFinite(a.value)) return a.value;
      const next = nodes[i + 1];
      if (next && Math.abs(next.altitudeM - heightM) < 0.00001 && Number.isFinite(next.value)) return next.value;
      return null;
    }
    const b = nodes[i + 1];
    if (b && heightM > a.altitudeM && heightM < b.altitudeM) {
      if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return null;
      return a.value + (b.value - a.value) * (heightM - a.altitudeM) / (b.altitudeM - a.altitudeM);
    }
  }
  return null;
}

type Scale = Pick<WindgramView, "anchors" | "top" | "bottom" | "floorM" | "topM">;
export function heightToY(view: Scale, heightM: number): number {
  const anchors = view.anchors;
  if (heightM <= view.floorM) return view.bottom;
  if (heightM >= view.topM) return view.top;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    if (heightM <= b.heightM) return a.y + (b.y - a.y) * (heightM - a.heightM) / (b.heightM - a.heightM);
  }
  return view.top;
}
export function yToHeight(view: Scale, y: number): number {
  if (y >= view.bottom) return view.floorM;
  if (y <= view.top) return view.topM;
  for (let i = 1; i < view.anchors.length; i++) {
    const a = view.anchors[i - 1], b = view.anchors[i];
    if (y >= b.y) return a.heightM + (b.heightM - a.heightM) * (a.y - y) / (a.y - b.y);
  }
  return view.topM;
}

/** Compare with the last retained label so dense profiles still have an axis. */
export function visibleHeightAnchors(view: Pick<WindgramView, "anchors" | "top" | "compact">): HeightAnchor[] {
  const minimumGap = view.compact ? 23 : 29;
  const selected: HeightAnchor[] = [];
  for (const anchor of view.anchors) {
    const previous = selected.at(-1);
    if (!previous || (anchor.y - view.top > 20 && previous.y - anchor.y >= minimumGap)) selected.push(anchor);
  }
  return selected;
}

/** Thin only display marks, keeping both ends of the complete forecast visible. */
export function visibleWindgramHourIndices(view: Pick<WindgramView, "hours" | "compact">, minimumSpacingPx = 34): number[] {
  if (!view.compact) return view.hours.map((_, i) => i);
  const selected: number[] = [];
  for (const [i, hour] of view.hours.entries()) {
    if (!selected.length || hour.x - view.hours[selected.at(-1)!].x >= minimumSpacingPx) selected.push(i);
  }
  const lastIndex = view.hours.length - 1;
  if (selected.length > 1 && selected.at(-1) !== lastIndex) selected[selected.length - 1] = lastIndex;
  return selected;
}

function hourSampling(hour: ProfileHour, floorM: number): HourSampling {
  const levels = hour.levels.filter((l) => finite(scalar(l.heightM)) && scalar(l.heightM)! > floorM)
    .sort((a, b) => scalar(a.heightM)! - scalar(b.heightM)!);
  const nodes = (key: "temperatureC" | "dewPointC") => [
    { altitudeM: floorM, value: scalar(hour.surface[key]) ?? NaN },
    ...levels.map((l) => ({ altitudeM: scalar(l.heightM)!, value: scalar(l[key]) ?? NaN })),
  ];
  const temperatureC = nodes("temperatureC"), dewPointC = nodes("dewPointC");
  const wind = (speed: unknown, direction: unknown) => {
    const s = scalar(speed), d = scalar(direction);
    return s === null || d === null ? { uMps: NaN, vMps: NaN } : windToComponents(s, d);
  };
  const winds = [wind(hour.surface.windSpeedMps, hour.surface.windDirectionDeg), ...levels.map((l) => wind(l.windSpeedMps, l.windDirectionDeg))];
  // Represent temperature gradients as interval quantities, constant within each source interval.
  // Use a tiny step epsilon before interior upper endpoints so interval transitions stay sharp.
  const lastIdx = temperatureC.length - 2;
  const lapseCPer1000Ft = temperatureC.slice(0, -1).flatMap((a, i) => {
    const b = temperatureC[i + 1];
    if (!b) return [];
    const value = Number.isFinite(a.value) && Number.isFinite(b.value)
      ? lapseRateCPer1000Ft({ heightM: a.altitudeM, temperatureC: a.value }, { heightM: b.altitudeM, temperatureC: b.value }) ?? NaN : NaN;
    const upperAlt = i < lastIdx && b.altitudeM - a.altitudeM > 0.02 ? b.altitudeM - 0.01 : b.altitudeM;
    return [{ altitudeM: a.altitudeM, value }, { altitudeM: upperAlt, value }];
  });
  const usable = scalar(publishedLift(hour).usableLiftTopM);
  const effectiveLimit = scalar(publishedEffectiveCloudLimit(hour));
  return {
    validAt: hour.validAt, temperatureC, dewPointC, lapseCPer1000Ft,
    relativeHumidityPercent: temperatureC.map((p, i) => ({ altitudeM: p.altitudeM, value: Number.isFinite(p.value) && Number.isFinite(dewPointC[i].value) ? relativeHumidityPercent(p.value, dewPointC[i].value) : NaN })),
    windU: temperatureC.map((p, i) => ({ altitudeM: p.altitudeM, value: winds[i].uMps })),
    windV: temperatureC.map((p, i) => ({ altitudeM: p.altitudeM, value: winds[i].vMps })),
    verticalVelocityPaS: levels.map((l) => ({ altitudeM: scalar(l.heightM)!, value: scalar(l.verticalVelocityPaS) ?? NaN })),
    thermalIndexC: [], smoke: hour.smoke && finite(scalar(hour.smoke.surfaceUgm3)) ? { surfaceUgm3: scalar(hour.smoke.surfaceUgm3)!, aot: scalar(hour.smoke.aot) } : null,
    observation: null, aotObservation: null,
    cloudCapped: usable === null || effectiveLimit === null ? null : usable >= effectiveLimit - 1,
    capeCapped: scalar(hour.surface.capeJkg) === null || scalar(hour.surface.cinJkg) === null ? null : scalar(hour.surface.cinJkg)! <= -50,
  };
}

/** Reconstruct the colour field from interval centres. Source lapse rates stay
 * layer averages; this interpolation is only for drawing. Keep the edge of
 * each valid run, and pin zero crossings to the source inversion boundaries.
 */
function stabilityDisplayNodes(intervals: readonly FieldNode[]): FieldNode[] {
  const nodes: FieldNode[] = [];
  for (let i = 0; i + 1 < intervals.length; i += 2) {
    const { altitudeM: base, value } = intervals[i];
    const upper = intervals[i + 2]?.altitudeM ?? intervals[i + 1].altitudeM;
    if (!Number.isFinite(value)) {
      nodes.push({ altitudeM: base, value: NaN }, { altitudeM: upper, value: NaN });
      continue;
    }
    const previous = intervals[i - 2]?.value, next = intervals[i + 2]?.value;
    if (!Number.isFinite(previous)) nodes.push({ altitudeM: base, value });
    else if (previous * value <= 0 && previous !== value) nodes.push({ altitudeM: base, value: 0 });
    nodes.push({ altitudeM: (base + upper) / 2, value });
    if (!Number.isFinite(next)) nodes.push({ altitudeM: upper, value });
  }
  return nodes;
}

/**
 * Gap-preserving classified field path generator for Windgram stability bands.
 * Never bridges across missing vertical intervals (NaN nodes) and never blends
 * a missing interval from one hour into an adjacent hour's valid column.
 */
function buildStabilityFieldPaths(args: {
  nodesByHour: readonly (readonly FieldNode[])[];
  gaps: ReadonlySet<number>;
  floorM: number;
  topM: number;
  plotLeft: number;
  plotTop: number;
  plotBottom: number;
  plotWidth: number;
  banding: { breakpoints: readonly number[]; classNames: readonly string[] };
}): Record<string, string> {
  const hourCount = args.nodesByHour.length;
  if (hourCount === 0) return {};
  const FIELD_COLUMNS_PER_HOUR = 24;
  const FIELD_ROW_HEIGHT = 1.5;

  const valueAt = (hourIndex: number, altitudeM: number): number | null => {
    const nodes = args.nodesByHour[hourIndex];
    if (!nodes || nodes.length === 0 || altitudeM < nodes[0].altitudeM) return null;
    const clampedAlt = Math.min(altitudeM, nodes[nodes.length - 1].altitudeM);
    return sampleHeight(nodes, clampedAlt);
  };

  const valueAcrossTime = (timePosition: number, altitudeM: number): number | null => {
    const lowerIndex = Math.floor(timePosition);
    const upperIndex = Math.min(hourCount - 1, Math.ceil(timePosition));
    const lower = valueAt(lowerIndex, altitudeM);
    const upper = valueAt(upperIndex, altitudeM);
    if (lowerIndex === upperIndex) return lower;
    if (args.gaps.has(upperIndex)) {
      return timePosition < lowerIndex + 0.5 ? lower : upper;
    }
    if (lower === null && upper === null) return null;
    if (lower === null) return timePosition >= lowerIndex + 0.5 ? upper : null;
    if (upper === null) return timePosition <= lowerIndex + 0.5 ? lower : null;
    return lower + (upper - lower) * (timePosition - lowerIndex);
  };

  const columns = Math.max(1, hourCount * FIELD_COLUMNS_PER_HOUR);
  const plotHeight = args.plotBottom - args.plotTop;
  const rows = Math.max(1, Math.ceil(plotHeight / FIELD_ROW_HEIGHT));
  const values: (number | null)[][] = [];
  for (let row = 0; row <= rows; row += 1) {
    const altitudeM = args.topM - (row / rows) * (args.topM - args.floorM);
    const rowValues: (number | null)[] = [];
    for (let column = 0; column <= columns; column += 1) {
      const timePosition = Math.min(hourCount - 1, Math.max(0, (column / columns) * hourCount - 0.5));
      rowValues.push(valueAcrossTime(timePosition, altitudeM));
    }
    values.push(rowValues);
  }

  const xOf = (column: number) => args.plotLeft + (column / columns) * args.plotWidth;
  const yOf = (row: number) => args.plotTop + (row / rows) * plotHeight;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const shortNum = (v: number) => Number(v.toFixed(1));

  let centrePredicate: (mean: number, allValid: boolean) => boolean = () => false;
  const rings = (inside: (r: number, c: number) => boolean, fraction: (a: number | null, b: number | null) => number) => {
    type Seg = { from: [number, number]; to: [number, number]; used: boolean };
    const allSegments: Seg[] = [];
    const byStart = new Map<string, Seg[]>();
    const key = (point: [number, number]) => `${point[0].toFixed(3)},${point[1].toFixed(3)}`;
    const addSegment = (from: [number, number], to: [number, number]) => {
      const fromKey = key(from);
      if (fromKey === key(to)) return;
      const segment: Seg = { from, to, used: false };
      allSegments.push(segment);
      const queue = byStart.get(fromKey);
      if (queue) queue.push(segment);
      else byStart.set(fromKey, [segment]);
    };
    const insideAt = (r: number, c: number) => r >= 0 && r <= rows && c >= 0 && c <= columns && inside(r, c);
    const valAt = (r: number, c: number) => (r >= 0 && r <= rows && c >= 0 && c <= columns ? values[r][c] : null);
    const clampX = (x: number) => Math.min(args.plotLeft + args.plotWidth, Math.max(args.plotLeft, x));
    const clampY = (y: number) => Math.min(args.plotBottom, Math.max(args.plotTop, y));

    const saddleCentreInside = (r: number, c: number) => {
      const corners = [valAt(r, c), valAt(r, c + 1), valAt(r + 1, c + 1), valAt(r + 1, c)].filter((v): v is number => v !== null);
      if (corners.length === 0) return false;
      const mean = corners.reduce((sum, v) => sum + v, 0) / corners.length;
      return centrePredicate(mean, corners.length === 4);
    };

    for (let r = -1; r <= rows; r += 1) {
      for (let c = -1; c <= columns; c += 1) {
        const tl = insideAt(r, c);
        const tr = insideAt(r, c + 1);
        const br = insideAt(r + 1, c + 1);
        const bl = insideAt(r + 1, c);
        const caseIndex = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
        if (caseIndex === 0 || caseIndex === 15) continue;
        const vTL = valAt(r, c);
        const vTR = valAt(r, c + 1);
        const vBR = valAt(r + 1, c + 1);
        const vBL = valAt(r + 1, c);
        const topPt: [number, number] = [clampX(xOf(c + fraction(vTL, vTR))), clampY(yOf(r))];
        const bottomPt: [number, number] = [clampX(xOf(c + fraction(vBL, vBR))), clampY(yOf(r + 1))];
        const leftPt: [number, number] = [clampX(xOf(c)), clampY(yOf(r + fraction(vTL, vBL)))];
        const rightPt: [number, number] = [clampX(xOf(c + 1)), clampY(yOf(r + fraction(vTR, vBR)))];
        switch (caseIndex) {
          case 1: addSegment(leftPt, bottomPt); break;
          case 2: addSegment(bottomPt, rightPt); break;
          case 3: addSegment(leftPt, rightPt); break;
          case 4: addSegment(rightPt, topPt); break;
          case 6: addSegment(bottomPt, topPt); break;
          case 7: addSegment(leftPt, topPt); break;
          case 8: addSegment(topPt, leftPt); break;
          case 9: addSegment(topPt, bottomPt); break;
          case 11: addSegment(topPt, rightPt); break;
          case 12: addSegment(rightPt, leftPt); break;
          case 13: addSegment(rightPt, bottomPt); break;
          case 14: addSegment(bottomPt, leftPt); break;
          case 5:
            if (saddleCentreInside(r, c)) { addSegment(leftPt, topPt); addSegment(rightPt, bottomPt); }
            else { addSegment(leftPt, bottomPt); addSegment(rightPt, topPt); }
            break;
          case 10:
            if (saddleCentreInside(r, c)) { addSegment(topPt, rightPt); addSegment(bottomPt, leftPt); }
            else { addSegment(topPt, leftPt); addSegment(bottomPt, rightPt); }
            break;
        }
      }
    }
    const takeFrom = (pointKey: string) => {
      const queue = byStart.get(pointKey);
      if (!queue) return null;
      while (queue.length > 0) {
        const candidate = queue[queue.length - 1];
        if (!candidate.used) return candidate;
        queue.pop();
      }
      return null;
    };
    const out: [number, number][][] = [];
    for (const first of allSegments) {
      if (first.used) continue;
      const ring: [number, number][] = [first.from];
      let current: Seg | null = first;
      while (current) {
        current.used = true;
        ring.push(current.to);
        current = takeFrom(key(current.to));
      }
      if (ring.length >= 4) out.push(ring);
    }
    return out;
  };

  const thresholdRings = (t: number) => {
    centrePredicate = (mean, allValid) => allValid && mean >= t;
    return rings(
      (r, c) => {
        const v = values[r][c];
        return v !== null && v >= t;
      },
      (a, b) => {
        if (a === null || b === null || a === b) return 0.5;
        return clamp01((t - a) / (b - a));
      },
    );
  };
  const domainRings = () => {
    centrePredicate = (_mean, allValid) => allValid;
    return rings((r, c) => values[r][c] !== null, () => 0.5);
  };

  const ringCache = new Map<number, [number, number][][]>();
  const ringsAt = (t: number) => {
    let cached = ringCache.get(t);
    if (!cached) {
      cached = thresholdRings(t);
      ringCache.set(t, cached);
    }
    return cached;
  };

  const toPath = (ringSets: [number, number][][][]) => {
    const parts: string[] = [];
    for (const set of ringSets) {
      for (const ring of set) {
        const rounded: [number, number][] = [];
        for (const point of ring) {
          const x = shortNum(point[0]);
          const y = shortNum(point[1]);
          const last = rounded[rounded.length - 1];
          if (last && last[0] === x && last[1] === y) continue;
          const beforeLast = rounded[rounded.length - 2];
          if (last && beforeLast) {
            const cross = (last[0] - beforeLast[0]) * (y - beforeLast[1]) - (last[1] - beforeLast[1]) * (x - beforeLast[0]);
            if (Math.abs(cross) < 0.35) {
              last[0] = x;
              last[1] = y;
              continue;
            }
          }
          rounded.push([x, y]);
        }
        if (rounded.length >= 3) {
          parts.push(rounded.map(([x, y], idx) => `${idx === 0 ? "M" : "L"}${x} ${y}`).join("") + "Z");
        }
      }
    }
    return parts.join("");
  };

  const result: Record<string, string> = {};
  const { breakpoints, classNames } = args.banding;
  for (let interval = 0; interval < classNames.length; interval += 1) {
    const className = classNames[interval];
    if (!className) continue;
    const lower = interval === 0 ? null : breakpoints[interval - 1];
    const upper = interval === classNames.length - 1 ? null : breakpoints[interval];
    const sets: [number, number][][][] = [];
    if (lower === null) {
      sets.push(domainRings());
      if (upper !== null) sets.push(ringsAt(upper));
    } else {
      sets.push(ringsAt(lower));
      if (upper !== null) sets.push(ringsAt(upper));
    }
    const path = toPath(sets);
    if (path !== "") result[className] = result[className] ? result[className] + path : path;
  }
  return result;
}

/** All crossing branches, including an inversion's second crossing. */
function crossings(nodes: readonly FieldNode[], target: number) {
  const heights: number[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    if (!Number.isFinite(a.value) || !Number.isFinite(b.value) || a.value === b.value) continue;
    if (target < Math.min(a.value, b.value) || target > Math.max(a.value, b.value)) continue;
    const z = a.altitudeM + (b.altitudeM - a.altitudeM) * (target - a.value) / (b.value - a.value);
    if (!heights.some((h) => Math.abs(h - z) < 0.01)) heights.push(z);
  }
  return heights;
}

/** Marching squares over the actual temperature field, with null cells left open. */
function temperatureContours(view: WindgramView): TemperatureContour[] {
  const temperatures = view.sampling.flatMap((s) => s.temperatureC.map((n) => n.value)).filter(Number.isFinite);
  if (!temperatures.length) return [];
  const metric = getUnitSystem() === "metric";
  const step = metric ? 5 : 8;
  const low = Math.floor(convertQuantity(Math.min(...temperatures), "temperature")! / step) * step;
  const high = Math.ceil(convertQuantity(Math.max(...temperatures), "temperature")! / step) * step;
  const cols = Math.max(2, (view.hours.length - 1) * 8);
  const rows = Math.ceil(view.plotHeight / 4);
  const x0 = view.hours[0].x, x1 = view.hours[view.hours.length - 1].x;
  const gaps = timeGaps(view.hours);
  const valueAt = (time: number, z: number): number | null => {
    const a = Math.floor(time), b = Math.ceil(time);
    if (a !== b && gaps.has(b)) return null;
    const av = sampleHeight(view.sampling[a].temperatureC, z), bv = sampleHeight(view.sampling[b].temperatureC, z);
    if (av === null || bv === null) return null;
    return av + (bv - av) * (time - a);
  };
  const ys = Array.from({ length: rows + 1 }, (_, r) => view.top + view.plotHeight * r / rows);
  const xs = Array.from({ length: cols + 1 }, (_, c) => x0 + (x1 - x0) * c / cols);
  const grid = ys.map((y) => xs.map((_, c) => valueAt((view.hours.length - 1) * c / cols, yToHeight(view, y))));
  const labelHours = new Set<number>();
  let lastLabelTime = -Infinity;
  view.hours.forEach((h, i) => {
    if (i === 0 && view.hours.length >= 3) return;
    const time = Date.parse(h.validAt);
    if (time - lastLabelTime >= 3 * 3_600_000) { labelHours.add(i); lastLabelTime = time; }
  });
  const contours: TemperatureContour[] = [];
  for (let value = low; value <= high; value += step) {
    const target = metric ? value : (value - 32) * 5 / 9;
    const f = metric ? fahrenheit(target) : value;
    const segments: string[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const v = [grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]];
      if (v.some((n) => n === null)) continue;
      const values = v as number[];
      const p = [{ x: xs[c], y: ys[r] }, { x: xs[c + 1], y: ys[r] }, { x: xs[c + 1], y: ys[r + 1] }, { x: xs[c], y: ys[r + 1] }];
      const edges: { edge: number; p: Point }[] = [];
      for (let e = 0; e < 4; e++) {
        const n = (e + 1) % 4;
        if ((values[e] >= target) === (values[n] >= target)) continue;
        const fraction = (target - values[e]) / (values[n] - values[e]);
        edges.push({ edge: e, p: { x: p[e].x + (p[n].x - p[e].x) * fraction, y: p[e].y + (p[n].y - p[e].y) * fraction } });
      }
      const line = (a: Point, b: Point) => segments.push(`M${round(a.x)},${round(a.y)}L${round(b.x)},${round(b.y)}`);
      if (edges.length === 2) line(edges[0].p, edges[1].p);
      if (edges.length === 4) {
        // Resolve saddles by their centre; preserve both independent branches.
        const sameAsTopLeft = (values.reduce((sum, n) => sum + n, 0) / 4 >= target) === (values[0] >= target);
        if (sameAsTopLeft) { line(edges[0].p, edges[1].p); line(edges[2].p, edges[3].p); }
        else { line(edges[0].p, edges[3].p); line(edges[1].p, edges[2].p); }
      }
    }
    const labels = view.hours.flatMap((h, i) => labelHours.has(i)
      ? crossings(view.sampling[i].temperatureC, target).filter(z => z >= view.floorM && z <= view.topM)
        .map((z) => ({ x: h.x, y: heightToY(view, z) })) : []);
    if (segments.length || labels.length) contours.push({ temperatureF: f, path: segments.join(""), labels });
  }
  return contours;
}

function linearPath(points: (Point | null)[]) {
  let open = false;
  return points.map((p) => {
    if (!p) { open = false; return ""; }
    const cmd = open ? "L" : "M";
    open = true;
    return `${cmd}${round(p.x)},${round(p.y)}`;
  }).join("");
}

/** Keep optional diagnostics aligned when the upstream scene drops a missing hour. */
function alignedDiagnostics(strips: readonly MetricStrip[], sourceTimes: readonly string[], hours: ProfileHour[], left: number, pitch: number): MetricStrip[] {
  const gaps = timeGaps(hours);
  if (!gaps.size && sourceTimes.length === hours.length && sourceTimes.every((t, i) => t === hours[i].validAt)) return [...strips];
  const indices = hours.map((h) => sourceTimes.indexOf(h.validAt));
  const sourceValue = (h: ProfileHour, key: MetricStrip["key"]): unknown => {
    switch (key) {
      case "pressure": return h.surface.seaLevelPressureHpa;
      case "precipitation": return h.surface.precipitationMmHr;
      case "cloudCover": return h.surface.cloudCoverPercent;
      case "cape": return h.surface.capeJkg;
      case "smoke": return h.smoke?.surfaceUgm3;
      case "thermalStrength": return publishedLift(h).thermalVelocityMps;
      default: return null;
    }
  };
  return strips.map((strip) => {
    const values = indices.map((index) => index < 0 ? null : strip.values[index] ?? null);
    const y = (value: number) => strip.top + strip.height * (1 - clamp((value - strip.minimum) / Math.max(0.001, strip.maximum - strip.minimum), 0, 1));
    const points = values.flatMap((value, i): (Point | null)[] => {
      const p = value === null ? null : { x: left + pitch * (i + 0.5), y: y(value) };
      return gaps.has(i) ? [null, p] : [p];
    });
    const runs: Point[][] = []; let run: Point[] = [];
    for (const p of points) {
      if (!p) { if (run.length) runs.push(run); run = []; }
      else run.push(p);
    }
    if (run.length) runs.push(run);
    const areaPath = runs.filter((r) => r.length > 1).map((r) => linearPath([{ x: r[0].x, y: strip.top + strip.height }, ...r, { x: r[r.length - 1].x, y: strip.top + strip.height }]) + "Z").join("");
    const bands: { upper: Point[]; lower: Point[] }[] = []; let band: typeof bands[number] | null = null;
    hours.forEach((hour, i) => {
      if (gaps.has(i)) band = null;
      const value = sourceValue(hour, strip.key);
      if (!value || typeof value !== "object" || !("p25" in value) || !("p75" in value) || values[i] === null) { band = null; return; }
      const lo = scalar(value.p25), hi = scalar(value.p75), divisor = strip.key === "pressure" ? 10 : 1;
      if (lo === null || hi === null) { band = null; return; }
      if (!band) { band = { upper: [], lower: [] }; bands.push(band); }
      band.upper.push({ x: left + pitch * (i + 0.5), y: y(hi / divisor) });
      band.lower.push({ x: left + pitch * (i + 0.5), y: y(lo / divisor) });
    });
    const cells = strip.cells && indices.map((index, i) => {
      const cell = index < 0 ? null : strip.cells![index];
      return cell ? { ...cell, x: left + pitch * i, width: pitch } : null;
    });
    const rows = strip.rows?.map((row) => ({ ...row, cells: indices.map((index, i) => {
      const cell = index < 0 ? null : row.cells[index];
      return cell ? { ...cell, x: left + pitch * i, width: pitch } : null;
    }) }));
    return { ...strip, values, linePath: linearPath(points), areaPath,
      bandPath: bands.filter((b) => b.upper.length > 1).map((b) => linearPath([...b.upper, ...b.lower.reverse()]) + "Z").join("") || null,
      cells, rows, dots: runs.filter((r) => r.length === 1).map((r) => r[0]) };
  });
}

/** Contiguous portions of a profile above a cloud-evidence threshold. */
function moistLayers(nodes: readonly FieldNode[], threshold: number) {
  const layers: { baseM: number; topM: number; coverPercent: number }[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    if (!Number.isFinite(a.value) || !Number.isFinite(b.value) || Math.max(a.value, b.value) < threshold) continue;
    let baseM = a.altitudeM, topM = b.altitudeM;
    if (a.value < threshold) baseM += (topM - baseM) * (threshold - a.value) / (b.value - a.value);
    if (b.value < threshold) topM = a.altitudeM + (b.altitudeM - a.altitudeM) * (threshold - a.value) / (b.value - a.value);
    if (topM - baseM < 1) continue;
    const last = layers[layers.length - 1];
    if (last && Math.abs(last.topM - baseM) < 1) {
      last.topM = topM; last.coverPercent = Math.max(last.coverPercent, a.value, b.value);
    } else layers.push({ baseM, topM, coverPercent: Math.max(a.value, b.value) });
  }
  return layers;
}

/** Sunrise through sunset, bracketed by available forecast samples.
 * A multi-day profile stays contiguous so its controls retain their time indices.
 * Polar days/nights and forecasts outside daylight retain the supplied hours.
 */
export function windgramHours(profile: SiteForecast, options: WindgramOptions): ProfileHour[] {
  const window = options.hours;
  const selected = Array.isArray(window) ? new Set(window.map((h) => h.validAt)) : null;
  const dayWindow = window && !Array.isArray(window) && "dateKey" in window ? window : null;
  const hours = profile.hours.filter((h) => (!selected || selected.has(h.validAt)) && (!dayWindow || localDateKey(h.validAt, dayWindow.timeZone) === dayWindow.dateKey));
  if (!options.compact || hours.length < 2) return hours;
  const times = hours.map(hour => Date.parse(hour.validAt));
  const { latitude, longitude } = profile.site;
  if (times.some(time => !Number.isFinite(time)) || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return hours;
  const timeZone = dayWindow?.timeZone ?? options.timeZone;
  const daylight = (validAt: string) => {
    const dateKey = localDateKey(validAt, timeZone);
    // Resolve both midnights locally: DST days can have 23 or 25 hours.
    return sunriseSunset(localInstantMs(dateKey, 0, timeZone), localInstantMs(dateKey, 24, timeZone), latitude, longitude);
  };
  const firstDay = daylight(hours[0].validAt);
  const lastDay = localDateKey(hours[0].validAt, timeZone) === localDateKey(hours.at(-1)!.validAt, timeZone)
    ? firstDay : daylight(hours.at(-1)!.validAt);
  if (!firstDay || !lastDay) return hours;
  const start = firstDay.sunrise, end = lastDay.sunset;
  if (times.at(-1)! < start || times[0] > end) return hours;
  const first = Math.max(0, times.findLastIndex(time => time <= start));
  const last = times.findIndex(time => time >= end);
  return hours.slice(first, last < 0 ? hours.length : last + 1);
}

/** Regional maps retain many days; each chart shows the selected local day's daylight. */
export function windgramDayHours(profile: SiteForecast, validAt: string, timeZone: string): ProfileHour[] {
  return windgramHours(profile, { timeZone, compact: true, hours: { dateKey: localDateKey(validAt, timeZone), timeZone } });
}

export function buildWindgramView(profile: SiteForecast, options: WindgramOptions): WindgramView {
  const hours = windgramHours(profile, options);
  const compact = options.compact ?? false;
  const left = compact ? 52 : 102, right = compact ? 8 : 88, top = compact ? 70 : 65;
  const availableWidth = Math.max(1, (options.widthPx ?? 1000) - left - right);
  const columnWidth = compact ? availableWidth / Math.max(1, hours.length) : Math.max(48, availableWidth / Math.max(1, hours.length));
  const plotWidth = columnWidth * Math.max(1, hours.length);
  const preferredPlotHeight = compact ? clamp((options.heightPx ?? 720) - 260, 160, 440) : clamp(plotWidth * 0.8, 680, 1100);
  const plotHeight = compact && options.maxHeightPx !== undefined
    ? Math.min(preferredPlotHeight, Math.max(80, options.maxHeightPx - top - 82)) : preferredPlotHeight;
  const bottom = top + plotHeight;
  const modelFloorM = profile.site.modelElevationM;
  const focused = compact && options.heightRange !== "full";
  const floorM = focused ? Math.max(modelFloorM, scalar(options.launch?.elevationM) ?? modelFloorM) : modelFloorM;
  const grouped = new Map<number, number[]>();
  if (profile.model === "icon-eu") {
    // Native hybrid pressures change with each forecast hour. Fixed isobar ticks
    // keep the display scale independent of that changing pressure inventory.
    const ticks = [1000, 975, 950, 925, 900, 875, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100];
    for (const hour of hours) {
      const levels = hour.levels.map(level => ({ p: scalar(level.pressureHpa), z: scalar(level.heightM) }))
        .filter((level): level is { p: number; z: number } => level.p !== null && level.p > 0 && level.z !== null)
        .sort((a, b) => a.z - b.z);
      for (const p of ticks) {
        for (let i = 1; i < levels.length; i++) {
          const a = levels[i - 1], b = levels[i];
          if (a.p <= b.p || p > a.p || p < b.p) continue;
          const fraction = (Math.log(p) - Math.log(a.p)) / (Math.log(b.p) - Math.log(a.p));
          const z = a.z + fraction * (b.z - a.z);
          if (z > modelFloorM + 5) grouped.set(p, [...(grouped.get(p) ?? []), z]);
          break;
        }
      }
    }
  } else {
    for (const h of hours) for (const l of h.levels) {
      const p = scalar(l.pressureHpa), z = scalar(l.heightM);
      if (p !== null && z !== null && z > modelFloorM + 5) grouped.set(p, [...(grouped.get(p) ?? []), z]);
    }
  }
  const levelAnchors = [...grouped].map(([pressureHpa, zs]) => ({ pressureHpa, heightM: median(zs) })).sort((a, b) => a.heightM - b.heightM)
    .filter((a, i, all) => i === 0 || a.heightM > all[i - 1].heightM + 5);
  const highest = Math.max(modelFloorM + 800, ...hours.flatMap((h) => h.levels.map((l) => scalar(l.heightM) ?? modelFloorM)), scalar(options.launch?.elevationM) ?? modelFloorM);
  const fullTopM = highest + (highest - modelFloorM) * 0.04;
  // Use the whole displayed day, rather than the selected hour, so the scale
  // stays fixed while scrubbing. High potential LCLs do not imply usable lift.
  const liftTops = hours.flatMap((hour) => [publishedLift(hour).usableLiftTopM, publishedWxtoflyLiftTop(hour)]
    .flatMap(value => {
      const middle = scalar(value);
      const upper = value && typeof value === "object" && "p75" in value ? scalar(value.p75) : null;
      return [middle, upper].filter((z): z is number => z !== null);
    }));
  const peakM = Math.max(modelFloorM, scalar(options.launch?.elevationM) ?? modelFloorM, ...liftTops);
  const focusedTopM = Math.ceil(Math.max(modelFloorM + 1000, peakM + Math.max(500, (peakM - modelFloorM) * .25)) / 250) * 250;
  const strengths = hours.map(hour => scalar(publishedLift(hour).thermalVelocityMps));
  const calmDay = strengths.length > 0 && strengths.every(value => value === 0);
  const topM = focused && (liftTops.length || calmDay)
    ? Math.min(fullTopM, focusedTopM) : fullTopM;
  const baseAnchors = [{ pressureHpa: null as number | null, heightM: modelFloorM }, ...levelAnchors];
  // A short headroom segment leaves the top native wind barb inside the frame.
  const span = Math.max(1, baseAnchors.length - 1) + 0.35;
  const fullAnchors: HeightAnchor[] = baseAnchors.map((a, i) => ({ ...a, y: bottom - plotHeight * i / span }));
  fullAnchors.push({ pressureHpa: null, heightM: fullTopM, y: top });
  const fullScale = { anchors: fullAnchors, floorM: modelFloorM, topM: fullTopM, top, bottom };
  const croppedTopY = heightToY(fullScale, topM), croppedBottomY = heightToY(fullScale, floorM);
  const anchors: HeightAnchor[] = [{ pressureHpa: null, heightM: floorM, y: bottom },
    ...fullAnchors.filter(a => a.heightM > floorM && a.heightM < topM)
      .map(a => ({ ...a, y: bottom - (croppedBottomY - a.y) * plotHeight / (croppedBottomY - croppedTopY) }))];
  anchors.push({ pressureHpa: null, heightM: topM, y: top });
  const sampling = hours.map((h) => hourSampling(h, modelFloorM));
  // The library remains the authority for diagnostic semantics and units.
  const diagnosticColumnWidth = compact ? Math.max(44, columnWidth) : columnWidth;
  const diagnosticPlotWidth = diagnosticColumnWidth * Math.max(1, hours.length);
  const scene = buildMeteogramScene(profile, { ...options, hours, widthPx: diagnosticPlotWidth + 120, minColumnWidthPx: 1, plotHeightPx: 1,
    overlays: { stability: false, temperature: false, wind: false, cloudBase: false, usableLiftTop: false, boundaryLayerTop: false, selectedHour: false } });
  const labelTime = new Intl.DateTimeFormat("en-US", { timeZone: options.timeZone, hour: "numeric", hour12: true });
  const ensemble = (profile.run.members ?? 0) > 1 || hours.some((h) => typeof h.surface.temperatureC === "object" && h.surface.temperatureC !== null);
  const view: WindgramView = {
    width: left + plotWidth + right, height: bottom + (compact ? 82 : 86), left, top, plotWidth, plotHeight, bottom, columnWidth, floorM, topM,
    ground: { elevationM: scalar(options.launch?.elevationM) ?? modelFloorM, source: scalar(options.launch?.elevationM) === null ? "model" : "launch" },
    timeZone: options.timeZone, anchors, sampling, compact, ensemble, sourceNote: scene.smokeSource ? `Smoke: ${scene.smokeSource.model} · run ${scene.smokeSource.referenceTime}` : null,
    displayInterpolationNote: "Colours interpolate between layer centres and forecast hours. Contours and faint barbs interpolate between model levels.",
    hours: hours.map((h, i) => {
      const temp = scalar(h.surface.temperatureC), gust = scalar(h.surface.windGustMps), direction = scalar(h.surface.windDirectionDeg);
      const arcs = options.launchWindows;
      const inWindWindow = direction === null || !arcs?.length ? null : arcs.some((arc) => arc.fromDeg <= arc.toDeg ? direction >= arc.fromDeg && direction <= arc.toDeg : direction >= arc.fromDeg || direction <= arc.toDeg);
      return { validAt: h.validAt, label: labelTime.format(new Date(h.validAt)).replace(/\s/g, "").replace("AM", "a").replace("PM", "p"), x: left + columnWidth * (i + 0.5),
        temperatureF: temp === null ? null : fahrenheit(temp), usableLiftTopM: scalar(publishedLift(h).usableLiftTopM), thermalVelocityMps: scalar(publishedLift(h).thermalVelocityMps), gustKt: gust === null ? null : gust * KT, inWindWindow };
    }),
    fields: [], contours: [], barbs: [], clouds: [], cloudBands: [], freezing: [], wings: [], series: [], launch: null,
    diagnostics: alignedDiagnostics(scene.strips.filter((s) => s.key !== "thermalStrength"), scene.hourValidAts, hours, scene.scales.plotLeft, diagnosticColumnWidth), diagnosticLeft: scene.scales.plotLeft, diagnosticColumnWidth,
    selectedHourIndex: hours.reduce((best, h, i) => (scalar(publishedLift(h).thermalVelocityMps) ?? -1) > (scalar((hours[best] ? publishedLift(hours[best]).thermalVelocityMps : null)) ?? -1) ? i : best, 0),
  };
  if (!hours.length) return view;
  const y = (z: number) => heightToY(view, z);
  if (options.launch && options.launch.elevationM >= floorM && options.launch.elevationM <= topM) view.launch = {
    y: y(options.launch.elevationM), heightM: options.launch.elevationM,
    label: `${options.launch.name ?? "Launch"} · ${formatQuantity(options.launch.elevationM, "elevation")} MSL`,
  };

  // Smooth display colours independently of the source interval measurements.
  // NaN boundaries preserve holes when reconstructing and cropping the field.
  const gaps = timeGaps(view.hours);
  const fieldNodes = sampling.map((s) => {
    if (!s.lapseCPer1000Ft.some((n) => Number.isFinite(n.value))) return [];
    const displayNodes = stabilityDisplayNodes(s.lapseCPer1000Ft);
    const nodes = displayNodes.filter(n => n.altitudeM >= floorM && n.altitudeM <= topM);
    if (displayNodes[0].altitudeM < floorM && displayNodes.at(-1)!.altitudeM >= floorM && nodes[0]?.altitudeM !== floorM) {
      nodes.unshift({ altitudeM: floorM, value: sampleHeight(displayNodes, floorM) ?? NaN });
    }
    if (nodes.length && nodes.at(-1)!.altitudeM < topM && displayNodes.at(-1)!.altitudeM > topM) {
      nodes.push({ altitudeM: topM, value: sampleHeight(displayNodes, topM) ?? NaN });
    }
    return nodes.map((n) => ({ altitudeM: bottom - y(n.altitudeM), value: n.value }));
  });
  const fields = buildStabilityFieldPaths({
    nodesByHour: fieldNodes,
    gaps,
    floorM: 0,
    topM: plotHeight,
    plotLeft: left,
    plotTop: top,
    plotBottom: bottom,
    plotWidth,
    banding: {
      breakpoints: WINDGRAM_STABILITY.slice(0, -1).map((c) => c.maxLapse),
      classNames: WINDGRAM_STABILITY.map((c) => `meteo-gram-stab-${c.className}`),
    },
  });
  view.fields = Object.entries(fields).map(([className, path]) => ({ className, path }));
  fieldNodes.forEach((nodes, i) => {
    const rawNodes = sampling[i].lapseCPer1000Ft;
    const validNodes = nodes.filter((n) => Number.isFinite(n.value));
    const highestValidAlt = validNodes.length ? validNodes[validNodes.length - 1].altitudeM : 0;
    // Mask any missing internal intervals below the last valid measurement.
    let missingSpan: { baseY: number; topY: number } | null = null;
    for (let k = 0; k + 1 < rawNodes.length; k += 2) {
      const a = rawNodes[k], b = rawNodes[k + 1];
      if (Number.isFinite(a.value) && Number.isFinite(b.value)) continue;
      const dispTop = bottom - y(b.altitudeM);
      if (dispTop > highestValidAlt + 0.001) continue;
      const baseY = y(a.altitudeM), topY = y(b.altitudeM);
      if (missingSpan && Math.abs(missingSpan.topY - baseY) < 0.05) missingSpan.topY = topY;
      else {
        if (missingSpan && missingSpan.baseY > missingSpan.topY) {
          view.fields.push({ className: "windgram-missing", path: `M${left + i * columnWidth},${missingSpan.topY}h${columnWidth}v${missingSpan.baseY - missingSpan.topY}h-${columnWidth}Z` });
        }
        missingSpan = { baseY, topY };
      }
    }
    if (missingSpan && missingSpan.baseY > missingSpan.topY) {
      view.fields.push({ className: "windgram-missing", path: `M${left + i * columnWidth},${missingSpan.topY}h${columnWidth}v${missingSpan.baseY - missingSpan.topY}h-${columnWidth}Z` });
    }
    // Mask any truncated top extension above the highest valid node.
    const missingHeight = validNodes.length ? bottom - highestValidAlt - top : plotHeight;
    if (missingHeight > 0) view.fields.push({ className: "windgram-missing", path: `M${left + i * columnWidth},${top}h${columnWidth}v${missingHeight}h-${columnWidth}Z` });
  });
  for (const i of gaps) view.fields.push({ className: "windgram-missing", path: `M${view.hours[i - 1].x + 1},${top}h${columnWidth - 2}v${plotHeight}h-${columnWidth - 2}Z` });
  view.contours = temperatureContours(view);

  hours.forEach((h, i) => {
    const sample = sampling[i], x = view.hours[i].x;
    const addBarb = (z: number, interpolated: boolean, surface: boolean) => {
      if (z < floorM || z > topM) return;
      const u = sampleHeight(sample.windU, z), v = sampleHeight(sample.windV, z);
      if (u === null || v === null) return;
      const wind = componentsToWind(u, v);
      view.barbs.push({ x, y: surface ? bottom - 18 : y(z), hourIndex: i, heightM: z, speedKt: wind.speedMps * KT, directionDeg: wind.directionDeg, interpolated, surface });
    };
    for (let j = 0; j < sample.windU.length; j++) {
      const a = sample.windU[j], b = sample.windU[j + 1];
      addBarb(a.altitudeM, false, j === 0);
      const ay = j === 0 ? bottom - 18 : y(a.altitudeM);
      if (b && b.altitudeM - a.altitudeM <= 1000 && ay - y(b.altitudeM) >= 66) addBarb((a.altitudeM + b.altitudeM) / 2, true, false);
    }
    const freezing = crossings(sample.temperatureC, 0)[0];
    if (freezing !== undefined && freezing >= floorM && freezing <= topM) view.freezing.push({ x, y: y(freezing), hourIndex: i });
    const modelCloud = h.levels.map((l) => ({ altitudeM: scalar(l.heightM) ?? NaN, value: scalar(l.cloudFractionPercent) ?? NaN }))
      .filter((n) => Number.isFinite(n.altitudeM) && n.altitudeM >= modelFloorM).sort((a, b) => a.altitudeM - b.altitudeM);
    // Humidity hatching remains independent of model cloud fraction: either
    // source can identify a layer the other misses.
    for (const [kind, nodes, threshold] of [
      ["model", modelCloud, 30],
      ["humidity", sample.relativeHumidityPercent, 94.00001],
    ] as const) {
      for (const layer of moistLayers(nodes, threshold)) {
        if (layer.baseM >= topM || layer.topM <= floorM) continue;
        const coverPercent = kind === "model" ? layer.coverPercent : null;
        view.clouds.push({ ...layer, hourIndex: i, x, y: y(layer.baseM), kind, coverPercent });
        view.cloudBands.push({ x: x - columnWidth / 2, width: columnWidth, y: y(layer.topM), height: y(layer.baseM) - y(layer.topM), kind, coverPercent });
      }
    }
    const base = scalar(publishedLift(h).cloudBaseM);
    // WxToFly's cloud symbol is the potential LCL, independent of thermal reach.
    if (base !== null && base >= floorM && base <= topM) {
      view.clouds.push({ hourIndex: i, x, y: y(base), baseM: base, topM: base, kind: "potential", coverPercent: null });
    }
    const gliderTop = scalar(publishedWxtoflyLiftTop(h));
    if (i % 3 === 1 && gliderTop !== null && gliderTop > floorM + 10 && gliderTop <= topM) {
      view.wings.push({ x, y: y(gliderTop) + 8, heightM: gliderTop, hourIndex: i });
    }
  });

  for (const [key, label, color, dash] of [
    ["boundaryLayerTopM", "Boundary layer", "#a56800", "7 5"],
    ["usableLiftTopM", `Usable lift · ${formatQuantity(1, "lift")} sink`, "#134ac4", null],
    ["cloudBaseM", "Potential cloud base", "#426173", "2 5"],
  ] as const) {
    const value = (h: ProfileHour, i: number) => key === "usableLiftTopM" ? view.hours[i].usableLiftTopM : scalar(publishedLift(h)[key]);
    const points = hours.flatMap((h, i): (Point | null)[] => {
      const z = value(h, i);
      const point = z === null || z < floorM || z > topM ? null : { x: view.hours[i].x, y: y(z) };
      return gaps.has(i) ? [null, point] : [point];
    });
    const bandRuns: { lower: Point[]; upper: Point[] }[] = [];
    let run: typeof bandRuns[number] | null = null;
    for (let i = 0; i < hours.length; i++) {
      if (gaps.has(i)) run = null;
      const val = publishedLift(hours[i])[key];
      const lo = val && typeof val === "object" ? scalar(val.p25) : null;
      const hi = val && typeof val === "object" ? scalar(val.p75) : null;
      if (lo === null || hi === null) { run = null; continue; }
      if (!run) { run = { lower: [], upper: [] }; bandRuns.push(run); }
      run.lower.push({ x: view.hours[i].x, y: y(lo) }); run.upper.push({ x: view.hours[i].x, y: y(hi) });
    }
    const bandPath = bandRuns.filter((r) => r.lower.length > 1).map((r) => linearPath([...r.upper, ...r.lower.reverse()]) + "Z").join("") || null;
    view.series.push({ key, label, color, dash, path: linearPath(points), bandPath });
  }
  return view;
}

export function readWindgram(view: WindgramView, hourIndex: number, heightM: number): WindgramReading {
  const index = clamp(Math.round(hourIndex), 0, view.hours.length - 1);
  const sample = view.sampling[index];
  const z = clamp(heightM, view.floorM, view.topM);
  const t = sample ? sampleHeight(sample.temperatureC, z) : null;
  const u = sample ? sampleHeight(sample.windU, z) : null, v = sample ? sampleHeight(sample.windV, z) : null;
  const wind = u !== null && v !== null ? componentsToWind(u, v) : null;
  const cloud = view.clouds.find((c) => c.hourIndex === index && (c.kind === "potential" ? Math.abs(z - c.baseM) < 25 : z >= c.baseM && z <= c.topM));
  return { hourIndex: index, validAt: view.hours[index]?.validAt ?? "", heightM: z, heightAglM: z - view.ground.elevationM,
    temperatureF: t === null ? null : fahrenheit(t), speedKt: wind === null ? null : wind.speedMps * KT, directionDeg: wind?.directionDeg ?? null,
    interpolated: !sample?.temperatureC.some((n) => Math.abs(n.altitudeM - z) < 5), gustKt: view.hours[index]?.gustKt ?? null, cloud: cloud?.kind ?? null };
}
