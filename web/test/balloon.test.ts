import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { balloonSounding, choices, readChoice, srgSounding, type RaobDocument } from "../src/lib/balloon.ts";
import { parseSrg } from "../src/lib/srg.ts";
import { setUnitSystem } from "../src/lib/units.ts";

afterEach(() => setUnitSystem("imperial"));

const TZ = "America/Boise";
const SRG = parseSrg(readFileSync(new URL("./fixtures/srg-boi.txt", import.meta.url), "utf8"));
const FT = 3.28084;

test("the morning table lifted from the forecast high tops out near the NWS thermal height", () => {
  const s = srgSounding(SRG.observed!, 874, SRG.forecastMaxTempC)!;
  // Standard-atmosphere estimate at the table's first row (3000 ft); the balloon measured 913 hPa at 2867 ft.
  assert.ok(Math.abs(s.points[0].pressureHpa - 908) < 8, `surface ${s.points[0].pressureHpa}`);
  const topFt = s.marks.zoneTopM! * FT;
  // NWS: 9,264 ft MSL. Same method (dry adiabat from the forecast high), our own interpolation.
  assert.ok(Math.abs(topFt - 9264) < 300, `${topFt}`);
  assert.equal(s.hasDewPoint, false);
  assert.equal(s.marks.cloudBaseM, null);
  assert.ok(s.inversions.some((l) => l.grounded), "the valley inversion at dawn");
});

test("without a balloon file, the Soaring Forecast's own table and model hours are offered", () => {
  const list = choices(null, SRG, TZ);
  assert.deepEqual(list.map((c) => `${c.kind} ${c.validAt}`), [
    "balloon 2026-09-29T12:00:00Z",
    "model 2026-09-29T15:00:00Z",
    "model 2026-09-29T18:00:00Z",
    "model 2026-09-29T21:00:00Z",
    "model 2026-09-30T00:00:00Z",
  ]);
  assert.equal(list[0].start.source, "forecast-high");
  assert.equal(list[0].start.temperatureC, 24.9);
  assert.equal(list[1].start.source, "observed");
});

test("the morning reading uses the NWS numbers and says it plainly", () => {
  const [morning] = choices(null, SRG, TZ);
  const r = readChoice(morning, SRG, 1268, TZ);
  assert.match(r.headline, /^At forecast high 77 °F · thermals to 9,[3-5]\d{2} ft MSL\.$/);
  const title = (t: string) => r.findings.find((f) => f.title === t)!;
  assert.match(title("Thermals: Fair").text, /Forecast high 77 °F.*NWS top 9,264 ft · lift 382 ft\/min\./);
  assert.equal(title("When they start").text, "NWS trigger 70 °F · 1:30 PM.");
  assert.match(title("Launch reference").text, /Station parcel top 5,[1-3]\d{2} ft above launch elevation 4,160 ft MSL/);
  assert.equal(title("Storms").text, "Lifted index +8.1: Very stable aloft.");
  assert.equal(title("Clouds").text, "Humidity unavailable · cloud estimate unavailable.");
  assert.ok(r.findings.some((f) => f.title === "Valley inversion"));
});

test("a model hour reads as that hour's thermals", () => {
  const list = choices(null, SRG, TZ);
  const three = list.find((c) => c.validAt === "2026-09-29T21:00:00Z")!;
  const r = readChoice(three, SRG, 1268, TZ);
  assert.match(r.headline, /^Thermals to [\d,]+ ft MSL · 3:00 PM\.$/);
  assert.match(r.findings[0].text, /NWS 3:00 PM · surface 72 °F · parcel top [\d,]+ ft MSL/);
  assert.match(r.findings.find((f) => f.key === "storms")!.text, /Lifted index \+6\.2/);
});

