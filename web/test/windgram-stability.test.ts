import test, { afterEach } from "node:test";
import { setUnitSystem } from "../src/lib/units.ts";
afterEach(() => setUnitSystem("imperial"));
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSiteForecast } from "@azohra/meteo.briefing/contract";
import { buildWindgramView } from "../src/lib/windgram-view.ts";
import { renderWindgramKey, renderWindgramSvg } from "../src/lib/windgram-chart.ts";
import { WINDGRAM_STABILITY, stabilityRange } from "../src/lib/windgram-stability.ts";

function uniformLapseView(lapseCPer1000Ft: number) {
  const profile = parseSiteForecast(JSON.parse(readFileSync(new URL("../dev-data-src/convective-cycle.profile.json", import.meta.url), "utf8")))!;
  profile.hours = profile.hours.slice(0, 2);
  for (const hour of profile.hours) {
    hour.surface.temperatureC = 20;
    for (const level of hour.levels) level.temperatureC = 20 + (level.heightM - profile.site.modelElevationM) / 304.8 * lapseCPer1000Ft;
  }
  return buildWindgramView(profile, { timeZone: "Etc/UTC", widthPx: 600 });
}

// Classified fields contain nested rings rendered with fill-rule="evenodd".
// A nonempty path alone does not mean its interior is visibly painted.
function paintsPoint(path: string, x: number, y: number) {
  let painted = false;
  for (const ring of path.matchAll(/M([^Z]+)Z/g)) {
    const points = [...ring[1].matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])]);
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i], [xj, yj] = points[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) painted = !painted;
    }
  }
  return painted;
}

test("lapse colors and boundaries match the published WxToFly legend", () => {
  // Interior RGB samples at y=53, x=40/100/170/240/305/370/500/570 in
  // http://wxtofly.net/images/locallapserates.png (606 × 89 pixels).
  assert.deepEqual(WINDGRAM_STABILITY.map((band) => band.color), [
    "#ff3c39", "#ff9900", "#ffbaff", "#cdbeff", "#fff2e6", "#7b7de6", "#cdcecd", "#9c999c",
  ]);
  assert.deepEqual(WINDGRAM_STABILITY.map((band) => band.maxLapse), [-3, -2.5, -2, -1.5, -1.2, 0, .5, Infinity]);
  const svg = renderWindgramSvg(uniformLapseView(-.5));
  const key = renderWindgramKey();
  for (const [i, band] of WINDGRAM_STABILITY.entries()) {
    assert.ok(svg.includes(`.meteo-gram-stab-${band.className} { fill: ${band.color}; }`));
    assert.ok(key.includes(`style="--chip:${band.color}">${stabilityRange(i)}</span>`));
  }
  assert.match(key, /°F\/1,000 ft/);
});

test("filled bands use signed degrees Celsius per 1,000 feet on both sides of each guide threshold", () => {
  for (const [index, band] of WINDGRAM_STABILITY.slice(0, -1).entries()) {
    for (const [offset, expectedIndex] of [[-.01, index], [.01, index + 1]]) {
      const lapse = band.maxLapse + offset;
      const view = uniformLapseView(lapse);
      for (const hour of view.sampling) for (const node of hour.lapseCPer1000Ft) {
        assert.ok(Math.abs(node.value - lapse) < 1e-10, `${node.value} retains the signed °C/1,000ft gradient ${lapse}`);
      }
      for (const heightFraction of [.25, .5, .75]) {
        const x = view.left + view.plotWidth / 2, y = view.top + view.plotHeight * heightFraction;
        const classes = view.fields.filter((field) => paintsPoint(field.path, x, y)).map((field) => field.className);
        assert.deepEqual(classes, [`meteo-gram-stab-${WINDGRAM_STABILITY[expectedIndex].className}`], `palette transition at ${band.maxLapse}, offset ${offset}`);
      }
    }
  }
});


test("lapse legend converts display boundaries without changing WxToFly physics", () => {
  const imperial = uniformLapseView(-2.7);
  assert.equal(stabilityRange(0), "≤ −5.4");
  assert.equal(stabilityRange(5), "−2.16 to 0");
  assert.match(renderWindgramKey(), /half 5 \/ full 10 \/ flag 50 kt/);
  setUnitSystem("metric");
  assert.equal(stabilityRange(0), "≤ −9.84");
  assert.equal(stabilityRange(5), "−3.94 to 0");
  const key = renderWindgramKey();
  assert.match(key, /°C\/km/);
  assert.match(key, /half 2.5 \/ full 5 \/ flag 25 m\/s/);
  assert.match(key, /&lt;4.63 m\/s/);
  assert.match(key, /0 °C freezing level/);
  assert.deepEqual(uniformLapseView(-2.7).fields, imperial.fields);
});
