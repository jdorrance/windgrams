import { DEFAULT_STYLESHEET } from "@azohra/meteo.briefing/meteogram";
import { barbPaths } from "./wind-barb.ts";
import { heightToY, readWindgram, yToHeight, type WindgramCloud, type WindgramView } from "./windgram-view.ts";

const FT = 3.280839895;
const SVG_NS = "http://www.w3.org/2000/svg";
const fmt = (value: number) => Number(value.toFixed(2));
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const identifier = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "-");
const text = (x: number, y: number, value: string, attrs = "") => `<text x="${fmt(x)}" y="${fmt(y)}" ${attrs}>${escape(value)}</text>`;
const feet = (m: number) => Math.round(m * FT).toLocaleString("en-US");
const degrees = (direction: number) => `${["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(direction / 22.5) % 16]} ${Math.round(direction) % 360}°`;

const STABILITY = [
  ["very-unstable", "#ff3d3d", "≤ −3"],
  ["unstable", "#ff9900", "−3 to −2.5"],
  ["conditional-strong", "#ffbbff", "−2.5 to −2"],
  ["conditional", "#ccbfff", "−2 to −1.5"],
  ["near-neutral", "#faf0e6", "−1.5 to −1.2"],
  ["stable", "#8080e6", "−1.2 to 0"],
  ["inverted", "#cccccc", "0 to 0.5"],
  ["strong-inversion", "#999999", "> 0.5"],
] as const;

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
${STABILITY.map(([name, color]) => `.windgram .meteo-gram-stab-${name} { fill: ${color}; }`).join("\n")}
`;

// The flat bottom is the indicated cloud base; every lobe is above it.
const CLOUD_PATH = "M-20 0C-27 0-28-10-20-13C-20-21-8-24-3-17C4-28 19-23 20-14C30-14 32 0 22 0Z";
const WING_PATH = "M-12 0Q0-16 12 0M-10-1Q0-9 10-1M-9 0L-1 7M9 0L1 7M-1 7L0 10L1 7";

function cloudGlyph(cloud: WindgramCloud, scale: number) {
  const label = cloud.kind === "model" ? `Model cloud${cloud.coverPercent == null ? "" : `, ${Math.round(cloud.coverPercent)}%`}`
    : cloud.kind === "humidity" ? "Cloud inferred from relative humidity above 95%" : "Potential cumulus: thermal reaches condensation level";
  return `<g class="wg-cloud-symbol" data-cloud-kind="${cloud.kind}" transform="translate(${fmt(cloud.x)} ${fmt(cloud.y)}) scale(${fmt(scale)})"><title>${escape(`${label}; base ${feet(cloud.baseM)} ft MSL`)}</title><path d="${CLOUD_PATH}" class="${cloud.kind === "potential" ? "wg-cloud-potential" : "wg-cloud"}"/></g>`;
}

interface LabelBox { x: number; y: number; width: number; height: number }
const overlaps = (a: LabelBox, b: LabelBox, padding = 0) => a.x < b.x + b.width + padding && a.x + a.width > b.x - padding && a.y < b.y + b.height + padding && a.y + a.height > b.y - padding;

/** Pick nearby spaces on the same isotherm; suppress a label when no space remains. */
function temperatureLabels(view: WindgramView, cloudScale: number) {
  const occupied: LabelBox[] = view.clouds.map((c) => ({ x: c.x - 29 * cloudScale, y: c.y - 25 * cloudScale, width: 58 * cloudScale, height: 27 * cloudScale }));
  const winds: LabelBox[] = view.barbs.map((b) => {
    const direction = b.directionDeg * Math.PI / 180;
    const tipX = b.x + Math.sin(direction) * 22, tipY = b.y - Math.cos(direction) * 22;
    return { x: Math.min(b.x, tipX) - 7, y: Math.min(b.y, tipY) - 7, width: Math.abs(b.x - tipX) + 14, height: Math.abs(b.y - tipY) + 14 };
  });
  const labels: string[] = [];
  for (const contour of view.contours) {
    const segments = [...contour.path.matchAll(/M([^ML]+)L([^ML]+)/g)].map((match) => {
      const [x1, y1] = match[1].split(",").map(Number);
      const [x2, y2] = match[2].split(",").map(Number);
      return { x1, y1, x2, y2 };
    });
    for (const point of contour.labels) {
    const value = `${Math.round(contour.temperatureF)}°`;
    const width = Math.max(28, value.length * 8 + 10), height = 22;
    // Follow the nearest branch of the actual contour when shifting sideways.
    // Altitude alone is insufficient: an isotherm can slope steeply over time.
    const offsets = [0, -view.columnWidth * .24, view.columnWidth * .24];
    const positions = offsets.flatMap((offset) => {
      if (offset === 0) return [point];
      const x = point.x + offset;
      const candidates = segments.filter((s) => s.x1 !== s.x2 && x >= Math.min(s.x1, s.x2) && x <= Math.max(s.x1, s.x2))
        .map((s) => s.y1 + (s.y2 - s.y1) * (x - s.x1) / (s.x2 - s.x1)).sort((a, b) => Math.abs(a - point.y) - Math.abs(b - point.y));
      return candidates.length && Math.abs(candidates[0] - point.y) < 24 ? [{ x, y: candidates[0] }] : [];
    });
    const boxes = positions.map((position) => ({ x: position.x - width / 2, y: position.y - height / 2, width, height }))
      .filter((box) => box.x >= view.left + 3 && box.x + width <= view.left + view.plotWidth - 3 && box.y >= view.top + 3 && box.y + height <= view.bottom - 3 && !occupied.some((other) => overlaps(box, other, 4)));
    if (!boxes.length) continue;
    const box = boxes.find((candidate) => !winds.some((wind) => overlaps(candidate, wind, 1))) ?? boxes[0];
    occupied.push(box);
    labels.push(`<g class="wg-temperature-label" data-temperature-f="${contour.temperatureF}"><rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${width}" height="${height}" rx="2" class="wg-temperature-back"/>${text(box.x + width / 2, box.y + 16, value, `text-anchor="middle" class="wg-temperature${contour.temperatureF === 32 ? " wg-temperature-freezing" : ""}"`)}</g>`);
    }
  }
  return labels.join("");
}