test("a real balloon file comes first and shows clouds from its dew point", () => {
  const levels = [
    [913, 874, 12, 2], [900, 990, 14, 1], [850, 1480, 12, -1], [800, 1990, 8, -2], [750, 2520, 3.5, -3],
    [700, 3080, -1, -4], [650, 3660, -5.5, -6.5], [600, 4270, -10, -11], [550, 4910, -15, -19], [500, 5600, -20, -28], [400, 7200, -33, -45],
  ].map(([p, z, t, td]) => ({ pressureHpa: p, heightM: z, temperatureC: t, dewPointC: td, windDirectionDeg: 320, windSpeedMps: 6 }));
  const doc: RaobDocument = {
    schemaVersion: 1,
    generatedAt: "2026-09-29T13:30:00Z",
    station: { id: "KBOI", name: "Boise", latitude: 43.57, longitude: -116.21, distanceKm: 20, elevationM: 874 },
    soundings: [{ validAt: "2026-09-29T12:00:00Z", levels }],
  };
  const list = choices(doc, SRG, TZ);
  assert.equal(list[0].kind, "balloon");
  assert.equal(list[0].hasDewPoint, true);
  assert.equal(list[0].srgProfile, SRG.observed);
  assert.equal(list.filter((c) => c.kind === "balloon").length, 1, "the table is not repeated when the balloon file has that flight");
  const r = readChoice(list[0], SRG, 1268, TZ);
  assert.match(r.findings.find((f) => f.key === "clouds")!.text, /^(Cu possible · base|Blue thermals · LCL) [\d,]+ ft MSL/);
  assert.ok(balloonSounding(doc.soundings[0], null)!.points.every((p) => p.pressureHpa >= 450));
});

test("a flight the archive missed comes from the Soaring Forecast's table, in time order", () => {
  // Well mixed up to ~1.9 km (cooling faster than a dry thermal), an inversion at 2.3 km.
  const evening = [[913, 874, 23.8, -0.2], [850, 1500, 17.3, -3], [820, 1800, 14.2, -4], [790, 2300, 15, -12], [750, 2540, 12, -12], [700, 3100, 6, -14], [600, 4300, -4, -18], [500, 5700, -16, -25]]
    .map(([p, z, t, td]) => ({ pressureHpa: p, heightM: z, temperatureC: t, dewPointC: td, windDirectionDeg: 300, windSpeedMps: 5 }));
  const doc: RaobDocument = {
    schemaVersion: 1,
    generatedAt: "2026-09-30T05:00:00Z",
    station: { id: "KBOI", name: "Boise", latitude: 43.57, longitude: -116.21, distanceKm: 20, elevationM: 874 },
    soundings: [{ validAt: "2026-09-30T00:00:00Z", levels: evening }],
  };
  const balloons = choices(doc, SRG, TZ).filter((c) => c.kind === "balloon");
  assert.deepEqual(balloons.map((c) => [c.validAt, c.hasDewPoint]), [["2026-09-29T12:00:00Z", false], ["2026-09-30T00:00:00Z", true]]);
  assert.equal(balloons[0].start.source, "forecast-high");
  const r = readChoice(balloons[1], SRG, 1268, TZ);
  assert.match(r.findings[0].text, /^6:00 PM station parcel: 75 °F surface · top [\d,]+ ft MSL\.$/);
});

test("Thursday morning precedes Thursday evening regardless of source order, with model hours between them", () => {
  const morning = "2026-10-22T12:00:00Z";
  const evening = "2026-10-23T00:00:00Z";
  const timeZone = "America/New_York";
  const levels = [[913, 874, 12, 2], [850, 1480, 12, -1], [750, 2520, 3.5, -3], [650, 3660, -5.5, -6.5], [500, 5600, -20, -28]]
    .map(([p, z, t, td]) => ({ pressureHpa: p, heightM: z, temperatureC: t, dewPointC: td, windDirectionDeg: 320, windSpeedMps: 6 }));
  const srg = {
    ...SRG,
    forecastDate: "2026-10-22",
    observed: { ...SRG.observed!, validAt: "2026-10-22T08:00:00-04:00" },
    model: [
      { ...SRG.model[0], validAt: "2026-10-22T14:00:00-04:00" },
      { ...SRG.model[1], validAt: "2026-10-22T15:00:00Z" },
    ],
  };
  for (const flights of [[evening, morning], [morning, evening]]) {
    const doc: RaobDocument = {
      schemaVersion: 1,
      generatedAt: "2026-10-23T02:00:00Z",
      station: { id: "KBOI", name: "Boise", latitude: 43.57, longitude: -116.21, distanceKm: 20, elevationM: 874 },
      soundings: flights.map((validAt) => ({ validAt, levels })),
    };
    const list = choices(doc, srg, timeZone);
    assert.deepEqual(list.map((choice) => [choice.kind, choice.validAt]), [
      ["balloon", morning],
      ["model", "2026-10-22T15:00:00Z"],
      ["model", "2026-10-22T14:00:00-04:00"],
      ["balloon", evening],
    ]);
    const day = new Intl.DateTimeFormat("en-US", { weekday: "long", hour: "numeric", timeZone });
    assert.deepEqual(list.filter((choice) => choice.kind === "balloon").map((choice) => day.format(new Date(choice.validAt))), ["Thursday 8 AM", "Thursday 8 PM"]);
    assert.equal(list[0].hasDewPoint, true, "the actual flight takes precedence over the SRG fallback at the same instant");
    assert.equal(list[0].srgProfile, srg.observed, "the SRG table attaches to the flight even with a different timestamp offset");
  }
});

