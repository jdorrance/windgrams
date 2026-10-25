import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSiteForecast } from "@azohra/meteo.briefing/contract";
import {  buildWindgramView, type WindgramBarb  } from "./helpers/windgram.ts";
import {  renderWindgramKey, renderWindgramSvg  } from "./helpers/windgram.ts";
import {  cloudGlyphBounds, freezingGlyphBounds, windBarbGlyph, wingGlyphBounds  } from "./helpers/windgram.ts";
import {  displayedBarbs, layoutWindgramMarks, overlaps  } from "./helpers/windgram.ts";
import {  WINDGRAM_STABILITY  } from "./helpers/windgram.ts";

const fixture = () => {
  const source = parseSiteForecast(JSON.parse(readFileSync(new URL("../dev-data-src/convective-cycle.profile.json", import.meta.url), "utf8")));
  assert.ok(source);
  return source;
};
const viewOf = (compact = true) => buildWindgramView(fixture(), {
  compact, widthPx: compact ? 390 : 800, timeZone: "America/New_York", heightRange: "full",
  launch: { name: "Caption removed", elevationM: 1000 }, unitSystem: "imperial",
});

test("main chart uses aligned fixed rows, shared fonts and one timezone footer", () => {
  for (const compact of [true, false]) {
    const view = viewOf(compact), svg = renderWindgramSvg(view);
    assert.match(svg, /font-family: Arial, Helvetica, sans-serif/);
    assert.match(svg, /\.wg-hour \{ font-size: 12px/);
    assert.match(svg, /\.wg-lift \{[^}]+font-size: 14px/);
    assert.match(svg, /\.wg-axis-unit \{[^}]+font-size: 11px/);
    assert.equal(view.top, 56);
    assert.equal(view.height - view.bottom, 56);
    const tops = [...svg.matchAll(/<text x="([\d.]+)" y="16"[^>]+class="wg-hour wg-hour-top">([^<]+)<\/text>/g)].map(m => [m[1], m[2]]);
    const bottoms = [...svg.matchAll(new RegExp(`<text x="([\\d.]+)" y="${view.bottom + 24}"[^>]+class="wg-hour">([^<]+)<\\/text>`, "g"))].map(m => [m[1], m[2]]);
    assert.ok(tops.length > 1);
    assert.deepEqual(tops, bottoms);
    const footer = [...svg.matchAll(/<text[^>]+class="wg-axis-unit wg-footer">([^<]+)<\/text>/g)];
    assert.equal(footer.length, 1);
    assert.match(footer[0][1], /E[DS]T · Wind kt · temperature °F/);
    assert.doesNotMatch(svg, /Caption removed|class="wg-launch"/);
  }
});

test("wind display spacing keeps native levels before filling gaps on every screen size", () => {
  for (const compact of [true, false]) {
    const view = viewOf(compact), originals = structuredClone(view.barbs);
    const sample = view.barbs.find(barb => !barb.interpolated)!;
    view.barbs = [0, 1, 2].flatMap(hourIndex => [
      { ...sample, hourIndex, x: view.left + 50 + hourIndex * 25, y: view.top + 100, interpolated: true },
      { ...sample, hourIndex, x: view.left + 50 + hourIndex * 25, y: view.top + 110, interpolated: false },
      { ...sample, hourIndex, x: view.left + 50 + hourIndex * 25, y: view.top + 150, interpolated: false },
      { ...sample, hourIndex, x: view.left + 50 + hourIndex * 25, y: view.top + 190, interpolated: true },
    ]);
    const before = structuredClone(view.barbs);
    const displayed = displayedBarbs(view, new Set([0, 1, 2]));
    assert.deepEqual(new Set(displayed.map(b => b.hourIndex)), new Set([0, 2]));
    assert.ok(displayed.some(b => b.interpolated && b.y === view.top + 190));
    assert.ok(displayed.every(b => b.y !== view.top + 100), "nearby interpolated mark yields to native level");
    for (const a of displayed) for (const b of displayed) if (a !== b) {
      if (a.hourIndex === b.hourIndex) assert.ok(Math.abs(a.y - b.y) >= 28);
      else assert.ok(Math.abs(a.x - b.x) >= 40);
    }
    assert.deepEqual(view.barbs, before);
    view.barbs = originals;
  }
});

test("every calm, staff, feather and pennant has an outline in the rendered SVG", () => {
  const view = viewOf(false), source = view.barbs[0];
  view.contours = []; view.clouds = []; view.wings = []; view.freezing = [];
  view.barbs = [0, 5, 10, 75].map((speedKt, i) => ({ ...source, hourIndex: i, speedKt, directionDeg: 0, x: view.left + 60 + i * 100, y: view.top + 100 }));
  const svg = renderWindgramSvg(view);
  const glyphs = [...svg.matchAll(/<g transform="translate\([^)]+\)"[^>]+data-wind-source="[^"]+"><title>[^<]+<\/title>(.*?)<\/g>/g)];
  assert.equal(glyphs.length, 4);
  for (const [, glyph] of glyphs) {
    assert.equal([...glyph.matchAll(/class="wg-barb-rim"/g)].length, [...glyph.matchAll(/class="wg-barb"/g)].length);
  }
  assert.match(svg, /<circle r="3" class="wg-barb-rim"\/><circle r="3" class="wg-barb"/);
  assert.match(svg, /M0,0L0\.0,-24\.0/);
});

test("temperature labels avoid rendered cloud, wind, wing and freezing glyph bounds", () => {
  for (const compact of [false, true]) {
    const view = viewOf(compact);
    const clouds = view.clouds.filter(c => c.kind === "potential"), scale = 0.5;
    const thinned = displayedBarbs(view, new Set(view.hours.map((_, i) => i)));
    const { labels, barbs } = layoutWindgramMarks(view, scale, clouds, thinned);
    const obstacles = [
      ...clouds.map(c => cloudGlyphBounds(c.x, c.y, scale)),
      ...view.wings.map(w => wingGlyphBounds(w.x, w.y)),
      ...view.freezing.map(f => freezingGlyphBounds(f.x, f.y)),
      ...barbs.map(b => windBarbGlyph(b, view.presentation, view.unitSystem).bounds),
    ];
    assert.ok(labels.length > 0);
    assert.ok(barbs.length >= thinned.length * 0.75, "labels retain most wind samples");
    for (const label of labels) for (const obstacle of obstacles) assert.equal(overlaps(label.box, obstacle), false);
  }
});

test("one contour label can replace a conflicting wind mark without erasing a whole column", () => {
  const view = viewOf(false), y = view.top + 100;
  view.clouds = []; view.wings = []; view.freezing = [];
  view.contours = [{ temperatureF: 40, path: "", labels: [{ x: view.left + 100, y }], segments: [], components: [{
    minX: view.left + 100, maxX: view.left + 100, minY: y, maxY: y,
    candidates: [{ x: view.left + 100, y }], segments: [],
  }] }];
  const sample = view.barbs[0];
  const barbs: WindgramBarb[] = [0, 50, 100].map(dy => ({ ...sample, speedKt: 0, x: view.left + 100, y: y + dy }));
  const layout = layoutWindgramMarks(view, 1, [], barbs);
  assert.equal(layout.labels.length, 1);
  assert.deepEqual(layout.barbs, barbs.slice(1));
});

test("model cloud hatching and the key retain the requested palette and diagnostic hierarchy", () => {
  const view = viewOf(false);
  view.cloudBands.push({ x: view.left, y: view.top, width: 30, height: 40, kind: "model", coverPercent: 30 });
  const svg = renderWindgramSvg(view), key = renderWindgramKey("imperial");
  assert.match(svg, /fill="url\(#windgram-model-cloud\)" data-cloud-band="model"/);
  assert.match(svg, /stroke-width="1"[^>]+opacity="0.55" data-height-series="boundaryLayerTopM"/);
  assert.match(svg, /stroke-width="1.5"[^>]+opacity="1" data-height-series="usableLiftTopM"/);
  for (const { color } of WINDGRAM_STABILITY) { assert.ok(svg.includes(color)); assert.ok(key.includes(color)); }
  assert.match(key, /Sparse white diagonal hatching: model cloud ≥30%/);
  assert.doesNotMatch(key, /Pale bands/);
});


test("a daylight axis without forecast hours stays fully hatched", () => {
  const view = viewOf(true);
  view.hours = []; view.barbs = []; view.contours = []; view.clouds = [];
  view.cloudBands = []; view.wings = []; view.freezing = []; view.series = []; view.fields = [];
  view.timeAxis = view.timeAxis.map(hour => ({ ...hour, hourIndex: null }));
  const svg = renderWindgramSvg(view);
  assert.match(svg, new RegExp(`<rect x="${view.left}" y="${view.top}" width="${view.plotWidth}" height="${view.plotHeight}" fill="url\\(#windgram-missing\\)" data-forecast-unavailable=""`));
  assert.match(svg, /Daylight forecast unavailable in this run/);
  assert.match(svg, />Unavailable<\/text>/);
});
