import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCovered, launchOutsideGrid, stageModelBuild, buildModel } from "./build-covered.mjs";
import { engineTerrain } from './terrain.mjs';
import { validateCurrentDiagnostics } from './lib/diagnostic-completeness.mjs';
import { SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { postprocessPointForecast } from '@windgrams/soaring/compatibility';
import { parseSiteForecast } from '@azohra/meteo.briefing/contract';

const sites = [
  { slug: "va-daniels", name: "Daniels", latitude: 38.3105, longitude: -78.512 },
  { slug: "nc-jones-knob", name: "Jones Knob", latitude: 35.0786, longitude: -83.2937 },
  { slug: "nc-burkemont-mountain", name: "Burkemont Mountain", latitude: 35.6551, longitude: -81.7009 },
];

test('readiness retry settings stay with the build and invalid settings fail before acquisition', async t => {
  const root = mkdtempSync(join(tmpdir(), 'readiness-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalogue = join(root, 'sites.json');
  writeFileSync(catalogue, JSON.stringify({ sites }));
  let probed = false;
  const values = { model: 'rrfs', sites: catalogue, output: join(root, 'data'), 'readiness-attempts': '6', 'readiness-delay-ms': '60000' };
  await assert.rejects(() => buildModel(values, { probe: async (model, options) => {
    probed = true;
    assert.equal(model, 'rrfs');
    assert.deepEqual(options, { maxAttempts: 6, retryDelayMs: 60000 });
    return { selectedCycle: null };
  } }), /no complete upstream run/);
  assert.equal(probed, true);
  for (const invalid of [{ 'readiness-attempts': '0' }, { 'readiness-delay-ms': '-1' }, { 'readiness-attempts': '6.5' }]) {
    await assert.rejects(() => buildModel({ ...values, ...invalid }, { probe: () => assert.fail('No network for invalid retry settings') }), /must be an integer/);
  }
});

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
    const document = postprocessPointForecast(JSON.parse(readFileSync(new URL('../soaring/fixtures/rrfs-blanchard-published.json', import.meta.url))));
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

test('operator backfills a Mexican launch in the same run, skips complete work and repairs a truncated horizon', async t => {
  const output = mkdtempSync(join(tmpdir(), 'operator-backfill-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const fixture = JSON.parse(readFileSync(new URL('../soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
  const first = { slug: fixture.site.id, name: fixture.site.name, latitude: fixture.site.latitude, longitude: fixture.site.longitude, timeZone: fixture.site.timeZone };
  const second = { slug: 'mx-north', name: 'Mexican launch', latitude: 32, longitude: -116, timeZone: 'America/Tijuana' };
  const catalogue = join(output, 'catalogue.json');
  const setSites = selected => writeFileSync(catalogue, JSON.stringify({ sites: selected }));
  let acquisitions = 0;
  const measurements = [];
  const measureImpl = async selected => {
    measurements.push(selected.map(site => site.slug));
    return { schemaVersion: 3, generatedAt: `2026-10-24T${measurements.length === 1 ? '12' : '13'}:00:00Z`, sources: [engineTerrain.SOURCES.glo30, engineTerrain.SOURCES.worldcover2021],
      sites: Object.fromEntries(selected.map(site => [site.slug, { point: { latitude: site.latitude, longitude: site.longitude },
        elevation: { source: 'glo30', elevationM: 500 }, terrain: { source: 'glo30', elevationM: 500, slopeDeg: 10, aspectDeg: 180, relief: [{ radiusKm: 1, minM: 100, maxM: 700, percentile: 50 }] },
        landCover: { source: 'worldcover2021', atLaunch: 'grassland', fractions: [{ radiusKm: 1, byClass: { grassland: 1 } }] } }])) };
  };
  const adapterFactory = () => ({ acquire: async request => {
    acquisitions++;
    assert.equal(request.run.referenceTime, fixture.run.referenceTime);
    mkdirSync(join(request.outputRoot, 'rrfs/sites'), { recursive: true });
    for (const site of request.sites) {
      const doc = structuredClone(fixture); doc.site = { ...doc.site, ...site, id: site.slug }; delete doc.site.slug;
      writeFileSync(join(request.outputRoot, 'rrfs/sites', `${site.slug}.json`), JSON.stringify(doc));
    }
    writeFileSync(join(request.outputRoot, 'rrfs/manifest.json'), JSON.stringify({ model: 'rrfs', referenceTime: fixture.run.referenceTime, generatedAt: fixture.run.generatedAt,
      forecastHours: 84, firstForecastHour: 1, lastForecastHour: 84, sites: request.sites.map(site => ({ slug: site.slug, name: site.name })) }));
  } });
  const values = { model: 'rrfs', sites: catalogue, output, 'reference-time': fixture.run.referenceTime };
  const dependencies = { measureImpl, adapterFactory, log: () => {}, probe: () => { throw new Error('Pinned run must skip readiness probes'); } };
  setSites([first]); assert.equal((await buildModel(values, dependencies)).changed, true);
  setSites([first, second]); assert.equal((await buildModel(values, dependencies)).changed, true);
  assert.equal((await buildModel(values, dependencies)).changed, false);
  assert.equal(acquisitions, 2);
  // A method-only repair reuses complete retained source levels, preserves the issued revision,
  // and does not download a different set of inputs for the same initialization.
  const firstPath = join(output, 'rrfs/sites', `${first.slug}.json`), beforeRepair = JSON.parse(readFileSync(firstPath));
  const originalLevels = structuredClone(beforeRepair.hours.map(hour => hour.levels));
  beforeRepair.soaringMeta.contractVersion = '2.0.0';
  for (const hour of beforeRepair.hours) delete hour.soaring;
  writeFileSync(firstPath, JSON.stringify(beforeRepair));
  assert.equal((await buildModel(values, dependencies)).changed, true);
  assert.equal(acquisitions, 2);
  const repaired = JSON.parse(readFileSync(firstPath));
  validateCurrentDiagnostics(repaired);
  assert.deepEqual(repaired.hours.map(hour => hour.levels), originalLevels);
  assert.equal((await buildModel(values, dependencies)).changed, false);
  assert.deepEqual(measurements, [[first.slug], [second.slug]]);
  const context = JSON.parse(readFileSync(join(output, 'site-context-rrfs.json')));
  assert.equal(context.measurementTimes[first.slug], '2026-10-24T12:00:00Z');
  assert.equal(context.measurementTimes[second.slug], '2026-10-24T13:00:00Z');
  assert.equal(context.measurementPolicies[first.slug], 'terrain-v1:regional-north-america');
  assert.equal(context.measurementPolicies[second.slug], 'terrain-v1:glo30');
  const manifestPath = join(output, 'rrfs/manifest.json'), manifest = JSON.parse(readFileSync(manifestPath));
  manifest.forecastHours = 1; manifest.lastForecastHour = 1; writeFileSync(manifestPath, JSON.stringify(manifest));
  for (const site of [first, second]) {
    const path = join(output, 'rrfs/sites', `${site.slug}.json`), doc = JSON.parse(readFileSync(path));
    doc.hours = doc.hours.slice(0, 1); writeFileSync(path, JSON.stringify(doc));
  }
  assert.equal((await buildModel(values, dependencies)).changed, true);
  assert.equal(acquisitions, 3);
  assert.equal(JSON.parse(readFileSync(manifestPath)).forecastHours, 84);
});

test('diagnostic completeness accepts retained ensemble policy and rejects incomplete deterministic metadata', () => {
  const doc = postprocessPointForecast(JSON.parse(readFileSync(new URL('../soaring/fixtures/rrfs-blanchard-published.json', import.meta.url))));
  validateCurrentDiagnostics(doc);
  const missing = structuredClone(doc); delete missing.hours[0].soaring;
  assert.throws(() => validateCurrentDiagnostics(missing), /missing soaring diagnostics/);
  const nullified = structuredClone(doc); nullified.hours[0].soaring = null;
  assert.throws(() => validateCurrentDiagnostics(nullified), /unexplained unavailable/);
  assert.throws(() => validateCurrentDiagnostics({ ...doc, soaringMeta: { ...doc.soaringMeta, contractVersion: '2.0.0' } }), /outdated soaring method/);
  validateCurrentDiagnostics({ model: 'geps', run: { members: 21 }, hours: [{}], soaringMeta: { contractVersion: SOARING_CONTRACT_VERSION, modelKind: 'ensemble-percentiles',
    nonlinearMedianPostprocessRefused: true, postprocessAction: 'retained-upstream-member-percentiles' } });
});

test('diagnostic validation preserves missing versus zero while the pinned point-source contract rejects incomplete fluxes', () => {
  const input = JSON.parse(readFileSync(new URL('../soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
  input.hours = input.hours.slice(0, 1);
  input.hours[0].surface.sensibleHeatFluxWm2 = null;
  const missing = postprocessPointForecast(input);
  assert.equal(missing.hours[0].soaring.thermalVelocityV2Mps, null);
  validateCurrentDiagnostics(missing);
  // This tests the diagnostic guard independently. Production also requires
  // the pinned SiteForecast source contract, which does not accept null fluxes.
  assert.equal(parseSiteForecast(missing), null);
  const fabricated = structuredClone(missing);
  fabricated.hours[0].soaring.thermalVelocityV2Mps = 0;
  assert.throws(() => validateCurrentDiagnostics(fabricated), /missing heat flux/);
  for (const field of ['usableLiftTopV2M', 'hcritWxtoflyM', 'dryHcritM', 'buoyancyShearRatio']) {
    const invalid = structuredClone(missing); invalid.hours[0].soaring[field] = 0;
    assert.throws(() => validateCurrentDiagnostics(invalid), /requires thermal velocity/);
  }
  Object.assign(input.hours[0].surface, { sensibleHeatFluxWm2: 0, latentHeatFluxWm2: 0 });
  const zero = postprocessPointForecast(input);
  assert.equal(zero.hours[0].soaring.thermalVelocityV2Mps, 0);
  validateCurrentDiagnostics(zero);
  zero.hours[0].soaring.thermalVelocityV2Mps = null;
  assert.throws(() => validateCurrentDiagnostics(zero), /unexplained unavailable thermal velocity/);
});

test('empty regional coverage skips readiness, terrain and acquisition', async t => {
  const output = mkdtempSync(join(tmpdir(), 'operator-empty-')); t.after(() => rmSync(output, { recursive: true, force: true }));
  const catalogue = join(output, 'sites.json'); writeFileSync(catalogue, JSON.stringify({ sites: [{ slug: 'nz-test', latitude: -44, longitude: 169 }] }));
  const forbidden = () => { throw new Error('No external work expected'); };
  assert.deepEqual(await buildModel({ model: 'hrrr-conus', sites: catalogue, output }, { probe: forbidden, measureImpl: forbidden, adapterFactory: forbidden }), { changed: false, reason: 'no-covered-sites' });
});
