import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog, pointInGeometry, slugify, timeZoneFor, windFromFlags } from "./import-flyingsites.mjs";

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
});

test("preferred compass flags set the facing; empty flags keep the default window", () => {
  const south = windFromFlags({ N: "0", NE: "0", E: "0", SE: "0", S: "2", SW: "2", W: "0", NW: "0" });
  assert.equal(south.facingDeg, 202);
  assert.ok(south.windArcHalfWidthDeg >= 20 && south.windArcHalfWidthDeg <= 90);
  assert.deepEqual(windFromFlags({ N: "0", NE: "0", E: "0", SE: "0", S: "0", SW: "0", W: "0", NW: "0" }), {
    facingDeg: 0,
    windArcHalfWidthDeg: 45,
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
});
