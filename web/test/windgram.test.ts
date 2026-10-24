import { setUnitSystem } from "../src/lib/units.ts";
import { barbPaths } from "../src/lib/wind-barb.ts";
afterEach(() => setUnitSystem("imperial"));
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSiteForecast, type SiteForecast } from "@azohra/meteo.briefing/contract";
import { dewPointC, relativeHumidityPercent } from "@azohra/meteo.briefing/derive";
import { buildWindgramView, heightToY, readWindgram, visibleHeightAnchors, visibleWindgramHourIndices, yToHeight } from "../src/lib/windgram-view.ts";
import { mountWindgramInspector, renderWindgramDiagnosticsSvg, renderWindgramHeightAxisSvg, renderWindgramSvg } from "../src/lib/windgram-chart.ts";

const fixture = (name = "convective-cycle") => {
  const profile = parseSiteForecast(JSON.parse(readFileSync(new URL(`../dev-data-src/${name}.profile.json`, import.meta.url), "utf8")));
  assert.ok(profile, `${name} is a valid forecast fixture`);
  return profile;
};
const viewOf = (profile: SiteForecast) => buildWindgramView(profile, { timeZone: "Etc/UTC", widthPx: 1000 });
const close = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`);

/** Repeat an existing fully populated hour so vertical behavior is isolated
 * from a changing forecast, without inventing a second document contract. */
function steadyProfile(count = 3) {
  const profile = fixture();
  profile.hours = Array.from({ length: count }, (_, i) => ({
    ...structuredClone(profile.hours[0]), validAt: `2000-01-01T${String(10 + i).padStart(2, "0")}:00:00Z`,
  }));
  return profile;
}

test("the height transform is monotone, reversible and gives the lower atmosphere more room", () => {
  const view = viewOf(fixture());
  close(heightToY(view, view.floorM), view.bottom);
  close(heightToY(view, view.topM), view.top);
  const span = view.topM - view.floorM;
  let previousY = view.bottom + 1;
  for (let i = 0; i <= 40; i++) {
    const z = view.floorM + span * i / 40;
    const y = heightToY(view, z);
    assert.ok(y < previousY, `height must increase upwards at ${z}`);
    close(yToHeight(view, y), z, 0.01);
    previousY = y;
  }
  const low = heightToY(view, view.floorM) - heightToY(view, view.floorM + span / 4);
  const high = heightToY(view, view.topM - span / 4) - heightToY(view, view.topM);
  assert.ok(low > high, "equal-height layers near launch are visually taller");
  for (const anchor of view.anchors) close(yToHeight(view, anchor.y), anchor.heightM, 0.01);
});

test("wind reads in knots and interpolates components through north", () => {
  const profile = steadyProfile();
  const levels = profile.hours[0].levels;
  levels[0].windSpeedMps = 10;
  levels[0].windDirectionDeg = 350;
  levels[1].windSpeedMps = 10;
  levels[1].windDirectionDeg = 10;
  const view = viewOf(profile);
  const original = readWindgram(view, 0, levels[0].heightM);
  close(original.speedKt!, 10 * 1.943844, 0.0001);
  close(original.directionDeg!, 350);
  assert.equal(original.interpolated, false);
  const middle = readWindgram(view, 0, (levels[0].heightM + levels[1].heightM) / 2);
  assert.ok(middle.directionDeg! < 0.01 || middle.directionDeg! > 359.99, "north remains north, rather than averaging bearings to south");
  close(middle.speedKt!, 10 * Math.cos(10 * Math.PI / 180) * 1.943844, 0.0001);
  assert.equal(middle.interpolated, true);
});

test("missing source levels break temperature and wind interpolation", () => {
  const profile = steadyProfile();
  const levels = profile.hours[0].levels;
  levels[1].temperatureC = null;
  levels[1].windSpeedMps = null;
  levels[1].windDirectionDeg = null;
  const view = viewOf(profile);
  for (const z of [levels[1].heightM, (levels[0].heightM + levels[1].heightM) / 2, (levels[1].heightM + levels[2].heightM) / 2]) {
    const reading = readWindgram(view, 0, z);
    assert.equal(reading.temperatureF, null, `temperature gap at ${z}`);
    assert.equal(reading.speedKt, null, `wind gap at ${z}`);
    assert.equal(reading.directionDeg, null, `wind direction gap at ${z}`);
  }
  assert.ok(readWindgram(view, 0, levels[2].heightM).temperatureF !== null);
});

test("a truncated profile marks stability above its last measurement unavailable", () => {
  const profile = steadyProfile();
  profile.hours[1].levels = profile.hours[1].levels.slice(0, 2);
  const ceiling = profile.hours[1].levels.at(-1)!.heightM;
  const view = viewOf(profile);
  assert.ok(view.topM > ceiling + 1000);
  assert.equal(readWindgram(view, 1, ceiling + 1000).temperatureF, null);
  const columnLeft = view.left + view.columnWidth;
  const expected = `M${columnLeft},${view.top}h${view.columnWidth}v${heightToY(view, ceiling) - view.top}h-${view.columnWidth}Z`;
  assert.ok(view.fields.some((field) => field.className === "windgram-missing" && field.path === expected), "stability fill is masked over the full unavailable part of this hour");
});

test("temperature contours retain every crossing through an inversion", () => {
  const profile = steadyProfile();
  for (const hour of profile.hours) {
    hour.surface.temperatureC = 8;
    hour.levels = hour.levels.slice(0, 5).map((level, i) => ({ ...level, temperatureC: i % 2 === 0 ? 0 : 8 }));
  }
  const view = viewOf(profile);
  const contour = view.contours.find((c) => c.temperatureF > 32 && c.temperatureF < 46.4);
  assert.ok(contour, "a temperature between the warm and cold layers is contoured");
  const targetC = (contour.temperatureF - 32) / 1.8;
  const profilePoints = [{ heightM: profile.site.modelElevationM, temperatureC: 8 }, ...profile.hours[0].levels];
  const expected = profilePoints.slice(1).map((point, i) => {
    const previous = profilePoints[i];
    const ratio = (targetC - Number(previous.temperatureC)) / (Number(point.temperatureC) - Number(previous.temperatureC));
    return heightToY(view, previous.heightM + ratio * (point.heightM - previous.heightM));
  });
  for (const y of expected) {
    assert.ok(contour.labels.some((label) => Math.abs(label.y - y) < 1), `contour branch has a label near y=${y}`);
  }
  assert.ok(!/NaN|Infinity/.test(contour.path));
});

function temperatureLabelRects(svg: string, temperatureF: number) {
  return [...svg.matchAll(/<g class="wg-temperature-label" data-temperature-f="(-?[\d.]+)"><rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
    .filter((match) => Number(match[1]) === temperatureF)
    .map((match) => ({ x: Number(match[2]), y: Number(match[3]), width: Number(match[4]), height: Number(match[5]) }));
}

function smoothTemperatureProfile(count = 14) {
  const profile = steadyProfile(count);
  for (const hour of profile.hours) {
    hour.surface.temperatureC = 12;
    hour.surface.dewPointC = -13;
    hour.derived.cloudBaseM = null;
    for (const level of hour.levels) {
      level.temperatureC = 12 - (level.heightM - profile.site.modelElevationM) * .0065;
      level.dewPointC = Number(level.temperatureC) - 25;
      level.cloudFractionPercent = 0;
    }
  }
  return profile;
}

test("each long connected temperature line receives one label on desktop and mobile", () => {
  const profile = smoothTemperatureProfile();
  for (const compact of [false, true]) {
    const view = buildWindgramView(profile, { timeZone: "Etc/UTC", compact, heightRange: "full", widthPx: compact ? 320 : 1000, heightPx: 844 });
    const before = structuredClone(view.contours);
    const svg = renderWindgramSvg(view);
    for (const temperatureF of [24, 32, 40]) {
      assert.ok(view.contours.find((contour) => contour.temperatureF === temperatureF)!.labels.length > 1, "hourly physical crossing candidates remain available");
      assert.equal(temperatureLabelRects(svg, temperatureF).length, 1, `${temperatureF}°F is labelled once, compact=${compact}`);
    }
    assert.deepEqual(view.contours, before, "label placement never rewrites the contour geometry");
  }
});

test("separate inversion branches each receive one temperature label on their own line", () => {
  const profile = steadyProfile();
  for (const hour of profile.hours) {
    hour.surface.temperatureC = 8;
    hour.surface.dewPointC = -17;
    hour.derived.cloudBaseM = null;
    hour.levels = hour.levels.slice(0, 5).map((level, i) => ({
      ...level, temperatureC: i % 2 === 0 ? 0 : 8, dewPointC: -25, cloudFractionPercent: 0,
    }));
  }
  const view = viewOf(profile);
  const contour = view.contours.find((line) => line.temperatureF === 40)!;
  const expectedHeights = [...new Set(contour.labels.map((label) => label.y))].sort((a, b) => a - b);
  const labels = temperatureLabelRects(renderWindgramSvg(view), 40).sort((a, b) => a.y - b.y);
  assert.equal(expectedHeights.length, 5);
  assert.equal(labels.length, 5, "one label per disconnected inversion branch");
  labels.forEach((label, i) => close(label.y + label.height / 2, expectedHeights[i], 2));
});

test("a missing-time gap splits temperature labels without moving either into the gap", () => {
  const profile = smoothTemperatureProfile(5);
  profile.hours.forEach((hour, i) => { hour.validAt = `2000-01-01T${[10, 11, 12, 16, 17][i]}:00:00Z`; });
  const view = viewOf(profile);
  const labels = temperatureLabelRects(renderWindgramSvg(view), 40).sort((a, b) => a.x - b.x);
  assert.equal(labels.length, 2);
  assert.ok(labels[0].x + labels[0].width / 2 <= view.hours[2].x);
  assert.ok(labels[1].x + labels[1].width / 2 >= view.hours[3].x);
});

test("single-hour temperature crossings keep one finite label each", () => {
  const view = viewOf(smoothTemperatureProfile(1));
  const svg = renderWindgramSvg(view);
  for (const temperatureF of [24, 32, 40]) assert.equal(temperatureLabelRects(svg, temperatureF).length, 1);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
});

test("cloud evidence distinguishes dry LCL, saturated layers and model cloud", () => {
  const dry = steadyProfile();
  for (const hour of dry.hours) {
    hour.derived.cloudBaseM = 1600;
    hour.derived.boundaryLayerTopM = 2600;
    hour.derived.usableLiftTopM = 1600;
    hour.derived.thermalVelocityMps = 2;
    hour.surface.cloudCoverPercent = 0;
    for (const level of hour.levels) level.dewPointC = Number(level.temperatureC) - 20;
  }
  const potential = viewOf(dry);
  assert.ok(potential.clouds.some((cloud) => cloud.kind === "potential"));
  assert.ok(potential.clouds.every((cloud) => cloud.kind === "potential"), "a dry LCL must not masquerade as forecast cloud");
  assert.equal(potential.cloudBands.length, 0);

  const wet = structuredClone(dry);
  for (const hour of wet.hours) for (const level of hour.levels) level.dewPointC = level.temperatureC;
  const saturated = viewOf(wet);
  assert.ok(saturated.cloudBands.some((band) => band.kind === "humidity"));

  const modeled = structuredClone(dry);
  for (const hour of modeled.hours) for (const level of hour.levels) level.cloudFractionPercent = 100;
  const modelCloud = viewOf(modeled);
  assert.ok(modelCloud.clouds.some((cloud) => cloud.kind === "model"));
  assert.ok(modelCloud.cloudBands.some((band) => band.kind === "model"));

  const inaccessible = structuredClone(dry);
  for (const hour of inaccessible.hours) hour.derived.cloudBaseM = 10000;
  assert.equal(viewOf(inaccessible).clouds.length, 0, "LCL above the available profile is absent");
});

test("a missing temperature cannot create a saturated cloud layer", () => {
  const profile = steadyProfile();
  for (const hour of profile.hours) {
    hour.derived.thermalVelocityMps = 0;
    for (const level of hour.levels) {
      level.temperatureC = null;
      level.dewPointC = 0;
      level.cloudFractionPercent = 0;
    }
  }
  const view = viewOf(profile);
  assert.equal(view.cloudBands.length, 0);
  assert.ok(!view.clouds.some((cloud) => cloud.kind === "humidity"));
});

test("humidity hatching starts above 94 percent even when model cloud fraction is zero", () => {
  for (const humidity of [93.99, 94, 94.01]) {
    const profile = steadyProfile();
    const dewPoint = dewPointC(10, humidity);
    close(relativeHumidityPercent(10, dewPoint), humidity, 1e-10);
    for (const hour of profile.hours) {
      hour.surface.temperatureC = 10;
      hour.surface.dewPointC = dewPoint;
      hour.derived.cloudBaseM = null;
      for (const level of hour.levels) {
        level.temperatureC = 10;
        level.dewPointC = dewPoint;
        level.cloudFractionPercent = 0;
      }
    }
    const view = viewOf(profile);
    assert.equal(view.cloudBands.some((band) => band.kind === "humidity"), humidity > 94, `RH ${humidity}%`);
    assert.ok(!view.cloudBands.some((band) => band.kind === "model"));
    const svg = renderWindgramSvg(view);
    if (humidity > 94) assert.match(svg, /fill="url\(#windgram-humidity\)"[^>]*data-cloud-band="humidity"/);
    else assert.doesNotMatch(svg, /data-cloud-band="humidity"/);
  }
});

test("potential cloud base remains visible when thermals cannot reach it or have zero strength", () => {
  const profile = steadyProfile();
  const base = profile.site.modelElevationM + 1600;
  for (const hour of profile.hours) {
    hour.derived.cloudBaseM = base;
    hour.derived.usableLiftTopM = profile.site.modelElevationM + 300;
    hour.derived.boundaryLayerTopM = profile.site.modelElevationM + 600;
    hour.derived.thermalVelocityMps = 0;
    hour.surface.dewPointC = Number(hour.surface.temperatureC) - 25;
    for (const level of hour.levels) {
      level.dewPointC = Number(level.temperatureC) - 25;
      level.cloudFractionPercent = 0;
    }
  }
  const view = viewOf(profile);
  assert.ok(base < view.topM);
  assert.equal(view.cloudBands.length, 0, "a dry LCL does not imply existing cloud");
  assert.equal(view.clouds.length, profile.hours.length);
  for (const cloud of view.clouds) {
    assert.equal(cloud.kind, "potential");
    assert.equal(cloud.baseM, base);
    close(cloud.y, heightToY(view, base));
  }
  assert.equal([...renderWindgramSvg(view).matchAll(/data-cloud-kind="potential"/g)].length, profile.hours.length);
});

test("paraglider symbols use the published 225 ft/min ceiling and never substitute the 1 m/s lift top", () => {
  const profile = steadyProfile();
  const gliderTop = profile.site.modelElevationM + 700;
  const oneMetreTop = profile.site.modelElevationM + 1200;
  for (const hour of profile.hours) {
    hour.derived.usableLiftTopM = oneMetreTop + 100;
    Object.assign(hour, { soaring: {
      thermalVelocityV2Mps: 2, resolvedThermalTopM: oneMetreTop + 600,
      usableLiftTopV2M: oneMetreTop, surfaceLclM: oneMetreTop + 500, hcritWxtoflyM: gliderTop,
    } });
  }
  const view = viewOf(profile);
  assert.equal(view.wings.length, 1);
  assert.equal(view.wings[0].hourIndex, 1);
  assert.equal(view.wings[0].heightM, gliderTop);
  close(view.wings[0].y, heightToY(view, gliderTop) + 8);
  assert.notEqual(view.wings[0].heightM, oneMetreTop);
  assert.match(renderWindgramSvg(view), /Paraglider ceiling · 225 ft\/min sink/);
  for (const mode of ["null", "missing", "legacy"]) {
    const incomplete = structuredClone(profile);
    for (const hour of incomplete.hours) {
      const extended = hour as typeof hour & { soaring?: Record<string, unknown> };
      if (mode === "legacy") delete extended.soaring;
      else if (mode === "missing") delete extended.soaring!.hcritWxtoflyM;
      else extended.soaring!.hcritWxtoflyM = null;
    }
    assert.equal(viewOf(incomplete).wings.length, 0, `${mode} 225 ft/min diagnostic must stay absent`);
  }
});

test("wind feathers are green below 9 knots and white starting at 9 knots", () => {
  const view = viewOf(steadyProfile());
  const source = view.barbs.find((barb) => !barb.interpolated)!;
  view.barbs = [5, 8.99, 9, 9.01].map((speedKt) => ({ ...source, speedKt }));
  const colors = [...renderWindgramSvg(view).matchAll(/style="color:([^"]+)"[^>]*data-wind-source="native"/g)].map((match) => match[1]);
  assert.deepEqual(colors, ["#78ff78", "#78ff78", "#ffffff", "#ffffff"]);
});

test("snowflakes mark the lowest freezing crossing when an inversion creates several", () => {
  const profile = steadyProfile();
  for (const hour of profile.hours) {
    hour.surface.temperatureC = 8;
    hour.levels.forEach((level, i) => { level.temperatureC = i % 2 === 0 ? -8 : 8; });
  }
  const lowest = (profile.site.modelElevationM + profile.hours[0].levels[0].heightM) / 2;
  const view = viewOf(profile);
  assert.equal(view.freezing.length, profile.hours.length);
  for (const mark of view.freezing) close(mark.y, heightToY(view, lowest));
  const svg = renderWindgramSvg(view);
  const marks = [...svg.matchAll(/<path d="([^"]+)"[^>]*class="wg-freezing-mark"/g)];
  assert.equal(marks.length, profile.hours.length);
  for (const mark of marks) assert.equal([...mark[1].matchAll(/M/g)].length, 3, "snowflake has three crossing arms");
  assert.doesNotMatch(svg, /<circle[^>]*class="wg-freezing-mark"/);
  assert.match(svg, /Lowest freezing level · 32 °F/);
});

test("ensemble profiles retain median readings and uncertainty bands", () => {
  const profile = fixture("ensemble-wide");
  const view = viewOf(profile);
  assert.equal(view.ensemble, true);
  const temperature = profile.hours[0].surface.temperatureC;
  assert.ok(temperature && typeof temperature === "object" && "p50" in temperature);
  close(readWindgram(view, 0, profile.site.modelElevationM).temperatureF!, temperature.p50 * 1.8 + 32);
  assert.ok(view.series.some((series) => series.bandPath), "published ensemble spread remains visible");
});

test("windowed hours preserve source times and launch position under the same scale", () => {
  const profile = fixture();
  const selected = profile.hours.slice(2, 5);
  const view = buildWindgramView(profile, {
    timeZone: "Etc/UTC", widthPx: 1000, hours: selected,
    launch: { name: "Test launch", elevationM: 1300 },
  });
  assert.deepEqual(view.hours.map((hour) => hour.validAt), selected.map((hour) => hour.validAt));
  assert.equal(readWindgram(view, 0, 1300).validAt, selected[0].validAt);
  assert.ok(view.launch);
  close(view.launch.y, heightToY(view, 1300));
});

/** SVG paths emitted by the pure builder use M/L point pairs. Detect a line
 * through the middle of a missing forecast interval regardless of splitting. */
function bridgesX(path: string, x: number) {
  let previous: { x: number; y: number } | null = null;
  for (const match of path.matchAll(/([ML])(-?[\d.]+),(-?[\d.]+)/g)) {
    const point = { x: Number(match[2]), y: Number(match[3]) };
    if (match[1] === "L" && previous && Math.abs(point.x - previous.x) > 0.001
      && Math.min(previous.x, point.x) <= x && Math.max(previous.x, point.x) >= x) return true;
    previous = point;
  }
  return false;
}

test("missing forecast timestamps break contours and derived series without breaking normal three-hour cadence", () => {
  const profile = steadyProfile(5);
  const validHours = [10, 11, 12, 14, 15];
  profile.hours.forEach((hour, i) => { hour.validAt = `2000-01-01T${validHours[i]}:00:00Z`; });
  const view = viewOf(profile);
  const gapMiddle = (view.hours[2].x + view.hours[3].x) / 2;
  assert.ok(view.contours.length);
  for (const contour of view.contours) assert.ok(!bridgesX(contour.path, gapMiddle), `${contour.temperatureF}°F bridges a missing forecast`);
  for (const series of view.series) {
    assert.ok(!bridgesX(series.path, gapMiddle), `${series.key} bridges a missing forecast`);
    if (series.bandPath) assert.ok(!bridgesX(series.bandPath, gapMiddle), `${series.key} spread bridges a missing forecast`);
  }

  const regular = steadyProfile(4);
  regular.hours.forEach((hour, i) => { hour.validAt = `2000-01-01T${[10, 13, 16, 19][i]}:00:00Z`; });
  const regularView = viewOf(regular);
  const middle = (regularView.hours[1].x + regularView.hours[2].x) / 2;
  assert.ok(regularView.contours.some((contour) => bridgesX(contour.path, middle)), "normal three-hour model cadence remains continuous");
  assert.ok(regularView.contours.some((contour) => new Set(contour.labels.map((label) => label.x)).size >= 3), "temperature labels follow elapsed hours, not every third forecast column");
});

test("ensemble uncertainty bands also break at forecast time holes", () => {
  const profile = fixture("ensemble-wide");
  profile.hours = Array.from({ length: 5 }, (_, i) => ({
    ...structuredClone(profile.hours[0]), validAt: `2000-01-01T${[10, 11, 12, 16, 17][i]}:00:00Z`,
  }));
  const view = viewOf(profile);
  const gapMiddle = (view.hours[2].x + view.hours[3].x) / 2;
  assert.ok(view.series.some((series) => series.bandPath));
  for (const series of view.series) if (series.bandPath) {
    assert.ok(!bridgesX(series.bandPath, gapMiddle), `${series.key} spread bridges a missing forecast`);
  }
});

test("empty and single-hour windows have finite geometry", () => {
  for (const count of [0, 1]) {
    const profile = fixture();
    profile.hours = profile.hours.slice(0, count);
    const view = viewOf(profile);
    assert.equal(view.hours.length, count);
    for (const number of [view.width, view.height, view.floorM, view.topM, view.plotWidth, view.plotHeight]) assert.ok(Number.isFinite(number));
    assert.ok(view.topM > view.floorM);
    for (const field of view.fields) assert.ok(!/NaN|Infinity/.test(field.path));
    for (const contour of view.contours) assert.ok(!/NaN|Infinity/.test(contour.path));
  }
});

test("diagnostics keep their hour positions after an ensemble dropout", () => {
  const profile = steadyProfile(4);
  profile.hours[0].surface.precipitationMmHr = 1;
  profile.hours[1].surface.temperatureC = null;
  profile.hours[2].surface.precipitationMmHr = 3;
  profile.hours[3].surface.precipitationMmHr = 4;
  const before = structuredClone(profile);
  const view = viewOf(profile);
  const rain = view.diagnostics.find((strip) => strip.key === "precipitation");
  assert.ok(rain);
  assert.deepEqual(rain.values, [1, null, 3, 4]);
  assert.ok(rain.linePath.includes(`M${view.diagnosticLeft + 2.5 * view.columnWidth},`), "the first value after the dropout starts at its own hour");
  assert.deepEqual(profile, before, "building the display never rewrites forecast measurements");
});

test("compact charts fit a full forecast into portrait and landscape phones without discarding samples", () => {
  const profile = steadyProfile(14);
  for (const hour of profile.hours) hour.levels = Array.from({ length: 18 }, (_, i) => ({
    ...hour.levels[0], pressureHpa: 1000 - i * 25, heightM: profile.site.modelElevationM + 100 + i * 180,
  }));
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", compact: true, widthPx: 390, heightPx: 640 });
  assert.equal(view.left, 52);
  assert.equal(view.plotHeight, 380);
  assert.ok(view.height < 640);
  assert.equal(view.width, 390, "the whole forecast fits the available width");
  const labels = visibleHeightAnchors(view);
  assert.ok(labels.length >= 7, "dense native levels retain an evenly spaced subset of readable altitude labels");
  for (const [i, anchor] of labels.entries()) if (i) assert.ok(labels[i - 1].y - anchor.y >= 23);
  for (const anchor of view.anchors) close(yToHeight(view, anchor.y), anchor.heightM, 0.01);
  for (const heightPx of [300, 2000]) {
    const bounded = buildWindgramView(profile, { timeZone: "Etc/UTC", compact: true, widthPx: 390, heightPx });
    assert.ok(bounded.plotHeight >= 160 && bounded.plotHeight <= 440);
  }
  const desktop = viewOf(profile);
  assert.equal(desktop.compact, false);
  assert.equal(desktop.left, 102);
  assert.equal(desktop.top, 65);
  assert.ok(desktop.plotHeight >= 680);
  for (const [widthPx, heightPx] of [[240, 667], [320, 667], [390, 844], [430, 932], [780, 390]]) {
    const fitted = buildWindgramView(profile, { timeZone: "Etc/UTC", compact: true, heightRange: "full", widthPx, heightPx });
    close(fitted.width, widthPx);
    assert.ok(fitted.height <= heightPx - 40, `${widthPx}×${heightPx} fits vertically`);
    assert.deepEqual(fitted.hours.map((hour) => hour.validAt), desktop.hours.map((hour) => hour.validAt));
    assert.deepEqual(fitted.sampling, desktop.sampling, "fitting changes display coordinates, never atmospheric measurements");
    for (const [index, hour] of profile.hours.entries()) {
      for (const level of hour.levels) assert.deepEqual(readWindgram(fitted, index, level.heightM), readWindgram(desktop, index, level.heightM));
    }
    const visibleHours = visibleWindgramHourIndices(fitted);
    assert.equal(visibleHours[0], 0);
    assert.equal(visibleHours.at(-1), fitted.hours.length - 1);
    for (const [i, index] of visibleHours.entries()) if (i) assert.ok(fitted.hours[index].x - fitted.hours[visibleHours[i - 1]].x >= 34);
  }
});

test("mobile soaring range enlarges weak lift, preserves readings, and restores the full profile", () => {
  const profile = smoothTemperatureProfile(5);
  const floor = profile.site.modelElevationM;
  for (const hour of profile.hours) {
    hour.derived.usableLiftTopM = floor + 600;
    hour.derived.cloudBaseM = floor + 3000;
    hour.derived.boundaryLayerTopM = floor + 3200;
  }
  profile.hours[3].derived.usableLiftTopM = floor + 900;
  const before = structuredClone(profile);
  const options = { timeZone: "Etc/UTC", compact: true, widthPx: 390, heightPx: 780, launch: { elevationM: floor + 300 } };
  const focused = buildWindgramView(profile, options);
  const full = buildWindgramView(profile, { ...options, heightRange: "full" });
  assert.equal(focused.floorM, options.launch.elevationM);
  assert.equal(full.floorM, floor);
  assert.equal(focused.launch?.y, focused.bottom, "launch marks the lower edge of the focused chart");
  assert.ok(focused.topM < full.topM - 1000);
  assert.ok(focused.topM >= floor + 1400, "headroom above every displayed hour's usable lift");
  assert.ok(focused.topM < floor + 2000, "high potential cloud base and BL top do not force a tall scale");
  assert.equal(focused.height, full.height);
  assert.equal(focused.width, full.width);
  assert.deepEqual(focused.sampling, full.sampling);
  assert.deepEqual(profile, before);
  const visibleLift = (view: typeof focused) => (view.bottom - heightToY(view, floor + 900)) / view.plotHeight;
  assert.ok(visibleLift(focused) > .5);
  assert.ok(visibleLift(focused) > visibleLift(full));
  for (let z = focused.floorM; z < focused.topM; z += 50) {
    close(yToHeight(focused, heightToY(focused, z)), z, .01);
    assert.deepEqual(readWindgram(focused, 0, z), readWindgram(full, 0, z));
  }
  assert.ok(focused.barbs.every(barb => barb.heightM >= focused.floorM && barb.heightM <= focused.topM));
  assert.ok(focused.barbs.every(barb => !barb.surface), "model surface winds stay below the launch crop");
  assert.ok(full.barbs.some(barb => barb.surface), "full profile restores the model surface wind");
  assert.ok(focused.freezing.length === 0, "freezing above the crop stays outside the chart");
  assert.ok(focused.clouds.length === 0, "high potential cloud stays outside the chart");
  assert.ok(!focused.contours.some(contour => contour.temperatureF === 24), "upper isotherms cannot pile up on the chart edge");
  assert.doesNotMatch(renderWindgramSvg(focused), /NaN|Infinity|undefined/);
  const desktop = buildWindgramView(profile, { ...options, compact: false });
  assert.equal(desktop.floorM, floor);
  assert.equal(desktop.topM, full.topM);
  assert.deepEqual(desktop.sampling, full.sampling);
  const highLaunch = buildWindgramView(profile, { ...options, launch: { elevationM: floor + 2000 } });
  assert.ok(highLaunch.launch && highLaunch.topM >= floor + 2500);
});

test("launch cropping preserves clouds crossing launch and colours down to the chart floor", () => {
  const profile = smoothTemperatureProfile(3);
  const floor = profile.site.modelElevationM;
  const launchM = (profile.hours[0].levels[0].heightM + profile.hours[0].levels[1].heightM) / 2;
  for (const hour of profile.hours) {
    hour.derived.usableLiftTopM = floor + 600;
    hour.surface.dewPointC = hour.surface.temperatureC;
    for (const level of hour.levels) {
      level.dewPointC = level.temperatureC;
      level.cloudFractionPercent = 100;
    }
  }
  const options = { timeZone: "Etc/UTC", compact: true, widthPx: 390, heightPx: 780, launch: { elevationM: launchM } };
  const focused = buildWindgramView(profile, options);
  const full = buildWindgramView(profile, { ...options, heightRange: "full" });
  assert.equal(focused.floorM, launchM);
  for (const kind of ["model", "humidity"] as const) {
    const cloud = focused.clouds.find(cloud => cloud.hourIndex === 0 && cloud.kind === kind);
    const original = full.clouds.find(cloud => cloud.hourIndex === 0 && cloud.kind === kind);
    assert.ok(cloud && original);
    assert.ok(cloud.baseM < launchM && cloud.topM > focused.topM, `${kind} layer crosses both crop boundaries`);
    assert.equal(cloud.baseM, original.baseM, "cloud evidence retains its source height");
    assert.equal(cloud.topM, original.topM);
    const band = focused.cloudBands.find(band => band.kind === kind);
    assert.ok(band);
    close(band.y, focused.top);
    close(band.y + band.height, focused.bottom);
  }
  assert.ok(focused.fields.every(field => field.className !== "windgram-missing"), "cropping complete data creates no missing area");
  const fill = focused.fields.find(field => field.className === "meteo-gram-stab-conditional");
  assert.ok(fill?.path, "the uniform lapse-rate colour remains visible");
  const ys = [...fill.path.matchAll(/[ML]-?[\d.]+[ ,](-?[\d.]+)/g)].map(match => Number(match[1]));
  close(Math.min(...ys), focused.top, .1);
  close(Math.max(...ys), focused.bottom, .1);
  assert.deepEqual(readWindgram(focused, 0, launchM + 10), readWindgram(full, 0, launchM + 10));
  assert.doesNotMatch(renderWindgramSvg(focused), /NaN|Infinity|undefined/);
});

test("mobile focus retains model terrain without a launch above it", () => {
  const profile = smoothTemperatureProfile(3);
  const floor = profile.site.modelElevationM;
  for (const hour of profile.hours) hour.derived.usableLiftTopM = floor + 600;
  const options = { timeZone: "Etc/UTC", compact: true, widthPx: 390, heightPx: 780 };
  const noLaunch = buildWindgramView(profile, options);
  for (const elevationM of [floor - 250, floor]) {
    const view = buildWindgramView(profile, { ...options, launch: { elevationM } });
    assert.equal(view.floorM, floor, "a lower launch cannot invent a profile below model terrain");
    assert.equal(view.topM, noLaunch.topM);
    assert.deepEqual(view.sampling, noLaunch.sampling);
    assert.ok(view.barbs.some(barb => barb.surface));
  }
  assert.equal(noLaunch.floorM, floor);
  assert.ok(noLaunch.barbs.some(barb => barb.surface));
});

test("mobile range handles zero lift, missing diagnostics, strong days and ensemble spread", () => {
  const profile = steadyProfile();
  const floor = profile.site.modelElevationM;
  const options = { timeZone: "Etc/UTC", compact: true, widthPx: 390 };
  const fullTop = buildWindgramView(profile, { ...options, heightRange: "full" }).topM;
  for (const hour of profile.hours) {
    hour.derived.usableLiftTopM = null;
    hour.derived.thermalVelocityMps = null;
  }
  assert.equal(buildWindgramView(profile, options).topM, fullTop, "unknown lift retains full context");
  for (const hour of profile.hours) hour.derived.thermalVelocityMps = 0;
  assert.ok(buildWindgramView(profile, options).topM < fullTop);
  for (const hour of profile.hours) {
    Object.assign(hour, { soaring: { thermalVelocityV2Mps: 2, usableLiftTopV2M: { p25: floor + 400, p50: floor + 600, p75: floor + 1400 } } });
  }
  assert.ok(buildWindgramView(profile, options).topM >= floor + 1900, "ensemble upper quartile remains in view");
  for (const hour of profile.hours) Object.assign(hour, { soaring: { thermalVelocityV2Mps: 4, usableLiftTopV2M: fullTop - 200 } });
  assert.equal(buildWindgramView(profile, options).topM, fullTop, "strong days retain all available heights");
});

test("compact charts thin display marks, retain first and last hours, and keep diagnostics independently readable", () => {
  const view = buildWindgramView(fixture(), { timeZone: "Etc/UTC", compact: true, widthPx: 375, heightPx: 667 });
  const svg = renderWindgramSvg(view);
  const axis = renderWindgramHeightAxisSvg(view);
  const altitudeLabels = (markup: string) => [...markup.matchAll(/<text[^>]*class="wg-axis-feet"[^>]*>[^<]*<\/text>/g)].map((match) => match[0]);
  assert.deepEqual(altitudeLabels(axis), altitudeLabels(svg));
  assert.ok(altitudeLabels(axis).length > 1);
  assert.match(axis, new RegExp(`viewBox="0 0 ${view.left} ${view.height}"`));
  assert.match(axis, /aria-hidden="true"/);
  assert.match(axis, /fill="#7b7de6"/);
  assert.match(svg, /ft MSL/);
  assert.doesNotMatch(svg, / hPa<\/text>/);
  const visibleHours = visibleWindgramHourIndices(view);
  const hourLabels = [...svg.matchAll(/class="wg-hour wg-hour-top">([^<]+)</g)].map((match) => match[1]);
  assert.equal(hourLabels.length, visibleHours.length);
  assert.equal(hourLabels[0], view.hours[0].label);
  assert.equal(hourLabels.at(-1), view.hours.at(-1)!.label);
  assert.ok(hourLabels.length < view.hours.length);
  assert.equal([...svg.matchAll(/class="wg-hourline"/g)].length, view.hours.length, "every forecast column remains in the chart");
  assert.ok([...svg.matchAll(/data-wind-source=/g)].length < view.barbs.length, "wind feathers are thinned without deleting their source samples");
  assert.ok(view.diagnosticColumnWidth >= 44);
  const diagnostics = renderWindgramDiagnosticsSvg(view);
  assert.match(diagnostics, new RegExp(`viewBox="0 0 ${190 + view.diagnosticColumnWidth * view.hours.length} `));
  assert.ok(view.diagnosticColumnWidth > view.columnWidth);
  assert.doesNotMatch(svg + axis + diagnostics, /NaN|Infinity|undefined/);
});

