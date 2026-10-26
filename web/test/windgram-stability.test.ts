import test, { afterEach } from "node:test";
import { setUnitSystem } from "../src/lib/units.ts";
afterEach(() => setUnitSystem("imperial"));
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSiteForecast } from "@azohra/meteo.briefing/contract";
import {  buildWindgramView, heightToY  } from "./helpers/windgram.ts";
import {  renderWindgramKey, renderWindgramSvg  } from "./helpers/windgram.ts";
import {  WINDGRAM_STABILITY, stabilityRange  } from "./helpers/windgram.ts";

function uniformLapseView(lapseCPer1000Ft: number) {
  const profile = parseSiteForecast(JSON.parse(readFileSync(new URL("../dev-data-src/convective-cycle.profile.json", import.meta.url), "utf8")))!;
  profile.hours = profile.hours.slice(0, 2);
  for (const hour of profile.hours) {
    hour.surface.temperatureC = 20;
    for (const level of hour.levels) level.temperatureC = 20 + (level.heightM - (profile.site.modelElevationM + 2)) / 304.8 * lapseCPer1000Ft;
  }
  return buildWindgramView(profile, { timeZone: "Etc/UTC", widthPx: 600 });
}

// Classified fields contain nested rings rendered with fill-rule="evenodd".
// A nonempty path alone does not mean its interior is visibly painted.
function paintsPoint(path: string, x: number, y: number) {
  let painted = false;
  for (const ring of path.matchAll(/M([^Z]+)Z/g)) {
    // Missing-data masks use relative h/v commands; contour rings use M/L.
    const tokens = (`M${ring[1]}`).match(/[MLHVmlhv]|-?(?:\d*\.)?\d+(?:e[+-]?\d+)?/g) ?? [];
    const points: number[][] = [];
    let command = "M", px = 0, py = 0;
    for (let i = 0; i < tokens.length;) {
      if (/^[MLHVmlhv]$/.test(tokens[i])) command = tokens[i++];
      const relative = command === command.toLowerCase();
      if (command.toUpperCase() === "H") px = (relative ? px : 0) + Number(tokens[i++]);
      else if (command.toUpperCase() === "V") py = (relative ? py : 0) + Number(tokens[i++]);
      else {
        px = (relative ? px : 0) + Number(tokens[i++]);
        py = (relative ? py : 0) + Number(tokens[i++]);
      }
      points.push([px, py]);
    }
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
    "#ff4444", "#ff9900", "#ffbbff", "#ccbbff", "#ffeeee", "#7777dd", "#cccccc", "#999999",
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

test("interval lapse values stay exact while the displayed bands blend between layer midpoints", () => {
  const profile = parseSiteForecast(JSON.parse(readFileSync(new URL("../dev-data-src/convective-cycle.profile.json", import.meta.url), "utf8")))!;
  profile.site.modelElevationM = 0;
  profile.hours = profile.hours.slice(0, 2).map((hour) => ({
    ...hour,
    surface: { ...hour.surface, temperatureC: 20, dewPointC: 0 },
    levels: [
      { pressureHpa: 950, heightM: 500, temperatureC: 15, dewPointC: -5, windSpeedMps: 3, windDirectionDeg: 180 },
      { pressureHpa: 900, heightM: 1000, temperatureC: 20, dewPointC: -5, windSpeedMps: 3, windDirectionDeg: 180 },
      { pressureHpa: 850, heightM: 1500, temperatureC: 15, dewPointC: -5, windSpeedMps: 3, windDirectionDeg: 180 },
    ],
  }));
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", widthPx: 600 });
  const x = view.left + view.plotWidth / 2;
  const classesAtHeight = (z: number) => {
    const y = heightToY(view, z);
    return view.fields.filter((field) => paintsPoint(field.path, x, y)).map((field) => field.className);
  };
  for (const hour of view.sampling) {
    assert.deepEqual(hour.lapseCPer1000Ft.map(node => Math.round(node.value * 1000) / 1000),
      [-3.060, -3.060, 3.048, 3.048, -3.048, -3.048]);
  }
  // Each measured interval retains its gradient at its true height midpoint.
  assert.deepEqual(classesAtHeight(250), ["meteo-gram-stab-very-unstable"]);
  assert.deepEqual(classesAtHeight(750), ["meteo-gram-stab-strong-inversion"]);
  assert.deepEqual(classesAtHeight(1250), ["meteo-gram-stab-very-unstable"]);
  // Smooth display reconstruction gives intermediate colors inside the layer,
  // replacing the flat blocks without changing the measured interval values.
  assert.deepEqual(classesAtHeight(350), ["meteo-gram-stab-conditional"]);
  assert.deepEqual(classesAtHeight(450), ["meteo-gram-stab-stable"]);
  assert.deepEqual(classesAtHeight(550), ["meteo-gram-stab-strong-inversion"]);
});

test("display smoothing keeps inversion boundaries at their source heights for unequal layers", () => {
  const profile = parseSiteForecast(JSON.parse(readFileSync(new URL("../dev-data-src/convective-cycle.profile.json", import.meta.url), "utf8")))!;
  profile.site.modelElevationM = 0;
  const coolTopC = 20 - .6 * 1000 / 304.8;
  profile.hours = profile.hours.slice(0, 2).map(hour => ({
    ...hour,
    surface: { ...hour.surface, temperatureC: 20, dewPointC: 0 },
    levels: [
      { pressureHpa: 900, heightM: 1000, temperatureC: coolTopC, dewPointC: -5, windSpeedMps: 3, windDirectionDeg: 180 },
      { pressureHpa: 875, heightM: 1200, temperatureC: coolTopC + 3 * 200 / 304.8, dewPointC: -5, windSpeedMps: 3, windDirectionDeg: 180 },
      { pressureHpa: 750, heightM: 2200, temperatureC: coolTopC, dewPointC: -5, windSpeedMps: 3, windDirectionDeg: 180 },
    ],
  }));
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", widthPx: 600 });
  const x = view.hours[0].x;
  const classesAtHeight = (z: number) => view.fields.filter(field => paintsPoint(field.path, x, heightToY(view, z))).map(field => field.className);
  // A thin, strong inversion between deeper weak lapse layers must not spread
  // into either neighboring layer when reconstructing the display.
  assert.deepEqual(classesAtHeight(950), ["meteo-gram-stab-stable"]);
  assert.deepEqual(classesAtHeight(1050), ["meteo-gram-stab-strong-inversion"]);
  assert.deepEqual(classesAtHeight(1150), ["meteo-gram-stab-strong-inversion"]);
  assert.deepEqual(classesAtHeight(1250), ["meteo-gram-stab-stable"]);
});

test("displayed stability transitions continuously between forecast hours", () => {
  const profile = parseSiteForecast(JSON.parse(readFileSync(new URL("../dev-data-src/convective-cycle.profile.json", import.meta.url), "utf8")))!;
  profile.hours = profile.hours.slice(0, 2);
  for (const [index, hour] of profile.hours.entries()) {
    const lapse = index === 0 ? -3.2 : -.5;
    hour.surface.temperatureC = 20;
    for (const level of hour.levels) level.temperatureC = 20 + (level.heightM - profile.site.modelElevationM) / 304.8 * lapse;
  }
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", widthPx: 600 });
  const y = view.top + view.plotHeight * .5;
  for (const [fraction, expected] of [[.25, "unstable"], [.5, "conditional"], [.75, "stable"]] as const) {
    const x = view.hours[0].x + fraction * (view.hours[1].x - view.hours[0].x);
    assert.deepEqual(view.fields.filter(field => paintsPoint(field.path, x, y)).map(field => field.className),
      [`meteo-gram-stab-${expected}`]);
  }
});

test("missing temperature intervals are not bridged vertically or blended into adjacent valid hour columns", () => {
  const profile = parseSiteForecast(JSON.parse(readFileSync(new URL("../dev-data-src/convective-cycle.profile.json", import.meta.url), "utf8")))!;
  profile.site.modelElevationM = 0;
  // Hour 0: 0-500 m is strong inversion (+3.048 °C/1,000 ft), 500-1,500 m is missing (1,000 m temperature is NaN),
  // and 1,500-2,000 m is very unstable (-3.048 °C/1,000 ft).
  // Hour 1: 0-2,000 m is uniformly very unstable (-3.048 °C/1,000 ft).
  profile.hours = profile.hours.slice(0, 2).map((hour, hourIdx) => ({
    ...hour,
    surface: { ...hour.surface, temperatureC: 20, dewPointC: 0 },
    levels: [
      { pressureHpa: 950, heightM: 500, temperatureC: hourIdx === 0 ? 25 : 15, dewPointC: -5, windSpeedMps: 3, windDirectionDeg: 180 },
      { pressureHpa: 900, heightM: 1000, temperatureC: (hourIdx === 0 ? NaN : 10) as number, dewPointC: -5, windSpeedMps: 3, windDirectionDeg: 180 },
      { pressureHpa: 850, heightM: 1500, temperatureC: 5, dewPointC: -5, windSpeedMps: 3, windDirectionDeg: 180 },
      { pressureHpa: 800, heightM: 2000, temperatureC: 0, dewPointC: -5, windSpeedMps: 3, windDirectionDeg: 180 },
    ],
  }));
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", widthPx: 600 });
  const yMidGap = heightToY(view, 1000);
  // Hour 0 column (inside missing 500-1,500 m gap) has no stability class and is masked by windgram-missing
  const xHour0 = view.left + view.columnWidth * 0.5;
  const classesHour0Gap = view.fields.filter((f) => paintsPoint(f.path, xHour0, yMidGap)).map((f) => f.className);
  assert.deepEqual(classesHour0Gap, ["windgram-missing"]);

  // Hour 1 column (both near the column boundary with Hour 0 and at Hour 1 center) must remain pure very-unstable
  // without any bridged gradient from Hour 0's +3.048 inversion below 500 m bleeding into Hour 1.
  for (const colFrac of [1.15, 1.5, 1.85]) {
    const xHour1 = view.left + view.columnWidth * colFrac;
    const classesHour1 = view.fields.filter((f) => paintsPoint(f.path, xHour1, yMidGap)).map((f) => f.className);
    assert.deepEqual(classesHour1, ["meteo-gram-stab-very-unstable"], `Hour 1 column at fraction ${colFrac}`);
  }
});
