import { afterEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSiteForecast } from "@azohra/meteo.briefing/contract";
import {  buildWindgramView, heightToY, readWindgram, type WindgramView  } from "./helpers/windgram.ts";
import {  mountWindgramInspector, renderWindgramSvg, visibleWindgramHourIndices  } from "./helpers/windgram.ts";
import { setUnitSystem } from "../src/lib/units.ts";

const originalDOMPoint = globalThis.DOMPoint;
afterEach(() => {
  setUnitSystem("imperial");
  if (originalDOMPoint) globalThis.DOMPoint = originalDOMPoint;
  else Reflect.deleteProperty(globalThis, "DOMPoint");
});
const source = () => {
  const profile = parseSiteForecast(JSON.parse(readFileSync(new URL("../dev-data-src/convective-cycle.profile.json", import.meta.url), "utf8")));
  assert.ok(profile);
  return profile;
};
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < .01, `${actual} ≈ ${expected}`);
const liftProfile = () => {
  const profile = source();
  for (const [i, hour] of profile.hours.entries()) hour.derived.usableLiftTopM = profile.site.modelElevationM + 600 + i * 50;
  return profile;
};

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

function inspector(t: TestContext, view: WindgramView, mode: 'lift' | 'height' = 'lift') {
  class Point {
    x: number; y: number;
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    matrixTransform(matrix: { scale: number; offsetX?: number; offsetY?: number }) { return new Point(this.x * matrix.scale + (matrix.offsetX ?? 0), this.y * matrix.scale + (matrix.offsetY ?? 0)); }
  }
  globalThis.DOMPoint = Point as unknown as typeof DOMPoint;
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
  const cleanup = mountWindgramInspector(host as unknown as HTMLElement, null, view, time => selected.push(time), undefined, { mode });
  t.after(cleanup);
  const pointer = (type: string, x: number, y: number, pointerType = "mouse") => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, pointerType, pointerId: 1, isPrimary: true });
    host.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, "pointer inspection leaves native scrolling available");
  };
  const key = (key: string) => { const event = new Event("keydown", { cancelable: true }); Object.assign(event, { key }); host.dispatchEvent(event); return event; };
  return { nodes, host, bounds, matrix, selected, pointer, key, cleanup, attributes, ownerDocument };
}

test('height inspection handles missing lift and keeps altitude on hour changes', t => {
  const p = liftProfile();
  for (const hour of p.hours) hour.derived.usableLiftTopM = null;
  const view = buildWindgramView(p, { timeZone: 'Etc/UTC', unitSystem: 'metric', heightRange: 'full' });
  const h = inspector(t, view, 'height');
  const height = view.floorM + 500;
  h.pointer('pointerdown', view.hours[0].x, heightToY(view, height), 'touch');
  h.pointer('pointerup', view.hours[0].x, heightToY(view, height), 'touch');
  assert.match(h.attributes.get('aria-label')!, /Inspected height/);
  close(Number(h.nodes['cursor-point'].getAttribute('cy')), heightToY(view, height));
  h.key('ArrowRight');
  close(Number(h.nodes['cursor-point'].getAttribute('cy')), heightToY(view, height));
  assert.equal(h.key('ArrowUp').defaultPrevented, true);
  close(Number(h.nodes['cursor-point'].getAttribute('cy')), heightToY(view, height + 100));
  assert.match(h.attributes.get('aria-label')!, /Dew point/);
  assert.match(h.attributes.get('aria-label')!, /CIN/);
});

test('programmatic inspection clears stale readings and stops after disposal', t => {
  const view = buildWindgramView(liftProfile(), { timeZone: 'Etc/UTC', heightRange: 'full' });
  const h = inspector(t, view);
  const instructions = h.attributes.get('aria-label');
  h.cleanup.select(0);
  assert.match(h.attributes.get('aria-label')!, /Lift top ·/);
  h.cleanup.select(null);
  assert.equal(h.attributes.get('aria-label'), instructions);
  assert.equal(h.nodes['windgram-cursor'].getAttribute('visibility'), 'hidden');
  h.cleanup.select(1);
  h.cleanup.select(view.hours.length);
  assert.equal(h.attributes.get('aria-label'), instructions);
  h.cleanup();
  h.cleanup.select(0);
  assert.equal(h.attributes.has('aria-label'), false);
});

