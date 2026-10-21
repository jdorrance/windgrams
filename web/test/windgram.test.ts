import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSiteForecast, type SiteForecast } from "@azohra/meteo.briefing/contract";
import { buildWindgramView, heightToY, readWindgram, yToHeight } from "../src/lib/windgram-view.ts";

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
