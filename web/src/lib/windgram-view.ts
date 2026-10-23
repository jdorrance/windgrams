import { publishedLift } from "./published-lift.ts";
import type { SiteForecast } from "@azohra/meteo.briefing/contract";
import { componentsToWind, lapseRateCPer1000Ft, localDateKey, relativeHumidityPercent, STABILITY_CLASSES, windToComponents } from "@azohra/meteo.briefing/derive";
import { buildMeteogramScene, sampledFieldPaths, type FieldNode, type HourSampling, type MeteogramOptions, type MetricStrip } from "@azohra/meteo.briefing/meteogram";

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
  wings: { x: number; y: number }[]; series: WindgramSeries[];
  launch: { y: number; heightM: number; label: string } | null;
  diagnostics: readonly MetricStrip[]; diagnosticLeft: number; diagnosticColumnWidth: number;
  sampling: readonly HourSampling[]; selectedHourIndex: number;
  compact: boolean; ensemble: boolean; sourceNote: string | null;
  displayInterpolationNote: string;
}
export type WindgramOptions = Pick<MeteogramOptions, "timeZone" | "hours" | "launch" | "launchWindows" | "capabilities" | "widthPx"> & {
  compact?: boolean;
  /** Available viewport height; compact charts reserve room for page controls. */
  heightPx?: number;
  /** Total height available below page controls, including the chart's axes. */
  maxHeightPx?: number;
};
export interface WindgramReading {
  hourIndex: number; validAt: string; heightM: number;
  temperatureF: number | null; speedKt: number | null; directionDeg: number | null;
  interpolated: boolean; gustKt: number | null; cloud: CloudEvidence | null;
}

const KT = 1.9438444924406;
const FT = 3.280839895;
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
    if (Math.abs(a.altitudeM - heightM) < 0.00001) return Number.isFinite(a.value) ? a.value : null;
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
  const lapseCPer1000Ft = temperatureC.map((p, i) => {
    const a = temperatureC[Math.min(i, temperatureC.length - 2)], b = temperatureC[Math.min(i + 1, temperatureC.length - 1)];
    return { altitudeM: p.altitudeM, value: a && b && Number.isFinite(a.value) && Number.isFinite(b.value)
      ? lapseRateCPer1000Ft({ heightM: a.altitudeM, temperatureC: a.value }, { heightM: b.altitudeM, temperatureC: b.value }) ?? NaN : NaN };
  });
  const usable = scalar(publishedLift(hour).usableLiftTopM), base = scalar(publishedLift(hour).cloudBaseM);
  return {
    validAt: hour.validAt, temperatureC, dewPointC, lapseCPer1000Ft,
    relativeHumidityPercent: temperatureC.map((p, i) => ({ altitudeM: p.altitudeM, value: Number.isFinite(p.value) && Number.isFinite(dewPointC[i].value) ? relativeHumidityPercent(p.value, dewPointC[i].value) : NaN })),
    windU: temperatureC.map((p, i) => ({ altitudeM: p.altitudeM, value: winds[i].uMps })),
    windV: temperatureC.map((p, i) => ({ altitudeM: p.altitudeM, value: winds[i].vMps })),
    verticalVelocityPaS: levels.map((l) => ({ altitudeM: scalar(l.heightM)!, value: scalar(l.verticalVelocityPaS) ?? NaN })),
    thermalIndexC: [], smoke: hour.smoke && finite(scalar(hour.smoke.surfaceUgm3)) ? { surfaceUgm3: scalar(hour.smoke.surfaceUgm3)!, aot: scalar(hour.smoke.aot) } : null,
    observation: null, aotObservation: null,
    cloudCapped: usable === null || base === null ? null : usable >= base - 1,
    capeCapped: scalar(hour.surface.capeJkg) === null || scalar(hour.surface.cinJkg) === null ? null : scalar(hour.surface.cinJkg)! <= -50,
  };
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
  const low = Math.floor(fahrenheit(Math.min(...temperatures)) / 8) * 8;
  const high = Math.ceil(fahrenheit(Math.max(...temperatures)) / 8) * 8;
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
  for (let f = low; f <= high; f += 8) {
    const target = (f - 32) * 5 / 9;
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
      ? crossings(view.sampling[i].temperatureC, target).map((z) => ({ x: h.x, y: heightToY(view, z) })) : []);
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

