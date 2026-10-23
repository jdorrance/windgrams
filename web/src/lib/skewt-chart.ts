import { convertQuantity, formatQuantity, fromDisplayQuantity, getUnitSystem, unitLabel } from "./units.ts";
// A Skew-T log-P diagram of one sounding, annotated for pilots: the thermal
// zone, the top of the lift, cloud base, inversions ("lids"), cloud layers
// and the launch are drawn and named inside the diagram, and hovering reads
// out the air at any height in plain words.
//
// Geometry: height runs up on a log-pressure scale, and
// lines of equal temperature lean to the right by about 7 °C per km of
// height, so a normal atmosphere stands near-vertical and a dry thermal's
// path leans left, at any chart width. The model's
// published levels are joined by straight segments and marked with dots;
// nothing between them is invented.

import { solveVerticalLabels } from "@azohra/meteo.briefing/sounding";
import { compassPoint } from "./launches.ts";
import { barbPaths } from "./wind-barb.ts";
import { environmentAtHeight, heightAtPressure, pressureAtHeight, windAtHeight, type Sounding } from "./skewt.ts";
export { barbPaths } from "./wind-barb.ts";

const SVG = "http://www.w3.org/2000/svg";
const FT = 3.28084;
const MPH = 2.23694;
const KT = 1.94384;

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}, parent?: Element) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

function text(parent: Element, x: number, y: number, value: string, attrs: Record<string, string | number> = {}) {
  const t = el("text", { x, y, ...attrs }, parent);
  t.textContent = value;
  return t;
}

const heightLabel = (m: number) => formatQuantity(m, "elevation");

export interface Geometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
  pBottom: number;
  pTop: number;
  /** Pixels per °C. */
  k: number;
  /** Temperature at the bottom-left corner. */
  t0: number;
}

/** Skew: °C of lean per unit of ln(p), about 7 °C per km with an 8 km scale height. */
export const SKEW_C_PER_LNP = 56;

/** y of a pressure on the log-pressure scale. */
export function yOf(g: Geometry, p: number) {
  return g.bottom - ((Math.log(g.pBottom) - Math.log(p)) / (Math.log(g.pBottom) - Math.log(g.pTop))) * (g.bottom - g.top);
}

/** x of a temperature at a pressure; isotherms lean right with height. */
export function xOf(g: Geometry, t: number, p: number) {
  return g.left + (t - g.t0 + SKEW_C_PER_LNP * (Math.log(g.pBottom) - Math.log(p))) * g.k;
}

/** Pressure at a y. */
export function pOf(g: Geometry, y: number) {
  return Math.exp(Math.log(g.pBottom) - ((g.bottom - y) / (g.bottom - g.top)) * (Math.log(g.pBottom) - Math.log(g.pTop)));
}

/**
 * Fits the traces into the plot, centred, with at least 30 °C across so a
 * quiet sounding is not blown up out of proportion.
 */
export function fitGeometry(s: Sounding, box: { left: number; right: number; top: number; bottom: number }): Geometry {
  const pBottom = s.points[0].pressureHpa + 4;
  const pTop = s.points[s.points.length - 1].pressureHpa - 8;
  const width = box.right - box.left;
  const skewed: number[] = [];
  const add = (t: number, p: number) => skewed.push(t + SKEW_C_PER_LNP * (Math.log(pBottom) - Math.log(p)));
  for (const p of s.points) {
    add(p.temperatureC, p.pressureHpa);
    if (Number.isFinite(p.dewPointC)) add(p.dewPointC, p.pressureHpa);
  }
  for (const p of s.parcel) add(p.parcelC, p.pressureHpa);
  const min = Math.min(...skewed);
  const max = Math.max(...skewed);
  const pad = 26;
  const span = Math.max(30, max - min);
  const k = (width - 2 * pad) / span;
  const t0 = (min + max) / 2 - width / 2 / k;
  return { ...box, pBottom, pTop, k, t0 };
}

export interface SkewTLaunch {
  name: string;
  elevationM: number | null;
}

export class SkewTChart {
  private sounding: Sounding | null = null;
  private readonly observer: ResizeObserver;
  private width = 0;
  private readonly tooltip: HTMLDivElement;
  private readonly host: HTMLElement;
  private launch: SkewTLaunch;

  constructor(host: HTMLElement, launch: SkewTLaunch) {
    this.host = host;
    this.launch = launch;
    host.classList.add("skewt");
    this.tooltip = document.createElement("div");
    this.tooltip.className = "tooltip";
    this.tooltip.hidden = true;
    this.observer = new ResizeObserver(() => {
      if (this.sounding && Math.abs(host.clientWidth - this.width) > 4) this.render();
    });
    this.observer.observe(host);
  }

