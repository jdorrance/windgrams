import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSiteForecast, type SiteForecast } from "@azohra/meteo.briefing/contract";
import { buildWindgramView, windgramDayHours, windgramHours, type WindgramOptions } from "../src/lib/windgram-view.ts";
import { renderWindgramSvg } from "../src/lib/windgram-chart.ts";

type Hour = SiteForecast["hours"][number];
const options: WindgramOptions = { timeZone: "America/Boise", compact: true, launch: { elevationM: 1200 } };
const timestamp = (date: string, hour: number) => new Date(Date.parse(`${date}T00:00:00Z`) + hour * 3_600_000).toISOString();
const times = (hours: readonly { validAt: string }[]) => hours.map(hour => hour.validAt);
const range = (first: number, last: number, step = 1) => Array.from({ length: Math.floor((last - first) / step) + 1 }, (_, i) => first + i * step);
const expected = (date: string, first: number, last: number, step = 1) => range(first, last, step).map(hour => timestamp(date, hour));

function publish(hour: Hour, top: unknown, strength: unknown) {
  Object.assign(hour, { soaring: { thermalVelocityV2Mps: strength, usableLiftTopV2M: top } });
}

function profileAt(date = "2026-09-30", hours = range(6, 29)): SiteForecast {
  const profile = parseSiteForecast(JSON.parse(readFileSync(new URL("../dev-data-src/convective-cycle.profile.json", import.meta.url), "utf8")));
  assert.ok(profile);
  Object.assign(profile.site, { latitude: 43.62332, longitude: -115.98076, modelElevationM: 900, timeZone: "America/Boise" });
  const template = profile.hours[0];
  profile.hours = hours.map(time => {
    const hour = { ...structuredClone(template), validAt: timestamp(date, time) };
    publish(hour, null, 0);
    return hour;
  });
  return profile;
}

test("every screen width brackets sunrise and sunset in every season", () => {
  // NREL SPA references also checked independently in sunlight.test.ts:
  // Sep 30: 13:40:35–Oct 1 01:26:25Z; Jun 21: 12:02:35–Jun 22 03:29:05Z;
  // Dec 21: 15:14:15–Dec 22 00:10:05Z. Include the available samples on either side.
  for (const [date, start, end, first, last] of [
    ["2026-09-30", 6, 29, 13, 26],
    ["2026-06-21", 6, 29, 12, 28],
    ["2026-12-21", 7, 30, 15, 25],
  ] as const) {
    const profile = profileAt(date, range(start, end));
    const visible = expected(date, first, last);
    for (const compact of [true, false]) for (const heightRange of ["soaring", "full"] as const) {
      const selected = { ...options, compact, heightRange };
      assert.deepEqual(times(windgramHours(profile, selected)), visible, `${date} ${heightRange}`);
      assert.deepEqual(times(buildWindgramView(profile, selected).hours), visible, "chart and controls share the window");
    }
  }
});

test("summer daylight includes sunrise before 7am local", () => {
  const profile = profileAt("2026-06-21");
  assert.equal(windgramHours(profile, options)[0].validAt, "2026-06-21T12:00:00.000Z", "6am MDT brackets 6:02am sunrise");
});

test("three-hour forecasts keep the samples outside sunrise and sunset", () => {
  const profile = profileAt("2026-09-30", range(6, 27, 3));
  assert.deepEqual(times(windgramHours(profile, options)), expected("2026-09-30", 12, 27, 3));
});

test("daylight window stays fixed across weak, strong, unknown and ensemble lift", () => {
  const profile = profileAt();
  const visible = expected("2026-09-30", 13, 26);
  for (const [top, strength] of [[null, 0], [3000, 4], [null, null], [{ members: 21, p10: 900, p25: 1000, p50: 1500, p75: 2200, p90: 2600 }, 2]]) {
    for (const hour of profile.hours) publish(hour, top, strength);
    assert.deepEqual(times(windgramHours(profile, options)), visible);
    assert.deepEqual(times(windgramHours(profile, { ...options, launch: { elevationM: 4000 } })), visible);
    assert.deepEqual(times(windgramHours(profile, { ...options, launch: null })), visible);
  }
});