export function renderWindgramSvg(view: WindgramView, options: { idPrefix?: string } = {}): string {
  const id = identifier(options.idPrefix ?? "windgram");
  const right = view.left + view.plotWidth;
  const cloudScale = Math.max(.64, Math.min(1, view.columnWidth / 64));
  const parts: string[] = [
    `<style>${STYLES}</style>`,
    `<defs><clipPath id="${id}-plot"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}"/></clipPath><pattern id="${id}-missing" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#a7a4c0"/><path d="M0 0L8 8M-2 6L2 10M6-2L10 2" stroke="#77758f" stroke-width="1"/></pattern></defs>`,
    `<rect width="${fmt(view.width)}" height="${fmt(view.height)}" rx="6" fill="#7977ce"/>`,
    text(view.left - 12, 27, "Lift w*", 'text-anchor="end" class="wg-lift"'),
    text(view.left - 12, 43, "m/s", 'text-anchor="end" class="wg-axis-unit"'),
    text(right + 12, view.top - 14, "FEET MSL", 'class="wg-axis-unit"'),
    `<g clip-path="url(#${id}-plot)"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="#8080e6"/>`,
  ];
  for (const field of view.fields) parts.push(`<path d="${escape(field.path)}" class="${escape(field.className)}" fill-rule="evenodd"${field.className === "windgram-missing" ? ` fill="url(#${id}-missing)"` : ""}/>`);
  for (const band of view.cloudBands) parts.push(`<rect x="${fmt(band.x)}" y="${fmt(band.y)}" width="${fmt(band.width)}" height="${fmt(band.height)}" fill="#fff" opacity="${band.kind === "model" ? ".14" : ".08"}" data-cloud-band="${band.kind}"/>`);
  for (const hour of view.hours) parts.push(`<line x1="${fmt(hour.x)}" x2="${fmt(hour.x)}" y1="${view.top}" y2="${fmt(view.bottom)}" class="wg-hourline"/>`);
  for (const anchor of view.anchors) parts.push(`<line x1="${view.left}" x2="${fmt(right)}" y1="${fmt(anchor.y)}" y2="${fmt(anchor.y)}" class="wg-grid"/>`);
  for (const series of view.series) {
    if (series.bandPath) parts.push(`<path d="${escape(series.bandPath)}" fill="${escape(series.color)}" opacity=".16" data-ensemble-band="${escape(series.key)}"/>`);
    if (series.path) parts.push(`<path d="${escape(series.path)}" fill="none" stroke="${escape(series.color)}" stroke-width="${series.key === "usableLiftTopM" ? 1.8 : 1.25}"${series.dash ? ` stroke-dasharray="${escape(series.dash)}"` : ""} opacity=".85"><title>${escape(series.label)}</title></path>`);
  }
  for (const contour of view.contours) parts.push(`<path d="${escape(contour.path)}" class="${contour.temperatureF === 32 ? "wg-isotherm-freezing" : "wg-isotherm"}" data-temperature-f="${contour.temperatureF}"/>`);
  if (view.launch) parts.push(`<line x1="${view.left}" x2="${fmt(right)}" y1="${fmt(view.launch.y)}" y2="${fmt(view.launch.y)}" stroke="#413b62" stroke-width="1.1" stroke-dasharray="3 4"/>`);
  for (const barb of view.barbs) {
    const geometry = barbPaths(barb.speedKt, barb.directionDeg);
    const color = barb.speedKt < 6 ? "#c8ffc8" : barb.speedKt < 9 ? "#78ff78" : "#ffffff";
    const title = `${barb.speedKt.toFixed(1)} kt from ${degrees(barb.directionDeg)} · ${feet(barb.heightM)} ft · ${barb.interpolated ? "interpolated" : "native model level"}`;
    const shape = geometry.calm ? '<circle r="3" class="wg-barb"/>' : `<path d="${geometry.staff}" class="wg-barb-rim"/><path d="${geometry.staff}" class="wg-barb"/>${geometry.flags.map((flag) => `<path d="${flag}" class="wg-barb"${flag.endsWith("Z") ? ' style="fill:currentColor"' : ""}/>`).join("")}`;
    parts.push(`<g transform="translate(${fmt(barb.x)} ${fmt(barb.y)})" style="color:${color}" class="${barb.interpolated ? "wg-barb-interpolated" : "wg-barb-native"}" data-wind-source="${barb.interpolated ? "interpolated" : "native"}"><title>${escape(title)}</title>${shape}</g>`);
  }
  parts.push(temperatureLabels(view, cloudScale));
  for (const freeze of view.freezing) parts.push(`<circle cx="${fmt(freeze.x)}" cy="${fmt(freeze.y)}" r="2.7" class="wg-freezing-mark"><title>Freezing level · 32°F</title></circle>`);
  for (const wing of view.wings) parts.push(`<path d="${WING_PATH}" transform="translate(${fmt(wing.x)} ${fmt(wing.y)})" class="wg-wing"><title>Usable lift top</title></path>`);
  if (view.launch) parts.push(text(view.left + 8, Math.max(view.top + 15, view.launch.y - 7), view.launch.label, 'class="wg-launch"'));
  // Actual clouds are opaque and render after every atmospheric mark.
  for (const cloud of view.clouds) parts.push(cloudGlyph(cloud, cloudScale));
  parts.push("</g>");
  parts.push(`<rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="none" stroke="#eeebff" stroke-width="1.4"/>`);
  const visibleAnchors = view.anchors.filter((anchor, index, all) => index === 0 || (anchor.y - view.top > 20 && all[index - 1].y - anchor.y >= 29));
  for (const anchor of visibleAnchors) {
    parts.push(`<path d="M${view.left - 5} ${fmt(anchor.y)}h5M${fmt(right)} ${fmt(anchor.y)}h5" stroke="#fff" stroke-width="1"/>`);
    parts.push(text(view.left - 10, anchor.y - 3, anchor.pressureHpa === null ? "Ground" : `${Math.round(anchor.pressureHpa)} hPa`, 'text-anchor="end" class="wg-axis"'));
    parts.push(text(view.left - 10, anchor.y + 12, `${Math.round(anchor.heightM).toLocaleString("en-US")} m`, 'text-anchor="end" class="wg-axis"'));
    parts.push(text(right + 10, anchor.y + 4, feet(anchor.heightM), 'class="wg-axis-feet"'));
  }
  for (const hour of view.hours) {
    parts.push(text(hour.x, 36, hour.thermalVelocityMps == null ? "—" : `${Math.round(hour.thermalVelocityMps * 10) / 10}`, 'text-anchor="middle" class="wg-lift"'));
    parts.push(`<line x1="${fmt(hour.x)}" x2="${fmt(hour.x)}" y1="${fmt(view.bottom)}" y2="${fmt(view.bottom + 5)}" stroke="#fff"/>`);
    if (hour.inWindWindow !== null) parts.push(hour.inWindWindow
      ? `<path d="M${fmt(hour.x)} ${fmt(view.bottom + 9)}l4 7h-8Z" fill="#afffb1"><title>Surface wind direction is in the launch window</title></path>`
      : `<circle cx="${fmt(hour.x)}" cy="${fmt(view.bottom + 13)}" r="3" fill="none" stroke="#ffe1cf" stroke-width="1.3"><title>Surface wind direction is outside the launch window</title></circle>`);
    parts.push(text(hour.x, view.bottom + 35, hour.label, 'text-anchor="middle" class="wg-hour"'));
    parts.push(text(hour.x, view.bottom + 53, hour.temperatureF == null ? "—" : `${Math.round(hour.temperatureF)}°`, 'text-anchor="middle" class="wg-surface-temp"'));
  }
  parts.push(text(view.left - 10, view.bottom + 53, "Surface °F", 'text-anchor="end" class="wg-axis-unit"'));
  parts.push(text(view.left + view.plotWidth / 2, view.bottom + 75, `${view.timeZone} · wind in knots · temperatures °F${view.ensemble ? " · ensemble median" : ""}`, 'text-anchor="middle" class="wg-axis-unit"'));
  parts.push(`<g class="wg-inspector" data-windgram-cursor="" visibility="hidden"><line data-cursor-vertical=""/><line data-cursor-horizontal=""/><circle data-cursor-point="" r="7"/></g>`);
  const first = view.hours[0], last = view.hours[view.hours.length - 1];
  const description = `Windgram${first ? ` from ${first.label} to ${last.label}` : ""}, ${view.timeZone}. Pressure and height at left, feet above sea level at right. Vertical spacing expands the lower atmosphere. Wind feathers use knots. Temperature contours use Fahrenheit. White clouds show model or humidity evidence; outlined clouds show potential cumulus. ${view.ensemble ? "Ensemble median with shaded uncertainty bands." : ""}`;
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${fmt(view.width)} ${fmt(view.height)}" role="img" aria-labelledby="${id}-title ${id}-description" class="windgram"><title id="${id}-title">Wind, temperature and clouds by hour and altitude</title><desc id="${id}-description">${escape(description)}</desc>${parts.join("\n")}</svg>`;
}

