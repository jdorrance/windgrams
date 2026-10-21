import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsIndexFromDisk } from "./write-runs-index.mjs";

test("runsIndexFromDisk keeps models that have a manifest and skips the rest", () => {
  const output = mkdtempSync(join(tmpdir(), "runs-"));
  mkdirSync(join(output, "hrrr-conus"), { recursive: true });
  writeFileSync(
    join(output, "hrrr-conus", "manifest.json"),
    JSON.stringify({ model: "hrrr-conus", referenceTime: "2026-10-21T00:00:00Z", generatedAt: "2026-10-21T02:00:00Z" }),
  );
  const index = runsIndexFromDisk(output, ["hrrr-conus", "gfs"]);
  assert.deepEqual(index, {
    schemaVersion: 1,
    runs: { "hrrr-conus": { referenceTime: "2026-10-21T00:00:00Z", generatedAt: "2026-10-21T02:00:00Z" } },
  });
});