test("missing timestamps remain gaps inside the daylight window", () => {
  const profile = profileAt("2026-09-30", range(6, 29).filter(hour => hour !== 17 && hour !== 18));
  assert.deepEqual(times(windgramHours(profile, options)), expected("2026-09-30", 13, 26).filter(time => ![17, 18].some(hour => time === timestamp("2026-09-30", hour))));
});

test("partial forecasts stay inside supplied coverage without invented padding", () => {
  for (const [start, end, first, last] of [[18, 29, 18, 26], [6, 20, 13, 20], [18, 23, 18, 23]]) {
    const profile = profileAt("2026-09-30", range(start, end));
    assert.deepEqual(times(windgramHours(profile, options)), expected("2026-09-30", first, last));
  }
  const single = profileAt("2026-09-30", [18]);
  assert.deepEqual(windgramHours(single, options), single.hours);
  assert.deepEqual(windgramHours(profileAt("2026-09-30", []), options), []);
});

test("nighttime-only coverage retains its available context", () => {
  for (const hours of [range(6, 10), range(27, 29)]) {
    const profile = profileAt("2026-09-30", hours);
    assert.deepEqual(windgramHours(profile, options), profile.hours);
  }
});

test("an explicit day with only nighttime coverage keeps a fully unavailable daylight frame", () => {
  for (const sourceHours of [range(6, 10), range(27, 29), [27]]) {
    const profile = profileAt("2026-09-30", sourceHours);
    const original = structuredClone(profile);
    const selected = { ...options, hours: { dateKey: "2026-09-30", timeZone: "America/Boise" } };
    assert.deepEqual(windgramHours(profile, selected), []);
    for (const compact of [true, false]) for (const heightRange of ["soaring", "full"] as const) {
      const view = buildWindgramView(profile, { ...selected, compact, heightRange, widthPx: compact ? 356 : 1200 });
      assert.deepEqual(times(view.timeAxis), expected("2026-09-30", 13, 26));
      assert.ok(view.timeAxis.every(tick => tick.hourIndex === null));
      assert.deepEqual(view.hours, []);
      assert.deepEqual(view.sampling, []);
      assert.deepEqual(view.barbs, []);
      const svg = renderWindgramSvg(view);
      assert.match(svg, /data-forecast-unavailable/);
      assert.match(svg, /Daylight forecast unavailable/);
      assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
    }
    assert.deepEqual(profile, original);
  }
});

test("an explicit polar date retains supplied hours when sunrise and sunset are unavailable", () => {
  const profile = profileAt("2026-12-21", range(0, 23));
  Object.assign(profile.site, { latitude: 80, longitude: 0 });
  assert.deepEqual(windgramHours(profile, {
    timeZone: "Etc/UTC", hours: { dateKey: "2026-12-21", timeZone: "Etc/UTC" },
  }), profile.hours);
});

test("explicit hour selection is applied before daylight clipping", () => {
  const profile = profileAt();
  const hours = profile.hours.filter(hour => hour.validAt >= timestamp("2026-09-30", 18));
  assert.deepEqual(times(windgramHours(profile, { ...options, hours })), expected("2026-09-30", 18, 26));
  assert.deepEqual(windgramHours(profile, { ...options, hours: [] }), []);
});

test("local date selection crosses UTC midnight and its timezone takes precedence", () => {
  const profile = profileAt("2026-09-30", range(0, 53));
  const hours = { dateKey: "2026-09-30", timeZone: "America/Boise" };
  const selected = { ...options, timeZone: "Etc/UTC", hours };
  assert.deepEqual(times(windgramHours(profile, selected)), expected("2026-09-30", 13, 26));
  assert.deepEqual(times(windgramHours(profile, { ...selected, heightRange: "full" })), expected("2026-09-30", 13, 26));
});

test("DST transition days use their local calendar date", () => {
  // March 8 has 23 hours (07Z–next 06Z); November 1 has 25 (06Z–next 07Z).
  for (const [date, start, end, last] of [["2026-03-08", 7, 29, 26], ["2026-11-01", 6, 30, 25]] as const) {
    const profile = profileAt(date, range(start, end));
    assert.deepEqual(times(windgramHours(profile, options)), expected(date, 14, last));
  }
});