export function buildWindgramView(profile: SiteForecast, options: WindgramOptions): WindgramView {
  const window = options.hours;
  const selected = Array.isArray(window) ? new Set(window.map((h) => h.validAt)) : null;
  const dayWindow = window && !Array.isArray(window) && "dateKey" in window ? window : null;
  const hours = profile.hours.filter((h) => (!selected || selected.has(h.validAt)) && (!dayWindow || localDateKey(h.validAt, dayWindow.timeZone) === dayWindow.dateKey));
  const compact = options.compact ?? false;
  const left = compact ? 52 : 102, right = compact ? 8 : 88, top = compact ? 70 : 65;
  const availableWidth = Math.max(1, (options.widthPx ?? 1000) - left - right);
  const columnWidth = compact ? availableWidth / Math.max(1, hours.length) : Math.max(48, availableWidth / Math.max(1, hours.length));
  const plotWidth = columnWidth * Math.max(1, hours.length);
  const preferredPlotHeight = compact ? clamp((options.heightPx ?? 720) - 260, 160, 440) : clamp(plotWidth * 0.8, 680, 1100);
  const plotHeight = compact && options.maxHeightPx !== undefined
    ? Math.min(preferredPlotHeight, Math.max(80, options.maxHeightPx - top - 82)) : preferredPlotHeight;
  const bottom = top + plotHeight;
  const floorM = profile.site.modelElevationM;
  const grouped = new Map<number, number[]>();
  for (const h of hours) for (const l of h.levels) {
    const p = scalar(l.pressureHpa), z = scalar(l.heightM);
    if (p !== null && z !== null && z > floorM + 5) grouped.set(p, [...(grouped.get(p) ?? []), z]);
  }
  const levelAnchors = [...grouped].map(([pressureHpa, zs]) => ({ pressureHpa, heightM: median(zs) })).sort((a, b) => a.heightM - b.heightM)
    .filter((a, i, all) => i === 0 || a.heightM > all[i - 1].heightM + 5);
  const highest = Math.max(floorM + 800, ...hours.flatMap((h) => h.levels.map((l) => scalar(l.heightM) ?? floorM)), options.launch?.elevationM ?? floorM);
  const topM = highest + (highest - floorM) * 0.04;
  const baseAnchors = [{ pressureHpa: null as number | null, heightM: floorM }, ...levelAnchors];
  // A short headroom segment leaves the top native wind barb inside the frame.
  const span = Math.max(1, baseAnchors.length - 1) + 0.35;
  const anchors: HeightAnchor[] = baseAnchors.map((a, i) => ({ ...a, y: bottom - plotHeight * i / span }));
  anchors.push({ pressureHpa: null, heightM: topM, y: top });
  const sampling = hours.map((h) => hourSampling(h, floorM));
  // The library remains the authority for diagnostic semantics and units.
  const diagnosticColumnWidth = compact ? Math.max(44, columnWidth) : columnWidth;
  const diagnosticPlotWidth = diagnosticColumnWidth * Math.max(1, hours.length);
  const scene = buildMeteogramScene(profile, { ...options, hours, widthPx: diagnosticPlotWidth + 120, minColumnWidthPx: 1, plotHeightPx: 1,
    overlays: { stability: false, temperature: false, wind: false, cloudBase: false, usableLiftTop: false, boundaryLayerTop: false, selectedHour: false } });
  const labelTime = new Intl.DateTimeFormat("en-US", { timeZone: options.timeZone, hour: "numeric", hour12: true });
  const ensemble = (profile.run.members ?? 0) > 1 || hours.some((h) => typeof h.surface.temperatureC === "object" && h.surface.temperatureC !== null);
  const view: WindgramView = {
    width: left + plotWidth + right, height: bottom + (compact ? 82 : 86), left, top, plotWidth, plotHeight, bottom, columnWidth, floorM, topM,
    timeZone: options.timeZone, anchors, sampling, compact, ensemble, sourceNote: scene.smokeSource ? `Smoke: ${scene.smokeSource.model} · run ${scene.smokeSource.referenceTime}` : null,
    displayInterpolationNote: "Contours, lapse-rate bands, and intermediate wind barbs use linear display interpolation between captured model levels and do not add vertical resolution or resolve sub-grid inversions.",
    hours: hours.map((h, i) => {
      const temp = scalar(h.surface.temperatureC), gust = scalar(h.surface.windGustMps), direction = scalar(h.surface.windDirectionDeg);
      const arcs = options.launchWindows;
      const inWindWindow = direction === null || !arcs?.length ? null : arcs.some((arc) => arc.fromDeg <= arc.toDeg ? direction >= arc.fromDeg && direction <= arc.toDeg : direction >= arc.fromDeg || direction <= arc.toDeg);
      return { validAt: h.validAt, label: labelTime.format(new Date(h.validAt)).replace(/\s/g, "").replace("AM", "a").replace("PM", "p"), x: left + columnWidth * (i + 0.5),
        temperatureF: temp === null ? null : fahrenheit(temp), thermalVelocityMps: scalar(publishedLift(h).thermalVelocityMps), gustKt: gust === null ? null : gust * KT, inWindWindow };
    }),
    fields: [], contours: [], barbs: [], clouds: [], cloudBands: [], freezing: [], wings: [], series: [], launch: null,
    diagnostics: alignedDiagnostics(scene.strips.filter((s) => s.key !== "thermalStrength"), scene.hourValidAts, hours, scene.scales.plotLeft, diagnosticColumnWidth), diagnosticLeft: scene.scales.plotLeft, diagnosticColumnWidth,
    selectedHourIndex: hours.reduce((best, h, i) => (scalar(publishedLift(h).thermalVelocityMps) ?? -1) > (scalar((hours[best] ? publishedLift(hours[best]).thermalVelocityMps : null)) ?? -1) ? i : best, 0),
  };
  if (!hours.length) return view;
  const y = (z: number) => heightToY(view, z);
  if (options.launch && options.launch.elevationM >= floorM && options.launch.elevationM <= topM) view.launch = {
    y: y(options.launch.elevationM), heightM: options.launch.elevationM,
    label: `${options.launch.name ?? "Launch"} · ${Math.round(options.launch.elevationM * FT).toLocaleString("en-US")} ft`,
  };

  // Sample in physical metres before moving nodes into display coordinates.
  // Inserting every anchor preserves physical interpolation across scale bends.
  const fieldNodes = sampling.map((s) => {
    const nodes = s.lapseCPer1000Ft;
    if (nodes.some((n) => !Number.isFinite(n.value)) || nodes.length < 2) return [];
    const heights = [...new Set([...nodes.map((n) => n.altitudeM), ...anchors.map((a) => a.heightM)])].sort((a, b) => a - b);
    return heights.flatMap((z) => { const value = sampleHeight(nodes, z); return value === null ? [] : [{ altitudeM: bottom - y(z), value }]; });
  });
  const fields = sampledFieldPaths({ nodesByHour: fieldNodes, floorM: 0, topM: plotHeight, plotLeft: left, plotTop: top, plotBottom: bottom, plotWidth,
    banding: { breakpoints: STABILITY_CLASSES.slice(0, -1).map((c) => c.maxLapse), classNames: STABILITY_CLASSES.map((c) => `meteo-gram-stab-${c.className}`) } });
  view.fields = Object.entries(fields).map(([className, path]) => ({ className, path }));
  fieldNodes.forEach((nodes, i) => {
    // The public band renderer extends its last value to the plot ceiling.
    // Mask that extension so a truncated profile never invents stability aloft.
    const missingHeight = nodes.length ? bottom - nodes[nodes.length - 1].altitudeM - top : plotHeight;
    if (missingHeight > 0) view.fields.push({ className: "windgram-missing", path: `M${left + i * columnWidth},${top}h${columnWidth}v${missingHeight}h-${columnWidth}Z` });
  });
  const gaps = timeGaps(view.hours);
  for (const i of gaps) view.fields.push({ className: "windgram-missing", path: `M${view.hours[i - 1].x + 1},${top}h${columnWidth - 2}v${plotHeight}h-${columnWidth - 2}Z` });
  view.contours = temperatureContours(view);

  hours.forEach((h, i) => {
    const sample = sampling[i], x = view.hours[i].x;
    const addBarb = (z: number, interpolated: boolean, surface: boolean) => {
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
    if (freezing !== undefined) view.freezing.push({ x, y: y(freezing), hourIndex: i });
    const modelCloud = h.levels.map((l) => ({ altitudeM: scalar(l.heightM) ?? NaN, value: scalar(l.cloudFractionPercent) ?? NaN }))
      .filter((n) => Number.isFinite(n.altitudeM) && n.altitudeM >= floorM).sort((a, b) => a.altitudeM - b.altitudeM);
    const hasModelCloud = modelCloud.filter((n) => Number.isFinite(n.value)).length >= 2;
    const kind = hasModelCloud ? "model" : "humidity";
    const layers = moistLayers(hasModelCloud ? modelCloud : sample.relativeHumidityPercent, hasModelCloud ? 30 : 95.00001);
    for (const layer of layers) {
      view.clouds.push({ ...layer, hourIndex: i, x, y: y(layer.baseM), kind, coverPercent: hasModelCloud ? layer.coverPercent : null });
      view.cloudBands.push({ x: x - columnWidth / 2, width: columnWidth, y: y(layer.topM), height: y(layer.baseM) - y(layer.topM), kind, coverPercent: hasModelCloud ? layer.coverPercent : null });
    }
    const base = scalar(publishedLift(h).cloudBaseM), usable = scalar(publishedLift(h).usableLiftTopM), wstar = scalar(publishedLift(h).thermalVelocityMps);
    if (sample.cloudCapped && base !== null && base >= floorM && base <= topM && wstar !== null && wstar >= 0.1
      && !layers.some((l) => base >= l.baseM - 100 && base <= l.topM + 100)) {
      view.clouds.push({ hourIndex: i, x, y: y(base), baseM: base, topM: base, kind: "potential", coverPercent: null });
    }
    if (i % 3 === 1 && usable !== null && usable > floorM + 10 && usable <= topM && wstar !== null && wstar >= 0.1) view.wings.push({ x, y: y(usable) + 10 });
  });

  for (const [key, label, color, dash] of [
    ["boundaryLayerTopM", "Boundary layer", "#a56800", "7 5"],
    ["usableLiftTopM", "Usable lift", "#134ac4", null],
    ["cloudBaseM", "Potential cloud base", "#426173", "2 5"],
  ] as const) {
    const value = (h: ProfileHour) => scalar(publishedLift(h)[key]);
    const points = hours.flatMap((h, i): (Point | null)[] => {
      const z = value(h);
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
  return { hourIndex: index, validAt: view.hours[index]?.validAt ?? "", heightM: z, temperatureF: t === null ? null : fahrenheit(t),
    speedKt: wind ? wind.speedMps * KT : null, directionDeg: wind && wind.speedMps >= 0.05 ? wind.directionDeg : null,
    interpolated: !!sample && !sample.windU.some((n) => Math.abs(n.altitudeM - z) < 0.5), gustKt: view.hours[index]?.gustKt ?? null, cloud: cloud?.kind ?? null };
}