test('height keys stay inside daylight after clearing an off-chart hour', t => {
  const profile = liftProfile();
  Object.assign(profile.site, { latitude: 45, longitude: 0 });
  profile.hours = Array.from({ length: 8 }, (_, index) => ({
    ...structuredClone(profile.hours[0]), validAt: new Date(Date.parse('2026-10-25T00:00:00Z') + index * 3 * 3_600_000).toISOString(),
  }));
  const view = buildWindgramView(profile, { timeZone: 'Etc/UTC', heightRange: 'full' });
  const visible = visibleWindgramHourIndices(view, 0);
  assert.ok(visible[0] > 0, 'the view retains an earlier source hour outside daylight');
  const h = inspector(t, view, 'height');
  for (const index of [0, view.hours.length + 10]) {
    h.cleanup.select(null);
    view.selectedHourIndex = index;
    h.key('ArrowUp');
    const selectedIndex = view.hours.findIndex(hour => hour.validAt === h.selected.at(-1));
    assert.ok(visible.includes(selectedIndex));
    close(Number(h.nodes['cursor-point'].getAttribute('cx')), view.hours[selectedIndex].x);
  }
});

test('calm surface wind omits direction in the inspector', t => {
  const profile = liftProfile();
  profile.hours[0].surface.windSpeedMps = 0;
  profile.hours[0].surface.windDirectionDeg = 90;
  const view = buildWindgramView(profile, { timeZone: 'Etc/UTC', heightRange: 'full' });
  const h = inspector(t, view);
  h.cleanup.select(0);
  assert.match(h.attributes.get('aria-label')!, /Model surface wind 0 mph ·/);
});