test("balloon winds retain MSL heights and do not turn remote winds into launch or turbulence verdicts", () => {
  const levels = [[1000, 93, 16, 5], [950, 600, 12, 3], [900, 1100, 9, 0], [850, 1600, 7, -2], [700, 3100, -4, -8], [500, 5600, -20, -25]]
    .map(([p, z, t, td]) => ({ pressureHpa: p, heightM: z, temperatureC: t, dewPointC: td, windDirectionDeg: 300, windSpeedMps: 15 }));
  const doc: RaobDocument = { schemaVersion: 1, generatedAt: "2026-10-23T01:00:00Z", station: { id: "KIAD", name: "Dulles", latitude: 38.95, longitude: -77.4, distanceKm: 91, elevationM: 93 }, soundings: [{ validAt: "2026-10-23T00:00:00Z", levels }] };
  const choice = choices(doc, null, "America/New_York")[0];
  assert.equal(choice.sounding.modelElevationM, 93);
  assert.equal(choice.sounding.points[0].heightM, 93, "the station elevation is not added to MSL profile heights");
  const wind = readChoice(choice, null, 565, "America/New_York").findings.find(f => f.key === "wind")!;
  assert.equal(wind.title, "Station profile wind");
  assert.match(wind.text, /^1,854 ft MSL: WNW 34 mph/);
  assert.doesNotMatch(wind.text, /Strong wind|broken thermals|expect drift/);
  assert.equal(wind.tone, "neutral");
  const below = readChoice(choice, null, 10, "America/New_York").findings.find(f => f.key === "wind")!;
  assert.match(below.text, /^33 ft MSL: unavailable/);
  const unknown = readChoice(choice, null, null, "America/New_York").findings.find(f => f.key === "wind")!;
  assert.match(unknown.text, /^2,274 ft MSL:/);
});

test("metric balloon readings convert displayed values while preserving sounding physics and findings", () => {
  const original = structuredClone(SRG);
  const imperial = choices(null, SRG, TZ);
  const imperialReading = readChoice(imperial[0], SRG, 1268, TZ);
  setUnitSystem("metric");
  const metric = choices(null, SRG, TZ);
  assert.deepEqual(metric.map(({ id, kind, validAt, start }) => ({ id, kind, validAt, start })), imperial.map(({ id, kind, validAt, start }) => ({ id, kind, validAt, start })));
  for (let i = 0; i < imperial.length; i++) {
    const physical = (sounding: typeof imperial[number]["sounding"]) => ({
      ...sounding, marks: { ...sounding.marks, top: sounding.marks.top && { heightM: sounding.marks.top.heightM } },
    });
    assert.deepEqual(physical(metric[i].sounding), physical(imperial[i].sounding));
  }
  const metricReading = readChoice(metric[0], SRG, 1268, TZ);
  assert.equal(metricReading.headline, "At forecast high 25 °C · thermals to 2,897 m MSL.");
  assert.match(metricReading.findings[0].text, /NWS top 2,824 m · lift 1\.94 m\/s/);
  assert.match(metricReading.findings.find(finding => finding.key === "wind")!.text, /^1,268 m MSL: NNW 23 km\/h/);
  assert.match(metric[0].sounding.marks.top!.label, /2,897 m/);
  const categories = (reading: typeof metricReading) => reading.findings.map(({ key, title, tone }) => ({ key, title, tone }));
  assert.deepEqual(categories(metricReading), categories(imperialReading));
  assert.doesNotMatch(JSON.stringify(metricReading), /mph|ft\/min|ft MSL|°F/);
  assert.deepEqual(SRG, original);
});

