import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSiteForecast, type SiteForecast } from "@azohra/meteo.briefing/contract";
import { buildWindgramView, windgramDayHours, windgramHours, type WindgramOptions } from "../src/lib/windgram-view.ts";

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

test("mobile brackets sunrise and sunset in every season", () => {
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
    for (const heightRange of ["soaring", "full"] as const) {
      const selected = { ...options, heightRange };
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

test("multi-date regional profiles retain a contiguous interval including overnight hours", () => {
  const profile = profileAt("2026-09-30", range(6, 53));
  assert.deepEqual(times(windgramHours(profile, options)), expected("2026-09-30", 13, 50));
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

test("desktop retains every supplied hour", () => {
  const profile = profileAt();
  for (const overrides of [{ compact: false }, { compact: undefined }, { compact: false, heightRange: "full" as const }]) {
    assert.deepEqual(windgramHours(profile, { ...options, ...overrides }), profile.hours);
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

test("a 78-hour ICON run provides three complete Armenian daylight windows", () => {
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
