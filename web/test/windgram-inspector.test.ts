import { afterEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSiteForecast } from "@azohra/meteo.briefing/contract";
import { buildWindgramView, heightToY, readWindgram, yToHeight, type WindgramView } from "../src/lib/windgram-view.ts";
import { mountWindgramInspector, renderWindgramSvg } from "../src/lib/windgram-chart.ts";
import { setUnitSystem } from "../src/lib/units.ts";

afterEach(() => setUnitSystem("imperial"));
const source = () => {
  const profile = parseSiteForecast(JSON.parse(readFileSync(new URL("../dev-data-src/convective-cycle.profile.json", import.meta.url), "utf8")));
  assert.ok(profile);
  return profile;
};
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < .01, `${actual} ≈ ${expected}`);

test("AGL uses launch ground in either height range, including launch below model terrain", () => {
  const profile = source(), terrain = profile.site.modelElevationM;
  const options = { timeZone: "Etc/UTC", compact: true, widthPx: 390, heightPx: 780 };
  for (const launchM of [terrain - 250, terrain + 300]) {
    const focused = buildWindgramView(profile, { ...options, launch: { elevationM: launchM } });
    const full = buildWindgramView(profile, { ...options, launch: { elevationM: launchM }, heightRange: "full" });
    assert.deepEqual(focused.ground, { elevationM: launchM, source: "launch" });
    assert.deepEqual(focused.ground, full.ground);
    const altitude = Math.max(focused.floorM, full.floorM) + 200;
    close(readWindgram(focused, 0, altitude).heightAglM, altitude - launchM);
    close(readWindgram(full, 0, altitude).heightAglM, altitude - launchM);
    close(readWindgram(full, 0, terrain).heightAglM, terrain - launchM);
  }
  const noLaunch = buildWindgramView(profile, options);
  assert.deepEqual(noLaunch.ground, { elevationM: terrain, source: "model" });
  close(readWindgram(noLaunch, 0, terrain + 200).heightAglM, 200);
});

function inspector(t: TestContext, view: WindgramView) {
  const originalDOMPoint = globalThis.DOMPoint;
  class Point {
    x: number; y: number;
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    matrixTransform(matrix: { scale: number; offsetX?: number; offsetY?: number }) { return new Point(this.x * matrix.scale + (matrix.offsetX ?? 0), this.y * matrix.scale + (matrix.offsetY ?? 0)); }
  }
  globalThis.DOMPoint = Point as unknown as typeof DOMPoint;
  t.after(() => { if (originalDOMPoint) globalThis.DOMPoint = originalDOMPoint; else Reflect.deleteProperty(globalThis, "DOMPoint"); });
  const element = () => {
    const attributes = new Map<string, string>();
    return { attributes, textContent: "", setAttribute: (key: string, value: string) => attributes.set(key, value), getAttribute: (key: string) => attributes.get(key) ?? null };
  };
  const nodes = Object.fromEntries(["windgram-cursor", "cursor-vertical", "cursor-horizontal", "cursor-point", "cursor-readout", "cursor-back", "cursor-agl", "cursor-msl"].map(name => [name, element()]));
  const bounds = { left: 0, right: view.width, top: 0, bottom: view.height };
  const matrix = { scale: 1, offsetX: 0, offsetY: 0, inverse: () => ({ scale: 1 / matrix.scale, offsetX: -matrix.offsetX / matrix.scale, offsetY: -matrix.offsetY / matrix.scale }) };
  const svg = { querySelector: (selector: string) => nodes[selector.slice(6, -1)] ?? null, getScreenCTM: () => matrix };
  const ownerDocument = Object.assign(new EventTarget(), { defaultView: { innerWidth: view.width, innerHeight: view.height } });
  const attributes = new Map<string, string>();
  const host = Object.assign(new EventTarget(), {
    querySelector: () => svg, getBoundingClientRect: () => bounds, ownerDocument,
    contains: (node: EventTarget) => node === host,
    getAttribute: (key: string) => attributes.get(key) ?? null,
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key), tabIndex: -1, scrollLeft: 0,
  });
  const selected: string[] = [];
  const cleanup = mountWindgramInspector(host as unknown as HTMLElement, null, view, time => selected.push(time));
  t.after(cleanup);
  const pointer = (type: string, x: number, y: number, pointerType = "mouse") => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, pointerType, pointerId: 1, isPrimary: true });
    host.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, "pointer inspection leaves native scrolling available");
  };
  const key = (key: string) => { const event = new Event("keydown", { cancelable: true }); Object.assign(event, { key }); host.dispatchEvent(event); };
  return { nodes, host, bounds, matrix, selected, pointer, key, cleanup, attributes, ownerDocument };
}

