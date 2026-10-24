import {
  convertQuantity,
  defaultQuantityDigits,
  fahrenheitToCelsius,
  formatQuantity,
  getUnitSystem,
  knotsToMps,
  unitLabel,
  type UnitSystem,
} from "./units.ts";
import { DEFAULT_STYLESHEET } from "@azohra/meteo.briefing/meteogram";
import { barbPaths } from "./wind-barb.ts";
import { mountWindgramInspector } from "./windgram-inspector.ts";
import { displayedBarbs, placeTemperatureLabels } from "./windgram-label-layout.ts";
import { WINDGRAM_STABILITY, WINDGRAM_STABLE_COLOR, stabilityRange } from "./windgram-stability.ts";
import {
  visibleHeightAnchors,
  visibleWindgramHourIndices,
  type WindgramCloud,
  type WindgramView,
} from "./windgram-view.ts";

export { mountWindgramInspector };

const SVG_NS = "http://www.w3.org/2000/svg";
const fmt = (value: number) => Number(value.toFixed(2));
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const identifier = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "-");
const text = (x: number, y: number, value: string, attrs = "") =>
  `<text x="${fmt(x)}" y="${fmt(y)}" ${attrs}>${escape(value)}</text>`;
const altitude = (m: number, system: UnitSystem) => Math.round(convertQuantity(m, "elevation", system)!).toLocaleString("en-US");
const temperature = (f: number, system: UnitSystem) => convertQuantity(fahrenheitToCelsius(f), "temperature", system)!;
const barbSpeed = (knots: number, system: UnitSystem) => formatQuantity(knotsToMps(knots), "barbWind", undefined, system);
const degrees = (direction: number) =>
  `${["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(direction / 22.5) % 16]} ${Math.round(direction) % 360}°`;

const STYLES = `
.windgram { font-family: ui-sans-serif, system-ui, sans-serif; }
.windgram text { fill: #fff; font-size: 13px; }
.windgram .wg-axis { fill: #f5f3ff; font-size: 12px; }
.windgram .wg-axis-feet { font-size: 13px; font-weight: 650; }
.windgram .wg-axis-unit { fill: #eceaff; font-size: 10px; letter-spacing: .04em; }
.windgram .wg-grid { stroke: #f7f1ff; stroke-width: .8; opacity: .4; }
.windgram .wg-hourline { stroke: #fff; stroke-width: .6; opacity: .16; }
.windgram .wg-lift { fill: #ffff7c; font-size: 14px; font-weight: 700; }
.windgram .wg-hour { font-size: 14px; font-weight: 600; }
.windgram .wg-surface-temp { fill: #fff0d4; font-size: 12px; }
.windgram .wg-isotherm { fill: none; stroke: #6b5481; stroke-width: .7; opacity: .7; }
.windgram .wg-isotherm-freezing { fill: none; stroke: #44f3ef; stroke-width: 1.25; stroke-dasharray: 6 4; }
.windgram .wg-temperature { font-size: 14px; font-weight: 650; fill: #fff; }
.windgram .wg-temperature-back { fill: #6968bf; stroke: #fff; stroke-opacity: .12; stroke-width: .6; }
.windgram .wg-temperature-freezing { fill: #d4ffff; }
.windgram .wg-launch { fill: #fff; font-size: 11px; font-weight: 650; paint-order: stroke; stroke: #5b567f; stroke-width: 3px; stroke-linejoin: round; }
.windgram .wg-unavailable { fill: #fff; font-size: 10px; font-weight: 650; paint-order: stroke; stroke: #77758f; stroke-width: 3px; }
.windgram .wg-barb { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
.windgram .wg-barb-native { opacity: 1; }
.windgram .wg-barb-interpolated { opacity: .72; }
.windgram .wg-barb-rim { fill: none; stroke: #51486e; stroke-opacity: .35; stroke-width: 2.1; stroke-linecap: round; stroke-linejoin: round; }
.windgram .wg-cloud { fill: #fff; stroke: #eef0ff; stroke-width: .7; }
.windgram .wg-cloud-potential { fill: #b4abe8; fill-opacity: .14; stroke: #fff; stroke-width: 1.4; stroke-dasharray: 3 2; }
.windgram .wg-wing { fill: none; stroke: #0739cc; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.windgram .wg-freezing-mark { fill: #7274bc; stroke: #80fffa; stroke-width: 1.2; }
.windgram .wg-inspector { pointer-events: none; }
.windgram .wg-inspector line { stroke: #14223f; stroke-width: 1; stroke-dasharray: 3 4; }
.windgram .wg-inspector circle { fill: none; stroke: #17253e; stroke-width: 2; }
.windgram .wg-inspector-back { fill: #182c43; fill-opacity: .96; stroke: #fff; stroke-opacity: .7; stroke-width: .75; }
.windgram .wg-inspector-agl { fill: #fff; font-size: 15px; font-weight: 750; }
.windgram .wg-inspector-msl { fill: #e4edf4; font-size: 10px; }
.windgram-compact .wg-hour, .windgram-compact .wg-lift, .windgram-compact .wg-temperature { font-size: 12px; }
.windgram-compact .wg-axis-feet, .windgram-compact .wg-surface-temp { font-size: 11px; }
${WINDGRAM_STABILITY.map(({ className, color }) => `.windgram .meteo-gram-stab-${className} { fill: ${color}; }`).join("\n")}
`;

