import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCovered, launchOutsideGrid } from "./build-covered.mjs";

const sites = [
  { slug: "va-daniels", name: "Daniels", latitude: 38.3105, longitude: -78.512 },
  { slug: "nc-jones-knob", name: "Jones Knob", latitude: 35.0786, longitude: -83.2937 },
  { slug: "nc-burkemont-mountain", name: "Burkemont Mountain", latitude: 35.6551, longitude: -81.7009 },
];

test("launchOutsideGrid matches a coordinate and a site name", () => {
  const coordinate = "error: hrdps-continental build failed: (35.0786, -83.2937) is outside the model grid (nearest gridpoint 84 km away)";
  assert.equal(launchOutsideGrid(coordinate, sites)?.slug, "nc-jones-knob");
  const named = "error: hrrr-conus build failed: Burkemont Mountain is outside the model grid (nearest gridpoint 40 km away)";
  assert.equal(launchOutsideGrid(named, sites)?.slug, "nc-burkemont-mountain");
  assert.equal(launchOutsideGrid("error: hrdps-continental build failed: Datamart returned 500", sites), null);
});

test("buildCovered drops launches the grid rejects and then succeeds", async () => {
  const seen = [];
  const result = await buildCovered("hrdps-continental", sites, async (remaining) => {
    seen.push(remaining.map((site) => site.slug));
    const blocked = remaining.find((site) => site.slug.startsWith("nc-"));
    if (blocked) return { status: 1, text: `error: hrdps-continental build failed: (${blocked.latitude}, ${blocked.longitude}) is outside the model grid` };
    return { status: 0, text: "Published 1 profiles" };
  }, () => {});
  assert.deepEqual(result.dropped, ["nc-jones-knob", "nc-burkemont-mountain"]);
  assert.deepEqual(result.kept.map((site) => site.slug), ["va-daniels"]);
  assert.equal(seen.length, 3);
});

test("buildCovered stops on an error that is not an uncovered launch", async () => {
  await assert.rejects(
    () => buildCovered("hrdps-continental", sites, async () => ({ status: 1, text: "error: disk full" }), () => {}),
    /disk full/,
  );
});