test("hover reports the exact cursor altitude and keeps the compact height readout inside the plot", t => {
  const profile = source();
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", compact: true, heightRange: "full", widthPx: 320, launch: { elevationM: profile.site.modelElevationM + 200 } });
  assert.match(renderWindgramSvg(view), /data-cursor-agl/);
  const h = inspector(t, view);
  const barb = view.barbs.find(barb => barb.y > view.top + 15 && barb.y < view.bottom - 15)!;
  const y = barb.y + 3, z = yToHeight(view, y);
  h.pointer("pointermove", view.hours[barb.hourIndex].x, y);
  assert.equal(h.nodes["cursor-agl"].textContent, `${Math.round((z - view.ground.elevationM) / .3048).toLocaleString("en-US")} ft AGL`);
  assert.equal(h.nodes["cursor-msl"].textContent, `${Math.round(z / .3048).toLocaleString("en-US")} ft MSL`);
  close(Number(h.nodes["cursor-point"].getAttribute("cy")), y);
  assert.deepEqual(h.selected, [], "hover does not change the selected forecast hour");
  for (const x of [view.left + 1, view.left + view.plotWidth - 1]) for (const y of [view.top + 1, view.bottom - 1]) {
    h.pointer("pointermove", x, y);
    const [labelX, labelY] = h.nodes["cursor-readout"].getAttribute("transform")!.match(/[\d.]+/g)!.map(Number);
    const width = Number(h.nodes["cursor-back"].getAttribute("width"));
    assert.ok(labelX >= view.left && labelX + width <= view.left + view.plotWidth + .01);
    assert.ok(labelY >= view.top && labelY + 47 <= view.bottom);
  }
  h.pointer("pointermove", view.left - 1, view.top);
  assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "hidden");
});

test("touch taps pin signed AGL; dragging, cancellation and Escape leave scrolling and clearing intact", t => {
  const profile = source(), ground = profile.site.modelElevationM + 300;
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", widthPx: 700, launch: { elevationM: ground } });
  const h = inspector(t, view), x = view.hours[0].x, y = heightToY(view, ground - 100);
  h.pointer("pointerdown", x, y, "touch");
  h.pointer("pointermove", x, y + 30, "touch");
  h.pointer("pointerup", x, y, "touch");
  assert.deepEqual(h.selected, [], "a scroll returning to its starting point is still a drag");
  h.pointer("pointerdown", x, y, "touch");
  h.pointer("pointercancel", x, y, "touch");
  h.pointer("pointerup", x, y, "touch");
  assert.deepEqual(h.selected, []);
  h.pointer("pointerdown", x, y, "touch");
  h.pointer("pointerup", x, y, "touch");
  assert.equal(h.nodes["cursor-agl"].textContent, "-328 ft AGL");
  assert.deepEqual(h.selected, [view.hours[0].validAt]);
  h.pointer("pointerleave", x, y, "touch");
  assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "visible");
  h.key("ArrowRight");
  assert.equal(h.selected.at(-1), view.hours[1].validAt);
  h.key("Escape");
  assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "hidden");
  h.pointer("pointerdown", x, y, "touch");
  h.pointer("pointerup", x, y, "touch");
  h.ownerDocument.dispatchEvent(new Event("pointerdown"));
  assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "hidden", "a tap outside dismisses the pinned card");
  h.pointer("pointerdown", x, y, "touch");
  h.pointer("pointerup", x, y, "touch");
  h.cleanup();
  const count = h.selected.length;
  h.key("ArrowRight");
  assert.equal(h.selected.length, count);
  h.ownerDocument.dispatchEvent(new Event("pointerdown"));
  assert.equal(h.attributes.size, 0);
});

test("callout stays in the visible viewport when the page or chart is scrolled", t => {
  const view = buildWindgramView(source(), { timeZone: "Etc/UTC", widthPx: 1000 });
  const h = inspector(t, view);
  h.bounds.left = 180; h.bounds.right = 480;
  h.matrix.offsetY = -view.top - 200;
  h.bounds.top = h.matrix.offsetY;
  h.bounds.bottom = view.height + h.matrix.offsetY;
  h.ownerDocument.defaultView.innerHeight = 300;
  h.pointer("pointermove", 350, 8);
  const [x, y] = h.nodes["cursor-readout"].getAttribute("transform")!.match(/[\d.]+/g)!.map(Number);
  const width = Number(h.nodes["cursor-back"].getAttribute("width"));
  assert.ok(x >= 180 && x + width <= 480.01, "card fits the horizontally visible plot");
  assert.ok(y + h.matrix.offsetY > 8, "card moves below a hover near the screen top");
  assert.ok(y + h.matrix.offsetY + 47 <= 300);
  h.pointer("pointermove", 350, 290);
  const lowerY = Number(h.nodes["cursor-readout"].getAttribute("transform")!.match(/[\d.]+/g)![1]);
  assert.ok(lowerY + h.matrix.offsetY >= 0 && lowerY + h.matrix.offsetY + 47 <= 300);
});

test("metric inspection and a scaled chart preserve physical height and model-ground fallback", t => {
  setUnitSystem("metric");
  const profile = source();
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", compact: true, widthPx: 390 });
  const h = inspector(t, view);
  h.matrix.scale = .75;
  h.bounds.right = view.width * .75;
  const altitude = view.ground.elevationM + 200;
  h.pointer("pointermove", view.hours[0].x * .75, heightToY(view, altitude) * .75);
  assert.equal(h.nodes["cursor-agl"].textContent, "200 m AGL");
  assert.match(h.nodes["cursor-msl"].textContent, /m MSL · model ref$/);
  assert.doesNotMatch(h.attributes.get("aria-label")!, /\bft\b/);
});
