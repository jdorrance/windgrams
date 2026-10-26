import { renderWindgramSvg } from './windgram-chart.ts';
import { fahrenheitToCelsius, formatQuantity, gustNoun, knotsToMps, type UnitSystem } from './windgram-format.ts';
import { heightToY } from './windgram-scale.ts';
import { readWindgram } from './windgram-inspector.ts';
import { visibleWindgramHourIndices } from './windgram-time-axis.ts';
import type { WindgramView } from './windgram-view.ts';
import type { WindgramMountOptions, WindgramMount } from './dom.ts';
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const fmt = (value: number) => Number(value.toFixed(2));
const barbSpeed = (knots: number, system: UnitSystem) => formatQuantity(knotsToMps(knots), 'barbWind', undefined, system);
const degrees = (direction: number) => `${["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(direction / 22.5) % 16]} ${Math.round(direction) % 360}°`;

/** Inspect each forecast hour at its published blue usable-lift line. */
export function mountWindgramInspector(
  host: HTMLElement,
  readout: HTMLElement | null,
  view: WindgramView,
  onSelectHour?: (validAt: string) => void,
  selectedHourIndex?: () => number,
): () => void {
  const system = view.unitSystem;
  const svg = host.querySelector<SVGSVGElement>("svg.windgram");
  const visibleHours = visibleWindgramHourIndices(view, 0);
  if (!svg || !visibleHours.length) return () => {};
  const ownerDocument = host.ownerDocument;
  const cursor = svg.querySelector<SVGGElement>("[data-windgram-cursor]");
  const vertical = svg.querySelector<SVGLineElement>("[data-cursor-vertical]");
  const horizontal = svg.querySelector<SVGLineElement>("[data-cursor-horizontal]");
  const point = svg.querySelector<SVGCircleElement>("[data-cursor-point]");
  const callout = svg.querySelector<SVGGElement>("[data-cursor-readout]");
  const calloutBack = svg.querySelector<SVGRectElement>("[data-cursor-back]");
  const aglLabel = svg.querySelector<SVGTextElement>("[data-cursor-agl]");
  const mslLabel = svg.querySelector<SVGTextElement>("[data-cursor-msl]");
  const originalAttributes = new Map(["tabindex", "role", "aria-label", "aria-describedby"].map((key) => [key, host.getAttribute(key)]));
  const readoutAttributes = new Map(["role", "aria-live", "aria-atomic"].map((key) => [key, readout?.getAttribute(key) ?? null]));
  const interactionLabel =
    "Interactive windgram. Hover or tap an hour for lift top AGL. Left and right arrows change hour. Escape clears the selection.";
  host.tabIndex = 0;
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", interactionLabel);
  if (readout?.id) host.setAttribute("aria-describedby", readout.id);
  readout?.setAttribute("role", "status");
  readout?.setAttribute("aria-live", "polite");
  readout?.setAttribute("aria-atomic", "true");
  const instructions = "Hover for lift top · click or tap to pin · left/right arrows change hour · Escape clears";
  if (readout) readout.textContent = instructions;
  let activeHour: number | null = null;
  let pinned = false;
  let pointerStart: { x: number; y: number; id: number; moved: boolean } | null = null;
  let lastText = "";
  const clear = () => {
    pinned = false;
    activeHour = null;
    lastText = "";
    cursor?.setAttribute("visibility", "hidden");
    if (readout) readout.textContent = instructions;
    else host.setAttribute("aria-label", interactionLabel);
  };

  const update = (hourIndex: number, keyboard = false) => {
    const hour = view.hours[hourIndex];
    activeHour = hourIndex;
    const x = hour.x;
    if (keyboard) {
      onSelectHour?.(hour.validAt);
      // Reveal the selected hour even when its lift ceiling is unavailable.
      const matrix = svg.getScreenCTM();
      if (matrix) {
        const screen = new DOMPoint(x, view.top).matrixTransform(matrix);
        const rect = host.getBoundingClientRect();
        const clearance = view.compact ? view.left + 16 : 32;
        if (screen.x < rect.left + clearance) host.scrollLeft -= rect.left + clearance - screen.x;
        else if (screen.x > rect.right - 32) host.scrollLeft += screen.x - rect.right + 32;
      }
    }
    const when = new Intl.DateTimeFormat("en-US", {
      timeZone: view.timeZone,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(hour.validAt));
    const heightM = hour.usableLiftTopM;
    if (heightM === null || heightM < view.floorM || heightM > view.topM) {
      cursor?.setAttribute("visibility", "hidden");
      lastText = `${when} · ${heightM === null ? "Lift top unavailable" : "Lift top outside this view"}`;
      if (readout) readout.textContent = lastText;
      else host.setAttribute("aria-label", `${interactionLabel} ${lastText}`);
      return;
    }
    const reading = readWindgram(view, hourIndex, heightM);
    const y = heightToY(view, heightM);
    const attr = (element: Element | null, values: Record<string, number>) => {
      for (const [key, value] of Object.entries(values)) element?.setAttribute(key, String(fmt(value)));
    };
    attr(vertical, { x1: x, x2: x, y1: view.top, y2: view.bottom });
    attr(horizontal, { x1: view.left, x2: view.left + view.plotWidth, y1: y, y2: y });
    attr(point, { cx: x, cy: y });
    cursor?.setAttribute("visibility", "visible");
    const aglText = `${formatQuantity(reading.heightAglM, "elevation", undefined, system)} AGL`;
    const mslText = `${formatQuantity(reading.heightM, "elevation", undefined, system)} MSL${view.ground.source === "model" ? " · model ref" : ""}`;
    if (aglLabel) aglLabel.textContent = aglText;
    if (mslLabel) mslLabel.textContent = mslText;
    // Keep the card visible while the page or the wide desktop chart is scrolled.
    let visibleLeft = view.left, visibleRight = view.left + view.plotWidth;
    let visibleTop = view.top, visibleBottom = view.bottom;
    const matrix = svg.getScreenCTM();
    if (matrix) {
      const bounds = host.getBoundingClientRect(), inverse = matrix.inverse();
      const viewport = ownerDocument?.defaultView;
      const topLeft = new DOMPoint(Math.max(0, bounds.left), Math.max(0, bounds.top)).matrixTransform(inverse);
      const bottomRight = new DOMPoint(
        Math.min(viewport?.innerWidth ?? Infinity, bounds.right),
        Math.min(viewport?.innerHeight ?? Infinity, bounds.bottom),
      ).matrixTransform(inverse);
      visibleLeft = Math.max(visibleLeft, topLeft.x);
      visibleRight = Math.min(visibleRight, bottomRight.x);
      visibleTop = Math.max(visibleTop, topLeft.y);
      visibleBottom = Math.min(visibleBottom, bottomRight.y);
    }
    const padding = 4, calloutHeight = 47;
    const labelWidth =
      Math.max(aglLabel?.getComputedTextLength?.() ?? aglText.length * 9, mslLabel?.getComputedTextLength?.() ?? mslText.length * 5.5) + 20;
    const calloutWidth = Math.min(labelWidth, Math.max(0, visibleRight - visibleLeft - padding * 2));
    const calloutX = Math.max(
      visibleLeft + padding,
      Math.min(
        x + 12 + calloutWidth <= visibleRight - padding ? x + 12 : x - 12 - calloutWidth,
        visibleRight - calloutWidth - padding,
      ),
    );
    const calloutY = Math.max(
      visibleTop + padding,
      Math.min(
        y - calloutHeight - 12 >= visibleTop + padding ? y - calloutHeight - 12 : y + 12,
        visibleBottom - calloutHeight - padding,
      ),
    );
    callout?.setAttribute("transform", `translate(${fmt(calloutX)} ${fmt(calloutY)})`);
    attr(calloutBack, { width: calloutWidth });
    const title = `${when} · Lift top · ${aglText} · ${mslText}`;
    const values = [
      reading.temperatureF == null ? "Temperature unavailable" : `${formatQuantity(fahrenheitToCelsius(reading.temperatureF), "temperature", 1, system)}`,
      reading.speedKt == null
        ? "Wind unavailable"
        : reading.speedKt < 0.1
          ? "Calm"
          : `${barbSpeed(reading.speedKt, system)}${reading.directionDeg == null ? "" : ` from ${degrees(reading.directionDeg)}`}`,
      reading.speedKt == null ? null : reading.interpolated ? "Interpolated" : "Model level",
      reading.gustKt == null ? null : `Surface ${gustNoun(view.gustSemantics)} ${barbSpeed(reading.gustKt, system)}`,
      reading.cloud === "model"
        ? "Model cloud layer"
        : reading.cloud === "humidity"
          ? "Likely cloud layer from humidity >94%"
          : reading.cloud === "potential"
            ? "Potential cloud base"
            : null,
      view.ensemble ? "Ensemble median" : null,
      hour.liftFamily === "v1-legacy" ? "Earlier lift method (v1)" : null,
    ].filter((value): value is string => value !== null);
    const nextText = `${title} · ${values.join(" · ")}`;
    if (nextText !== lastText) {
      if (readout) {
        const strong = ownerDocument.createElement("strong");
        strong.textContent = title;
        readout.replaceChildren(strong, ownerDocument.createTextNode(` · ${values.join(" · ")}`));
      } else host.setAttribute("aria-label", `${interactionLabel} ${nextText}`);
      lastText = nextText;
    }
  };
  const location = (event: PointerEvent) => {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    if (position.x < view.left || position.x > view.left + view.plotWidth || position.y < view.top || position.y > view.bottom) return null;
    const dataLeft = view.hours[0].x - view.columnWidth / 2;
    const dataRight = view.hours.at(-1)!.x + view.columnWidth / 2;
    if (position.x < dataLeft || position.x > dataRight) return null;
    const hourIndex = visibleHours.reduce((best, index) =>
      Math.abs(view.hours[index].x - position.x) < Math.abs(view.hours[best].x - position.x) ? index : best);
    return { hourIndex };
  };
  const onMove = (event: PointerEvent) => {
    if (pointerStart?.id === event.pointerId && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 10) pointerStart.moved = true;
    if (event.pointerType !== "mouse" || pinned) return;
    const p = location(event);
    if (p) update(p.hourIndex);
    else cursor?.setAttribute("visibility", "hidden");
  };
  const onDown = (event: PointerEvent) => {
    if (event.isPrimary !== false) pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
  };
  const onUp = (event: PointerEvent) => {
    const start = pointerStart;
    pointerStart = null;
    if (!start || start.moved || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) return;
    const p = location(event);
    if (!p) return;
    pinned = true;
    update(p.hourIndex);
    onSelectHour?.(view.hours[p.hourIndex].validAt);
  };
  const onCancel = () => {
    pointerStart = null;
  };
  const onLeave = () => {
    if (!pinned) cursor?.setAttribute("visibility", "hidden");
  };
  const onOutsideDown = (event: Event) => {
    if (pinned && !host.contains(event.target as Node)) clear();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      clear();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    pinned = true;
    let hourIndex = selectedHourIndex?.() ?? activeHour ?? view.selectedHourIndex;
    if (event.key === "ArrowLeft") hourIndex = visibleHours.findLast(index => index < hourIndex) ?? visibleHours[0];
    if (event.key === "ArrowRight") hourIndex = visibleHours.find(index => index > hourIndex) ?? visibleHours.at(-1)!;
    if (event.key === "Home") hourIndex = visibleHours[0];
    if (event.key === "End") hourIndex = visibleHours.at(-1)!;
    update(hourIndex, true);
  };
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerdown", onDown);
  host.addEventListener("pointerup", onUp);
  host.addEventListener("pointercancel", onCancel);
  host.addEventListener("pointerleave", onLeave);
  host.addEventListener("keydown", onKey);
  ownerDocument?.addEventListener("pointerdown", onOutsideDown);
  return () => {
    host.removeEventListener("pointermove", onMove);
    host.removeEventListener("pointerdown", onDown);
    host.removeEventListener("pointerup", onUp);
    host.removeEventListener("pointercancel", onCancel);
    host.removeEventListener("pointerleave", onLeave);
    host.removeEventListener("keydown", onKey);
    ownerDocument?.removeEventListener("pointerdown", onOutsideDown);
    for (const [name, value] of originalAttributes) value === null ? host.removeAttribute(name) : host.setAttribute(name, value);
    for (const [name, value] of readoutAttributes) value === null ? readout?.removeAttribute(name) : readout?.setAttribute(name, value);
    cursor?.setAttribute("visibility", "hidden");
  };
}


type InternalMountOptions = Omit<WindgramMountOptions, 'view'> & { view: WindgramView };
/** Owns one SVG host; callers own profiles, layout, routing and persisted state. */
export function mountWindgram(host: HTMLElement, options: InternalMountOptions): Omit<WindgramMount, 'update'> & { update(view: WindgramView): void } {
  let clearInspector: (() => void) | null = null;
  let disposed = false;
  let view = options.view;
  let selectedValidAt = options.selectedValidAt === undefined ? view.hours[view.selectedHourIndex]?.validAt ?? null : options.selectedValidAt;
  const select = (validAt: string | null) => {
    if (disposed) return;
    selectedValidAt = validAt;
    const index = validAt ? view.hours.findIndex(hour => hour.validAt === validAt && hour.x >= view.left && hour.x <= view.left + view.plotWidth) : -1;
    const cursor = host.querySelector<SVGRectElement>('[data-selected-hour]');
    if (cursor) {
      cursor.setAttribute('visibility', index >= 0 ? 'visible' : 'hidden');
      if (index >= 0) {
        const left = Math.max(view.left, view.hours[index].x - view.columnWidth / 2);
        const right = Math.min(view.left + view.plotWidth, view.hours[index].x + view.columnWidth / 2);
        cursor.setAttribute('x', String(left));
        cursor.setAttribute('width', String(right - left));
      }
    }
  };
  const update = (next: WindgramView) => {
    if (disposed) return;
    clearInspector?.();
    view = next;
    host.innerHTML = renderWindgramSvg(view, { idPrefix: options.idPrefix });
    const svg = host.querySelector<SVGSVGElement>('svg.windgram');
    if (svg) {
      const selected = host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
      for (const [key, value] of Object.entries({
        y: view.top, height: view.plotHeight, width: view.columnWidth,
        fill: '#237e81', 'fill-opacity': 0.04, stroke: '#237e81', 'stroke-width': 1,
        'pointer-events': 'none', 'data-selected-hour': '',
      })) selected.setAttribute(key, String(value));
      svg.insertBefore(selected, svg.querySelector('[data-windgram-cursor]'));
    }
    select(selectedValidAt);
    clearInspector = mountWindgramInspector(host, options.readout ?? null, view, validAt => {
      select(validAt);
      options.onSelectHour?.(validAt);
    }, () => Math.max(0, view.hours.findIndex(hour => hour.validAt === selectedValidAt)));
  };
  update(view);
  return {
    update, select,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInspector?.();
      clearInspector = null;
      host.replaceChildren();
    },
  };
}
