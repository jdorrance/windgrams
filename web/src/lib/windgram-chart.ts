import { DEFAULT_STYLESHEET } from "@azohra/meteo.briefing/meteogram";
import { barbPaths } from "./wind-barb.ts";
import { WINDGRAM_STABILITY, WINDGRAM_STABLE_COLOR } from "./windgram-stability.ts";
import { heightToY, readWindgram, visibleHeightAnchors, visibleWindgramHourIndices, yToHeight, type WindgramBarb, type WindgramCloud, type WindgramView } from "./windgram-view.ts";

const FT = 3.280839895;
const SVG_NS = "http://www.w3.org/2000/svg";
const fmt = (value: number) => Number(value.toFixed(2));
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const identifier = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "-");
const text = (x: number, y: number, value: string, attrs = "") => `<text x="${fmt(x)}" y="${fmt(y)}" ${attrs}>${escape(value)}</text>`;
const feet = (m: number) => Math.round(m * FT).toLocaleString("en-US");
const degrees = (direction: number) => `${["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(direction / 22.5) % 16]} ${Math.round(direction) % 360}°`;

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
.windgram-compact .wg-hour, .windgram-compact .wg-lift, .windgram-compact .wg-temperature { font-size: 12px; }
.windgram-compact .wg-axis-feet, .windgram-compact .wg-surface-temp { font-size: 11px; }
${WINDGRAM_STABILITY.map(({ className, color }) => `.windgram .meteo-gram-stab-${className} { fill: ${color}; }`).join("\n")}
`;

// The flat bottom is the indicated cloud base; every lobe is above it.
const CLOUD_PATH = "M-20 0C-27 0-28-10-20-13C-20-21-8-24-3-17C4-28 19-23 20-14C30-14 32 0 22 0Z";
const SNOWFLAKE_PATH = "M-4 0H4M-2-3.46L2 3.46M-2 3.46L2-3.46";
const WING_PATH = "M-12 0Q0-16 12 0M-10-1Q0-9 10-1M-9 0L-1 7M9 0L1 7M-1 7L0 10L1 7";

function cloudGlyph(cloud: WindgramCloud, scale: number) {
  return `<g class="wg-cloud-symbol" data-cloud-kind="potential" transform="translate(${fmt(cloud.x)} ${fmt(cloud.y)}) scale(${fmt(scale)})"><title>${escape(`Potential cloud base (LCL); ${feet(cloud.baseM)} ft MSL; does not imply clouds or reachable lift`)}</title><path d="${CLOUD_PATH}" class="wg-cloud-potential"/></g>`;
}

interface LabelBox { x: number; y: number; width: number; height: number }
const overlaps = (a: LabelBox, b: LabelBox, padding = 0) => a.x < b.x + b.width + padding && a.x + a.width > b.x - padding && a.y < b.y + b.height + padding && a.y + a.height > b.y - padding;

interface ContourPoint { x: number; y: number }
interface ContourSegment { x1: number; y1: number; x2: number; y2: number }
interface ContourComponent {
  segments: ContourSegment[]; candidates: ContourPoint[];
  minX: number; maxX: number; minY: number; maxY: number;
}
const contourPointKey = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
function closestOnSegment(point: ContourPoint, segment: ContourSegment): ContourPoint {
  const dx = segment.x2 - segment.x1, dy = segment.y2 - segment.y1;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared ? Math.max(0, Math.min(1, ((point.x - segment.x1) * dx + (point.y - segment.y1) * dy) / lengthSquared)) : 0;
  return { x: segment.x1 + fraction * dx, y: segment.y1 + fraction * dy };
}

/** The contour builder emits separate marching-square segments. Shared rounded
 * endpoints join one line; inversions and missing-time gaps remain independent. */
function contourComponents(contour: WindgramView["contours"][number]): ContourComponent[] {
  const segments = [...contour.path.matchAll(/M([^ML]+)L([^ML]+)/g)].map((match) => {
    const [x1, y1] = match[1].split(",").map(Number);
    const [x2, y2] = match[2].split(",").map(Number);
    return { x1, y1, x2, y2 };
  });
  const parent = segments.map((_, i) => i);
  const root = (index: number): number => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  const endpoint = new Map<string, number>();
  segments.forEach((segment, i) => {
    for (const key of [contourPointKey(segment.x1, segment.y1), contourPointKey(segment.x2, segment.y2)]) {
      const previous = endpoint.get(key);
      if (previous !== undefined) parent[root(i)] = root(previous);
      else endpoint.set(key, i);
    }
  });
  const groups = new Map<number, ContourComponent>();
  segments.forEach((segment, i) => {
    const id = root(i);
    let group = groups.get(id);
    if (!group) {
      group = { segments: [], candidates: [], minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      groups.set(id, group);
    }
    group.segments.push(segment);
    group.minX = Math.min(group.minX, segment.x1, segment.x2);
    group.maxX = Math.max(group.maxX, segment.x1, segment.x2);
    group.minY = Math.min(group.minY, segment.y1, segment.y2);
    group.maxY = Math.max(group.maxY, segment.y1, segment.y2);
  });
  const components = [...groups.values()];
  for (const candidate of contour.labels) {
    let nearest: { component: ContourComponent; point: ContourPoint; distanceSquared: number } | null = null;
    for (const component of components) for (const segment of component.segments) {
      const point = closestOnSegment(candidate, segment);
      const distanceSquared = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
      if (!nearest || distanceSquared < nearest.distanceSquared) nearest = { component, point, distanceSquared };
    }
    // Physical crossing candidates can differ slightly from the sampled line;
    // never move one onto a distant inversion branch or across a missing hour.
    if (nearest && nearest.distanceSquared <= 36) nearest.component.candidates.push(nearest.point);
  }
  return components;
}

/** Label each connected isotherm once, in a readable space on that same line. */
function temperatureLabels(view: WindgramView, cloudScale: number, clouds = view.clouds, barbs = view.barbs) {
  const occupied: LabelBox[] = clouds.map((c) => ({ x: c.x - 29 * cloudScale, y: c.y - 25 * cloudScale, width: 58 * cloudScale, height: 27 * cloudScale }));
  const winds: LabelBox[] = barbs.map((b) => {
    const direction = b.directionDeg * Math.PI / 180;
    const tipX = b.x + Math.sin(direction) * 22, tipY = b.y - Math.cos(direction) * 22;
    return { x: Math.min(b.x, tipX) - 7, y: Math.min(b.y, tipY) - 7, width: Math.abs(b.x - tipX) + 14, height: Math.abs(b.y - tipY) + 14 };
  });
  const labels: string[] = [];
  for (const contour of view.contours) {
    for (const component of contourComponents(contour)) {
      const value = `${Math.round(contour.temperatureF)}°`;
      const width = view.compact ? Math.max(24, value.length * 7 + 6) : Math.max(28, value.length * 8 + 10);
      const height = view.compact ? 19 : 22;
      const middleX = (component.minX + component.maxX) / 2, middleY = (component.minY + component.maxY) / 2;
      // Geometry candidates cover short branches between source-hour labels and
      // provide another place on the line when the central candidate is cloudy.
      const stride = Math.max(1, Math.ceil(component.segments.length / 40));
      const anchors = [...component.candidates, ...component.segments.filter((_, i) => i % stride === 0)
        .map((segment) => ({ x: (segment.x1 + segment.x2) / 2, y: (segment.y1 + segment.y2) / 2 }))];
      const positions = anchors.flatMap((point) => [0, -view.columnWidth * .24, view.columnWidth * .24].flatMap((offset) => {
        if (offset === 0) return [point];
        const x = point.x + offset;
        const crossings = component.segments.filter((segment) => segment.x1 !== segment.x2 && x >= Math.min(segment.x1, segment.x2) && x <= Math.max(segment.x1, segment.x2))
          .map((segment) => segment.y1 + (segment.y2 - segment.y1) * (x - segment.x1) / (segment.x2 - segment.x1)).sort((a, b) => Math.abs(a - point.y) - Math.abs(b - point.y));
        return crossings.length && Math.abs(crossings[0] - point.y) < 24 ? [{ x, y: crossings[0] }] : [];
      }));
      positions.sort((a, b) => (Math.abs(a.x - middleX) + Math.abs(a.y - middleY) * .15) - (Math.abs(b.x - middleX) + Math.abs(b.y - middleY) * .15));
      const boxes = positions.map((position) => ({ x: position.x - width / 2, y: position.y - height / 2, width, height }))
        .filter((box) => box.x >= view.left + 3 && box.x + width <= view.left + view.plotWidth - 3 && box.y >= view.top + 3 && box.y + height <= view.bottom - 3 && !occupied.some((other) => overlaps(box, other, 4)));
      if (!boxes.length) continue;
      const box = boxes.find((candidate) => !winds.some((wind) => overlaps(candidate, wind, 1))) ?? boxes[0];
      occupied.push(box);
      labels.push(`<g class="wg-temperature-label" data-temperature-f="${contour.temperatureF}"><rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${width}" height="${height}" rx="2" class="wg-temperature-back"/>${text(box.x + width / 2, box.y + (view.compact ? 14 : 16), value, `text-anchor="middle" class="wg-temperature${contour.temperatureF === 32 ? " wg-temperature-freezing" : ""}"`)}</g>`);
    }
  }
  return labels.join("");
}

