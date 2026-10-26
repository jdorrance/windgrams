// Windgram scene-graph assembler and compatibility re-exports.
// Composes `windgram-time-axis`, `windgram-scale`, `windgram-sampling`,
// `windgram-geometry`, and `windgram-inspector`.

import type { SiteForecast } from "@azohra/meteo.briefing/contract";
import { componentsToWind } from "@azohra/meteo.briefing/derive";
import { buildMeteogramScene, type HourSampling, type MetricStrip } from "@azohra/meteo.briefing/meteogram";
import type { WindgramLayout, WindgramHour as PublicHour, WindgramOptions } from './scene-types.ts';
export type { WindgramOptions } from './scene-types.ts';
import { publishedLift, publishedWxtoflyLiftTop } from "@windgrams/contracts/published-lift";
import {
  celsiusToFahrenheit,
  convertQuantity,
  finiteScalar,
  formatQuantity,
  legacyMpsToKnots,
  type UnitSystem,
} from "./windgram-format.ts";
import {
  buildStabilityFieldPaths,
  temperatureContours,
  type ContourComponent,
  type ContourSegment,
  type TemperatureContour,
} from "./windgram-geometry.ts";
import { readWindgram, type WindgramReading } from "./windgram-inspector.ts";
import {
  alignedDiagnostics,
  crossings,
  hourSampling,
  linearPath,
  moistLayers,
  sampleHeight,
  stabilityDisplayNodes,
  type Point,
} from "./windgram-sampling.ts";
import {
  buildWindgramVerticalScale,
  heightToY,
  visibleHeightAnchors,
  yToHeight,
  type HeightAnchor,
} from "./windgram-scale.ts";
import { WINDGRAM_STABILITY } from "./windgram-stability.ts";
import {
  buildWindgramTimeLayout,
  daylightSpan,
  formatWindgramHourLabel,
  timeGaps,
  visibleWindgramHourIndices,
  windgramDayHours,
  windgramHours,
  type WindgramTimeTick,
} from "./windgram-time-axis.ts";
import { resolveWindgramPresentation, type WindgramPresentation } from "./windgram-presentation.ts";

export {
  buildStabilityFieldPaths,
  crossings,
  daylightSpan,
  heightToY,
  hourSampling,
  moistLayers,
  readWindgram,
  sampleHeight,
  stabilityDisplayNodes,
  temperatureContours,
  timeGaps,
  visibleHeightAnchors,
  visibleWindgramHourIndices,
  windgramDayHours,
  windgramHours,
  yToHeight,
  type ContourComponent,
  type ContourSegment,
  type HeightAnchor,
  type TemperatureContour,
  type WindgramReading,
  type WindgramTimeTick,
};

export interface WindgramBarb {
  x: number;
  y: number;
  heightM: number;
  hourIndex: number;
  speedKt: number;
  directionDeg: number;
  interpolated: boolean;
  surface: boolean;
}
export type CloudEvidence = "model" | "humidity" | "potential";
export interface WindgramCloud {
  hourIndex: number;
  x: number;
  y: number;
  baseM: number;
  topM: number;
  kind: CloudEvidence;
  coverPercent: number | null;
}
export interface WindgramSeries {
  key: string;
  label: string;
  color: string;
  dash: string | null;
  path: string;
  bandPath: string | null;
}
export interface WindgramHour extends PublicHour {
  temperatureF: number | null;
  gustKt: number | null;
  inWindWindow: boolean | null;
}
export interface WindgramView extends WindgramLayout {
  modelElevationM: number;
  hasWindWindow: boolean;
  presentation: WindgramPresentation;
  anchors: HeightAnchor[];
  hours: WindgramHour[];
  /** Daylight axis includes empty columns outside the selected run's coverage. */
  timeAxis: WindgramTimeTick[];
  fields: { className: string; path: string }[];
  contours: TemperatureContour[];
  barbs: WindgramBarb[];
  clouds: WindgramCloud[];
  cloudBands: { x: number; y: number; width: number; height: number; kind: CloudEvidence; coverPercent: number | null }[];
  freezing: { x: number; y: number; hourIndex: number }[];
  wings: { x: number; y: number; heightM: number; hourIndex: number }[];
  series: WindgramSeries[];
  launch: { y: number; heightM: number; label: string } | null;
  diagnostics: readonly MetricStrip[];
  diagnosticLeft: number;
  diagnosticColumnWidth: number;
  sampling: readonly HourSampling[];
  ensemble: boolean;
  sourceNote: string | null;
  displayInterpolationNote: string;
}
type ProfileHour = SiteForecast["hours"][number];

