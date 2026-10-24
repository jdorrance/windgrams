import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSiteForecast, type SiteForecast } from "@azohra/meteo.briefing/contract";
import { buildWindgramView, windgramHours, type WindgramOptions } from "../src/lib/windgram-view.ts";

type Hour = SiteForecast["hours"][number];
const timestamp = (hour: number) => new Date(Date.UTC(2000, 0, 1, hour)).toISOString();
const options: WindgramOptions = { timeZone: "Etc/UTC", compact: true, launch: { elevationM: 1200 } };
const times = (hours: readonly { validAt: string }[]) => hours.map(hour => hour.validAt);
const range = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => first + i);

function publish(hour: Hour, top: unknown, strength: unknown = top === null ? 0 : 2) {
  Object.assign(hour, { soaring: { thermalVelocityV2Mps: strength, usableLiftTopV2M: top } });
}

function profileAt(hours = range(6, 22)): SiteForecast {
  const profile = parseSiteForecast(JSON.parse(readFileSync(new URL("../dev-data-src/convective-cycle.profile.json", import.meta.url), "utf8")));
  assert.ok(profile);
  profile.site.modelElevationM = 900;
  const template = profile.hours[0];
  profile.hours = hours.map(time => {
    const hour = { ...structuredClone(template), validAt: timestamp(time) };
    // Retain a different legacy forecast to catch accidental family mixing.
    hour.derived.usableLiftTopM = 3000;
    hour.derived.thermalVelocityMps = 3;
    publish(hour, null, 0);
    return hour;
  });
  return profile;
}

function soaring(profile: SiteForecast, hours: number[], top = 1800) {
  for (const hour of profile.hours) if (hours.some(time => timestamp(time) === hour.validAt)) publish(hour, top);
}

test("mobile keeps one hour of context around usable lift above launch", () => {
  const profile = profileAt();
  soaring(profile, [12, 13, 14]);
  const expected = range(11, 15).map(timestamp);
  assert.deepEqual(times(windgramHours(profile, options)), expected);
  assert.deepEqual(times(buildWindgramView(profile, options).hours), expected, "chart and hour controls use the same window");
});

test("three-hour forecasts retain the nearest samples outside the padded window", () => {
  const profile = profileAt([0, 3, 6, 9, 12, 15, 18, 21]);
  soaring(profile, [12, 15]);
  assert.deepEqual(times(windgramHours(profile, options)), [9, 12, 15, 18].map(timestamp));
});

test("separate soaring periods retain the midday lull between them", () => {
  const profile = profileAt();
  soaring(profile, [10, 11, 15, 16]);
  assert.deepEqual(times(windgramHours(profile, options)), range(9, 17).map(timestamp));
});

test("missing forecast timestamps remain gaps inside the selected window", () => {
  const profile = profileAt([6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 18]);
  soaring(profile, [10, 14]);
  assert.deepEqual(times(windgramHours(profile, options)), [9, 10, 13, 14, 15].map(timestamp));
});

test("one usable hour keeps its neighbours and a one-sample forecast remains intact", () => {
  const profile = profileAt();
  soaring(profile, [13]);
  assert.deepEqual(times(windgramHours(profile, options)), [12, 13, 14].map(timestamp));
  const single = profileAt([13]);
  soaring(single, [13]);
  assert.deepEqual(windgramHours(single, options), single.hours);
  const empty = profileAt([]);
  assert.deepEqual(windgramHours(empty, options), []);
});

test("lift at or below launch leaves the full day available", () => {
  const profile = profileAt();
  soaring(profile, [10, 11], 1199);
  soaring(profile, [12, 13], 1200);
  assert.deepEqual(windgramHours(profile, options), profile.hours);
});

test("a launch below model terrain uses model terrain as the usable-lift floor", () => {
  const profile = profileAt();
  soaring(profile, [8, 9], 900);
  soaring(profile, [12], 901);
  const lowLaunch = { ...options, launch: { elevationM: 600 } };
  assert.deepEqual(times(windgramHours(profile, lowLaunch)), [11, 12, 13].map(timestamp));
  assert.deepEqual(times(windgramHours(profile, { ...options, launch: null })), [11, 12, 13].map(timestamp));
});