function heightAxisHeader(view: WindgramView) {
  return text(view.left - (view.compact ? 8 : 12), view.compact ? 31 : 27, "Lift w*", 'text-anchor="end" class="wg-lift"')
    + text(view.left - (view.compact ? 8 : 12), view.compact ? 44 : 43, "m/s", 'text-anchor="end" class="wg-axis-unit"')
    + (view.compact ? text(view.left - 8, view.top - 12, "ft MSL", 'text-anchor="end" class="wg-axis-unit"') : "");
}

function heightAxisLabels(view: WindgramView) {
  return visibleHeightAnchors(view).map((anchor) => {
    const tick = `<path d="M${view.left - 5} ${fmt(anchor.y)}h5" stroke="#fff" stroke-width="1"/>`;
    return tick + (view.compact
      ? text(view.left - 9, anchor.y + 4, feet(anchor.heightM), 'text-anchor="end" class="wg-axis-feet"')
      : text(view.left - 10, anchor.y - 3, anchor.pressureHpa === null ? "Ground" : `${Math.round(anchor.pressureHpa)} hPa`, 'text-anchor="end" class="wg-axis"')
        + text(view.left - 10, anchor.y + 12, `${Math.round(anchor.heightM).toLocaleString("en-US")} m`, 'text-anchor="end" class="wg-axis"'));
  }).join("");
}

