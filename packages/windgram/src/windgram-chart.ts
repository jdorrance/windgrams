import {
  convertQuantity,
  defaultQuantityDigits,
  fahrenheitToCelsius,
  formatQuantity,
  knotsToMps,
  unitLabel,
  type UnitSystem,
} from "./windgram-format.ts";
import { CALM_RADIUS, CLOUD_PATH, SNOWFLAKE_PATH, WING_PATH, windBarbGlyph, windgramCloudScale } from "./windgram-glyphs.ts";
import { displayedBarbs, layoutWindgramMarks, type PlacedTemperatureLabel } from "./windgram-label-layout.ts";
import { WINDGRAM_STABILITY, WINDGRAM_STABLE_COLOR, stabilityRange } from "./windgram-stability.ts";
import {
  visibleHeightAnchors,
  visibleWindgramHourIndices,
  type WindgramCloud,
  type WindgramView,
} from "./windgram-view.ts";


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

const styleTag = (stylesheet?: string) => stylesheet ? `<style>${stylesheet}</style>` : '';

function cloudGlyph(cloud: WindgramCloud, scale: number, system: UnitSystem) {
  const effective = cloud.kind === 'effective';
  return `<g class="wg-cloud-symbol" data-cloud-kind="${effective ? 'effective' : 'potential'}" transform="translate(${fmt(cloud.x)} ${fmt(cloud.y)}) scale(${fmt(scale)})"><title>${escape(`${effective ? 'Effective cloud limit (v1)' : 'Potential cloud base (surface LCL)'}; ${altitude(cloud.baseM, system)} ${unitLabel("elevation", system)} MSL`)}</title><path d="${CLOUD_PATH}" class="${effective ? 'wg-cloud-effective' : 'wg-cloud-potential'}"/></g>`;
}

function renderTemperatureLabelsSvg(labels: readonly PlacedTemperatureLabel[]): string {
  return labels
    .map(
      ({ temperatureF, valueText, box, textX, textY, freezing }) =>
        `<g class="wg-temperature-label" data-temperature-f="${temperatureF}"><rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${box.width}" height="${box.height}" rx="2" class="wg-temperature-back"/>${text(textX, textY, valueText, `text-anchor="middle" class="wg-temperature${freezing ? " wg-temperature-freezing" : ""}"`)}</g>`,
    )
    .join("");
}

function heightAxisHeader(view: WindgramView, system: UnitSystem) {
  const x = view.left - 8;
  return text(x, 16, `${unitLabel("elevation", system)} MSL`, 'text-anchor="end" class="wg-axis-unit"') +
    text(x, 36, "Lift w*", 'text-anchor="end" class="wg-lift"') +
    text(x, 49, unitLabel("lift", system), 'text-anchor="end" class="wg-axis-unit"');
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
  options: { idPrefix?: string; stylesheet?: string } = {},
): string {
  const system = view.unitSystem;
  const id = identifier(options.idPrefix ?? "windgram-height-axis");
  return `<svg xmlns="${SVG_NS}" id="${id}" viewBox="0 0 ${view.left} ${fmt(view.height)}" width="${view.left}" height="${fmt(view.height)}" aria-hidden="true" focusable="false" class="windgram${view.compact ? " windgram-compact" : ""} windgram-height-axis">${styleTag(options.stylesheet)}<rect width="${view.left}" height="${fmt(view.height)}" fill="${WINDGRAM_STABLE_COLOR}"/>${heightAxisHeader(view, system)}${heightAxisLabels(view, system)}<line x1="${view.left - 0.7}" x2="${view.left - 0.7}" y1="${view.top}" y2="${fmt(view.bottom)}" stroke="#eeebff" stroke-width="1"/>${text(view.left - 8, view.bottom + 38, `${view.compact ? "Sfc" : "Surface"} ${unitLabel("temperature", system)}`, 'text-anchor="end" class="wg-axis-unit"')}</svg>`;
}