test("undated multi-day profiles retain every source hour without daylight padding or cropping", () => {
  const profile = profileAt("2026-09-30", range(6, 53));
  for (const compact of [false, true]) {
    const selected = { ...options, compact };
    assert.deepEqual(windgramHours(profile, selected), profile.hours);
    const view = buildWindgramView(profile, selected);
    assert.deepEqual(times(view.hours), times(profile.hours));
    assert.deepEqual(times(view.timeAxis), times(profile.hours));
    assert.ok(view.timeAxis.every(tick => tick.hourIndex !== null));
  }
});

test("Full profile expands heights while retaining the daylight hours and column positions", () => {
  const profile = profileAt();
  const focused = buildWindgramView(profile, options);
  const full = buildWindgramView(profile, { ...options, heightRange: "full" });
  assert.deepEqual(times(full.hours), times(focused.hours));
  assert.deepEqual(full.hours.map(hour => hour.x), focused.hours.map(hour => hour.x));
  assert.equal(full.floorM, profile.site.modelElevationM);
  assert.ok(full.floorM < focused.floorM);
  assert.ok(full.topM > focused.topM);
});

test("desktop and mobile use the same daylight hours and unavailable edges", () => {
  const profile = profileAt();
  for (const overrides of [{ compact: false }, { compact: undefined }, { compact: false, heightRange: "full" as const }]) {
    assert.deepEqual(windgramHours(profile, { ...options, ...overrides }), windgramHours(profile, options));
  }
  const partial = profileAt("2026-09-30", range(18, 23));
  const mobile = buildWindgramView(partial, options);
  const desktop = buildWindgramView(partial, { ...options, compact: false, widthPx: 1200 });
  assert.deepEqual(desktop.timeAxis.map(({ validAt, hourIndex }) => ({ validAt, hourIndex })),
    mobile.timeAxis.map(({ validAt, hourIndex }) => ({ validAt, hourIndex })));
  for (const view of [mobile, desktop]) {
    assert.equal(view.timeAxis[0].hourIndex, null);
    assert.equal(view.timeAxis.at(-1)!.hourIndex, null);
  }
});

test("unavailable solar events and invalid locations preserve supplied hours", () => {
  for (const coords of [
    { latitude: NaN, longitude: -115.98076 },
    { latitude: 43.62332, longitude: NaN },
    { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: 181 },
    { latitude: undefined, longitude: undefined },
  ]) {
    const profile = profileAt();
    Object.assign(profile.site, coords);
    assert.deepEqual(windgramHours(profile, options), profile.hours);
  }
  for (const date of ["2026-06-21", "2026-12-21"]) {
    const profile = profileAt(date, range(0, 23));
    Object.assign(profile.site, { latitude: 80, longitude: 0 });
    assert.deepEqual(windgramHours(profile, { ...options, timeZone: "Etc/UTC" }), profile.hours, "polar day/night");
  }
});

test("daylight clipping is idempotent and preserves source hours and diagnostics", () => {
  const profile = profileAt();
  const before = structuredClone(profile);
  const selected = windgramHours(profile, options);
  assert.deepEqual(profile, before);
  assert.ok(selected.length < profile.hours.length);
  for (const hour of selected) assert.equal(hour, profile.hours.find(source => source.validAt === hour.validAt));
  assert.deepEqual(windgramHours(profile, { ...options, hours: selected }), selected);
  assert.deepEqual(times(buildWindgramView(profile, { ...options, hours: selected }).hours), times(selected));
});

test("a 00Z 78-hour ICON run provides three complete Armenian daylight windows", () => {
  const profile = profileAt("2026-10-24", range(1, 78));
  profile.model = "icon-eu";
  Object.assign(profile.site, { latitude: 40.294048, longitude: 44.697437, timeZone: "Asia/Yerevan" });
  for (const dateKey of ["2026-10-24", "2026-10-25", "2026-10-26"]) {
    const selected = { ...options, timeZone: "Asia/Yerevan", hours: { dateKey, timeZone: "Asia/Yerevan" } };
    const focused = windgramHours(profile, { ...selected, heightRange: "soaring" });
    const full = windgramHours(profile, { ...selected, heightRange: "full" });
    assert.deepEqual(times(focused), times(full));
    assert.equal(focused.length, 13);
    assert.equal(focused[0].validAt, `${dateKey}T03:00:00.000Z`);
    assert.equal(focused.at(-1)!.validAt, `${dateKey}T15:00:00.000Z`);
  }
});