test("hover snaps to each hour's usable-lift line regardless of pointer height", t => {
  const profile = liftProfile();
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", compact: true, heightRange: "full", widthPx: 320, launch: { elevationM: profile.site.modelElevationM + 200 } });
  assert.match(renderWindgramSvg(view), /data-cursor-agl/);
  const h = inspector(t, view);
  for (const hour of view.hours) for (const pointerY of [view.top + 1, (view.top + view.bottom) / 2, view.bottom - 1]) {
    const z = hour.usableLiftTopM!;
    h.pointer("pointermove", hour.x, pointerY);
    assert.equal(h.nodes["cursor-agl"].textContent, `${Math.round((z - view.ground.elevationM) / .3048).toLocaleString("en-US")} ft AGL`);
    assert.equal(h.nodes["cursor-msl"].textContent, `${Math.round(z / .3048).toLocaleString("en-US")} ft MSL`);
    close(Number(h.nodes["cursor-point"].getAttribute("cx")), hour.x);
    close(Number(h.nodes["cursor-point"].getAttribute("cy")), heightToY(view, z));
    close(Number(h.nodes["cursor-horizontal"].getAttribute("y1")), heightToY(view, z));
    assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "visible");
  }
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

test("inspection follows the view's units while the global preference differs", t => {
  for (const unitSystem of ["metric", "imperial"] as const) {
    setUnitSystem(unitSystem === "metric" ? "imperial" : "metric");
    const view = buildWindgramView(liftProfile(), {
      timeZone: "Etc/UTC", compact: true, heightRange: "full", widthPx: 390, unitSystem,
    });
    const h = inspector(t, view);
    h.key("Home");
    const agl = view.hours[0].usableLiftTopM! - view.ground.elevationM;
    const expected = unitSystem === "metric"
      ? `${Math.round(agl).toLocaleString("en-US")} m AGL`
      : `${Math.round(agl / .3048).toLocaleString("en-US")} ft AGL`;
    assert.equal(h.nodes["cursor-agl"].textContent, expected);
    assert.match(h.attributes.get("aria-label")!, unitSystem === "metric" ? /m\/s/ : /kt/);
    assert.match(h.attributes.get("aria-label")!, unitSystem === "metric" ? /°C/ : /°F/);
    setUnitSystem(unitSystem);
    h.key("Home");
    assert.equal(h.nodes["cursor-agl"].textContent, expected);
  }
});

test("the readout names the document's gust class and the earlier lift method only when they apply", t => {
  const readout = (profile: ReturnType<typeof liftProfile>) => {
    const view = buildWindgramView(profile, { timeZone: "Etc/UTC", compact: true, heightRange: "full", widthPx: 390, unitSystem: "metric" });
    const h = inspector(t, view);
    h.key("Home");
    return { view, text: h.attributes.get("aria-label")! };
  };
  const declared = liftProfile();
  assert.equal(declared.semantics?.gust, "hourMax", "fixture declares the hour-max class");
  declared.hours[0].surface.windGustMps = 7;
  const hourMax = readout(declared);
  assert.equal(hourMax.view.gustSemantics, "hourMax");
  assert.deepEqual(hourMax.view.hours.map(hour => hour.liftFamily).slice(0, 2), ["v1-legacy", "v1-legacy"], "the fixture publishes only hour.derived");
  assert.match(hourMax.text, /Surface hour-max gust 7\.0 m\/s/);
  assert.match(hourMax.text, /Earlier lift method \(v1\)/);

  const sampled = liftProfile();
  sampled.semantics = { ...sampled.semantics, gust: "instant" };
  sampled.hours[0].surface.windGustMps = 7;
  assert.match(readout(sampled).text, /Surface gust sample 7\.0 m\/s/);

  const undeclared = liftProfile();
  delete undeclared.semantics;
  undeclared.hours[0].surface.windGustMps = 7;
  const plain = readout(undeclared);
  assert.equal(plain.view.gustSemantics, null);
  assert.match(plain.text, /Surface gust 7\.0 m\/s/, "an undeclared class keeps the plain word, never a default");

  const current = liftProfile();
  for (const hour of current.hours) {
    (hour as typeof hour & { soaring: unknown }).soaring = {
      thermalVelocityV2Mps: hour.derived.thermalVelocityMps, usableLiftTopV2M: hour.derived.usableLiftTopM,
      resolvedThermalTopM: hour.derived.boundaryLayerTopM, surfaceLclM: hour.derived.cloudBaseM,
    };
  }
  const v2 = readout(current);
  assert.equal(v2.view.hours[0].liftFamily, "v2");
  assert.doesNotMatch(v2.text, /Earlier lift method/);
});

test("unavailable daylight edges stay blank and cannot select a forecast hour", t => {
  const profile = liftProfile();
  Object.assign(profile.site, { latitude: 40.5913, longitude: 44.4741, timeZone: "Asia/Yerevan" });
  profile.hours = profile.hours.slice(0, 3).map((hour, index) => ({ ...hour, validAt: `2026-10-24T${String(9 + index).padStart(2, "0")}:00:00.000Z` }));
  const view = buildWindgramView(profile, { timeZone: "Asia/Yerevan", compact: true, widthPx: 390, heightRange: "full" });
  const h = inspector(t, view), y = (view.top + view.bottom) / 2;
  assert.equal(view.timeAxis[0].label, "8a");
  assert.equal(view.timeAxis.at(-1)!.label, "6p");
  assert.equal(view.timeAxis[0].hourIndex, null);
  assert.equal(view.timeAxis.at(-1)!.hourIndex, null);
  const rendered = renderWindgramSvg(view);
  assert.match(rendered, /Windgram 8a–6p/, "accessible description uses visible daylight ticks");
  assert.match(rendered, />8a</);
  assert.match(rendered, />6p</, 'the final daylight label stays visible inside the chart');
  assert.equal([...rendered.matchAll(/data-forecast-unavailable=""/g)].length, 2, "both unavailable edges receive the missing-data treatment");
  for (const tick of [view.timeAxis[0], view.timeAxis.at(-1)!]) {
    h.pointer("pointermove", view.hours[0].x, y);
    assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "visible");
    h.pointer("pointermove", tick.x, y);
    assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "hidden", "hovering an unavailable edge hides the forecast reading");
    h.pointer("pointerdown", tick.x, y, "touch");
    h.pointer("pointerup", tick.x, y, "touch");
    assert.deepEqual(h.selected, [], "an unavailable edge cannot select the nearest real forecast");
  }
  h.key("Home");
  assert.deepEqual(h.selected, [view.hours[0].validAt]);
  close(Number(h.nodes["cursor-point"].getAttribute("cx")), view.hours[0].x);
  h.key("ArrowRight");
  assert.equal(h.selected.at(-1), view.hours[1].validAt);
  h.key("End");
  assert.equal(h.selected.at(-1), view.hours.at(-1)!.validAt);
  h.key("Escape");
  h.pointer("pointerdown", view.hours[0].x, y, "touch");
  h.pointer("pointerup", view.hours[0].x, y, "touch");
  assert.equal(h.selected.at(-1), view.hours[0].validAt, "a tap at the shifted first source column selects that source hour");
  close(Number(h.nodes["cursor-point"].getAttribute("cx")), view.hours[0].x);
});