export function buildWindgramView(profile: SiteForecast, options: WindgramOptions): WindgramView {
  const system = options.unitSystem;
  const hours = windgramHours(profile, options);
  const compact = options.compact ?? false;
  // Use all supplied native heights so focused/full switching retains the same margins.
  const altitudeLabels = [profile.site.modelElevationM, options.launch?.elevationM,
    ...hours.flatMap(hour => hour.levels.map(level => finiteScalar(level.heightM))),
  ].filter((height): height is number => typeof height === "number" && Number.isFinite(height))
    .map(height => `${Math.round(convertQuantity(height, "elevation", system)!).toLocaleString("en-US")}${compact ? "" : system === "metric" ? " m" : " ft"}`);
  const presentation = resolveWindgramPresentation({ compact, widthPx: options.widthPx, altitudeLabels });
  const { left, right, top, columnWidth, plotWidth, dataLeft, before, after, cadence, firstTime, lastTime, emptyTimes } =
    buildWindgramTimeLayout(profile, hours, {
      timeZone: options.timeZone,
      hours: options.hours,
      compact,
      widthPx: options.widthPx,
      presentation,
    });
  const plotHeight = presentation.plotHeight;
  const bottom = top + plotHeight;
  const launchElevationM = finiteScalar(options.launch?.elevationM);
  const { modelFloorM, floorM, topM, anchors } = buildWindgramVerticalScale(profile, hours, {
    compact,
    heightRange: options.heightRange,
    launchElevationM,
    top,
    bottom,
    plotHeight,
  });

  const sampling = hours.map((h) => hourSampling(h, modelFloorM));
  // The library remains the authority for diagnostic semantics and units.
  const diagnosticColumnWidth = compact ? Math.max(44, columnWidth) : columnWidth;
  const diagnosticPlotWidth = diagnosticColumnWidth * Math.max(1, hours.length);
  const scene = buildMeteogramScene(profile, {
    ...options,
    hours,
    widthPx: diagnosticPlotWidth + 120,
    minColumnWidthPx: 1,
    plotHeightPx: 1,
    overlays: {
      stability: false,
      temperature: false,
      wind: false,
      cloudBase: false,
      usableLiftTop: false,
      boundaryLayerTop: false,
      selectedHour: false,
    },
  });
  const labelTime = new Intl.DateTimeFormat("en-US", { timeZone: options.timeZone, hour: "numeric", minute: "2-digit", hour12: true });
  const ensemble = (profile.run.members ?? 0) > 1 || hours.some((h) => typeof h.surface.temperatureC === "object" && h.surface.temperatureC !== null);

  const view: WindgramView = {
    unitSystem: system,
    presentation,
    width: left + plotWidth + right,
    height: presentation.height,
    left,
    top,
    plotWidth,
    plotHeight,
    bottom,
    columnWidth,
    floorM,
    topM,
    ground: { elevationM: launchElevationM ?? modelFloorM, source: launchElevationM === null ? "model" : "launch" },
    modelElevationM: modelFloorM,
    hasWindWindow: Boolean(options.launchWindows?.length),
    timeZone: options.timeZone,
    anchors,
    sampling,
    compact,
    ensemble,
    sourceNote: scene.smokeSource ? `Smoke: ${scene.smokeSource.model} · run ${scene.smokeSource.referenceTime}` : null,
    displayInterpolationNote: "Colours interpolate between layer centres and forecast hours. Contours and faint barbs interpolate between model levels.",
    timeAxis: [],
    hours: hours.map((h, i) => {
      const temp = finiteScalar(h.surface.temperatureC);
      const gust = finiteScalar(h.surface.windGustMps);
      const direction = finiteScalar(h.surface.windDirectionDeg);
      const speed = finiteScalar(h.surface.windSpeedMps);
      const arcs = options.launchWindows;
      const inWindWindow =
        speed === null || speed < 0.5 || direction === null || !arcs?.length
          ? null
          : arcs.some((arc) => (arc.fromDeg <= arc.toDeg ? direction >= arc.fromDeg && direction <= arc.toDeg : direction >= arc.fromDeg || direction <= arc.toDeg));
      return {
        validAt: h.validAt,
        label: formatWindgramHourLabel(h.validAt, labelTime),
        x: dataLeft + columnWidth * (i + 0.5),
        temperatureF: temp === null ? null : celsiusToFahrenheit(temp),
        usableLiftTopM: finiteScalar(publishedLift(h).usableLiftTopM),
        thermalVelocityMps: finiteScalar(publishedLift(h).thermalVelocityMps),
        gustKt: gust === null ? null : legacyMpsToKnots(gust),
        inWindWindow,
      };
    }),
    fields: [],
    contours: [],
    barbs: [],
    clouds: [],
    cloudBands: [],
    freezing: [],
    wings: [],
    series: [],
    launch: null,
    diagnostics: alignedDiagnostics(
      scene.strips.filter((s) => s.key !== "thermalStrength"),
      scene.hourValidAts,
      hours,
      scene.scales.plotLeft,
      diagnosticColumnWidth,
    ),
    diagnosticLeft: scene.scales.plotLeft,
    diagnosticColumnWidth,
    selectedHourIndex: hours.reduce(
      (best, h, i) =>
        (finiteScalar(publishedLift(h).thermalVelocityMps) ?? -1) >
        (finiteScalar(hours[best] ? publishedLift(hours[best]).thermalVelocityMps : null) ?? -1)
          ? i
          : best,
      0,
    ),
  };

  const emptyTick = (time: number, column: number): WindgramTimeTick => ({
    validAt: new Date(time).toISOString(),
    label: formatWindgramHourLabel(time, labelTime),
    x: left + columnWidth * (column + 0.5),
    hourIndex: null,
  });
  view.timeAxis = [
    ...emptyTimes.map((time, i) => emptyTick(time, i)),
    ...Array.from({ length: before }, (_, i) => emptyTick(firstTime - (before - i) * cadence, i)),
    ...view.hours.map(({ validAt, label, x }, hourIndex) => ({ validAt, label, x, hourIndex })),
    ...Array.from({ length: after }, (_, i) => emptyTick(lastTime + (i + 1) * cadence, before + hours.length + i)),
  ];
  if (!hours.length) return view;

  const y = (z: number) => heightToY(view, z);
  if (options.launch && options.launch.elevationM >= floorM && options.launch.elevationM <= topM) {
    view.launch = {
      y: y(options.launch.elevationM),
      heightM: options.launch.elevationM,
      label: `${options.launch.name ?? "Launch"} · ${formatQuantity(options.launch.elevationM, "elevation", undefined, system)} MSL`,
    };
  }

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
    plotLeft: dataLeft,
    plotTop: top,
    plotBottom: bottom,
    plotWidth: hours.length * columnWidth,
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
          view.fields.push({
            className: "windgram-missing",
            path: `M${dataLeft + i * columnWidth},${missingSpan.topY}h${columnWidth}v${missingSpan.baseY - missingSpan.topY}h-${columnWidth}Z`,
          });
        }
        missingSpan = { baseY, topY };
      }
    }
    if (missingSpan && missingSpan.baseY > missingSpan.topY) {
      view.fields.push({
        className: "windgram-missing",
        path: `M${dataLeft + i * columnWidth},${missingSpan.topY}h${columnWidth}v${missingSpan.baseY - missingSpan.topY}h-${columnWidth}Z`,
      });
    }
    // Mask any truncated top extension above the highest valid node.
    const missingHeight = validNodes.length ? bottom - highestValidAlt - top : plotHeight;
    if (missingHeight > 0) {
      view.fields.push({
        className: "windgram-missing",
        path: `M${dataLeft + i * columnWidth},${top}h${columnWidth}v${missingHeight}h-${columnWidth}Z`,
      });
    }
  });
  for (const i of gaps) {
    view.fields.push({
      className: "windgram-missing",
      path: `M${view.hours[i - 1].x + 1},${top}h${columnWidth - 2}v${plotHeight}h-${columnWidth - 2}Z`,
    });
  }
  view.contours = temperatureContours(view, system);

  hours.forEach((h, i) => {
    const sample = sampling[i], x = view.hours[i].x;
    const addBarb = (z: number, interpolated: boolean, surface: boolean) => {
      if (z < floorM || z > topM) return;
      const u = sampleHeight(sample.windU, z), v = sampleHeight(sample.windV, z);
      if (u === null || v === null) return;
      const wind = componentsToWind(u, v);
      view.barbs.push({
        x,
        y: surface ? bottom - 18 : y(z),
        hourIndex: i,
        heightM: z,
        speedKt: legacyMpsToKnots(wind.speedMps),
        directionDeg: wind.directionDeg,
        interpolated,
        surface,
      });
    };
    for (let j = 0; j < sample.windU.length; j++) {
      const a = sample.windU[j], b = sample.windU[j + 1];
      const surface = a.altitudeM === modelFloorM + 10;
      addBarb(a.altitudeM, false, surface);
      const ay = surface ? bottom - 18 : y(a.altitudeM);
      if (b && b.altitudeM - a.altitudeM <= 1000 && ay - y(b.altitudeM) >= 66) addBarb((a.altitudeM + b.altitudeM) / 2, true, false);
    }
    const freezing = crossings(sample.temperatureC, 0)[0];
    if (freezing !== undefined && freezing >= floorM && freezing <= topM) view.freezing.push({ x, y: y(freezing), hourIndex: i });
    const modelCloud = h.levels
      .map((l) => ({ altitudeM: finiteScalar(l.heightM) ?? NaN, value: finiteScalar(l.cloudFractionPercent) ?? NaN }))
      .filter((n) => Number.isFinite(n.altitudeM) && n.altitudeM >= modelFloorM)
      .sort((a, b) => a.altitudeM - b.altitudeM);
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
        view.cloudBands.push({
          x: x - columnWidth / 2,
          width: columnWidth,
          y: y(layer.topM),
          height: y(layer.baseM) - y(layer.topM),
          kind,
          coverPercent,
        });
      }
    }
    const base = finiteScalar(publishedLift(h).cloudBaseM);
    // WxToFly's cloud symbol is the potential LCL, independent of thermal reach.
    if (base !== null && base >= floorM && base <= topM) {
      view.clouds.push({ hourIndex: i, x, y: y(base), baseM: base, topM: base, kind: "potential", coverPercent: null });
    }
    const gliderTop = finiteScalar(publishedWxtoflyLiftTop(h));
    if (i % 3 === 1 && gliderTop !== null && gliderTop > floorM + 10 && gliderTop <= topM) {
      view.wings.push({ x, y: y(gliderTop) + 8, heightM: gliderTop, hourIndex: i });
    }
  });

  for (const [key, label, color, dash] of [
    ["boundaryLayerTopM", "Thermal top (parcel)", "#a56800", "7 5"],
    ["usableLiftTopM", `Usable lift · ${formatQuantity(1, "lift", undefined, system)} sink`, "#134ac4", null],
    ["cloudBaseM", "Potential cloud base", "#426173", "2 5"],
  ] as const) {
    const value = (h: ProfileHour, i: number) =>
      key === "usableLiftTopM" ? view.hours[i].usableLiftTopM : finiteScalar(publishedLift(h)[key]);
    const points = hours.flatMap((h, i): (Point | null)[] => {
      const z = value(h, i);
      const point = z === null || z < floorM || z > topM ? null : { x: view.hours[i].x, y: y(z) };
      return gaps.has(i) ? [null, point] : [point];
    });
    const bandRuns: { lower: Point[]; upper: Point[] }[] = [];
    let run: (typeof bandRuns)[number] | null = null;
    for (let i = 0; i < hours.length; i++) {
      if (gaps.has(i)) run = null;
      const val = publishedLift(hours[i])[key];
      const lo = val && typeof val === "object" ? finiteScalar(val.p25) : null;
      const hi = val && typeof val === "object" ? finiteScalar(val.p75) : null;
      if (lo === null || hi === null) {
        run = null;
        continue;
      }
      if (!run) {
        run = { lower: [], upper: [] };
        bandRuns.push(run);
      }
      run.lower.push({ x: view.hours[i].x, y: y(lo) });
      run.upper.push({ x: view.hours[i].x, y: y(hi) });
    }
    const bandPath =
      bandRuns
        .filter((r) => r.lower.length > 1)
        .map((r) => linearPath([...r.upper, ...r.lower.reverse()]) + "Z")
        .join("") || null;
    view.series.push({ key, label, color, dash, path: linearPath(points), bandPath });
  }
  return view;
}