function aparanProfile(hours = range(7, 84)) {
  const profile = profileAt("2026-10-24", hours);
  profile.model = "icon-eu";
  profile.run.referenceTime = "2026-10-24T06:00:00Z";
  Object.assign(profile.site, { latitude: 40.5913, longitude: 44.4741, timeZone: "Asia/Yerevan" });
  return profile;
}

test("a 06Z ICON run keeps the first day's sunrise axis while its forecast starts at 11am", () => {
  const profile = aparanProfile(), original = structuredClone(profile);
  const selected = { ...options, timeZone: "Asia/Yerevan", hours: { dateKey: "2026-10-24", timeZone: "Asia/Yerevan" }, widthPx: 390 };
  const focused = buildWindgramView(profile, { ...selected, heightRange: "soaring" });
  const full = buildWindgramView(profile, { ...selected, heightRange: "full" });
  assert.deepEqual(times(focused.timeAxis), expected("2026-10-24", 3, 15), "7am–7pm brackets Aparan's 7:23am sunrise and 6:09pm sunset");
  assert.deepEqual(focused.timeAxis.map(tick => tick.hourIndex), [null, null, null, null, ...range(0, 8)]);
  assert.deepEqual(times(focused.hours), expected("2026-10-24", 7, 15), "unavailable morning hours have no forecast values");
  assert.deepEqual(focused.timeAxis, full.timeAxis, "full height retains the daylight axis");
  assert.deepEqual(focused.hours.map(hour => hour.x), full.hours.map(hour => hour.x));
  assert.equal(focused.sampling.length, focused.hours.length);
  for (const [index, hour] of focused.hours.entries()) {
    const tick = focused.timeAxis[index + 4];
    assert.equal(tick.validAt, hour.validAt);
    assert.equal(tick.x, hour.x);
    assert.ok(Math.abs(hour.x - focused.left - focused.columnWidth * (index + 4.5)) < 1e-8);
  }
  const dataLeft = focused.hours[0].x - focused.columnWidth / 2;
  const dataRight = focused.hours.at(-1)!.x + focused.columnWidth / 2;
  const forecastPaths = [...focused.fields.filter(field => field.className !== "windgram-missing"), ...focused.contours, ...focused.series];
  const forecastX = forecastPaths.flatMap(({ path }) => [...path.matchAll(/[ML](-?[\d.]+)[ ,]/g)].map(match => Number(match[1])));
  assert.ok(forecastX.length > 0);
  assert.ok(forecastX.every(x => x >= dataLeft - .1 && x <= dataRight + .1), "colour fields, contours and lift lines stay inside actual forecast coverage");
  assert.deepEqual(profile, original, "axis padding leaves the source run unchanged");
  const regional = windgramDayHours(profile, "2026-10-24T09:00:00Z", "Asia/Yerevan");
  assert.equal(regional[0], profile.hours[0]);
  const regionalView = buildWindgramView(profile, { ...selected, hours: regional });
  assert.deepEqual(regionalView.timeAxis, focused.timeAxis, "preselected regional hours preserve the same morning gap");
});

test("the same 06Z ICON run has a complete middle day and an unavailable final afternoon", () => {
  const profile = aparanProfile();
  const selected = { ...options, timeZone: "Asia/Yerevan", widthPx: 390 };
  const middle = buildWindgramView(profile, { ...selected, hours: { dateKey: "2026-10-25", timeZone: "Asia/Yerevan" } });
  assert.deepEqual(times(middle.timeAxis), expected("2026-10-25", 3, 15));
  assert.deepEqual(middle.timeAxis.map(tick => tick.hourIndex), range(0, 12));
  assert.deepEqual(times(middle.hours), times(middle.timeAxis));
  const last = buildWindgramView(profile, { ...selected, hours: { dateKey: "2026-10-27", timeZone: "Asia/Yerevan" } });
  assert.deepEqual(times(last.timeAxis), expected("2026-10-27", 3, 15));
  assert.deepEqual(times(last.hours), expected("2026-10-27", 3, 12));
  assert.deepEqual(last.timeAxis.map(tick => tick.hourIndex), [...range(0, 9), null, null, null]);
  assert.equal(last.sampling.length, 10);
});