test('coarse daylight inspection selects visible native hours while retaining night brackets for interpolation', t => {
  const profile = liftProfile();
  Object.assign(profile.site, { latitude: -45.03, longitude: 168.66, timeZone: 'Pacific/Auckland' });
  profile.hours = Array.from({ length: 7 }, (_, index) => ({
    ...structuredClone(profile.hours[0]), validAt: new Date(Date.parse('2026-12-20T15:00:00Z') + index * 3 * 3_600_000).toISOString(),
  }));
  profile.hours[0].derived.thermalVelocityMps = 9;
  profile.hours[3].derived.thermalVelocityMps = 5;
  const view = buildWindgramView(profile, { timeZone: 'Pacific/Auckland', compact: true, widthPx: 390, heightRange: 'full' });
  assert.equal(view.hours.length, 7);
  assert.ok(view.hours[0].x < view.left && view.hours.at(-1)!.x > view.left + view.plotWidth);
  assert.equal(view.selectedHourIndex, 3, 'peak selection ignores the hidden nighttime maximum');
  const h = inspector(t, view), y = (view.top + view.bottom) / 2;
  h.key('Home');
  h.key('ArrowLeft');
  assert.deepEqual(h.selected, [view.hours[1].validAt, view.hours[1].validAt]);
  h.key('End');
  h.key('ArrowRight');
  assert.equal(h.selected.at(-1), view.hours[5].validAt);
  for (const [x, index] of [[view.left + 1, 1], [view.left + view.plotWidth - 1, 5]]) {
    h.pointer('pointerdown', x, y, 'touch');
    h.pointer('pointerup', x, y, 'touch');
    assert.equal(h.selected.at(-1), view.hours[index].validAt);
    close(Number(h.nodes['cursor-point'].getAttribute('cx')), view.hours[index].x);
  }
});

test("touch pins the lift ceiling; dragging, cancellation and Escape leave scrolling and clearing intact", t => {
  const profile = liftProfile(), ground = profile.site.modelElevationM + 300;
  profile.hours[0].derived.usableLiftTopM = ground - 100;
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", widthPx: 700, launch: { elevationM: ground } });
  const h = inspector(t, view), x = view.hours[0].x, y = view.top + 20;
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
  close(Number(h.nodes["cursor-point"].getAttribute("cy")), heightToY(view, view.hours[1].usableLiftTopM!));
  const selectedCount = h.selected.length, pinnedY = h.nodes["cursor-point"].getAttribute("cy");
  for (const key of ["ArrowUp", "ArrowDown"]) assert.equal(h.key(key).defaultPrevented, false, "vertical arrows retain native scrolling");
  assert.equal(h.selected.length, selectedCount);
  assert.equal(h.nodes["cursor-point"].getAttribute("cy"), pinnedY);
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
  const view = buildWindgramView(liftProfile(), { timeZone: "Etc/UTC", widthPx: 1000 });
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
  assert.ok(y + h.matrix.offsetY >= 0, "card stays below the visible plot top");
  assert.ok(y + h.matrix.offsetY + 47 <= 300);
  h.pointer("pointermove", 350, 290);
  const lowerY = Number(h.nodes["cursor-readout"].getAttribute("transform")!.match(/[\d.]+/g)![1]);
  assert.ok(lowerY + h.matrix.offsetY >= 0 && lowerY + h.matrix.offsetY + 47 <= 300);
});

test("metric inspection and a scaled chart preserve physical height and model-ground fallback", t => {
  setUnitSystem("metric");
  const profile = liftProfile();
  profile.hours[0].derived.usableLiftTopM = profile.site.modelElevationM + 200;
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", compact: true, widthPx: 390 });
  const h = inspector(t, view);
  h.matrix.scale = .75;
  h.bounds.right = view.width * .75;
  h.pointer("pointermove", view.hours[0].x * .75, (view.top + 1) * .75);
  assert.equal(h.nodes["cursor-agl"].textContent, "200 m AGL");
  close(Number(h.nodes["cursor-point"].getAttribute("cy")), heightToY(view, view.ground.elevationM + 200));
  assert.match(h.nodes["cursor-msl"].textContent, /m MSL · model ref$/);
  assert.doesNotMatch(h.attributes.get("aria-label")!, /\bft\b/);
});