/** Optional stationary altitude scale for an independently zoomed chart. */
export function renderWindgramHeightAxisSvg(view: WindgramView, options: { idPrefix?: string } = {}): string {
  const id = identifier(options.idPrefix ?? "windgram-height-axis");
  return `<svg xmlns="${SVG_NS}" id="${id}" viewBox="0 0 ${view.left} ${fmt(view.height)}" width="${view.left}" height="${fmt(view.height)}" aria-hidden="true" focusable="false" class="windgram${view.compact ? " windgram-compact" : ""} windgram-height-axis"><style>${STYLES}</style><rect width="${view.left}" height="${fmt(view.height)}" fill="${WINDGRAM_STABLE_COLOR}"/>${heightAxisHeader(view)}${heightAxisLabels(view)}<line x1="${view.left - .7}" x2="${view.left - .7}" y1="${view.top}" y2="${fmt(view.bottom)}" stroke="#eeebff" stroke-width="1.4"/>${text(view.left - 8, view.bottom + (view.compact ? 42 : 53), view.compact ? "Sfc °F" : "Surface °F", 'text-anchor="end" class="wg-axis-unit"')}</svg>`;
}

/** Avoid colliding wind feathers at small screen sizes without changing samples. */
function displayedBarbs(view: WindgramView, hourIndices: Set<number>): WindgramBarb[] {
  if (!view.compact) return view.barbs;
  const visible: WindgramBarb[] = [];
  for (const hourIndex of hourIndices) {
    const native = view.barbs.filter((barb) => barb.hourIndex === hourIndex && !barb.interpolated && barb.y >= view.top + 20).sort((a, b) => b.y - a.y);
    const selected: WindgramBarb[] = [];
    for (const barb of native) if (!selected.length || selected.at(-1)!.y - barb.y >= 23) selected.push(barb);
    const top = native.at(-1);
    if (top && selected.length > 1 && selected.at(-1) !== top) selected[selected.length - 1] = top;
    visible.push(...selected);
  }
  return visible;
}

