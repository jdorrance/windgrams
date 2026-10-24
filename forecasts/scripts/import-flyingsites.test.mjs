import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildCatalog, buildCountryCatalog, mergeCatalogs, pointInGeometry, slugify, timeZoneFor, windFromFlags } from "./import-flyingsites.mjs";

const square = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};

test("point in polygon respects the ring", () => {
  assert.equal(pointInGeometry(0.5, 0.5, square), true);
  assert.equal(pointInGeometry(2, 2, square), false);
});

test("time zones follow the state, with far southeast Oregon on Mountain time", () => {
  assert.equal(timeZoneFor("VA", -78.5), "America/New_York");
  assert.equal(timeZoneFor("NC", -81.7), "America/New_York");
  assert.equal(timeZoneFor("WA", -122), "America/Los_Angeles");
  assert.equal(timeZoneFor("OR", -123), "America/Los_Angeles");
  assert.equal(timeZoneFor("OR", -117), "America/Boise");
  assert.equal(timeZoneFor("AM", 44.5), "Asia/Yerevan");
});

test("preferred compass flags set the facing; empty flags stay unknown", () => {
  const south = windFromFlags({ N: "0", NE: "0", E: "0", SE: "0", S: "2", SW: "2", W: "0", NW: "0" });
  assert.equal(south.facingDeg, 202);
  assert.ok(south.windArcHalfWidthDeg >= 20 && south.windArcHalfWidthDeg <= 90);
  assert.deepEqual(windFromFlags({ N: "0", NE: "0", E: "0", SE: "0", S: "0", SW: "0", W: "0", NW: "0" }), {
    facingDeg: null,
    windArcHalfWidthDeg: null,
  });
});

test("catalog slugs are prefixed by state and a second site with the same name gets a coordinate suffix", () => {
  const states = {
    VA: { name: "Virginia", geometry: square },
    WA: { name: "Washington", geometry: square },
    MD: { name: "Maryland", geometry: square },
    NC: { name: "North Carolina", geometry: square },
    OR: { name: "Oregon", geometry: square },
  };
  const feature = (name, lon, lat) => ({
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { name, takeoff_description: "  Grassy slope.  ", S: "2" },
  });
  const { sitesFile, launchesFile } = buildCatalog(
    [feature("Daniels", 0.2, 0.2), feature("Daniels", 0.4, 0.4), feature("Elsewhere", 5, 5)],
    states,
  );
  assert.deepEqual(
    sitesFile.sites.map((s) => s.slug),
    ["va-daniels", `va-daniels-${Math.round(0.4 * 100)}n${Math.round(0.4 * 100)}e`],
  );
  assert.equal(launchesFile.launches["va-daniels"].region, "Virginia");
  assert.equal(launchesFile.launches["va-daniels"].notes, "Grassy slope.");
  assert.equal(slugify("Woodrat Mountain"), "woodrat-mountain");
  assert.equal(launchesFile.launches["va-daniels"].windMinMph, null);
  assert.equal(launchesFile.launches["va-daniels"].windMaxMph, null);
  assert.equal(launchesFile.launches["va-daniels"].gustMaxMph, null);
});

const reviewed = JSON.parse(readFileSync(new URL("data/armenia-launches.json", import.meta.url), "utf8"));
const snapshot = JSON.parse(readFileSync(new URL("data/armenia-pge-source.json", import.meta.url), "utf8"));

test("Armenia includes every reviewed free-flight source record and seven additional takeoffs", () => {
  const catalog = buildCountryCatalog(reviewed);
  assert.equal(snapshot.features.length, 34);
  assert.equal(catalog.sitesFile.sites.length, 40);
  const sourceIds = new Set(reviewed.launches.map((site) => site.sourceId).filter(Boolean));
  assert.equal(sourceIds.size, 33);
  for (const record of snapshot.features) assert.equal(sourceIds.has(record.sourceId), record.sourceId !== "15652");
  assert.equal(new Set(catalog.sitesFile.sites.map((site) => site.slug)).size, 40);
  assert.equal(new Set(catalog.sitesFile.sites.map((site) => `${site.latitude},${site.longitude}`)).size, 40);
  for (const site of catalog.sitesFile.sites) {
    assert.equal(site.slug.startsWith("am-"), true);
    assert.equal(site.timeZone, "Asia/Yerevan");
    assert.ok(site.latitude >= 38.8 && site.latitude <= 41.3 && site.longitude >= 43.4 && site.longitude <= 46.7, site.slug);
    assert.equal("elevationM" in site, false, "unverified source altitudes must not become forecast terrain");
    const launch = catalog.launchesFile.launches[site.slug];
    assert.equal(launch.windMinMph, null);
    assert.equal(launch.windMaxMph, null);
    assert.equal(launch.gustMaxMph, null);
    assert.ok(launch.source.url.startsWith("https://"));
  }
  assert.equal(Object.values(catalog.launchesFile.launches).filter((site) => site.facingDeg === null).length, 22);
  assert.equal(catalog.launchesFile.launches["am-tsovagyugh"].facingDeg, 315);
  assert.equal(catalog.launchesFile.launches["am-aragats-south-summit"].facingDeg, null);
});