test("missing or clipped lift ceilings hide heights while taps and keys still select hours", t => {
  const profile = liftProfile();
  const floor = profile.site.modelElevationM;
  profile.hours[1].derived.usableLiftTopM = null;
  profile.hours[2].derived.usableLiftTopM = floor - 1;
  profile.hours[3].derived.usableLiftTopM = 20_000;
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", widthPx: 700 });
  const h = inspector(t, view), pointerY = (view.top + view.bottom) / 2;
  for (const index of [1, 2, 3]) {
    h.pointer("pointermove", view.hours[0].x, pointerY);
    assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "visible");
    const hour = view.hours[index];
    h.pointer("pointermove", hour.x, pointerY);
    assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "hidden", "a missing ceiling never inherits a stale height or clamps to the plot edge");
    assert.doesNotMatch(h.attributes.get("aria-label")!, /Lift top · .*ft AGL/);
    assert.match(h.attributes.get("aria-label")!, /Model surface wind/);
    h.pointer("pointerdown", hour.x, pointerY, "touch");
    h.pointer("pointerup", hour.x, pointerY, "touch");
    assert.equal(h.selected.at(-1), hour.validAt);
    assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "hidden");
    h.key("Escape");
  }
  h.key("Home");
  assert.equal(h.selected.at(-1), view.hours[0].validAt);
  assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "visible");
  for (const index of [1, 2, 3]) {
    h.key("ArrowRight");
    assert.equal(h.selected.at(-1), view.hours[index].validAt);
    assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "hidden");
  }
  h.key("ArrowRight");
  assert.equal(h.selected.at(-1), view.hours[4].validAt);
  assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "visible");
  h.key("End");
  assert.equal(h.selected.at(-1), view.hours.at(-1)!.validAt);
  h.key("ArrowLeft");
  assert.equal(h.selected.at(-1), view.hours.at(-2)!.validAt);
});

test("focused cropping hides a ceiling below launch; full height keeps its signed launch AGL", t => {
  const profile = liftProfile(), launchM = profile.site.modelElevationM + 300;
  profile.hours[0].derived.usableLiftTopM = launchM - 100;
  const options = { timeZone: "Etc/UTC", widthPx: 390, compact: true, launch: { elevationM: launchM } };
  const focused = buildWindgramView(profile, options), full = buildWindgramView(profile, { ...options, heightRange: "full" });
  const focusedInspector = inspector(t, focused), fullInspector = inspector(t, full);
  focusedInspector.pointer("pointermove", focused.hours[0].x, focused.bottom - 1);
  assert.equal(focusedInspector.nodes["windgram-cursor"].getAttribute("visibility"), "hidden");
  fullInspector.pointer("pointermove", full.hours[0].x, full.top + 1);
  assert.equal(fullInspector.nodes["cursor-agl"].textContent, "-328 ft AGL");
  close(Number(fullInspector.nodes["cursor-point"].getAttribute("cy")), heightToY(full, launchM - 100));
  focusedInspector.pointer("pointermove", focused.hours[1].x, focused.top + 1);
  fullInspector.pointer("pointermove", full.hours[1].x, full.bottom - 1);
  assert.equal(focusedInspector.nodes["cursor-agl"].textContent, fullInspector.nodes["cursor-agl"].textContent);
  assert.equal(focusedInspector.nodes["cursor-msl"].textContent, fullInspector.nodes["cursor-msl"].textContent);
});

test("inspection uses published V2 ceilings and ensemble medians, preserving unavailable values", t => {
  const profile = liftProfile();
  const median = profile.site.modelElevationM + 800;
  Object.assign(profile.hours[0], { soaring: { thermalVelocityV2Mps: 2, usableLiftTopV2M: null } });
  Object.assign(profile.hours[1], { soaring: { thermalVelocityV2Mps: 2, usableLiftTopV2M: { p25: median - 200, p50: median, p75: median + 300 } } });
  Object.assign(profile.hours[2], { soaring: { thermalVelocityV2Mps: 2, usableLiftTopV2M: { p25: median - 200, p50: null, p75: median + 300 } } });
  Object.assign(profile.hours[3], { soaring: { thermalVelocityV2Mps: 2, usableLiftTopV2M: median + 100, hcritWxtoflyM: median - 150 } });
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", widthPx: 700 });
  assert.deepEqual(view.hours.slice(0, 4).map(hour => hour.usableLiftTopM), [null, median, null, median + 100]);
  const h = inspector(t, view);
  for (const index of [0, 2]) {
    h.pointer("pointermove", view.hours[index].x, view.top + 1);
    assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "hidden", "a missing V2 ceiling stays missing despite the legacy diagnostic");
  }
  for (const [index, height] of [[1, median], [3, median + 100]]) {
    h.pointer("pointermove", view.hours[index].x, view.bottom - 1);
    assert.equal(h.nodes["windgram-cursor"].getAttribute("visibility"), "visible");
    close(Number(h.nodes["cursor-point"].getAttribute("cy")), heightToY(view, height));
    assert.equal(h.nodes["cursor-agl"].textContent, `${Math.round((height - view.ground.elevationM) / .3048).toLocaleString("en-US")} ft AGL`);
  }
});