export function renderWindgramSvg(
  view: WindgramView,
  options: { idPrefix?: string; stylesheet?: string } = {},
): string {
  const system = view.unitSystem;
  const id = identifier(options.idPrefix ?? "windgram");
  const right = view.left + view.plotWidth;
  const labelX = (x: number) => Math.max(view.left + 12, Math.min(right - 12, x));
  const visibleHours = new Set(visibleWindgramHourIndices({
    hours: view.timeAxis.map(tick => ({ x: labelX(tick.x) })), compact: view.compact,
  }));
  // Cloud outlines show the published parcel base or effective limit.
  const clouds = view.clouds.filter((cloud) => cloud.kind === "potential" || cloud.kind === "effective");
  const cloudScale = windgramCloudScale(view);
  const { barbs, labels } = layoutWindgramMarks(view, cloudScale, clouds,
    displayedBarbs(view, new Set(view.hours.map((_, i) => i))));
  const parts: string[] = [
    styleTag(options.stylesheet),
    `<defs><clipPath id="${id}-plot"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}"/></clipPath><pattern id="${id}-missing" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#a7a4c0"/><path d="M0 0L8 8M-2 6L2 10M6-2L10 2" stroke="#77758f" stroke-width="1"/></pattern><pattern id="${id}-humidity" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0L8 8M0 8L8 0" fill="none" stroke="#fff" stroke-width=".8" opacity=".75"/></pattern><pattern id="${id}-model-cloud" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M-3 3L3-3M0 12L12 0M9 15L15 9" fill="none" stroke="#fff" stroke-width=".7" opacity=".55"/></pattern></defs>`,
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
      : view.timeAxis.length ? [{ x: view.left, width: view.plotWidth }] : [];
  for (const span of uncovered) {
    parts.push(
      `<rect x="${fmt(span.x)}" y="${view.top}" width="${fmt(span.width)}" height="${fmt(view.plotHeight)}" fill="url(#${id}-missing)" data-forecast-unavailable=""><title>Forecast unavailable for these hours in this run</title></rect>`,
    );
    if (span.width >= 64) parts.push(text(span.x + span.width / 2, view.top + view.plotHeight / 2, "Unavailable", 'text-anchor="middle" class="wg-unavailable"'));
  }
  for (const band of view.cloudBands) {
    const label = band.kind === "humidity" ? "Relative humidity above 94%: likely cloud layer" : "Model cloud fraction at least 30%";
    parts.push(
      `<rect x="${fmt(band.x)}" y="${fmt(band.y)}" width="${fmt(band.width)}" height="${fmt(band.height)}" fill="${band.kind === "humidity" ? `url(#${id}-humidity)` : `url(#${id}-model-cloud)`}" data-cloud-band="${band.kind}"><title>${label}</title></rect>`,
    );
  }
  for (const hour of view.timeAxis) parts.push(`<line x1="${fmt(hour.x)}" x2="${fmt(hour.x)}" y1="${view.top}" y2="${fmt(view.bottom)}" class="wg-hourline"/>`);
  for (const anchor of view.anchors) parts.push(`<line x1="${view.left}" x2="${fmt(right)}" y1="${fmt(anchor.y)}" y2="${fmt(anchor.y)}" class="wg-grid"/>`);
  for (const series of view.series) {
    if (series.bandPath) parts.push(`<path d="${escape(series.bandPath)}" fill="${escape(series.color)}" opacity=".16" data-ensemble-band="${escape(series.key)}"/>`);
    if (series.path) {
      parts.push(
        `<path d="${escape(series.path)}" fill="none" stroke="${escape(series.color)}" stroke-width="${series.key === "usableLiftTopM" ? view.presentation.strokes.lift : 1}"${series.dash ? ` stroke-dasharray="${escape(series.dash)}"` : ""} opacity="${series.key === "usableLiftTopM" ? 1 : 0.55}" data-height-series="${escape(series.key)}"><title>${escape(series.label)}</title></path>`,
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
    const geometry = windBarbGlyph(barb, view.presentation, system);
    const color = barb.speedKt < 9 ? "#78ff78" : "#ffffff";
    const reference = barb.surface
      ? `Model surface · 10 m above model ground (${formatQuantity(view.modelElevationM, "elevation", undefined, system)} MSL)`
      : `${formatQuantity(barb.heightM, "elevation", undefined, system)} MSL · ${barb.interpolated ? "Interpolated" : "Model level"}`;
    const windLabel = barb.speedKt === 0 ? 'Calm' : `${barbSpeed(barb.speedKt, system)} from ${degrees(barb.directionDeg)}`;
    const title = `${windLabel} · ${reference}`;
    const shape = geometry.calm
      ? `<circle r="${CALM_RADIUS}" class="wg-barb-rim"/><circle r="${CALM_RADIUS}" class="wg-barb"/>`
      : ["wg-barb-rim", "wg-barb"].map(className =>
        `<path d="${geometry.staff}" class="${className}"/>${geometry.flags.map(flag =>
          `<path d="${flag}" class="${className}"${className === "wg-barb" && flag.endsWith("Z") ? ' style="fill:currentColor"' : ""}/>`
        ).join("")}`
      ).join("");
    parts.push(
      `<g transform="translate(${fmt(barb.x)} ${fmt(barb.y)})" style="color:${color}" class="${barb.interpolated ? "wg-barb-interpolated" : "wg-barb-native"}" data-wind-source="${barb.interpolated ? "interpolated" : "native"}"><title>${escape(title)}</title>${shape}</g>`,
    );
  }
  parts.push(renderTemperatureLabelsSvg(labels));
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
  // Potential cloud-base symbols are outlines so the lapse-rate color stays visible.
  for (const cloud of clouds) parts.push(cloudGlyph(cloud, cloudScale, system));
  parts.push("</g>");
  parts.push(`<rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="none" stroke="#eeebff" stroke-width="1"/>`);
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
    if (hour && view.hasWindWindow) {
      parts.push(
        hour.inWindWindow === null
          ? `<g data-model-wind-window="unknown"><title>Model surface wind direction comparison unavailable or light/calm; launch wind is unknown</title>${text(hour.x, view.bottom + 16, '?', 'text-anchor="middle" fill="#eee" font-size="10"')}</g>`
          : hour.inWindWindow
            ? `<path data-model-wind-window="inside" d="M${fmt(hour.x)} ${fmt(view.bottom + 9)}l4 7h-8Z" fill="none" stroke="#d9e8ff" stroke-width="1.3"><title>Model surface wind direction is inside the saved direction window; launch wind may differ</title></path>`
            : `<circle data-model-wind-window="outside" cx="${fmt(hour.x)}" cy="${fmt(view.bottom + 13)}" r="3" fill="none" stroke="#ffe1cf" stroke-width="1.3"><title>Model surface wind direction is outside the saved direction window; launch wind may differ</title></circle>`,
      );
    }
    if (!visibleHours.has(axisIndex)) continue;
    const x = labelX(tick.x);
    parts.push(text(x, 16, tick.label, 'text-anchor="middle" class="wg-hour wg-hour-top"'));
    parts.push(
      text(
        x,
        36,
        hour?.thermalVelocityMps == null ? "—" : `${Number(convertQuantity(hour.thermalVelocityMps, "lift", system)!.toFixed(system === "metric" ? 1 : 0))}`,
        'text-anchor="middle" class="wg-lift"',
      ),
    );
    parts.push(text(x, view.bottom + 24, tick.label, 'text-anchor="middle" class="wg-hour"'));
    parts.push(
      text(
        x,
        view.bottom + 38,
        hour?.temperatureF == null ? "—" : `${Math.round(temperature(hour.temperatureF, system))}°`,
        'text-anchor="middle" class="wg-surface-temp"',
      ),
    );
  }
  parts.push(
    text(
      view.left - (view.compact ? 8 : 10),
      view.bottom + 38,
      `${view.compact ? "Sfc" : "Surface"} ${unitLabel("temperature", system)}`,
      'text-anchor="end" class="wg-axis-unit"',
    ),
  );
  const referenceTime = view.timeAxis[0]?.validAt ?? view.hours[0]?.validAt;
  const timeZoneLabel = referenceTime
    ? new Intl.DateTimeFormat("en-US", { timeZone: view.timeZone, timeZoneName: "short" })
      .formatToParts(new Date(referenceTime)).find(part => part.type === "timeZoneName")?.value ?? view.timeZone
    : view.timeZone;
  parts.push(text(view.width / 2, view.bottom + 51,
    `${timeZoneLabel} · Wind ${unitLabel("barbWind", system)} · temperature ${unitLabel("temperature", system)}${view.ensemble ? " · median" : ""}`,
    'text-anchor="middle" class="wg-axis-unit wg-footer"'));
  parts.push(
    `<g class="wg-inspector" data-windgram-cursor="" visibility="hidden" aria-hidden="true"><line data-cursor-vertical=""/><line data-cursor-horizontal=""/><circle data-cursor-point="" r="7"/><g data-cursor-readout=""><rect data-cursor-back="" height="47" rx="6" class="wg-inspector-back"/><text x="10" y="20" data-cursor-agl="" class="wg-inspector-agl"/><text x="10" y="36" data-cursor-msl="" class="wg-inspector-msl"/></g></g>`,
  );
  const first = view.timeAxis[0], last = view.timeAxis.at(-1)!;
  const coverage = uncovered.length && firstData && lastData ? ` Forecast available ${firstData.label}–${lastData.label}; hatched hours unavailable.` : !view.hours.length ? " Daylight forecast unavailable in this run." : "";
  const description = `Windgram${first ? ` ${first.label}–${last.label}` : ""} · ${view.timeZone}.${coverage} Height ${unitLabel("elevation", system)} MSL. Wind feathers ${unitLabel("barbWind", system)}. Temperature ${unitLabel("temperature", system)}. Lift ${unitLabel("lift", system)}. Crosshatching: RH >94%. Diagonal hatching: model cloud ≥30%. Dashed cloud outlines: potential surface LCL (v2). Solid cloud outlines: effective cloud limit (v1). Paragliders: ${formatQuantity(1.143, "lift", undefined, system)} sink. ${view.ensemble ? "Ensemble median and uncertainty." : ""}`;
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${fmt(view.width)} ${fmt(view.height)}" role="img" aria-labelledby="${id}-title ${id}-description" class="windgram${view.compact ? " windgram-compact" : ""}"><title id="${id}-title">Wind, temperature and clouds by hour and altitude</title><desc id="${id}-description">${escape(description)}</desc>${parts.join("\n")}</svg>`;
}

/** Reuses the diagnostic data and path geometry, with a compact independent layout. */
export function renderWindgramDiagnosticsSvg(
  view: WindgramView,
  options: { idPrefix?: string; stylesheet?: string } = {},
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
    styleTag(options.stylesheet),
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

export function renderWindgramKey(system: UnitSystem): string {
  const icon = (content: string, width = 35) => `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} 24" width="${width}" height="24" aria-hidden="true">${content}</svg>`;
  const humidity = icon(
    `<rect x="2" y="1" width="31" height="22" rx="2" fill="${WINDGRAM_STABLE_COLOR}"/><path d="M4 3L22 21M13 3L31 21M4 21L22 3M13 21L31 3" stroke="#fff" stroke-width="1"/>`,
  );
  const modelCloud = icon(`<rect x="2" y="1" width="31" height="22" rx="2" fill="${WINDGRAM_STABLE_COLOR}"/><path d="M4 15L16 3M8 21L26 3M20 21L31 10" fill="none" stroke="#fff" stroke-width=".7" opacity=".55"/>`);
  const potential = icon(`<path d="${CLOUD_PATH}" transform="translate(17 20) scale(.55)" fill="none" stroke="#7773bc" stroke-width="1.7" stroke-dasharray="4 3"/>`);
  const wind = icon('<path d="M9 21L9 3M9 3L20 7M9 8L15 10" fill="none" stroke="#355963" stroke-width="1"/>');
  const freezing = icon(
    `<path d="M1 12H34" stroke="#237d92" stroke-width="1.5" stroke-dasharray="5 3"/><path d="${SNOWFLAKE_PATH}" transform="translate(17 12)" fill="none" stroke="#237d92"/>`,
  );
  const lift = icon(`<path d="${WING_PATH}" transform="translate(17 12) scale(.7)" fill="none" stroke="#134ac4" stroke-width="1.8"/>`);
  const feathers = system === "metric" ? "half 2.5 / full 5 / flag 25 m/s" : "half 5 / full 10 / flag 50 kt";
  const greenLimit = formatQuantity(knotsToMps(9), "barbWind", system === "metric" ? 2 : 0, system);
  return `<div class="windgram-legend"><div class="windgram-legend-ramp"><strong>Lapse rate · ${unitLabel("lapseRate", system)}</strong>${WINDGRAM_STABILITY.map(({ color }, i) => `<span class="windgram-legend-chip" style="--chip:${color}">${stabilityRange(i, system)}</span>`).join("")}</div><div class="windgram-legend-symbols"><span>${wind}Wind · ${feathers}</span><span>${humidity}RH &gt;94%</span><span>${modelCloud}Model cloud ≥30%</span><span>${potential}Cloud · dashed LCL / solid limit</span><span>${freezing}${formatQuantity(0, "temperature", undefined, system)} freezing level</span><span>${lift}${formatQuantity(1.143, "lift", undefined, system)} sink</span></div><details class="windgram-legend-note"><summary>Chart key</summary><p>Lapse scale: <a href="http://wxtofly.net/windgramexplain.html">WxToFly</a> · ${unitLabel("lapseRate", system)}. Red/orange: rapid cooling. Gray: inversion. Dark hatching: unavailable profile. White crosshatching: RH &gt;94%. Sparse white diagonal hatching: model cloud ≥30%. Dashed cloud outlines: potential surface LCL (v2). Solid cloud outlines: effective cloud limit (v1). Snowflakes: lowest freezing level. Green wind: &lt;${greenLimit}; white: ≥${greenLimit}. Faint barbs: interpolated. Paragliders: ${formatQuantity(1.143, "lift", undefined, system)} sink ceiling. Blue line: ${formatQuantity(1, "lift", undefined, system)} sink ceiling. Dashed amber line: thermal top (parcel). Teal dashed line: effective cloud limit. Lift w*: ${unitLabel("lift", system)}. Temperature: ${unitLabel("temperature", system)}. Height: ${unitLabel("elevation", system)} MSL.</p><p>Direction marks compare the 10 m model-surface wind with a saved direction window: triangle inside, circle outside, ? unavailable or light/calm. Local launch wind can differ. Surface temperature is at 2 m above model ground. Surface rows and symbols are placed along the chart edge for readability.</p></details></div>`;
}