export function renderWindgramSvg(view: WindgramView, options: { idPrefix?: string } = {}): string {
  const id = identifier(options.idPrefix ?? "windgram");
  const right = view.left + view.plotWidth;
  const visibleHours = new Set(visibleWindgramHourIndices(view));
  const glyphHours = new Set<number>();
  for (const [i, hour] of view.hours.entries()) {
    if (!view.compact || (hour.x >= view.left + 20 && hour.x <= right - 20
      && (!glyphHours.size || hour.x - view.hours[Array.from(glyphHours).at(-1)!].x >= 38))) glyphHours.add(i);
  }
  const barbs = displayedBarbs(view, glyphHours);
  // Cloud icons mean potential LCL; actual cloud evidence stays in full-width bands.
  const clouds = view.clouds.filter((cloud) => cloud.kind === "potential");
  const cloudScale = view.compact ? Math.max(.2, Math.min(.58, view.columnWidth / 60)) : Math.max(.64, Math.min(1, view.columnWidth / 64));
  const parts: string[] = [
    `<style>${STYLES}</style>`,
    `<defs><clipPath id="${id}-plot"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}"/></clipPath><pattern id="${id}-missing" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#a7a4c0"/><path d="M0 0L8 8M-2 6L2 10M6-2L10 2" stroke="#77758f" stroke-width="1"/></pattern><pattern id="${id}-humidity" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 0L8 8M0 8L8 0" fill="none" stroke="#fff" stroke-width=".8" opacity=".75"/></pattern></defs>`,
    `<rect width="${fmt(view.width)}" height="${fmt(view.height)}" rx="6" fill="${WINDGRAM_STABLE_COLOR}"/>`,
    heightAxisHeader(view),
    view.compact ? "" : text(right + 12, view.top - 14, "FEET MSL", 'class="wg-axis-unit"'),
    `<g clip-path="url(#${id}-plot)"><rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="${WINDGRAM_STABLE_COLOR}"/>`,
  ];
  for (const field of view.fields) parts.push(`<path d="${escape(field.path)}" class="${escape(field.className)}" fill-rule="evenodd"${field.className === "windgram-missing" ? ` fill="url(#${id}-missing)"` : ""}/>`);
  for (const band of view.cloudBands) {
    const label = band.kind === "humidity" ? "Relative humidity above 94%: likely cloud layer" : "Model cloud fraction at least 30%";
    parts.push(`<rect x="${fmt(band.x)}" y="${fmt(band.y)}" width="${fmt(band.width)}" height="${fmt(band.height)}" fill="${band.kind === "humidity" ? `url(#${id}-humidity)` : "#fff"}"${band.kind === "model" ? ' opacity=".2"' : ""} data-cloud-band="${band.kind}"><title>${label}</title></rect>`);
  }
  for (const hour of view.hours) parts.push(`<line x1="${fmt(hour.x)}" x2="${fmt(hour.x)}" y1="${view.top}" y2="${fmt(view.bottom)}" class="wg-hourline"/>`);
  for (const anchor of view.anchors) parts.push(`<line x1="${view.left}" x2="${fmt(right)}" y1="${fmt(anchor.y)}" y2="${fmt(anchor.y)}" class="wg-grid"/>`);
  for (const series of view.series) {
    if (series.bandPath) parts.push(`<path d="${escape(series.bandPath)}" fill="${escape(series.color)}" opacity=".16" data-ensemble-band="${escape(series.key)}"/>`);
    if (series.path) parts.push(`<path d="${escape(series.path)}" fill="none" stroke="${escape(series.color)}" stroke-width="${series.key === "usableLiftTopM" ? 1.8 : 1.25}"${series.dash ? ` stroke-dasharray="${escape(series.dash)}"` : ""} opacity=".85"><title>${escape(series.label)}</title></path>`);
  }
  for (const contour of view.contours) parts.push(`<path d="${escape(contour.path)}" class="${contour.temperatureF === 32 ? "wg-isotherm-freezing" : "wg-isotherm"}" data-temperature-f="${contour.temperatureF}"/>`);
  if (view.launch) parts.push(`<line x1="${view.left}" x2="${fmt(right)}" y1="${fmt(view.launch.y)}" y2="${fmt(view.launch.y)}" stroke="#413b62" stroke-width="1.1" stroke-dasharray="3 4"/>`);
  for (const barb of barbs) {
    const geometry = barbPaths(barb.speedKt, barb.directionDeg);
    const color = barb.speedKt < 9 ? "#78ff78" : "#ffffff";
    const title = `${barb.speedKt.toFixed(1)} kt from ${degrees(barb.directionDeg)} · ${feet(barb.heightM)} ft · ${barb.interpolated ? "estimated between forecast levels" : "forecast level"}`;
    const shape = geometry.calm ? '<circle r="3" class="wg-barb"/>' : `<path d="${geometry.staff}" class="wg-barb-rim"/><path d="${geometry.staff}" class="wg-barb"/>${geometry.flags.map((flag) => `<path d="${flag}" class="wg-barb"${flag.endsWith("Z") ? ' style="fill:currentColor"' : ""}/>`).join("")}`;
    parts.push(`<g transform="translate(${fmt(barb.x)} ${fmt(barb.y)})${view.compact ? " scale(.7)" : ""}" style="color:${color}" class="${barb.interpolated ? "wg-barb-interpolated" : "wg-barb-native"}" data-wind-source="${barb.interpolated ? "interpolated" : "native"}"><title>${escape(title)}</title>${shape}</g>`);
  }
  parts.push(temperatureLabels(view, cloudScale, clouds, barbs));
  for (const freeze of view.freezing) parts.push(`<path d="${SNOWFLAKE_PATH}" transform="translate(${fmt(freeze.x)} ${fmt(freeze.y)})" class="wg-freezing-mark"><title>Lowest freezing level · 32°F</title></path>`);
  for (const wing of view.wings) parts.push(`<path d="${WING_PATH}" transform="translate(${fmt(wing.x)} ${fmt(wing.y)})" class="wg-wing"><title>Paraglider ceiling · 225 ft/min sink · ${feet(wing.heightM)} ft MSL</title></path>`);
  if (view.launch) parts.push(text(view.left + 8, Math.max(view.top + 15, view.launch.y - 7), view.launch.label, 'class="wg-launch"'));
  // Potential cloud-base symbols are outlines so the lapse-rate color stays visible.
  for (const cloud of clouds) parts.push(cloudGlyph(cloud, cloudScale));
  parts.push("</g>");
  parts.push(`<rect x="${view.left}" y="${view.top}" width="${fmt(view.plotWidth)}" height="${fmt(view.plotHeight)}" fill="none" stroke="#eeebff" stroke-width="1.4"/>`);
  parts.push(heightAxisLabels(view));
  if (!view.compact) for (const anchor of visibleHeightAnchors(view)) {
    parts.push(`<path d="M${fmt(right)} ${fmt(anchor.y)}h5" stroke="#fff" stroke-width="1"/>`);
    parts.push(text(right + 10, anchor.y + 4, feet(anchor.heightM), 'class="wg-axis-feet"'));
  }
  for (const [hourIndex, hour] of view.hours.entries()) {
    parts.push(`<line x1="${fmt(hour.x)}" x2="${fmt(hour.x)}" y1="${fmt(view.bottom)}" y2="${fmt(view.bottom + 5)}" stroke="#fff"/>`);
    if (hour.inWindWindow !== null) parts.push(hour.inWindWindow
      ? `<path d="M${fmt(hour.x)} ${fmt(view.bottom + 9)}l4 7h-8Z" fill="#afffb1"><title>Surface wind direction is in the launch window</title></path>`
      : `<circle cx="${fmt(hour.x)}" cy="${fmt(view.bottom + 13)}" r="3" fill="none" stroke="#ffe1cf" stroke-width="1.3"><title>Surface wind direction is outside the launch window</title></circle>`);
    if (!visibleHours.has(hourIndex)) continue;
    if (view.compact) parts.push(text(hour.x, 17, hour.label, 'text-anchor="middle" class="wg-hour wg-hour-top"'));
    parts.push(text(hour.x, view.compact ? 38 : 36, hour.thermalVelocityMps == null ? "—" : `${Math.round(hour.thermalVelocityMps * 10) / 10}`, 'text-anchor="middle" class="wg-lift"'));
    parts.push(text(hour.x, view.bottom + (view.compact ? 27 : 35), hour.label, 'text-anchor="middle" class="wg-hour"'));
    parts.push(text(hour.x, view.bottom + (view.compact ? 42 : 53), hour.temperatureF == null ? "—" : `${Math.round(hour.temperatureF)}°`, 'text-anchor="middle" class="wg-surface-temp"'));
  }
  parts.push(text(view.left - (view.compact ? 8 : 10), view.bottom + (view.compact ? 42 : 53), view.compact ? "Sfc °F" : "Surface °F", 'text-anchor="end" class="wg-axis-unit"'));
  if (view.compact) {
    parts.push(text(view.width / 2, view.bottom + 59, `Wind kt · temperature °F${view.ensemble ? " · median" : ""}`, 'text-anchor="middle" class="wg-axis-unit"'));
    parts.push(text(view.width / 2, view.bottom + 73, view.timeZone, 'text-anchor="middle" class="wg-axis-unit"'));
  } else parts.push(text(view.left + view.plotWidth / 2, view.bottom + 75, `${view.timeZone} · wind in knots · temperatures °F${view.ensemble ? " · ensemble median" : ""}`, 'text-anchor="middle" class="wg-axis-unit"'));
  parts.push(`<g class="wg-inspector" data-windgram-cursor="" visibility="hidden"><line data-cursor-vertical=""/><line data-cursor-horizontal=""/><circle data-cursor-point="" r="7"/></g>`);
  const first = view.hours[0], last = view.hours[view.hours.length - 1];
  const description = `Windgram${first ? ` from ${first.label} to ${last.label}` : ""}, ${view.timeZone}. ${view.compact ? "Feet above sea level at left." : "Pressure and height at left, feet above sea level at right."} Vertical spacing expands the lower atmosphere. Wind feathers use knots. Temperature contours use Fahrenheit. White crosshatching shows relative humidity above 94%; pale bands show model cloud. Outlined clouds mark potential cloud base; paraglider symbols use 225 feet per minute sink. ${view.ensemble ? "Ensemble median with shaded uncertainty bands." : ""}`;
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${fmt(view.width)} ${fmt(view.height)}" role="img" aria-labelledby="${id}-title ${id}-description" class="windgram${view.compact ? " windgram-compact" : ""}"><title id="${id}-title">Wind, temperature and clouds by hour and altitude</title><desc id="${id}-description">${escape(description)}</desc>${parts.join("\n")}</svg>`;
}

/** Reuses the diagnostic data and path geometry, with a compact independent layout. */
export function renderWindgramDiagnosticsSvg(view: WindgramView, options: { idPrefix?: string } = {}): string {
  const id = identifier(options.idPrefix ?? "windgram-diagnostics");
  const left = view.compact ? 102 : view.left;
  const plotWidth = view.diagnosticColumnWidth * Math.max(1, view.hours.length);
  const width = view.compact ? left + plotWidth + 88 : view.width;
  const rowPitch = 45, firstTop = 26, plotRight = left + plotWidth;
  const footer = view.sourceNote ? 58 : 34;
  const height = firstTop + view.diagnostics.length * rowPitch + footer;
  const parts = [`<style>${DEFAULT_STYLESHEET}\n.wg-diagnostics text{font-family:ui-sans-serif,system-ui,sans-serif}.wg-diagnostics .wg-diagnostic-label{fill:#263f48;font-size:12px;font-weight:650}.wg-diagnostics .wg-diagnostic-unit{fill:#4a6068;font-size:10px}.wg-diagnostics .wg-diagnostic-scale{fill:#4a6068;font-size:10px}.wg-diagnostics .wg-diagnostic-note{fill:#4a6068;font-size:10px}</style>`, `<rect width="${fmt(width)}" height="${height}" fill="#fffdf8"/>`];
  for (const [index, strip] of view.diagnostics.entries()) {
    const top = firstTop + index * rowPitch;
    const dx = left - view.diagnosticLeft, dy = top - strip.top;
    const bottom = top + strip.height;
    parts.push(`<rect x="${left}" y="${top}" width="${fmt(plotWidth)}" height="${strip.height}" class="meteo-gram-strip-frame" stroke-width=".7"/>`);
    parts.push(`<line x1="${left}" x2="${fmt(plotRight)}" y1="${fmt(top + strip.height / 2)}" y2="${fmt(top + strip.height / 2)}" stroke="#73818a" stroke-dasharray="2 4" opacity=".22"/>`);
    parts.push(text(left - 10, top + 10, strip.label, 'text-anchor="end" class="wg-diagnostic-label"'));
    parts.push(text(left - 10, top + 23, strip.unit, 'text-anchor="end" class="wg-diagnostic-unit"'));
    parts.push(`<g transform="translate(${fmt(dx)} ${fmt(dy)})">`);
    if (strip.cells) for (const cell of strip.cells) if (cell) parts.push(`<rect x="${fmt(cell.x)}" y="${strip.top}" width="${fmt(cell.width)}" height="${strip.height}" class="${escape(cell.className)}"${cell.opacity === undefined ? "" : ` opacity="${cell.opacity}"`}/>`);
    if (strip.rows) for (const row of strip.rows) {
      for (const cell of row.cells) if (cell) parts.push(`<rect x="${fmt(cell.x)}" y="${fmt(row.top)}" width="${fmt(cell.width)}" height="${fmt(row.height)}" class="${escape(cell.className)}"${cell.opacity === undefined ? "" : ` opacity="${cell.opacity}"`}/>`);
      parts.push(text(view.diagnosticLeft + plotWidth + 8, row.top + row.height - 1, row.label, 'class="wg-diagnostic-scale"'));
    }
    if (strip.areaPath) parts.push(`<path d="${escape(strip.areaPath)}" class="${escape(strip.className)}-area" opacity=".18"/>`);
    if (strip.bandPath) parts.push(`<path d="${escape(strip.bandPath)}" class="${escape(strip.className)}-band" opacity=".2"/>`);
    if (strip.linePath) parts.push(`<path d="${escape(strip.linePath)}" class="${escape(strip.className)}" fill="none" stroke-width="1.7"/>`);
    for (const dot of strip.dots ?? []) parts.push(`<circle cx="${fmt(dot.x)}" cy="${fmt(dot.y)}" r="2" class="${escape(strip.className)}-dot"/>`);
    for (const dot of strip.degradedDots ?? []) parts.push(`<circle cx="${fmt(dot.x)}" cy="${fmt(dot.y)}" r="2" class="${escape(strip.className)}-degraded-dot"/>`);
    if (strip.measuredToX != null) parts.push(`<rect x="${fmt(strip.measuredToX)}" y="${strip.top}" width="${fmt(Math.max(0, view.diagnosticLeft + plotWidth - strip.measuredToX))}" height="${strip.height}" class="meteo-gram-strip-pending"/>`);
    parts.push("</g>");
    if (!strip.rows) {
      parts.push(text(plotRight + 8, top + 5, `${Math.round(strip.maximum * 10) / 10}`, 'class="wg-diagnostic-scale"'));
      parts.push(text(plotRight + 8, bottom + 2, `${Math.round(strip.minimum * 10) / 10}`, 'class="wg-diagnostic-scale"'));
    }
    if (strip.sourceLabel) parts.push(text(left + 5, bottom + 12, strip.sourceLabel, 'class="wg-diagnostic-note"'));
  }
  const timeY = firstTop + view.diagnostics.length * rowPitch + 8;
  for (const [index, hour] of view.hours.entries()) parts.push(text(left + view.diagnosticColumnWidth * (index + .5), timeY, hour.label, 'text-anchor="middle" class="wg-diagnostic-label"'));
  if (view.sourceNote) parts.push(text(left, timeY + 24, view.sourceNote, 'class="wg-diagnostic-note"'));
  if (!view.diagnostics.length) parts.push(text(left, 25, "No supplemental forecast values are available.", 'class="wg-diagnostic-note"'));
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${fmt(width)} ${height}" role="img" aria-labelledby="${id}-title" class="meteo-gram wg-diagnostics"><title id="${id}-title">Supplemental weather diagnostics aligned to the windgram hours</title>${parts.join("\n")}</svg>`;
}

export function renderWindgramKey(): string {
  const icon = (content: string, width = 35) => `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} 24" width="${width}" height="24" aria-hidden="true">${content}</svg>`;
  const humidity = icon('<rect x="2" y="1" width="31" height="22" rx="2" fill="#7b7de6"/><path d="M4 3L22 21M13 3L31 21M4 21L22 3M13 21L31 3" stroke="#fff" stroke-width="1"/>');
  const potential = icon(`<path d="${CLOUD_PATH}" transform="translate(17 20) scale(.55)" fill="none" stroke="#7773bc" stroke-width="1.7" stroke-dasharray="4 3"/>`);
  const wind = icon('<path d="M9 21L9 3M9 3L20 7M9 8L15 10" fill="none" stroke="#355963" stroke-width="1.4"/>');
  const freezing = icon(`<path d="M1 12H34" stroke="#237d92" stroke-width="1.5" stroke-dasharray="5 3"/><path d="${SNOWFLAKE_PATH}" transform="translate(17 12)" fill="none" stroke="#237d92"/>`);
  const lift = icon(`<path d="${WING_PATH}" transform="translate(17 12) scale(.7)" fill="none" stroke="#134ac4" stroke-width="1.8"/>`);
  return `<div class="windgram-legend"><div class="windgram-legend-ramp"><strong>Lapse rate · °C / 1,000 ft</strong>${WINDGRAM_STABILITY.map(({ color, range }) => `<span class="windgram-legend-chip" style="--chip:${color}">${range}</span>`).join("")}</div><div class="windgram-legend-symbols"><span>${wind}Wind · half 5 / full 10 / flag 50 kt</span><span>${humidity}Humidity &gt;94%</span><span>${potential}Potential cloud base</span><span>${freezing}32°F freezing level</span><span>${lift}225 ft/min sink</span></div><details class="windgram-legend-note"><summary>How to read this chart</summary><p>Colors and lapse-rate thresholds follow <a href="http://wxtofly.net/windgramexplain.html">WxToFly’s guide</a>. Red/orange: fastest cooling with height. Gray: inversion. Dark diagonal hatching: unavailable profile. White crosshatching: humidity above 94%. Pale white bands: model cloud fraction ≥30%. Outlined clouds: potential condensation level, even when thermals cannot reach it. Snowflakes: lowest freezing crossing, not snowfall. Wind colors: green &lt;9 kt, white ≥9 kt. Fainter barbs are interpolated between model levels. Paragliders: ceiling at 225 ft/min (1.143 m/s) sink; blue line: 1 m/s sink. Lift w* uses m/s; temperatures use °F; all heights are above sea level. Rain and other surface values are in Weather details.</p></details></div>`;
}

/** Pointer and keyboard inspection stays in the same nonlinear height coordinates. */
export function mountWindgramInspector(host: HTMLElement, readout: HTMLElement | null, view: WindgramView, onSelectHour?: (validAt: string) => void): () => void {
  const svg = host.querySelector<SVGSVGElement>("svg.windgram");
  if (!svg || !view.hours.length) return () => {};
  const cursor = svg.querySelector<SVGGElement>("[data-windgram-cursor]");
  const vertical = svg.querySelector<SVGLineElement>("[data-cursor-vertical]");
  const horizontal = svg.querySelector<SVGLineElement>("[data-cursor-horizontal]");
  const point = svg.querySelector<SVGCircleElement>("[data-cursor-point]");
  const originalAttributes = new Map(["tabindex", "role", "aria-label", "aria-describedby"].map((key) => [key, host.getAttribute(key)]));
  const readoutAttributes = new Map(["role", "aria-live", "aria-atomic"].map((key) => [key, readout?.getAttribute(key) ?? null]));
  const interactionLabel = "Interactive windgram. Left and right arrows change hour; up and down arrows change altitude. Escape clears the selection.";
  host.tabIndex = 0;
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", interactionLabel);
  if (readout?.id) host.setAttribute("aria-describedby", readout.id);
  readout?.setAttribute("role", "status");
  readout?.setAttribute("aria-live", "polite");
  readout?.setAttribute("aria-atomic", "true");
  const instructions = "Hover to inspect · click or tap to pin · arrow keys change hour and height · Escape clears";
  if (readout) readout.textContent = instructions;
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
      reading.speedKt == null ? null : reading.interpolated ? "Estimated between forecast levels" : "Forecast level",
      reading.gustKt == null ? null : `Surface gust ${Math.round(reading.gustKt)} kt`,
      reading.cloud === "model" ? "Model cloud layer" : reading.cloud === "humidity" ? "Likely cloud layer from humidity >94%" : reading.cloud === "potential" ? "Potential cloud base, not confirmed cloud" : null,
      view.ensemble ? "Ensemble median" : null].filter((value): value is string => value !== null);
    const nextText = `${title} · ${values.join(" · ")}`;
    if (nextText !== lastText) {
      if (readout) {
        const strong = document.createElement("strong");
        strong.textContent = title;
        readout.replaceChildren(strong, document.createTextNode(` · ${values.join(" · ")}`));
      } else host.setAttribute("aria-label", `${interactionLabel} ${nextText}`);
      lastText = nextText;
    }
    if (keyboard) {
      onSelectHour?.(reading.validAt);
      // Only reveal a newly selected hour horizontally; focus alone never scrolls.
      const matrix = svg.getScreenCTM();
      if (matrix) {
        const screen = new DOMPoint(x, y).matrixTransform(matrix);
        const rect = host.getBoundingClientRect();
        const clearance = view.compact ? view.left + 16 : 32;
        if (screen.x < rect.left + clearance) host.scrollLeft -= rect.left + clearance - screen.x;
        else if (screen.x > rect.right - 32) host.scrollLeft += screen.x - rect.right + 32;
      }
    }
  };
  const location = (event: PointerEvent) => {
    if (view.compact && event.clientX < host.getBoundingClientRect().left + view.left) return null;
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
    onSelectHour?.(view.hours[p.hourIndex].validAt);
  };
  const onCancel = () => { pointerStart = null; };
  const onLeave = () => { if (!pinned) cursor?.setAttribute("visibility", "hidden"); };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      pinned = false; active = null; lastText = "";
      cursor?.setAttribute("visibility", "hidden");
      if (readout) readout.textContent = instructions;
      else host.setAttribute("aria-label", interactionLabel);
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
    for (const [name, value] of readoutAttributes) value === null ? readout?.removeAttribute(name) : readout?.setAttribute(name, value);
    cursor?.setAttribute("visibility", "hidden");
  };
}
