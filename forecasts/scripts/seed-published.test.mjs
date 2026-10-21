import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGroup, collectGroup, groupHasLocal } from "./seed-published.mjs";

test("collectGroup follows a model manifest and skips a 404", async () => {
  const docs = {
    "hrrr-conus/manifest.json": { model: "hrrr-conus", sites: [{ slug: "va-daniels" }, { slug: "va-eagle-rock" }] },
    "hrrr-conus/sites/va-daniels.json": { slug: "va-daniels" },
    "gfs/manifest.json": null,
  };
  const files = await collectGroup("noaa-cloud", {
    get: async (key) => (Object.hasOwn(docs, key) ? docs[key] : null),
  });
  assert.deepEqual([...files.keys()], ["hrrr-conus/manifest.json", "hrrr-conus/sites/va-daniels.json"]);
});

test("collectGroup reads NWS offices, ECMWF sites, and one balloon file per launch", async () => {
  const asked = [];
  await collectGroup("observations", {
    sites: [{ slug: "va-daniels" }],
    get: async (key) => {
      asked.push(key);
      if (key === "nws/manifest.json") return { sites: [{ slug: "va-daniels" }], offices: [{ office: "LWX" }] };
      if (key === "ecmwf/manifest.json") return { sites: [{ slug: "va-daniels" }] };
      return { key };
    },
  });
  assert.deepEqual(asked, [
    "nws/manifest.json",
    "nws/sites/va-daniels.json",
    "nws/offices/LWX.json",
    "ecmwf/manifest.json",
    "ecmwf/sites/va-daniels.json",
    "raob/sites/va-daniels.json",
  ]);
});

test("applyGroup replaces a model directory and leaves an unfetched model", () => {
  const output = mkdtempSync(join(tmpdir(), "seed-"));
  mkdirSync(join(output, "hrrr-conus", "sites"), { recursive: true });
  mkdirSync(join(output, "gfs"), { recursive: true });
  writeFileSync(join(output, "hrrr-conus", "sites", "old.json"), "{}\n");
  writeFileSync(join(output, "gfs", "manifest.json"), "{}\n");
  applyGroup(output, "noaa-cloud", new Map([
    ["hrrr-conus/manifest.json", { model: "hrrr-conus" }],
    ["hrrr-conus/sites/va-daniels.json", { slug: "va-daniels" }],
  ]));
  assert.equal(readFileSync(join(output, "hrrr-conus", "sites", "va-daniels.json"), "utf8").includes("va-daniels"), true);
  assert.equal(readFileSync(join(output, "gfs", "manifest.json"), "utf8"), "{}\n");
  assert.throws(() => readFileSync(join(output, "hrrr-conus", "sites", "old.json")));
  assert.equal(groupHasLocal(output, "noaa-cloud"), true);
});