test("ensemble median defines the window instead of optimistic upper members", () => {
  const profile = profileAt();
  const quantiles = (p50: number) => ({ members: 21, p10: 900, p25: 1000, p50, p75: 2200, p90: 2600 });
  for (const hour of profile.hours) publish(hour, quantiles(1100), 2);
  publish(profile.hours[6], quantiles(1600), 2); // 12 UTC
  publish(profile.hours[7], quantiles(1700), 2); // 13 UTC
  assert.deepEqual(times(windgramHours(profile, options)), range(11, 14).map(timestamp));
});

test("unknown lift at any supplied hour retains the full range", () => {
  const profile = profileAt();
  soaring(profile, [12, 13, 14]);
  publish(profile.hours[0], null, null);
  assert.deepEqual(times(windgramHours(profile, options)), times(profile.hours));
});

test("a known below-launch ceiling remains nonusable when thermal strength is missing", () => {
  const profile = profileAt();
  soaring(profile, [12, 13, 14]);
  publish(profile.hours[0], 1100, null);
  assert.deepEqual(times(windgramHours(profile, options)), range(11, 15).map(timestamp));
});

test("known usable ceiling can define the window when thermal strength is missing", () => {
  const profile = profileAt();
  publish(profile.hours[6], 1800, null);
  assert.deepEqual(times(windgramHours(profile, options)), [11, 12, 13].map(timestamp));
});

test("a day of zero thermal strength and null lift ceilings keeps every supplied hour", () => {
  const profile = profileAt();
  assert.deepEqual(windgramHours(profile, options), profile.hours);
});

test("desktop and Full profile preserve the supplied day", () => {
  const profile = profileAt();
  soaring(profile, [12, 13, 14]);
  assert.deepEqual(windgramHours(profile, { ...options, compact: false }), profile.hours);
  assert.deepEqual(windgramHours(profile, { ...options, compact: undefined }), profile.hours);
  assert.deepEqual(windgramHours(profile, { ...options, heightRange: "full" }), profile.hours);
});

test("explicit hour selection is applied before cropping and supplies no outside padding", () => {
  const profile = profileAt();
  soaring(profile, [10, 11, 12, 13, 14]);
  const selected = profile.hours.filter(hour => [12, 13, 14, 15, 16, 17].some(time => hour.validAt === timestamp(time)));
  assert.deepEqual(times(windgramHours(profile, { ...options, hours: selected })), range(12, 15).map(timestamp));
  assert.deepEqual(windgramHours(profile, { ...options, hours: [] }), []);
});

test("local day filtering precedes cropping across a UTC date boundary", () => {
  const profile = profileAt(range(0, 32));
  soaring(profile, [26, 27, 28]);
  publish(profile.hours[1], null, null);
  publish(profile.hours[31], null, null);
  const hours = { dateKey: "2000-01-01", timeZone: "America/New_York" };
  assert.deepEqual(times(windgramHours(profile, { ...options, hours })), [25, 26, 27, 28].map(timestamp));
  assert.deepEqual(times(windgramHours(profile, { ...options, hours, heightRange: "full" })), range(5, 28).map(timestamp));
});

test("published V2 nulls never borrow the legacy lift ceiling", () => {
  const profile = profileAt();
  soaring(profile, [12, 13]);
  publish(profile.hours[0], null, 2);
  assert.deepEqual(times(windgramHours(profile, options)), range(11, 14).map(timestamp));
  publish(profile.hours[0], null, null);
  assert.deepEqual(windgramHours(profile, options), profile.hours, "unknown V2 retains context despite complete legacy fields");
});

test("windowing keeps source hours and diagnostics unchanged", () => {
  const profile = profileAt();
  soaring(profile, [12, 13, 14]);
  const before = structuredClone(profile);
  const selected = windgramHours(profile, options);
  assert.deepEqual(profile, before);
  assert.ok(selected.length < profile.hours.length);
  for (const hour of selected) assert.equal(hour, profile.hours.find(source => source.validAt === hour.validAt));
});