/** Reuses the diagnostic data and path geometry, with a compact independent layout. */
export function renderWindgramDiagnosticsSvg(view: WindgramView, options: { idPrefix?: string } = {}): string {
  const id = identifier(options.idPrefix ?? "windgram-diagnostics");
  const rowPitch = 45, firstTop = 26, plotRight = view.left + view.plotWidth;
  const footer = view.sourceNote ? 58 : 34;
  const height = firstTop + view.diagnostics.length * rowPitch + footer;
  const parts = [`<style>${DEFAULT_STYLESHEET}\n.wg-diagnostics text{font-family:ui-sans-serif,system-ui,sans-serif}.wg-diagnostics .wg-diagnostic-label{fill:#263f48;font-size:12px;font-weight:650}.wg-diagnostics .wg-diagnostic-unit{fill:#4a6068;font-size:10px}.wg-diagnostics .wg-diagnostic-scale{fill:#4a6068;font-size:10px}.wg-diagnostics .wg-diagnostic-note{fill:#4a6068;font-size:10px}</style>`, `<rect width="${fmt(view.width)}" height="${height}" fill="#fffdf8"/>`];
  for (const [index, strip] of view.diagnostics.entries()) {
    const top = firstTop + index * rowPitch;
    const dx = view.left - view.diagnosticLeft, dy = top - strip.top;
    const bottom = top + strip.height;
    parts.push(`<rect x="${view.left}" y="${top}" width="${fmt(view.plotWidth)}" height="${strip.height}" class="meteo-gram-strip-frame" stroke-width=".7"/>`);
    parts.push(`<line x1="${view.left}" x2="${fmt(plotRight)}" y1="${fmt(top + strip.height / 2)}" y2="${fmt(top + strip.height / 2)}" stroke="#73818a" stroke-dasharray="2 4" opacity=".22"/>`);
    parts.push(text(view.left - 10, top + 10, strip.label, 'text-anchor="end" class="wg-diagnostic-label"'));
    parts.push(text(view.left - 10, top + 23, strip.unit, 'text-anchor="end" class="wg-diagnostic-unit"'));
    parts.push(`<g transform="translate(${fmt(dx)} ${fmt(dy)})">`);
    if (strip.cells) for (const cell of strip.cells) if (cell) parts.push(`<rect x="${fmt(cell.x)}" y="${strip.top}" width="${fmt(cell.width)}" height="${strip.height}" class="${escape(cell.className)}"${cell.opacity === undefined ? "" : ` opacity="${cell.opacity}"`}/>`);
    if (strip.rows) for (const row of strip.rows) {
      for (const cell of row.cells) if (cell) parts.push(`<rect x="${fmt(cell.x)}" y="${fmt(row.top)}" width="${fmt(cell.width)}" height="${fmt(row.height)}" class="${escape(cell.className)}"${cell.opacity === undefined ? "" : ` opacity="${cell.opacity}"`}/>`);
      parts.push(text(view.diagnosticLeft + view.plotWidth + 8, row.top + row.height - 1, row.label, 'class="wg-diagnostic-scale"'));
    }
    if (strip.areaPath) parts.push(`<path d="${escape(strip.areaPath)}" class="${escape(strip.className)}-area" opacity=".18"/>`);
    if (strip.bandPath) parts.push(`<path d="${escape(strip.bandPath)}" class="${escape(strip.className)}-band" opacity=".2"/>`);
    if (strip.linePath) parts.push(`<path d="${escape(strip.linePath)}" class="${escape(strip.className)}" fill="none" stroke-width="1.7"/>`);
    for (const dot of strip.dots ?? []) parts.push(`<circle cx="${fmt(dot.x)}" cy="${fmt(dot.y)}" r="2" class="${escape(strip.className)}-dot"/>`);
    for (const dot of strip.degradedDots ?? []) parts.push(`<circle cx="${fmt(dot.x)}" cy="${fmt(dot.y)}" r="2" class="${escape(strip.className)}-degraded-dot"/>`);
    if (strip.measuredToX != null) parts.push(`<rect x="${fmt(strip.measuredToX)}" y="${strip.top}" width="${fmt(Math.max(0, view.diagnosticLeft + view.plotWidth - strip.measuredToX))}" height="${strip.height}" class="meteo-gram-strip-pending"/>`);
    parts.push("</g>");
    if (!strip.rows) {
      parts.push(text(plotRight + 8, top + 5, `${Math.round(strip.maximum * 10) / 10}`, 'class="wg-diagnostic-scale"'));
      parts.push(text(plotRight + 8, bottom + 2, `${Math.round(strip.minimum * 10) / 10}`, 'class="wg-diagnostic-scale"'));
    }
    if (strip.sourceLabel) parts.push(text(view.left + 5, bottom + 12, strip.sourceLabel, 'class="wg-diagnostic-note"'));
  }
  const timeY = firstTop + view.diagnostics.length * rowPitch + 8;
  for (const hour of view.hours) parts.push(text(hour.x, timeY, hour.label, 'text-anchor="middle" class="wg-diagnostic-label"'));
  if (view.sourceNote) parts.push(text(view.left, timeY + 24, view.sourceNote, 'class="wg-diagnostic-note"'));
  if (!view.diagnostics.length) parts.push(text(view.left, 25, "No supplemental forecast values are available.", 'class="wg-diagnostic-note"'));
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${fmt(view.width)} ${height}" role="img" aria-labelledby="${id}-title" class="meteo-gram wg-diagnostics"><title id="${id}-title">Supplemental weather diagnostics aligned to the windgram hours</title>${parts.join("\n")}</svg>`;
}

