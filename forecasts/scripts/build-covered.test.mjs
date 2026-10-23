import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCovered, launchOutsideGrid, stageModelBuild } from "./build-covered.mjs";

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

function modelOutput(root, run, { omitProfile = false } = {}) {
  mkdirSync(join(root, 'rrfs', 'sites'), { recursive: true });
  writeFileSync(join(root, 'rrfs', 'manifest.json'), JSON.stringify({ model: 'rrfs', referenceTime: run, forecastHours: 2, sites: [{ slug: 'wa-tiger' }] }));
  if (!omitProfile) {
    const document = JSON.parse(readFileSync(new URL('../soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
    document.run.referenceTime = run;
    document.site.id = 'wa-tiger';
    document.hours = document.hours.slice(0, 2).map((hour, i) => ({ ...hour, validAt: new Date(Date.parse(run) + (i + 1) * 3600000).toISOString().replace('.000Z', 'Z') }));
    writeFileSync(join(root, 'rrfs', 'sites', 'wa-tiger.json'), JSON.stringify(document));
  }
}
const finish = () => ({ postprocessedCount: 1, archived: null });
const oldRun = '2026-10-22T18:00:00Z';
const newRun = '2026-10-23T00:00:00Z';

test('partial builds and postprocessing failures retain all last-good bytes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'build-covered-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  modelOutput(root, oldRun);
  const before = readFileSync(join(root, 'rrfs', 'manifest.json'), 'utf8');
  await assert.rejects(stageModelBuild(root, 'rrfs', async staging => {
    modelOutput(staging, newRun);
    throw new Error('download interrupted');
  }, finish), /download interrupted/);
  await assert.rejects(stageModelBuild(root, 'rrfs', async staging => modelOutput(staging, newRun),
    () => { throw new Error('invalid diagnostics'); }), /invalid diagnostics/);
  await assert.rejects(stageModelBuild(root, 'rrfs', async staging => modelOutput(staging, newRun, { omitProfile: true }), finish), /ENOENT/);
  assert.equal(readFileSync(join(root, 'rrfs', 'manifest.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(root), ['rrfs']);
});

test('complete staged builds replace stale launch files and reject older fallback runs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'build-covered-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  modelOutput(root, oldRun);
  writeFileSync(join(root, 'rrfs', 'sites', 'removed-launch.json'), '{}');
  const result = await stageModelBuild(root, 'rrfs', async staging => modelOutput(staging, newRun), finish);
  assert.equal(result.changed, true);
  assert.deepEqual(readdirSync(join(root, 'rrfs', 'sites')), ['wa-tiger.json']);
  await assert.rejects(stageModelBuild(root, 'rrfs', async staging => modelOutput(staging, oldRun), finish), /refusing to replace/);
  assert.equal(JSON.parse(readFileSync(join(root, 'rrfs', 'manifest.json'))).referenceTime, newRun);
});

test('a builder with no new run retains seeded output but cannot publish an empty first run', async t => {
  const root = mkdtempSync(join(tmpdir(), 'build-covered-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(stageModelBuild(root, 'rrfs', async () => {}, finish), /no complete output/);
  modelOutput(root, oldRun);
  assert.equal((await stageModelBuild(root, 'rrfs', async () => {}, finish)).changed, false);
});

test('semantic RRFS errors after postprocessing cannot replace last-good output', async t => {
  const root = mkdtempSync(join(tmpdir(), 'build-covered-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  modelOutput(root, oldRun);
  await assert.rejects(stageModelBuild(root, 'rrfs', async staging => modelOutput(staging, newRun), staging => {
    const path = join(staging, 'rrfs', 'sites', 'wa-tiger.json');
    const document = JSON.parse(readFileSync(path));
    document.hours[0].soaring.usableLiftTopV2M = document.hours[0].soaring.resolvedThermalTopM + 1000;
    writeFileSync(path, JSON.stringify(document));
    return finish();
  }), /exceeds thermal top/);
  assert.equal(JSON.parse(readFileSync(join(root, 'rrfs', 'manifest.json'))).referenceTime, oldRun);
});