test("source corrections preserve original evidence and distinguish nearby takeoffs", () => {
  const { sitesFile } = buildCountryCatalog(reviewed);
  const site = (slug) => sitesFile.sites.find((entry) => entry.slug === slug);
  assert.deepEqual(snapshot.features.find((record) => record.sourceId === "14321").coordinates, [44, 39]);
  assert.ok(Math.abs(site("am-nor-ughi").latitude - (39 + 56 / 60 + 41.16 / 3600)) < 1e-8);
  assert.ok(Math.abs(site("am-nor-ughi").longitude - (44 + 40 / 60 + 34.03 / 3600)) < 1e-8);
  assert.equal(site("am-hatis-500").latitude, 40.294048);
  assert.equal(site("am-hatis-500").longitude, 44.697437);
  for (const slug of ["am-lernaglukh", "am-aparan", "am-teghenis", "am-teghenis-summit", "am-gutansar", "am-gutansar-summit", "am-tsovagyugh", "am-sevan-upper", "am-lusashogh", "am-lusashogh-2"]) assert.ok(site(slug), slug);
});

test("imports preserve existing regions, manual coordinates and notes, and stay idempotent", () => {
  const armenia = buildCountryCatalog(reviewed);
  const retainedSite = { slug: "va-woodstock", name: "Woodstock", latitude: 38.87, longitude: -78.45, timeZone: "America/New_York" };
  const retainedLaunch = { facingDeg: 315, windArcHalfWidthDeg: 45, windMinMph: 5, windMaxMph: 15, gustMaxMph: 20, region: "Virginia", notes: "Keep this manual edit." };
  const existing = { sitesFile: { schemaVersion: 2, sites: [retainedSite] }, launchesFile: { schemaVersion: 1, launches: { "va-woodstock": retainedLaunch } } };
  const merged = mergeCatalogs(existing, armenia);
  assert.deepEqual(merged.sitesFile.sites[0], retainedSite);
  assert.deepEqual(merged.launchesFile.launches["va-woodstock"], retainedLaunch);
  assert.equal(merged.sitesFile.sites.length, 41);
  const changedSource = structuredClone(armenia);
  changedSource.sitesFile.sites[0].latitude += 0.01;
  changedSource.launchesFile.launches[changedSource.sitesFile.sites[0].slug].notes = "Replacement source note";
  assert.deepEqual(mergeCatalogs(merged, changedSource), merged);
  // A later US-only import cannot discard the Armenian catalogue or manual edits.
  const usSource = { sitesFile: { schemaVersion: 2, sites: [{ ...retainedSite, latitude: 0 }] }, launchesFile: { schemaVersion: 1, launches: { "va-woodstock": { ...retainedLaunch, notes: "Raw source text" } } } };
  assert.deepEqual(mergeCatalogs(merged, usSource), merged);
});

test("reviewed country imports reject duplicate identities, bad coordinates and incomplete attribution", () => {
  const duplicate = structuredClone(reviewed);
  duplicate.launches.push(duplicate.launches[0]);
  assert.throws(() => buildCountryCatalog(duplicate), /duplicate launch slug/);
  const invalid = structuredClone(reviewed);
  invalid.launches[0].latitude = 100;
  assert.throws(() => buildCountryCatalog(invalid), /Invalid launch location/);
  const anonymous = structuredClone(reviewed);
  anonymous.launches[0].source = undefined;
  assert.throws(() => buildCountryCatalog(anonymous), /attribution required/);
});