test("compact chart height can fit the space below phone controls", () => {
  for (const maxHeightPx of [264, 350]) {
    const view = buildWindgramView(fixture(), { timeZone: "Etc/UTC", compact: true, heightRange: "full", widthPx: 320, heightPx: 667, maxHeightPx });
    assert.equal(view.height, maxHeightPx);
    assert.equal(view.plotHeight, maxHeightPx - 152);
    assert.ok(visibleHeightAnchors(view).length > 3);
    assert.equal(visibleWindgramHourIndices(view).at(-1), view.hours.length - 1);
    assert.match(renderWindgramSvg(view), /Sfc °F/);
  }
});

test("compact charts retain isolated model cloud bands and every potential cloud-base symbol", () => {
  const profile = steadyProfile(14);
  for (const hour of profile.hours) {
    hour.derived.thermalVelocityMps = 0;
    hour.derived.cloudBaseM = profile.site.modelElevationM + 700;
    for (const level of hour.levels) {
      level.dewPointC = Number(level.temperatureC) - 20;
      level.cloudFractionPercent = 0;
    }
  }
  profile.hours[3].levels[2].cloudFractionPercent = 100;
  const view = buildWindgramView(profile, { timeZone: "Etc/UTC", compact: true, widthPx: 320, heightPx: 667 });
  assert.ok(!visibleWindgramHourIndices(view).includes(3));
  const modelCloud = view.clouds.filter((cloud) => cloud.kind === "model");
  assert.equal(modelCloud.length, 1);
  assert.equal(modelCloud[0].hourIndex, 3);
  const potential = view.clouds.filter((cloud) => cloud.kind === "potential");
  assert.equal(potential.length, profile.hours.length, "zero lift does not hide potential LCL symbols");
  const svg = renderWindgramSvg(view);
  const windXs = [...svg.matchAll(/<g transform="translate\(([-\d.]+) [-\d.]+\) scale\(\.7\)"[^>]*data-wind-source=/g)].map((match) => Number(match[1]));
  assert.ok(windXs.every((x) => Math.abs(x - view.hours[3].x) > .01), "the cloud occurs between sampled wind columns");
  assert.doesNotMatch(svg, /data-cloud-kind="model"/);
  assert.equal([...svg.matchAll(/data-cloud-kind="potential"/g)].length, potential.length);
  assert.match(svg, /data-cloud-band="model"/);
  assert.equal([...svg.matchAll(/data-cloud-band="model"/g)].length, 1);
});