test("a single daylight profile keeps a full axis without manufacturing other source hours", () => {
  const profile = aparanProfile([9]);
  const view = buildWindgramView(profile, { ...options, timeZone: "Asia/Yerevan" });
  assert.deepEqual(times(view.timeAxis), expected("2026-10-24", 3, 15));
  assert.deepEqual(times(view.hours), expected("2026-10-24", 9, 9));
  assert.equal(view.sampling.length, 1);
  assert.deepEqual(view.timeAxis.filter(tick => tick.hourIndex !== null).map(tick => tick.hourIndex), [0]);
  assert.equal(view.timeAxis[6].x, view.hours[0].x);
});

test("daylight edge padding follows three-hour source cadence", () => {
  const profile = aparanProfile(range(9, 84, 3));
  const view = buildWindgramView(profile, { ...options, timeZone: "Asia/Yerevan", hours: { dateKey: "2026-10-24", timeZone: "Asia/Yerevan" } });
  assert.deepEqual(times(view.timeAxis), expected("2026-10-24", 3, 15, 3));
  assert.deepEqual(view.timeAxis.map(tick => tick.hourIndex), [null, null, 0, 1, 2]);
  assert.deepEqual(times(view.hours), expected("2026-10-24", 9, 15, 3));
});

test("padding daylight edges preserves a missing interior profile", () => {
  const profile = aparanProfile(range(7, 84).filter(hour => hour !== 10));
  const before = structuredClone(profile);
  const selected = { ...options, timeZone: "Asia/Yerevan", hours: { dateKey: "2026-10-24", timeZone: "Asia/Yerevan" } };
  const sourceHours = windgramHours(profile, selected);
  const view = buildWindgramView(profile, selected);
  assert.deepEqual(times(view.hours), expected("2026-10-24", 7, 15).filter(time => time !== timestamp("2026-10-24", 10)));
  assert.equal(view.timeAxis[0].validAt, timestamp("2026-10-24", 3));
  assert.equal(view.timeAxis.at(-1)!.validAt, timestamp("2026-10-24", 15));
  assert.equal(view.sampling.length, sourceHours.length);
  for (const tick of view.timeAxis) if (tick.hourIndex !== null) {
    assert.equal(tick.validAt, sourceHours[tick.hourIndex].validAt);
    assert.equal(tick.x, view.hours[tick.hourIndex].x);
  }
  assert.deepEqual(profile, before);
});

test('regional charts select the middle local day without losing source hour identity', () => {
  const profile = profileAt('2026-10-24', range(1, 78));
  profile.model = 'icon-eu';
  Object.assign(profile.site, { latitude: 40.294048, longitude: 44.697437, timeZone: 'Asia/Yerevan' });
  const original = structuredClone(profile);
  const selected = windgramDayHours(profile, '2026-10-25T09:00:00Z', 'Asia/Yerevan');
  assert.deepEqual(times(selected), expected('2026-10-25', 3, 15));
  assert.equal(profile.hours.indexOf(selected[0]), 26, 'first visible chart column retains forecast hour 27');
  for (const compact of [true, false]) for (const heightRange of ['soaring', 'full'] as const) {
    const view = buildWindgramView(profile, { timeZone: 'Asia/Yerevan', hours: selected, compact, heightRange });
    assert.deepEqual(times(view.hours), times(selected));
  }
  assert.deepEqual(times(windgramDayHours(profile, '2026-10-24T21:00:00Z', 'Asia/Yerevan')), times(selected), 'local after-midnight map hours select the next Armenian date');
  assert.deepEqual(profile, original);
});