// The flat bottom is the indicated cloud base; every lobe is above it.
const CLOUD_PATH = "M-20 0C-27 0-28-10-20-13C-20-21-8-24-3-17C4-28 19-23 20-14C30-14 32 0 22 0Z";
const SNOWFLAKE_PATH = "M-4 0H4M-2-3.46L2 3.46M-2 3.46L2-3.46";
const WING_PATH = "M-12 0Q0-16 12 0M-10-1Q0-9 10-1M-9 0L-1 7M9 0L1 7M-1 7L0 10L1 7";

function cloudGlyph(cloud: WindgramCloud, scale: number, system: UnitSystem) {
  return `<g class="wg-cloud-symbol" data-cloud-kind="potential" transform="translate(${fmt(cloud.x)} ${fmt(cloud.y)}) scale(${fmt(scale)})"><title>${escape(`Potential cloud base (LCL); ${altitude(cloud.baseM, system)} ${unitLabel("elevation", system)} MSL`)}</title><path d="${CLOUD_PATH}" class="wg-cloud-potential"/></g>`;
}

function renderTemperatureLabelsSvg(
  view: WindgramView,
  cloudScale: number,
  clouds: readonly WindgramCloud[],
  barbs: readonly WindgramView["barbs"][number][],
  system: UnitSystem,
): string {
  return placeTemperatureLabels(view, cloudScale, clouds, barbs, system)
    .map(
      ({ temperatureF, valueText, box, textX, textY, freezing }) =>
        `<g class="wg-temperature-label" data-temperature-f="${temperatureF}"><rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${box.width}" height="${box.height}" rx="2" class="wg-temperature-back"/>${text(textX, textY, valueText, `text-anchor="middle" class="wg-temperature${freezing ? " wg-temperature-freezing" : ""}"`)}</g>`,
    )
    .join("");
}

function heightAxisHeader(view: WindgramView, system: UnitSystem) {
  return (
    text(view.left - (view.compact ? 8 : 12), view.compact ? 31 : 27, "Lift w*", 'text-anchor="end" class="wg-lift"') +
    text(view.left - (view.compact ? 8 : 12), view.compact ? 44 : 43, unitLabel("lift", system), 'text-anchor="end" class="wg-axis-unit"') +
    (view.compact ? text(view.left - 8, view.top - 12, `${unitLabel("elevation", system)} MSL`, 'text-anchor="end" class="wg-axis-unit"') : "")
  );
}

function heightAxisLabels(view: WindgramView, system: UnitSystem) {
  return visibleHeightAnchors(view)
    .map((anchor) => {
      const tick = `<path d="M${view.left - 5} ${fmt(anchor.y)}h5" stroke="#fff" stroke-width="1"/>`;
      return (
        tick +
        (view.compact
          ? text(view.left - 9, anchor.y + 4, altitude(anchor.heightM, system), 'text-anchor="end" class="wg-axis-feet"')
          : text(
              view.left - 10,
              anchor.y - 3,
              anchor.pressureHpa === null ? "Ground" : formatQuantity(anchor.pressureHpa, "pressure", undefined, system),
              'text-anchor="end" class="wg-axis"',
            ) +
            text(view.left - 10, anchor.y + 12, `${altitude(anchor.heightM, system)} ${unitLabel("elevation", system)}`, 'text-anchor="end" class="wg-axis"'))
      );
    })
    .join("");
}