test("balloon readings retain uncertainty without instructions or storm guarantees", () => {
  const morning = choices(null, SRG, TZ)[0];
  const unstable = { ...morning, srgProfile: { ...morning.srgProfile!, liftedIndex: -1 } };
  const storm = readChoice(unstable, SRG, 1268, TZ).findings.find(finding => finding.key === "storms")!;
  assert.equal(storm.text, "Lifted index -1: Slightly unstable · Cu growth possible.");
  assert.equal(storm.tone, "caution");
  const unheated = { ...morning, start: { temperatureC: 10, source: "observed" as const }, sounding: { ...morning.sounding, marks: { ...morning.sounding.marks, zoneTopM: null } } };
  assert.equal(readChoice(unheated, null, 1268, TZ).findings[0].text, "Stable morning parcel · forecast-high estimate unavailable.");
});

test("P2-4: balloon sounding carries profile-limited coverage limit through headline, launch comparison, and cloud conclusions", () => {
  // Dry dew point (-15 C at surface) so LCL (~4,600 m) is above the 3,000 m profile limit
  const levels = [
    [900, 1000, 15, -15],
    [850, 1500, 9, -16],
    [800, 2000, 3, -17],
    [750, 2500, -3, -18],
    [700, 3000, -9, -19],
  ].map(([p, z, t, td]) => ({ pressureHpa: p, heightM: z, temperatureC: t, dewPointC: td, windDirectionDeg: 270, windSpeedMps: 5 }));
  const s = balloonSounding({ validAt: "2026-09-29T12:00:00Z", levels }, 35)!;
  assert.equal(s.thermalTopProfileLimited, true);
  assert.match(s.marks.top!.label, /≥/);
  const doc: RaobDocument = {
    schemaVersion: 1,
    generatedAt: "2026-09-29T13:00:00Z",
    station: { id: "KBOI", name: "Boise", latitude: 43.57, longitude: -116.21, distanceKm: 20, elevationM: 1000 },
    soundings: [{ validAt: "2026-09-29T12:00:00Z", levels }],
  };
  const choice = choices(doc, { ...SRG, forecastMaxTempC: 35 }, TZ)[0];

  // For a 4,000 m launch above the 3,000 m profile limit, reports that the profile ends below launch and ceiling is unresolved
  const highLaunchReading = readChoice(choice, { ...SRG, forecastMaxTempC: 35 }, 4000, TZ);
  assert.match(highLaunchReading.headline, /thermals ≥ 9,843 ft MSL \(profile-limited\) · cloud reach unresolved/);
  assert.match(highLaunchReading.findings.find(f => f.key === "thermals")!.text, /buoyant through profile top.*ceiling unresolved/);
  const launchFinding = highLaunchReading.findings.find(f => f.key === "top")!;
  assert.match(launchFinding.text, /Profile ends at 9,843 ft MSL, near or below launch elevation 13,123 ft MSL · thermal ceiling unresolved/);
  assert.doesNotMatch(launchFinding.text, /Station parcel top near or below launch/);
  const cloudFinding = highLaunchReading.findings.find(f => f.key === "clouds")!;
  assert.match(cloudFinding.text, /above profile top 9,843 ft MSL · cloud reach unresolved/);
  assert.doesNotMatch(cloudFinding.text, /Blue thermals/);

  // For a 1,500 m launch below the 3,000 m profile limit, reports buoyant parcel at profile top with unresolved ceiling
  const lowLaunchReading = readChoice(choice, { ...SRG, forecastMaxTempC: 35 }, 1500, TZ);
  assert.match(lowLaunchReading.findings.find(f => f.key === "top")!.text, /Parcel remains buoyant at profile top.*ceiling unresolved/);
});