export function renderWindgramKey(): string {
  const icon = (content: string, width = 35) => `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} 24" width="${width}" height="24" aria-hidden="true">${content}</svg>`;
  const cloud = icon(`<path d="${CLOUD_PATH}" transform="translate(17 20) scale(.55)" fill="#fff" stroke="#7773bc" stroke-width="1.4"/>`);
  const potential = icon(`<path d="${CLOUD_PATH}" transform="translate(17 20) scale(.55)" fill="none" stroke="#7773bc" stroke-width="1.7" stroke-dasharray="4 3"/>`);
  const wind = icon('<path d="M9 21L9 3M9 3L20 7M9 8L15 10" fill="none" stroke="#355963" stroke-width="1.4"/>');
  const freezing = icon('<path d="M1 12H34" stroke="#237d92" stroke-width="1.5" stroke-dasharray="5 3"/><circle cx="17" cy="12" r="2.5" fill="#fff" stroke="#237d92"/>');
  const lift = icon(`<path d="${WING_PATH}" transform="translate(17 12) scale(.7)" fill="none" stroke="#134ac4" stroke-width="1.8"/>`);
  return `<div class="windgram-legend"><div class="windgram-legend-ramp"><strong>Lapse rate · °C / 1,000 ft</strong>${STABILITY.map(([, color, range]) => `<span class="windgram-legend-chip" style="--chip:${color}">${range}</span>`).join("")}</div><div class="windgram-legend-symbols"><span>${wind}Wind · half 5 / full 10 / flag 50 kt</span><span>${cloud}Model / humidity cloud</span><span>${potential}Potential cumulus</span><span>${freezing}32°F freezing level</span><span>${lift}Usable lift top</span></div><p class="windgram-legend-note">Color shows stability, not flight suitability. Red/orange: fastest cooling with height. Gray: inversion. Hatching: unavailable profile. Cyan dots: lowest freezing crossing. Wind colors: pale green &lt;6 kt, green 6–9 kt, white ≥9 kt. Fainter barbs interpolate between model levels. Filled clouds need model cloud or humidity evidence; outlined clouds indicate potential only. All heights are above sea level.</p></div>`;
}