test("keyboard hour selection and cleanup work without a visible inspector readout", () => {
  const attributes = new Map<string, string>();
  const svg = { querySelector: () => null, getScreenCTM: () => null };
  const host = Object.assign(new EventTarget(), {
    querySelector: () => svg,
    getAttribute: (key: string) => attributes.get(key) ?? null,
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
    tabIndex: -1,
  });
  const view = viewOf(steadyProfile());
  const selected: string[] = [];
  const cleanup = mountWindgramInspector(host as unknown as HTMLElement, null, view, (validAt) => selected.push(validAt));
  const key = (value: string) => {
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperty(event, "key", { value });
    host.dispatchEvent(event);
  };
  key("End");
  assert.deepEqual(selected, [view.hours.at(-1)!.validAt]);
  assert.match(attributes.get("aria-label")!, /ft MSL/);
  key("ArrowLeft");
  assert.equal(selected.at(-1), view.hours.at(-2)!.validAt);
  key("Escape");
  assert.doesNotMatch(attributes.get("aria-label")!, /ft MSL/);
  cleanup();
  assert.equal(attributes.size, 0);
  key("End");
  assert.equal(selected.length, 2, "cleanup removes selection handlers");
});


test("metric windgram labels and feathers change while physical fields and coordinates stay fixed", () => {
  const source = steadyProfile(3);
  source.hours[0].surface.temperatureC = 20;
  source.hours[0].derived.thermalVelocityMps = 2;
  for (const hour of source.hours) for (const level of hour.levels) { level.windSpeedMps = 10; level.windDirectionDeg = 270; }
  const options = { timeZone: "Etc/UTC", widthPx: 390, compact: true, heightPx: 844, launch: { elevationM: 1000, name: "Launch" } };
  const imperial = buildWindgramView(source, options);
  assert.match(renderWindgramSvg(imperial), /Sfc °F/);
  assert.match(renderWindgramSvg(imperial), />394<\/text>/);
  setUnitSystem("metric");
  const metric = buildWindgramView(source, options);
  assert.deepEqual(metric.fields, imperial.fields);
  assert.deepEqual(metric.anchors, imperial.anchors);
  assert.deepEqual(metric.barbs, imperial.barbs);
  assert.deepEqual(metric.cloudBands, imperial.cloudBands);
  assert.deepEqual(metric.wings, imperial.wings);
  assert.equal(metric.width, imperial.width);
  assert.equal(metric.height, imperial.height);
  assert.ok(metric.contours.every((c) => Math.abs((c.temperatureF - 32) / 1.8 / 5 - Math.round((c.temperatureF - 32) / 1.8 / 5)) < 1e-10));
  const svg = renderWindgramSvg(metric);
  assert.match(svg, /Sfc °C/);
  assert.match(svg, /Wind m\/s · temperature °C/);
  assert.match(svg, /Launch · 1,000 m MSL/);
  assert.match(svg, />2<\/text>/);
  const geometry = barbPaths(20, 270); // 10 m/s, full feather = 5 m/s.
  assert.ok(svg.includes(`d="${geometry.staff}"`));
  for (const flag of geometry.flags) assert.ok(svg.includes(`d="${flag}"`));
  assert.doesNotMatch(svg, /°F| ft | kt|inHg/);
  const details = renderWindgramDiagnosticsSvg(metric);
  assert.match(details, />hPa<\/text>/);
  assert.match(details, />mm\/h<\/text>/);
  assert.doesNotMatch(details, /inHg|in\/h/);
});