/** Optional stationary altitude scale for an independently zoomed chart. */
export function renderWindgramHeightAxisSvg(
  view: WindgramView,
  options: { idPrefix?: string } = {},
): string {
  const system = view.unitSystem;
  const id = identifier(options.idPrefix ?? "windgram-height-axis");
  return `<svg xmlns="${SVG_NS}" id="${id}" viewBox="0 0 ${view.left} ${fmt(view.height)}" width="${view.left}" height="${fmt(view.height)}" aria-hidden="true" focusable="false" class="windgram${view.compact ? " windgram-compact" : ""} windgram-height-axis"><style>${STYLES}</style><rect width="${view.left}" height="${fmt(view.height)}" fill="${WINDGRAM_STABLE_COLOR}"/>${heightAxisHeader(view, system)}${heightAxisLabels(view, system)}<line x1="${view.left - 0.7}" x2="${view.left - 0.7}" y1="${view.top}" y2="${fmt(view.bottom)}" stroke="#eeebff" stroke-width="1.4"/>${text(view.left - 8, view.bottom + (view.compact ? 42 : 53), `${view.compact ? "Sfc" : "Surface"} ${unitLabel("temperature", system)}`, 'text-anchor="end" class="wg-axis-unit"')}</svg>`;
}

export function renderWindgramSvg(
  view: WindgramView,
  options: { idPrefix?: string } = {},
): string {
  const system = view.unitSystem;
  const id = identifier(options.idPrefix ?? "windgram");
  const right = view.left + view.plotWidth;
  const visibleHours = new Set(visibleWindgramHourIndices({ hours: view.timeAxis, compact: view.compact }));
  const glyphHours = new Set<number>();
  for (const [i, hour] of view.hours.entries()) {
    if (
      !view.compact ||
      (hour.x >= view.left + 20 &&
        hour.x <= right - 20 &&
        (!glyphHours.size || hour.x - view.hours[Array.from(glyphHours).at(-1)!].x >= 38))
    ) {
      glyphHours.add(i);
    }
  }
  const barbs = displayedBarbs(view, glyphHours);
  // Cloud icons mean potential LCL; actual cloud evidence stays in full-width bands.
  const clouds = view.clouds.filter((cloud) => cloud.kind === "potential");
  const cloudScale = view.compact ? Math.max(0.2, Math.min(0.58, view.columnWidth / 60)) : Math.max(0.64, Math.min(1, view.columnWidth / 64));
  const parts: string[] = [
    `<style>${STYLES}</style>`,
    `<defs><clipPath id="${id}-plot"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}"/></clipPath><pattern id="${id}-missing" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#a7a4c0"/><path d="M0 0L8 8M-2 6L2 10M6-2L10 2" stroke="#77758f" stroke-width="1"/></pattern><pattern id="${id}-humidity" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0L8 8M0 8L8 0" fill="none" stroke="#fff" stroke-width=".8" opacity=".75"/></pattern></defs>`,
    `<rect width="${fmt(view.width)}" height="${fmt(view.height)}" rx="6" fill="${WINDGRAM_STABLE_COLOR}"/>`,
    heightAxisHeader(view, system),
    view.compact ? "" : text(right + 12, view.top - 14, `${unitLabel("elevation", system)} MSL`, 'class="wg-axis-unit"'),
    `<g clip-path="url(#${id}-plot)"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="${WINDGRAM_STABLE_COLOR}"/>`,
  ];
  for (const field of view.fields) {
    parts.push(
      `<path d="${escape(field.path)}" class="${escape(field.className)}" fill-rule="evenodd"${field.className === "windgram-missing" ? ` fill="url(#${id}-missing)"` : ""}/>`,
    );
  }
  const firstData = view.hours[0], lastData = view.hours.at(-1);
  const uncovered =
    firstData && lastData
      ? [
          { x: view.left, width: firstData.x - view.columnWidth / 2 - view.left },
          { x: lastData.x + view.columnWidth / 2, width: right - lastData.x - view.columnWidth / 2 },
        ].filter(span => span.width > 0.01)
      : [];
  for (const span of uncovered) {
    parts.push(
      `<rect x="${fmt(span.x)}" y="${view.top}" width="${fmt(span.width)}" height="${fmt(view.plotHeight)}" fill="url(#${id}-missing)" data-forecast-unavailable=""><title>Forecast unavailable for these hours in this run</title></rect>`,
    );
    if (span.width >= 64) parts.push(text(span.x + span.width / 2, view.top + view.plotHeight / 2, "Unavailable", 'text-anchor="middle" class="wg-unavailable"'));
  }
  for (const band of view.cloudBands) {
    const label = band.kind === "humidity" ? "Relative humidity above 94%: likely cloud layer" : "Model cloud fraction at least 30%";
    parts.push(
      `<rect x="${fmt(band.x)}" y="${fmt(band.y)}" width="${fmt(band.width)}" height="${fmt(band.height)}" fill="${band.kind === "humidity" ? `url(#${id}-humidity)` : "#fff"}"${band.kind === "model" ? ' opacity=".2"' : ""} data-cloud-band="${band.kind}"><title>${label}</title></rect>`,
    );
  }
  for (const hour of view.timeAxis) parts.push(`<line x1="${fmt(hour.x)}" x2="${fmt(hour.x)}" y1="${view.top}" y2="${fmt(view.bottom)}" class="wg-hourline"/>`);
  for (const anchor of view.anchors) parts.push(`<line x1="${view.left}" x2="${fmt(right)}" y1="${fmt(anchor.y)}" y2="${fmt(anchor.y)}" class="wg-grid"/>`);
  for (const series of view.series) {
    if (series.bandPath) parts.push(`<path d="${escape(series.bandPath)}" fill="${escape(series.color)}" opacity=".16" data-ensemble-band="${escape(series.key)}"/>`);
    if (series.path) {
      parts.push(
        `<path d="${escape(series.path)}" fill="none" stroke="${escape(series.color)}" stroke-width="${series.key === "usableLiftTopM" ? 1.8 : 1.25}"${series.dash ? ` stroke-dasharray="${escape(series.dash)}"` : ""} opacity=".85"><title>${escape(series.label)}</title></path>`,
      );
    }
  }
  for (const contour of view.contours) {
    const pathString =
      contour.segments && contour.segments.length
        ? contour.segments.map((s) => `M${fmt(s.x1)},${fmt(s.y1)}L${fmt(s.x2)},${fmt(s.y2)}`).join("")
        : contour.path;
    parts.push(
      `<path d="${escape(pathString)}" class="${contour.temperatureF === 32 ? "wg-isotherm-freezing" : "wg-isotherm"}" data-temperature-f="${contour.temperatureF}"/>`,
    );
  }
  if (view.launch) {
    parts.push(
      `<line x1="${view.left}" x2="${fmt(right)}" y1="${fmt(view.launch.y)}" y2="${fmt(view.launch.y)}" stroke="#413b62" stroke-width="1.1" stroke-dasharray="3 4"/>`,
    );
  }
  for (const barb of barbs) {
    const geometry = barbPaths(system === "metric" ? knotsToMps(barb.speedKt) * 2 : barb.speedKt, barb.directionDeg);
    const color = barb.speedKt < 9 ? "#78ff78" : "#ffffff";
    const title = `${barbSpeed(barb.speedKt, system)} from ${degrees(barb.directionDeg)} · ${formatQuantity(barb.heightM, "elevation", undefined, system)} MSL · ${barb.interpolated ? "Interpolated" : "Model level"}`;
    const shape = geometry.calm
      ? '<circle r="3" class="wg-barb"/>'
      : `<path d="${geometry.staff}" class="wg-barb-rim"/><path d="${geometry.staff}" class="wg-barb"/>${geometry.flags.map((flag) => `<path d="${flag}" class="wg-barb"${flag.endsWith("Z") ? ' style="fill:currentColor"' : ""}/>`).join("")}`;
    parts.push(
      `<g transform="translate(${fmt(barb.x)} ${fmt(barb.y)})${view.compact ? " scale(.7)" : ""}" style="color:${color}" class="${barb.interpolated ? "wg-barb-interpolated" : "wg-barb-native"}" data-wind-source="${barb.interpolated ? "interpolated" : "native"}"><title>${escape(title)}</title>${shape}</g>`,
    );
  }
  parts.push(renderTemperatureLabelsSvg(view, cloudScale, clouds, barbs, system));
  for (const freeze of view.freezing) {
    parts.push(
      `<path d="${SNOWFLAKE_PATH}" transform="translate(${fmt(freeze.x)} ${fmt(freeze.y)})" class="wg-freezing-mark"><title>Lowest freezing level · ${formatQuantity(0, "temperature", undefined, system)}</title></path>`,
    );
  }
  for (const wing of view.wings) {
    parts.push(
      `<path d="${WING_PATH}" transform="translate(${fmt(wing.x)} ${fmt(wing.y)})" class="wg-wing"><title>Paraglider ceiling · ${formatQuantity(1.143, "lift", undefined, system)} sink · ${formatQuantity(wing.heightM, "elevation", undefined, system)} MSL</title></path>`,
    );
  }
  if (view.launch) parts.push(text(view.left + 8, Math.max(view.top + 15, view.launch.y - 7), view.launch.label, 'class="wg-launch"'));
  // Potential cloud-base symbols are outlines so the lapse-rate color stays visible.
  for (const cloud of clouds) parts.push(cloudGlyph(cloud, cloudScale, system));
  parts.push("</g>");
  parts.push(`<rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="none" stroke="#eeebff" stroke-width="1.4"/>`);
  parts.push(heightAxisLabels(view, system));
  if (!view.compact) {
    for (const anchor of visibleHeightAnchors(view)) {
      parts.push(`<path d="M${fmt(right)} ${fmt(anchor.y)}h5" stroke="#fff" stroke-width="1"/>`);
      parts.push(text(right + 10, anchor.y + 4, altitude(anchor.heightM, system), 'class="wg-axis-feet"'));
    }
  }
  for (const [axisIndex, tick] of view.timeAxis.entries()) {
    const hour = tick.hourIndex === null ? null : view.hours[tick.hourIndex];
    parts.push(`<line x1="${fmt(tick.x)}" x2="${fmt(tick.x)}" y1="${fmt(view.bottom)}" y2="${fmt(view.bottom + 5)}" stroke="#fff"/>`);
    if (hour && hour.inWindWindow !== null) {
      parts.push(
        hour.inWindWindow
          ? `<path d="M${fmt(hour.x)} ${fmt(view.bottom + 9)}l4 7h-8Z" fill="#afffb1"><title>Surface wind direction is in the launch window</title></path>`
          : `<circle cx="${fmt(hour.x)}" cy="${fmt(view.bottom + 13)}" r="3" fill="none" stroke="#ffe1cf" stroke-width="1.3"><title>Surface wind direction is outside the launch window</title></circle>`,
      );
    }
    if (!visibleHours.has(axisIndex)) continue;
    if (view.compact) parts.push(text(tick.x, 17, tick.label, 'text-anchor="middle" class="wg-hour wg-hour-top"'));
    parts.push(
      text(
        tick.x,
        view.compact ? 38 : 36,
        hour?.thermalVelocityMps == null ? "—" : `${Number(convertQuantity(hour.thermalVelocityMps, "lift", system)!.toFixed(system === "metric" ? 1 : 0))}`,
        'text-anchor="middle" class="wg-lift"',
      ),
    );
    parts.push(text(tick.x, view.bottom + (view.compact ? 27 : 35), tick.label, 'text-anchor="middle" class="wg-hour"'));
    parts.push(
      text(
        tick.x,
        view.bottom + (view.compact ? 42 : 53),
        hour?.temperatureF == null ? "—" : `${Math.round(temperature(hour.temperatureF, system))}°`,
        'text-anchor="middle" class="wg-surface-temp"',
      ),
    );
  }
  parts.push(
    text(
      view.left - (view.compact ? 8 : 10),
      view.bottom + (view.compact ? 42 : 53),
      `${view.compact ? "Sfc" : "Surface"} ${unitLabel("temperature", system)}`,
      'text-anchor="end" class="wg-axis-unit"',
    ),
  );
  if (view.compact) {
    parts.push(
      text(
        view.width / 2,
        view.bottom + 59,
        `Wind ${unitLabel("barbWind", system)} · temperature ${unitLabel("temperature", system)}${view.ensemble ? " · median" : ""}`,
        'text-anchor="middle" class="wg-axis-unit"',
      ),
    );
    parts.push(text(view.width / 2, view.bottom + 73, view.timeZone, 'text-anchor="middle" class="wg-axis-unit"'));
  } else {
    parts.push(
      text(
        view.left + view.plotWidth / 2,
        view.bottom + 75,
        `${view.timeZone} · wind ${unitLabel("barbWind", system)} · temperature ${unitLabel("temperature", system)}${view.ensemble ? " · ensemble median" : ""}`,
        'text-anchor="middle" class="wg-axis-unit"',
      ),
    );
  }
  parts.push(
    `<g class="wg-inspector" data-windgram-cursor="" visibility="hidden" aria-hidden="true"><line data-cursor-vertical=""/><line data-cursor-horizontal=""/><circle data-cursor-point="" r="7"/><g data-cursor-readout=""><rect data-cursor-back="" height="47" rx="6" class="wg-inspector-back"/><text x="10" y="20" data-cursor-agl="" class="wg-inspector-agl"/><text x="10" y="36" data-cursor-msl="" class="wg-inspector-msl"/></g></g>`,
  );
  const first = view.timeAxis[0], last = view.timeAxis.at(-1)!;
  const coverage = uncovered.length && firstData && lastData ? ` Forecast available ${firstData.label}–${lastData.label}; hatched hours unavailable.` : "";
  const description = `Windgram${first ? ` ${first.label}–${last.label}` : ""} · ${view.timeZone}.${coverage} Height ${unitLabel("elevation", system)} MSL. Wind feathers ${unitLabel("barbWind", system)}. Temperature ${unitLabel("temperature", system)}. Lift ${unitLabel("lift", system)}. Crosshatching: RH >94%. Pale bands: model cloud. Outlined clouds: potential LCL. Paragliders: ${formatQuantity(1.143, "lift", undefined, system)} sink. ${view.ensemble ? "Ensemble median and uncertainty." : ""}`;
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${fmt(view.width)} ${fmt(view.height)}" role="img" aria-labelledby="${id}-title ${id}-description" class="windgram${view.compact ? " windgram-compact" : ""}"><title id="${id}-title">Wind, temperature and clouds by hour and altitude</title><desc id="${id}-description">${escape(description)}</desc>${parts.join("\n")}</svg>`;
}

/** Reuses the diagnostic data and path geometry, with a compact independent layout. */
export function renderWindgramDiagnosticsSvg(
  view: WindgramView,
  options: { idPrefix?: string } = {},
): string {
  const system = view.unitSystem;
  const id = identifier(options.idPrefix ?? "windgram-diagnostics");
  const left = view.compact ? 102 : view.left;
  const plotWidth = view.diagnosticColumnWidth * Math.max(1, view.hours.length);
  const width = view.compact ? left + plotWidth + 88 : view.width;
  const rowPitch = 45, firstTop = 26, plotRight = left + plotWidth;
  const footer = view.sourceNote ? 58 : 34;
  const height = firstTop + view.diagnostics.length * rowPitch + footer;
  const parts = [
    `<style>${DEFAULT_STYLESHEET}\n.wg-diagnostics text{font-family:ui-sans-serif,system-ui,sans-serif}.wg-diagnostics .wg-diagnostic-label{fill:#263f48;font-size:12px;font-weight:650}.wg-diagnostics .wg-diagnostic-unit{fill:#4a6068;font-size:10px}.wg-diagnostics .wg-diagnostic-scale{fill:#4a6068;font-size:10px}.wg-diagnostics .wg-diagnostic-note{fill:#4a6068;font-size:10px}</style>`,
    `<rect width="${fmt(width)}" height="${height}" fill="#fffdf8"/>`,
  ];
  for (const [index, strip] of view.diagnostics.entries()) {
    const top = firstTop + index * rowPitch;
    const kind = strip.unit === "kPa" ? "pressure" : strip.unit === "mm/h" ? "rainRate" : null;
    const displayUnit = kind ? unitLabel(kind, system) : strip.unit;
    const displayValue = (value: number) =>
      kind
        ? Number(convertQuantity(value * (kind === "pressure" ? 10 : 1), kind, system)!.toFixed(defaultQuantityDigits(kind, system)))
        : Math.round(value * 10) / 10;
    const dx = left - view.diagnosticLeft, dy = top - strip.top;
    const bottom = top + strip.height;
    parts.push(`<rect x="${left}" y="${top}" width="${fmt(plotWidth)}" height="${strip.height}" class="meteo-gram-strip-frame" stroke-width=".7"/>`);
    parts.push(`<line x1="${left}" x2="${fmt(plotRight)}" y1="${fmt(top + strip.height / 2)}" y2="${fmt(top + strip.height / 2)}" stroke="#73818a" stroke-dasharray="2 4" opacity=".22"/>`);
    parts.push(text(left - 10, top + 10, strip.label, 'text-anchor="end" class="wg-diagnostic-label"'));
    parts.push(text(left - 10, top + 23, displayUnit, 'text-anchor="end" class="wg-diagnostic-unit"'));
    parts.push(`<g transform="translate(${fmt(dx)} ${fmt(dy)})">`);
    if (strip.cells) {
      for (const cell of strip.cells) {
        if (cell) {
          parts.push(
            `<rect x="${fmt(cell.x)}" y="${strip.top}" width="${fmt(cell.width)}" height="${strip.height}" class="${escape(cell.className)}"${cell.opacity === undefined ? "" : ` opacity="${cell.opacity}"`}/>`,
          );
        }
      }
    }
    if (strip.rows) {
      for (const row of strip.rows) {
        for (const cell of row.cells) {
          if (cell) {
            parts.push(
              `<rect x="${fmt(cell.x)}" y="${fmt(row.top)}" width="${fmt(cell.width)}" height="${fmt(row.height)}" class="${escape(cell.className)}"${cell.opacity === undefined ? "" : ` opacity="${cell.opacity}"`}/>`,
            );
          }
        }
        parts.push(text(view.diagnosticLeft + plotWidth + 8, row.top + row.height - 1, row.label, 'class="wg-diagnostic-scale"'));
      }
    }
    if (strip.areaPath) parts.push(`<path d="${escape(strip.areaPath)}" class="${escape(strip.className)}-area" opacity=".18"/>`);
    if (strip.bandPath) parts.push(`<path d="${escape(strip.bandPath)}" class="${escape(strip.className)}-band" opacity=".2"/>`);
    if (strip.linePath) parts.push(`<path d="${escape(strip.linePath)}" class="${escape(strip.className)}" fill="none" stroke-width="1.7"/>`);
    for (const dot of strip.dots ?? []) parts.push(`<circle cx="${fmt(dot.x)}" cy="${fmt(dot.y)}" r="2" class="${escape(strip.className)}-dot"/>`);
    for (const dot of strip.degradedDots ?? []) parts.push(`<circle cx="${fmt(dot.x)}" cy="${fmt(dot.y)}" r="2" class="${escape(strip.className)}-degraded-dot"/>`);
    if (strip.measuredToX != null) {
      parts.push(
        `<rect x="${fmt(strip.measuredToX)}" y="${strip.top}" width="${fmt(Math.max(0, view.diagnosticLeft + plotWidth - strip.measuredToX))}" height="${strip.height}" class="meteo-gram-strip-pending"/>`,
      );
    }
    parts.push("</g>");
    if (!strip.rows) {
      parts.push(text(plotRight + 8, top + 5, `${displayValue(strip.maximum)}`, 'class="wg-diagnostic-scale"'));
      parts.push(text(plotRight + 8, bottom + 2, `${displayValue(strip.minimum)}`, 'class="wg-diagnostic-scale"'));
    }
    if (strip.sourceLabel) parts.push(text(left + 5, bottom + 12, strip.sourceLabel, 'class="wg-diagnostic-note"'));
  }
  const timeY = firstTop + view.diagnostics.length * rowPitch + 8;
  for (const [index, hour] of view.hours.entries()) {
    parts.push(text(left + view.diagnosticColumnWidth * (index + 0.5), timeY, hour.label, 'text-anchor="middle" class="wg-diagnostic-label"'));
  }
  if (view.sourceNote) parts.push(text(left, timeY + 24, view.sourceNote, 'class="wg-diagnostic-note"'));
  if (!view.diagnostics.length) parts.push(text(left, 25, "Weather details unavailable.", 'class="wg-diagnostic-note"'));
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${fmt(width)} ${height}" role="img" aria-labelledby="${id}-title" class="meteo-gram wg-diagnostics"><title id="${id}-title">Supplemental weather diagnostics aligned to the windgram hours</title>${parts.join("\n")}</svg>`;
}

export function renderWindgramKey(system: UnitSystem = getUnitSystem()): string {
  const icon = (content: string, width = 35) => `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} 24" width="${width}" height="24" aria-hidden="true">${content}</svg>`;
  const humidity = icon(
    '<rect x="2" y="1" width="31" height="22" rx="2" fill="#7b7de6"/><path d="M4 3L22 21M13 3L31 21M4 21L22 3M13 21L31 3" stroke="#fff" stroke-width="1"/>',
  );
  const potential = icon(`<path d="${CLOUD_PATH}" transform="translate(17 20) scale(.55)" fill="none" stroke="#7773bc" stroke-width="1.7" stroke-dasharray="4 3"/>`);
  const wind = icon('<path d="M9 21L9 3M9 3L20 7M9 8L15 10" fill="none" stroke="#355963" stroke-width="1.4"/>');
  const freezing = icon(
    `<path d="M1 12H34" stroke="#237d92" stroke-width="1.5" stroke-dasharray="5 3"/><path d="${SNOWFLAKE_PATH}" transform="translate(17 12)" fill="none" stroke="#237d92"/>`,
  );
  const lift = icon(`<path d="${WING_PATH}" transform="translate(17 12) scale(.7)" fill="none" stroke="#134ac4" stroke-width="1.8"/>`);
  const feathers = system === "metric" ? "half 2.5 / full 5 / flag 25 m/s" : "half 5 / full 10 / flag 50 kt";
  const greenLimit = formatQuantity(knotsToMps(9), "barbWind", system === "metric" ? 2 : 0, system);
  return `<div class="windgram-legend"><div class="windgram-legend-ramp"><strong>Lapse rate · ${unitLabel("lapseRate", system)}</strong>${WINDGRAM_STABILITY.map(({ color }, i) => `<span class="windgram-legend-chip" style="--chip:${color}">${stabilityRange(i, system)}</span>`).join("")}</div><div class="windgram-legend-symbols"><span>${wind}Wind · ${feathers}</span><span>${humidity}RH &gt;94%</span><span>${potential}Potential cloud base</span><span>${freezing}${formatQuantity(0, "temperature", undefined, system)} freezing level</span><span>${lift}${formatQuantity(1.143, "lift", undefined, system)} sink</span></div><details class="windgram-legend-note"><summary>Chart key</summary><p>Palette: <a href="http://wxtofly.net/windgramexplain.html">WxToFly</a>, converted to ${unitLabel("lapseRate", system)}. Red/orange: rapid cooling. Gray: inversion. Dark hatching: unavailable profile. White crosshatching: RH &gt;94%. Pale bands: model cloud ≥30%. Outlined clouds: potential LCL. Snowflakes: lowest freezing level. Green wind: &lt;${greenLimit}; white: ≥${greenLimit}. Faint barbs: interpolated. Paragliders: ${formatQuantity(1.143, "lift", undefined, system)} sink ceiling. Blue line: ${formatQuantity(1, "lift", undefined, system)} sink ceiling. Lift w*: ${unitLabel("lift", system)}. Temperature: ${unitLabel("temperature", system)}. Height: ${unitLabel("elevation", system)} MSL.</p></details></div>`;
}