/** Pointer and keyboard inspection stays in the same nonlinear height coordinates. */
export function mountWindgramInspector(host: HTMLElement, readout: HTMLElement, view: WindgramView): () => void {
  const svg = host.querySelector<SVGSVGElement>("svg.windgram");
  if (!svg || !view.hours.length) return () => {};
  const cursor = svg.querySelector<SVGGElement>("[data-windgram-cursor]");
  const vertical = svg.querySelector<SVGLineElement>("[data-cursor-vertical]");
  const horizontal = svg.querySelector<SVGLineElement>("[data-cursor-horizontal]");
  const point = svg.querySelector<SVGCircleElement>("[data-cursor-point]");
  const originalAttributes = new Map(["tabindex", "role", "aria-label", "aria-describedby"].map((key) => [key, host.getAttribute(key)]));
  const readoutAttributes = new Map(["role", "aria-live", "aria-atomic"].map((key) => [key, readout.getAttribute(key)]));
  host.tabIndex = 0;
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", "Interactive windgram. Left and right arrows change hour; up and down arrows change altitude. Escape clears the selection.");
  if (readout.id) host.setAttribute("aria-describedby", readout.id);
  readout.setAttribute("role", "status");
  readout.setAttribute("aria-live", "polite");
  readout.setAttribute("aria-atomic", "true");
  const instructions = "Hover to inspect · click or tap to pin · arrow keys change hour and height · Escape clears";
  readout.textContent = instructions;
  let active: { hourIndex: number; heightM: number } | null = null;
  let pinned = false;
  let pointerStart: { x: number; y: number; id: number } | null = null;
  let lastText = "";

  const update = (hourIndex: number, heightM: number, keyboard = false) => {
    const reading = readWindgram(view, hourIndex, heightM);
    active = { hourIndex: reading.hourIndex, heightM: reading.heightM };
    const x = view.hours[reading.hourIndex].x, y = heightToY(view, reading.heightM);
    const attr = (element: Element | null, values: Record<string, number>) => { for (const [key, value] of Object.entries(values)) element?.setAttribute(key, String(fmt(value))); };
    attr(vertical, { x1: x, x2: x, y1: view.top, y2: view.bottom });
    attr(horizontal, { x1: view.left, x2: view.left + view.plotWidth, y1: y, y2: y });
    attr(point, { cx: x, cy: y });
    cursor?.setAttribute("visibility", "visible");
    const when = new Intl.DateTimeFormat("en-US", { timeZone: view.timeZone, weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(reading.validAt));
    const title = `${when} · ${feet(reading.heightM)} ft (${Math.round(reading.heightM).toLocaleString("en-US")} m MSL)`;
    const values = [reading.temperatureF == null ? "Temperature unavailable" : `${reading.temperatureF.toFixed(1)}°F`,
      reading.speedKt == null ? "Wind unavailable" : reading.speedKt < .1 ? "Calm" : `${reading.speedKt.toFixed(1)} kt${reading.directionDeg == null ? "" : ` from ${degrees(reading.directionDeg)}`}`,
      reading.speedKt == null ? null : reading.interpolated ? "Interpolated between model levels" : "Native model level",
      reading.gustKt == null ? null : `Surface gust ${Math.round(reading.gustKt)} kt`,
      reading.cloud === "model" ? "Model cloud layer" : reading.cloud === "humidity" ? "Cloud inferred from humidity >95%" : reading.cloud === "potential" ? "Potential cumulus, not confirmed cloud" : null,
      view.ensemble ? "Ensemble median" : null].filter((value): value is string => value !== null);
    const nextText = `${title} · ${values.join(" · ")}`;
    if (nextText !== lastText) {
      const strong = document.createElement("strong");
      strong.textContent = title;
      readout.replaceChildren(strong, document.createTextNode(` · ${values.join(" · ")}`));
      lastText = nextText;
    }
    if (keyboard) {
      // Only reveal a newly selected hour horizontally; focus alone never scrolls.
      const matrix = svg.getScreenCTM();
      if (matrix) {
        const screen = new DOMPoint(x, y).matrixTransform(matrix);
        const rect = host.getBoundingClientRect();
        if (screen.x < rect.left + 32) host.scrollLeft -= rect.left + 32 - screen.x;
        else if (screen.x > rect.right - 32) host.scrollLeft += screen.x - rect.right + 32;
      }
    }
  };
  const location = (event: PointerEvent) => {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    if (position.x < view.left || position.x > view.left + view.plotWidth || position.y < view.top || position.y > view.bottom) return null;
    const hourIndex = Math.max(0, Math.min(view.hours.length - 1, Math.floor((position.x - view.left) / view.columnWidth)));
    const nearest = view.barbs.filter((barb) => barb.hourIndex === hourIndex).sort((a, b) => Math.abs(a.y - position.y) - Math.abs(b.y - position.y))[0];
    return { hourIndex, heightM: nearest && Math.abs(nearest.y - position.y) < 9 ? nearest.heightM : yToHeight(view, position.y) };
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || pinned) return;
    const p = location(event);
    if (p) update(p.hourIndex, p.heightM);
  };
  const onDown = (event: PointerEvent) => { pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId }; };
  const onUp = (event: PointerEvent) => {
    const start = pointerStart;
    pointerStart = null;
    if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) return;
    const p = location(event);
    if (!p) return;
    pinned = true;
    update(p.hourIndex, p.heightM);
  };
  const onCancel = () => { pointerStart = null; };
  const onLeave = () => { if (!pinned) cursor?.setAttribute("visibility", "hidden"); };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      pinned = false; active = null; lastText = "";
      cursor?.setAttribute("visibility", "hidden");
      readout.textContent = instructions;
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    pinned = true;
    let hourIndex = active?.hourIndex ?? view.selectedHourIndex;
    let heightM = active?.heightM ?? view.launch?.heightM ?? view.floorM;
    if (event.key === "ArrowLeft") hourIndex = Math.max(0, hourIndex - 1);
    if (event.key === "ArrowRight") hourIndex = Math.min(view.hours.length - 1, hourIndex + 1);
    if (event.key === "Home") hourIndex = 0;
    if (event.key === "End") hourIndex = view.hours.length - 1;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const heights = view.barbs.filter((barb) => barb.hourIndex === hourIndex).map((barb) => barb.heightM).sort((a, b) => a - b);
      heightM = event.key === "ArrowUp" ? heights.find((height) => height > heightM + 1) ?? heightM : heights.filter((height) => height < heightM - 1).at(-1) ?? heightM;
    }
    update(hourIndex, heightM, true);
  };
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerdown", onDown);
  host.addEventListener("pointerup", onUp);
  host.addEventListener("pointercancel", onCancel);
  host.addEventListener("pointerleave", onLeave);
  host.addEventListener("keydown", onKey);
  return () => {
    host.removeEventListener("pointermove", onMove);
    host.removeEventListener("pointerdown", onDown);
    host.removeEventListener("pointerup", onUp);
    host.removeEventListener("pointercancel", onCancel);
    host.removeEventListener("pointerleave", onLeave);
    host.removeEventListener("keydown", onKey);
    for (const [name, value] of originalAttributes) value === null ? host.removeAttribute(name) : host.setAttribute(name, value);
    for (const [name, value] of readoutAttributes) value === null ? readout.removeAttribute(name) : readout.setAttribute(name, value);
    cursor?.setAttribute("visibility", "hidden");
  };
}
