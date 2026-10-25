#!/usr/bin/env node
// Node 24. Offline, actual-renderer comparison against the pinned Git baseline.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadVisualFixture, manifest, repoRoot, sha256 } from '../test/fixtures/windgram-visual/scenarios.mjs';

const arg = (key, fallback) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? fallback : process.argv[index + 1];
};
const output = resolve(arg('--out', tmpdir() + '/windgram-visual-qa'));
const revision = arg('--baseline', manifest.baselineRevision);
const selected = arg('--fixtures', '').split(',').filter(Boolean);
const fixtures = manifest.fixtures.filter(entry => !selected.length || selected.includes(entry.id));
assert.ok(fixtures.length, 'At least one known fixture is required');
assert.equal(sha256(readFileSync(repoRoot + 'web/pnpm-lock.yaml')), manifest.dependencyLockSha256,
  'Dependency lock changed: review and explicitly refresh fixture provenance before comparing');
mkdirSync(output, { recursive: true });

// Git objects freeze every local library dependency, not just the entry module.
// Both versions use the exact dependency lock recorded with the fixtures.
const snapshot = mkdtempSync(tmpdir() + '/windgram-visual-baseline-');
const archive = execFileSync('git', ['archive', revision, 'web/src/lib', 'web/src/styles/global.css'], { cwd: repoRoot });
execFileSync('tar', ['-xf', '-', '-C', snapshot], { input: archive });
symlinkSync(repoRoot + 'web/node_modules', snapshot + '/web/node_modules', 'dir');
writeFileSync(snapshot + '/web/package.json', '{"type":"module"}\n');
async function modules(root) {
  const module = name => import(pathToFileURL(root + '/web/src/lib/' + name + '.ts').href);
  const [view, chart, sampling, published, stability] = await Promise.all([
    module('windgram-view'), module('windgram-chart'), module('windgram-sampling'),
    module('published-lift'), module('windgram-stability'),
  ]);
  return { ...view, ...chart, ...sampling, ...published, ...stability };
}
const [before, after] = await Promise.all([modules(snapshot), modules(repoRoot.replace(/\/$/, ''))]);
const boundaries = module => module.WINDGRAM_STABILITY.map(({ className, maxLapse }) => ({ className, maxLapse }));
assert.deepEqual(boundaries(after), boundaries(before), 'Physical lapse-rate categories must stay fixed');
const classification = (module, value) => Number.isFinite(value)
  ? module.WINDGRAM_STABILITY.find(band => value <= band.maxLapse).className : 'missing';
function physics(module, profile) {
  return profile.hours.map(hour => {
    const sampling = module.hourSampling(hour, profile.site.modelElevationM);
    return { validAt: hour.validAt, sampling, lift: module.publishedLift(hour),
      wxtoflyLiftTopM: module.publishedWxtoflyLiftTop(hour),
      lapseClasses: sampling.lapseCPer1000Ft.map(node => classification(module, node.value)) };
  });
}
function checkView(module, view, profile, sourcePhysics, entry) {
  const real = new Map(profile.hours.map(hour => [hour.validAt, hour]));
  const expected = new Map(sourcePhysics.map(hour => [hour.validAt, hour]));
  assert.equal(view.ground.source, 'launch');
  assert.equal(view.ground.elevationM, entry.launch.elevationM);
  for (const [i, hour] of view.hours.entries()) {
    assert.ok(real.has(hour.validAt), 'Presentation must never invent a forecast hour');
    assert.deepEqual(view.sampling[i], expected.get(hour.validAt).sampling, 'Native physical sampling changed');
    assert.equal(hour.thermalVelocityMps, expected.get(hour.validAt).lift.thermalVelocityMps);
    assert.equal(hour.usableLiftTopM, expected.get(hour.validAt).lift.usableLiftTopM);
    for (const height of [view.floorM, view.topM, hour.usableLiftTopM].filter(Number.isFinite)) {
      const reading = module.readWindgram(view, i, height);
      assert.equal(reading.heightAglM, reading.heightM - entry.launch.elevationM, 'AGL source changed');
    }
  }
  for (const tick of view.timeAxis) {
    if (tick.hourIndex !== null) assert.equal(tick.validAt, view.hours[tick.hourIndex].validAt);
  }
}
function compareReadings(left, right) {
  const indices = new Map(right.hours.map((hour, i) => [hour.validAt, i]));
  const floor = Math.max(left.floorM, right.floorM), top = Math.min(left.topM, right.topM);
  for (const [i, hour] of left.hours.entries()) {
    const j = indices.get(hour.validAt);
    if (j === undefined) continue; // Daylight cropping may change the displayed time range.
    const heights = left.sampling[i].temperatureC.map(node => node.altitudeM);
    heights.push(...heights.slice(1).map((height, k) => (height + heights[k]) / 2));
    if (hour.usableLiftTopM !== null) heights.push(hour.usableLiftTopM);
    for (const height of heights.filter(z => z >= floor && z <= top)) {
      const old = before.readWindgram(left, i, height), next = after.readWindgram(right, j, height);
      // Array positions are presentation; source time, physical values and AGL are invariant.
      const { hourIndex: oldIndex, ...oldReading } = old;
      const { hourIndex: newIndex, ...newReading } = next;
      assert.deepEqual(newReading, oldReading, 'Inspector physics at ' + hour.validAt + ' / ' + height + ' m');
    }
  }
}
const state = view => ({ width: view.width, height: view.height, floorM: view.floorM, topM: view.topM,
  hours: view.hours.map(hour => hour.validAt), axisStart: view.timeAxis[0]?.validAt,
  axisEnd: view.timeAxis.at(-1)?.validAt, emptyAxisTicks: view.timeAxis.filter(tick => tick.hourIndex === null).length });