  set(sounding: Sounding | null, launch?: SkewTLaunch) {
    if (launch) this.launch = launch;
    this.sounding = sounding;
    this.render();
  }

  private render() {
    const s = this.sounding;
    const host = this.host;
    host.replaceChildren();
    if (!s) return;
    this.width = host.clientWidth || 640;
    const W = Math.max(320, this.width);
    const narrow = W < 520;
    const H = narrow ? 500 : 560;
    const box = { left: narrow ? 44 : 60, right: W - (narrow ? 50 : 70), top: 24, bottom: H - 34 };
    const g = fitGeometry(s, box);
    const y = (p: number) => yOf(g, p);
    const x = (t: number, p: number) => xOf(g, t, p);
    const pAt = (z: number) => pressureAtHeight(s.points, z);
    const inside = (z: number | null): z is number => z !== null && z >= s.modelElevationM && pAt(z) >= g.pTop;

    const svg = el("svg", {
      viewBox: `0 0 ${W} ${H}`,
      width: W,
      height: H,
      role: "img",
      "aria-label": `Skew-T · Temperature ${unitLabel("temperature")} · Height ${unitLabel("elevation")} MSL · Wind ${unitLabel("wind")} · Thermals, clouds and inversions.`,
    });
    const defs = el("defs", {}, svg);
    const clip = el("clipPath", { id: "skewt-clip" }, defs);
    el("rect", { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }, clip);
    const hatch = el("pattern", { id: "skewt-hatch", width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    el("line", { x1: 0, y1: 0, x2: 0, y2: 7, class: "skewt-hatch-line" }, hatch);

    const plot = el("g", { "clip-path": "url(#skewt-clip)" }, svg);
    el("rect", { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, class: "skewt-frame" }, plot);

    // Layers first (under everything): thermal zone, lids, cloud layers.
    const band = (z0: number, z1: number, cls: string, x0 = box.left, x1 = box.right) => {
      const ya = y(pAt(Math.min(z1, heightAtPressure(s.points, g.pTop))));
      const yb = y(pAt(Math.max(z0, s.modelElevationM)));
      if (yb - ya < 1) return;
      el("rect", { x: x0, y: ya, width: x1 - x0, height: yb - ya, class: cls }, plot);
    };
    const zoneTop = s.marks.zoneTopM;
    if (zoneTop !== null) band(s.modelElevationM, zoneTop, "skewt-thermal-zone");
    for (const layer of s.inversions) band(layer.baseM, layer.topM, layer.kind === "inversion" ? "skewt-lid" : "skewt-lid skewt-lid-soft");
    for (const layer of s.cloudLayers) band(layer.baseM, layer.topM, "skewt-cloud-layer", box.right - Math.min(150, (box.right - box.left) * 0.3), box.right);

    // Guide lines use round display-unit temperatures; freezing stays physical 0 °C.
    const tMin = g.t0 - SKEW_C_PER_LNP * (Math.log(g.pBottom) - Math.log(g.pTop)) - 10;
    const tMax = g.t0 + (box.right - box.left) / g.k + 10;
    const temperatureStep = getUnitSystem() === "metric" ? 10 : 20;
    const temperatureTicks: number[] = [];
    for (let value = Math.ceil(convertQuantity(tMin, "temperature")! / temperatureStep) * temperatureStep; value <= convertQuantity(tMax, "temperature")!; value += temperatureStep) temperatureTicks.push(fromDisplayQuantity(value, "temperature")!);
    for (const t of [...new Set([...temperatureTicks, 0])]) {
      el("line", { x1: x(t, g.pBottom), y1: box.bottom, x2: x(t, g.pTop), y2: box.top, class: t === 0 ? "skewt-isotherm skewt-zero" : "skewt-isotherm" }, plot);
    }
    for (let theta = -20; theta <= 90; theta += 10) {
      const d: string[] = [];
      for (let i = 0; i <= 24; i += 1) {
        const p = g.pBottom + ((g.pTop - g.pBottom) * i) / 24;
        const t = (theta + 273.15) * (p / 1000) ** 0.2857 - 273.15;
        d.push(`${i ? "L" : "M"}${x(t, p).toFixed(1)},${y(p).toFixed(1)}`);
      }
      el("path", { d: d.join(""), class: "skewt-adiabat" }, plot);
    }

    // Height ticks use the chosen display units on the same log-pressure geometry.
    const zTop = heightAtPressure(s.points, g.pTop);
    const metric = getUnitSystem() === "metric";
    const step = metric ? (zTop - s.modelElevationM > 4500 ? 1000 : 500) : ((zTop - s.modelElevationM) * FT > 14000 ? 2000 : 1000);
    for (let value = Math.ceil(convertQuantity(s.modelElevationM, "elevation")! / step) * step; value <= convertQuantity(zTop, "elevation")!; value += step) {
      const yy = y(pAt(fromDisplayQuantity(value, "elevation")!));
      if (yy > box.bottom - 6) continue;
      el("line", { x1: box.left, x2: box.right, y1: yy, y2: yy, class: "skewt-grid" }, svg);
      text(svg, box.left - 6, yy + 4, metric ? value.toLocaleString("en-US") : `${(value / 1000).toLocaleString("en-US")}k`, { class: "tick", "text-anchor": "end" });
    }
    text(svg, box.left - 6, box.top - 8, `${unitLabel("elevation")} MSL`, { class: "tick", "text-anchor": "end" });

    // Where a thermal is warmer than the air around it (it keeps rising).
    const lcl = s.lclM;
    let run: typeof s.parcel = [];
    const flush = () => {
      if (run.length > 1) {
        const warm = run.filter((r) => lcl === null || r.heightM <= lcl);
        const growth = run.filter((r) => lcl !== null && r.heightM >= lcl);
        for (const [part, cls] of [[warm, "skewt-buoyant"], [growth, "skewt-cape"]] as const) {
          if (part.length < 2) continue;
          const fwd = part.map((r) => `${x(r.parcelC, r.pressureHpa).toFixed(1)},${y(r.pressureHpa).toFixed(1)}`);
          const back = [...part].reverse().map((r) => `${x(r.environmentC, r.pressureHpa).toFixed(1)},${y(r.pressureHpa).toFixed(1)}`);
          el("polygon", { points: [...fwd, ...back].join(" "), class: cls }, plot);
        }
      }
      run = [];
    };
    for (const r of s.parcel) {
      if (r.parcelC > r.environmentC) run.push(r);
      else flush();
    }
    flush();

    // Traces.
    const path = (pts: [number, number][]) => pts.map(([t, p], i) => `${i ? "L" : "M"}${x(t, p).toFixed(1)},${y(p).toFixed(1)}`).join("");
    el("path", { d: path(s.parcel.map((r) => [r.parcelC, r.pressureHpa])), class: "skewt-parcel" }, plot);
    if (s.hasDewPoint) el("path", { d: path(s.points.filter((p) => Number.isFinite(p.dewPointC)).map((p) => [p.dewPointC, p.pressureHpa])), class: "skewt-dew" }, plot);
    el("path", { d: path(s.points.map((p) => [p.temperatureC, p.pressureHpa])), class: "skewt-temp" }, plot);
    // Dots mark the published levels; a balloon's dense profile draws as a line alone.
    const dots = s.points.length <= 40;
    for (const p of s.points) {
      if (dots) el("circle", { cx: x(p.temperatureC, p.pressureHpa), cy: y(p.pressureHpa), r: 2.6, class: "skewt-temp-dot" }, plot);
      if (Number.isFinite(p.dewPointC) && dots) el("circle", { cx: x(p.dewPointC, p.pressureHpa), cy: y(p.pressureHpa), r: 2.6, class: "skewt-dew-dot" }, plot);
    }

    // Trace names at the ground, where they are furthest apart.
    // (On narrow screens the legend names them.)
    const p0 = s.points[0];
    const nameAt = (t: number, label: string, cls: string, prefer: "start" | "end") => {
      const px = x(t, p0.pressureHpa);
      const w = label.length * 6.6;
      const fitsLeft = px - 6 - w > box.left + 4;
      const fitsRight = px + 6 + w < box.right - 4;
      const anchor = prefer === "end" ? (fitsLeft ? "end" : "start") : fitsRight ? "start" : "end";
      text(plot, px + (anchor === "start" ? 6 : -6), box.bottom - 8, label, { class: `skewt-name ${cls}`, "text-anchor": anchor });
    };
    if (!narrow) {
      if (Number.isFinite(p0.dewPointC)) nameAt(p0.dewPointC, "Dew point", "skewt-name-dew", "end");
      nameAt(p0.temperatureC, "Temperature", "skewt-name-temp", "start");
    }

    // Horizontal marks, named on the right; labels solved so they never overlap.
    const marks: { id: string; z: number; label: string; cls: string }[] = [];
    if (this.launch.elevationM !== null && inside(this.launch.elevationM)) marks.push({ id: "launch", z: this.launch.elevationM, label: `Launch ${heightLabel(this.launch.elevationM)} MSL`, cls: "skewt-mark-launch" });
    if (s.marks.top && inside(s.marks.top.heightM)) marks.push({ id: "top", z: s.marks.top.heightM, label: `Top of lift ${heightLabel(s.marks.top.heightM)}`, cls: "skewt-mark-top" });
    if (inside(s.marks.cloudBaseM)) marks.push({ id: "base", z: s.marks.cloudBaseM, label: `☁ Cloud base ${heightLabel(s.marks.cloudBaseM)}`, cls: "skewt-mark-base" });
    if (inside(s.freezingLevelM) && s.freezingLevelM > s.modelElevationM + 50) marks.push({ id: "freezing", z: s.freezingLevelM, label: `Freezing level ${heightLabel(s.freezingLevelM)}`, cls: "skewt-mark-freezing" });
    for (const m of marks) el("line", { x1: box.left, x2: box.right, y1: y(pAt(m.z)), y2: y(pAt(m.z)), class: m.cls }, svg);

    const zoneLabels: { id: string; z: number; label: string; cls: string }[] = [];
    if (zoneTop !== null && zoneTop > s.modelElevationM + 150) {
      zoneLabels.push({ id: "zone", z: (s.modelElevationM + Math.min(zoneTop, zTop)) / 2, label: "Thermal zone", cls: "skewt-zone-label" });
    }
    for (const layer of s.inversions) {
      if (layer.topM - layer.baseM < 60 || !inside(layer.baseM)) continue;
      zoneLabels.push({ id: `lid-${layer.baseM}`, z: (layer.baseM + Math.min(layer.topM, zTop)) / 2, label: layer.grounded ? "Ground inversion" : layer.kind === "inversion" ? "Inversion" : "Stable layer", cls: "skewt-lid-label" });
    }
    for (const layer of s.cloudLayers) {
      if (!inside(layer.baseM)) continue;
      zoneLabels.push({ id: `cloud-${layer.baseM}`, z: (layer.baseM + Math.min(layer.topM, zTop)) / 2, label: "Cloud layer", cls: "skewt-cloud-label" });
    }

    const labelLayer = el("g", {}, svg);
    const place = (items: typeof marks, xPos: number, anchor: "start" | "end", above: boolean, reservedY: number[] = []) => {
      const solved = solveVerticalLabels(
        items.map((m) => ({ id: m.id, trueY: y(pAt(m.z)) + (above ? -5 : 4) })),
        { minGapPx: 15, topY: box.top + 12, bottomY: box.bottom - 22 },
      );
      for (const sol of solved) {
        // Mark labels have priority over layer names. The two text columns
        // overlap horizontally on phones, even when each column is spaced well.
        if (reservedY.some((yy) => Math.abs(yy - sol.y) < 15)) continue;
        const m = items.find((i) => i.id === sol.id)!;
        text(labelLayer, xPos, sol.y, m.label, { class: `skewt-label ${m.cls}-text`, "text-anchor": anchor });
      }
      return solved.map((sol) => sol.y);
    };
    const markLabelY = place(marks, box.right - 6, "end", true);
    place(zoneLabels, box.left + 6, "start", false, markLabelY);

    // Full barb feathers represent 10 kt or 5 m/s; speed labels use mph or km/h.
    const windX = box.right + (narrow ? 16 : 20);
    text(svg, box.right + (narrow ? 26 : 34), box.top - 8, unitLabel("wind"), { class: "tick", "text-anchor": "middle" });
    // A balloon reports many levels: draw a barb only where it has room.
    let lastBarbY = Infinity;
    for (const p of s.points) {
      if (p.windSpeedMps === null || p.windDirectionDeg === null) continue;
      const yy = y(p.windHeightM === undefined ? p.pressureHpa : pAt(p.windHeightM));
      if (yy < box.top + 12 || lastBarbY - yy < 15) continue;
      lastBarbY = yy;
      drawBarb(svg, windX, yy, p.windSpeedMps * (metric ? 2 : KT), p.windDirectionDeg);
      text(svg, windX + (narrow ? 20 : 28), yy + 4, String(Math.round(convertQuantity(p.windSpeedMps, "wind")!)), { class: "tick", "text-anchor": "end" });
    }

    // Temperature scale along the bottom.
    for (const t of temperatureTicks) {
      const xx = x(t, g.pBottom);
      if (xx < box.left + 8 || xx > box.right - 8) continue;
      text(svg, xx, box.bottom + 16, `${Math.round(convertQuantity(t, "temperature")!)}°`, { class: "tick", "text-anchor": "middle" });
    }
    text(svg, (box.left + box.right) / 2, H - 4, `Temperature ${unitLabel("temperature")} · Barbs ${metric ? "2.5/5/25 m/s" : "5/10/50 kt"}`, { class: "tick", "text-anchor": "middle" });

    // Hover: the air at any height in plain words.
    const cross = el("line", { x1: box.left, x2: box.right, class: "crosshair", visibility: "hidden" }, svg);
    const hit = el("rect", { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (event) => this.hover(event, svg, g, cross, W));
    hit.addEventListener("pointerleave", () => {
      cross.setAttribute("visibility", "hidden");
      this.tooltip.hidden = true;
    });

    host.append(svg, this.tooltip);
  }

  private hover(event: PointerEvent, svg: SVGSVGElement, g: Geometry, cross: SVGLineElement, W: number) {
    const s = this.sounding!;
    const box = svg.getBoundingClientRect();
    const scale = W / box.width;
    const yy = (event.clientY - box.top) * scale;
    const p = pOf(g, yy);
    const z = heightAtPressure(s.points, p);
    if (z < s.modelElevationM) return;
    cross.setAttribute("y1", String(yy));
    cross.setAttribute("y2", String(yy));
    cross.setAttribute("visibility", "visible");
    const env = environmentAtHeight(s.points, z);
    const wind = windAtHeight(s.points, z);
    const parcel = [...s.parcel].sort((a, b) => Math.abs(a.heightM - z) - Math.abs(b.heightM - z))[0];
    const spread = env.temperatureC - env.dewPointC;
    const rows: [string, string][] = [["Temperature", formatQuantity(env.temperatureC, "temperature", 1)]];
    if (Number.isFinite(env.dewPointC)) rows.push(["Dew point", `${formatQuantity(env.dewPointC, "temperature", 1)} · ${spread <= 1 ? "saturated: cloud" : spread <= 3 ? "moist" : "dry"}`]);
    if (wind) rows.push(["Wind", wind.speedMps * MPH < 2 ? "calm" : `${compassPoint(wind.directionDeg)} ${formatQuantity(wind.speedMps, "wind")}`]);
    let note = "";
    if (s.marks.zoneTopM !== null && parcel) {
      note = parcel.buoyancyC > 0.2
        ? `Parcel +${convertQuantity(parcel.buoyancyC, "temperatureDelta")!.toFixed(1)} ${unitLabel("temperature")} · Rising`
        : parcel.buoyancyC < -0.2
          ? `Parcel −${convertQuantity(Math.abs(parcel.buoyancyC), "temperatureDelta")!.toFixed(1)} ${unitLabel("temperature")} · Capped`
          : "Neutral parcel · Thermal ceiling";
    }
    const tip = this.tooltip;
    tip.replaceChildren();
    const head = document.createElement("div");
    head.className = "tt-time";
    head.textContent = `${heightLabel(z)} MSL · ${formatQuantity(p, "pressure")}`;
    tip.appendChild(head);
    for (const [label, value] of rows) {
      const r = document.createElement("div");
      r.className = "tt-row";
      const a = document.createElement("span");
      a.textContent = label;
      const b = document.createElement("strong");
      b.textContent = value;
      r.append(a, b);
      tip.appendChild(r);
    }
    if (note) {
      const n = document.createElement("div");
      n.className = "tt-note";
      n.textContent = note;
      tip.appendChild(n);
    }
    tip.hidden = false;
    const hostBox = this.host.getBoundingClientRect();
    const left = event.clientX - hostBox.left + 16;
    tip.style.left = `${Math.max(0, Math.min(left, hostBox.width - 240))}px`;
    tip.style.top = `${Math.max(0, event.clientY - hostBox.top - 20)}px`;
  }
}

function drawBarb(parent: Element, cx: number, cy: number, speedKt: number, directionDeg: number) {
  const g = el("g", { transform: `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`, class: "skewt-barb" }, parent);
  const { staff, flags, calm } = barbPaths(speedKt, directionDeg);
  if (calm) {
    el("circle", { r: 3.5, class: "skewt-barb-calm" }, g);
    return;
  }
  el("path", { d: staff }, g);
  for (const f of flags) el("path", { d: f, class: f.endsWith("Z") ? "skewt-pennant" : "" }, g);
}
