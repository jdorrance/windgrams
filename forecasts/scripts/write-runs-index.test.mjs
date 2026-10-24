import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsIndexFromDisk } from "./write-runs-index.mjs";

test("runsIndexFromDisk keeps models that have a manifest and skips the rest", t => {
  const output = mkdtempSync(join(tmpdir(), "runs-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
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

test('default run index includes the local ICON adapter', t => {
  const output = mkdtempSync(join(tmpdir(), 'runs-icon-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  mkdirSync(join(output, 'icon-eu'), { recursive: true });
  const run = { referenceTime: '2026-10-24T00:00:00Z', generatedAt: '2026-10-24T04:00:00Z' };
  writeFileSync(join(output, 'icon-eu', 'manifest.json'), JSON.stringify({ model: 'icon-eu', ...run }));
  assert.deepEqual(runsIndexFromDisk(output).runs, { 'icon-eu': run });
});