const sourceHashes = () => Object.fromEntries([
  ...readdirSync(repoRoot + 'web/src/lib').filter(name => name.endsWith('.ts')).sort().map(name => 'web/src/lib/' + name),
  'web/src/styles/global.css',
].map(path => [path, sha256(readFileSync(repoRoot + path))]));
const workingFiles = sourceHashes();
const report = { baselineRevision: revision, workingRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  dependencyLockSha256: manifest.dependencyLockSha256, generatedAt: new Date().toISOString(),
  fixtureManifestSha256: sha256(readFileSync(repoRoot + 'web/test/fixtures/windgram-visual/manifest.json')),
  scenarioRecipeSha256: sha256(readFileSync(repoRoot + 'web/test/fixtures/windgram-visual/scenarios.mjs')), workingFiles,
  runnerSha256: sha256(readFileSync(new URL('./windgram-visual-qa.mjs', import.meta.url))),
  snapshot, checks: ['fixture hashes', 'source timestamps', 'parsed source records', 'native sampling', 'lapse classifications',
    'published lift diagnostics', 'AGL ground reference', 'inspector physical readings', 'source immutability', 'finite SVG coordinates'], fixtures: [] };

for (const entry of fixtures) {
  const raw = loadVisualFixture(entry), text = JSON.stringify(raw);
  const oldProfile = before.parsePublishedProfileJson(text), newProfile = after.parsePublishedProfileJson(text);
  assert.ok(oldProfile && newProfile, entry.id + ' parses');
  assert.deepEqual(newProfile, oldProfile, entry.id + ' parsed source records');
  assert.deepEqual(newProfile.run, oldProfile.run);
  const oldPhysics = physics(before, oldProfile), newPhysics = physics(after, newProfile);
  assert.deepEqual(newPhysics, oldPhysics, entry.id + ' source physics');
  for (const [module, profile] of [[before, oldProfile], [after, newProfile]]) {
    const fallback = module.buildWindgramView(profile, { timeZone: entry.timeZone, compact: true,
      widthPx: 356, heightRange: 'soaring', hours: { dateKey: entry.day, timeZone: entry.timeZone } });
    assert.deepEqual(fallback.ground, { elevationM: profile.site.modelElevationM, source: 'model' });
    const reading = module.readWindgram(fallback, 0, fallback.floorM + 100);
    assert.equal(reading.heightAglM, reading.heightM - profile.site.modelElevationM);
  }
  const profileHash = sha256(JSON.stringify(oldProfile));
  const result = { id: entry.id, kind: entry.kind, source: entry.source, physicsSha256: sha256(JSON.stringify(oldPhysics)),
    sourceHourCount: raw.hours.length, variants: [] };
  mkdirSync(output + '/scenes/' + entry.id, { recursive: true });
  for (const [width, height] of manifest.viewports) for (const units of manifest.units) for (const range of manifest.ranges) {
    const compact = width <= 640 || (width <= 960 && height <= 600);
    const options = { timeZone: entry.timeZone, hours: { dateKey: entry.day, timeZone: entry.timeZone },
      launch: entry.launch, unitSystem: units, widthPx: width - 34, heightPx: height, compact, heightRange: range };
    const oldView = before.buildWindgramView(oldProfile, options), newView = after.buildWindgramView(newProfile, options);
    checkView(before, oldView, oldProfile, oldPhysics, entry);
    checkView(after, newView, newProfile, newPhysics, entry);
    compareReadings(oldView, newView);
    const key = width + 'x' + height + '-' + units + '-' + range;
    // Each harness page shows one SVG. Shared IDs keep the change flag about
    // presentation, rather than an artificial before/after prefix difference.
    const oldSvg = before.renderWindgramSvg(oldView, { idPrefix: entry.id + '-comparison' });
    const newSvg = after.renderWindgramSvg(newView, { idPrefix: entry.id + '-comparison' });
    for (const [version, svg, module] of [['before', oldSvg, before], ['after', newSvg, after]]) {
      assert.ok(!/NaN|Infinity/.test(svg), entry.id + ' finite SVG');
      writeFileSync(output + '/scenes/' + entry.id + '/' + key + '-' + version + '.svg', svg);
      writeFileSync(output + '/scenes/' + entry.id + '/' + units + '-' + version + '-key.html', module.renderWindgramKey(units));
    }
    result.variants.push({ key, before: state(oldView), after: state(newView), svgChanged: oldSvg !== newSvg });
  }
  assert.equal(sha256(JSON.stringify(oldProfile)), profileHash, entry.id + ' baseline source immutability');
  assert.equal(sha256(JSON.stringify(newProfile)), profileHash, entry.id + ' working source immutability');
  report.fixtures.push(result);
  console.log(entry.id + ': 16 paired scenes; physics and AGL unchanged');
}
assert.deepEqual(sourceHashes(), workingFiles, 'Source files changed during QA; rerun after edits finish');
report.status = 'passed';
report.checkedPairs = fixtures.length * 16;
report.svgCount = report.checkedPairs * 2;
writeFileSync(output + '/report.json', JSON.stringify(report, null, 2) + '\n');
writeFileSync(output + '/manifest.json', JSON.stringify({ ...manifest, fixtures }, null, 2) + '\n');
writeFileSync(output + '/before.css', readFileSync(snapshot + '/web/src/styles/global.css'));
writeFileSync(output + '/after.css', readFileSync(repoRoot + 'web/src/styles/global.css'));
writeFileSync(output + '/index.html', readFileSync(new URL('./windgram-visual-qa.html', import.meta.url)));
console.log('PASS: ' + fixtures.length * 16 + ' paired scenes. Open ' + output + '/index.html through a local HTTP server.');
