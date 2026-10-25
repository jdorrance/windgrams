import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveModelRun, archivedModelRuns, mergeHistoryArchives } from './history.mjs';
import { scoreHistory } from './score-history.mjs';

function workspace(t) { const root = mkdtempSync(join(tmpdir(), 'issued-history-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function issue(root, { referenceTime = '2026-10-21T00:00:00Z', temperatureC = 10, version = '2.1.0', build = 'a' } = {}) {
  const dir = join(root, 'hrrr-conus'); mkdirSync(join(dir, 'sites'), { recursive: true });
  const levels = [925, 900, 850].map((pressureHpa, i) => ({ pressureHpa, heightM: 500 + i * 500, temperatureC, dewPointC: 5, windSpeedMps: 3, windDirectionDeg: 180 }));
  const doc = { model: 'hrrr-conus', site: { id: 'or-woodrat-mountain', modelElevationM: 300 }, run: { referenceTime }, soaringMeta: { contractVersion: version },
    hours: [{ validAt: referenceTime, surface: { temperatureC }, levels, soaring: { contractVersion: version, thermalVelocityV2Mps: 0 } }] };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ model: doc.model, referenceTime, forecastHours: 1, diagnosticBuild: { implementationSha256: build }, sites: [{ slug: doc.site.id }] }));
  writeFileSync(join(dir, 'sites', `${doc.site.id}.json`), JSON.stringify(doc));
  return doc;
}

test('issued revisions are idempotent, preserve source identity and add changed method/build/content', t => {
  const root = workspace(t); issue(root);
  const a = archiveModelRun(root, 'hrrr-conus'), run = join(root, 'history/hrrr-conus', a.runKey), path = join(run, 'revisions', a.revisionId, 'sites/or-woodrat-mountain.json');
  const bytes = readFileSync(path), modified = statSync(path).mtimeMs;
  assert.equal(archiveModelRun(root, 'hrrr-conus').created, false);
  assert.equal(statSync(path).mtimeMs, modified);
  issue(root, { version: '2.0.0' }); const b = archiveModelRun(root, 'hrrr-conus');
  issue(root, { build: 'b' }); const c = archiveModelRun(root, 'hrrr-conus');
  assert.equal(new Set([a.revisionId, b.revisionId, c.revisionId]).size, 3);
  assert.deepEqual(readFileSync(path), bytes);
  issue(root); archiveModelRun(root, 'hrrr-conus');
  assert.equal(JSON.parse(readFileSync(join(run, 'index.json'))).latest, c.revisionId);
  assert.equal(archivedModelRuns(root, 'hrrr-conus')[0].revisionId, a.revisionId);
  const compact = JSON.parse(bytes); assert.deepEqual(compact.hours[0].levels.map(l => l.pressureHpa), [925, 850]);
  assert.throws(() => archiveModelRun(root, 'hrrr-conus', { retainFullColumns: true }), /explicitly pinned/);
  const full = archiveModelRun(root, 'hrrr-conus', { retainFullColumns: true, pinnedRunKeys: [a.runKey] });
  assert.deepEqual(readFileSync(join(run, 'revisions', full.revisionId, 'full-columns/sites/or-woodrat-mountain.json')), readFileSync(join(root, 'hrrr-conus/sites/or-woodrat-mountain.json')));
});

test('history merges validated immutable revisions, retains all issues and refuses corrupt inputs before copy', t => {
  const incoming = workspace(t), output = workspace(t); issue(incoming);
  const a = archiveModelRun(incoming, 'hrrr-conus');
  assert.equal(mergeHistoryArchives(incoming, output, 'hrrr-conus').copiedRevisions, 1);
  issue(incoming, { build: 'b' }); const b = archiveModelRun(incoming, 'hrrr-conus');
  assert.equal(mergeHistoryArchives(incoming, output, 'hrrr-conus').copiedRevisions, 1);
  const run = join(output, 'history/hrrr-conus', a.runKey);
  assert.deepEqual(JSON.parse(readFileSync(join(run, 'index.json'))), { schemaVersion: 1, revisions: [a.revisionId, b.revisionId], latest: b.revisionId });
  const stale = workspace(t); issue(stale); archiveModelRun(stale, 'hrrr-conus'); mergeHistoryArchives(stale, output, 'hrrr-conus');
  assert.equal(JSON.parse(readFileSync(join(run, 'index.json'))).latest, b.revisionId);
  const damaged = join(incoming, 'history/hrrr-conus', a.runKey, 'revisions', a.revisionId, 'sites/or-woodrat-mountain.json'); writeFileSync(damaged, '{}');
  assert.throws(() => mergeHistoryArchives(incoming, output, 'hrrr-conus'), /Corrupt issued-history/);
  assert.equal(readdirSync(join(run, 'revisions')).length, 2);
});

test('retention counts runs and legacy issue files are never overwritten', t => {
  const root = workspace(t); issue(root); const first = archiveModelRun(root, 'hrrr-conus');
  const legacy = join(root, 'history/hrrr-conus', first.runKey); cpSync(join(root, 'hrrr-conus/manifest.json'), join(legacy, 'manifest.json')); cpSync(join(root, 'hrrr-conus/sites'), join(legacy, 'sites'), { recursive: true });
  const bytes = readFileSync(join(legacy, 'sites/or-woodrat-mountain.json')); issue(root, { temperatureC: 12 }); archiveModelRun(root, 'hrrr-conus');
  assert.deepEqual(readFileSync(join(legacy, 'sites/or-woodrat-mountain.json')), bytes);
  assert.equal(archivedModelRuns(root, 'hrrr-conus')[0].revisionId, 'legacy');
  for (const day of [22, 23, 24]) { issue(root, { referenceTime: `2026-10-${day}T00:00:00Z` }); archiveModelRun(root, 'hrrr-conus', { maxRollingRuns: 1, pinnedRunKeys: [first.runKey] }); }
  assert.deepEqual(readdirSync(join(root, 'history/hrrr-conus')).sort(), [first.runKey, '20261024T000000Z']);
  assert.equal(readdirSync(join(legacy, 'revisions')).length, 2);
});

test('conflicting legacy history is rejected without overwriting the original issue', t => {
  const incoming = workspace(t), output = workspace(t);
  for (const root of [incoming, output]) {
    issue(root, { temperatureC: root === incoming ? 99 : 10 });
    const legacy = join(root, 'history/hrrr-conus/20261021T000000Z'); mkdirSync(legacy, { recursive: true });
    cpSync(join(root, 'hrrr-conus/manifest.json'), join(legacy, 'manifest.json')); cpSync(join(root, 'hrrr-conus/sites'), join(legacy, 'sites'), { recursive: true });
  }
  const path = join(output, 'history/hrrr-conus/20261021T000000Z/sites/or-woodrat-mountain.json'), original = readFileSync(path);
  assert.throws(() => mergeHistoryArchives(incoming, output, 'hrrr-conus'), /Conflicting legacy history/);
  assert.deepEqual(readFileSync(path), original);
});

test('partial legacy archives preserve available evidence without blocking complete new revisions', t => {
  const incoming = workspace(t), output = workspace(t); issue(incoming);
  const manifestPath = join(incoming, 'hrrr-conus/manifest.json'), manifest = JSON.parse(readFileSync(manifestPath));
  manifest.sites.push({ slug: 'historically-omitted' });
  const legacy = join(incoming, 'history/hrrr-conus/20261021T000000Z'); mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'manifest.json'), JSON.stringify(manifest)); cpSync(join(incoming, 'hrrr-conus/sites'), join(legacy, 'sites'), { recursive: true });
  const revision = archiveModelRun(incoming, 'hrrr-conus');
  assert.equal(mergeHistoryArchives(incoming, output, 'hrrr-conus').copiedRevisions, 1);
  assert.equal(archivedModelRuns(output, 'hrrr-conus')[0].revisionId, 'legacy');
  assert.equal(mergeHistoryArchives(incoming, output, 'hrrr-conus').copiedRevisions, 0);
  assert.equal(readdirSync(join(output, 'history/hrrr-conus', revision.runKey, 'sites')).length, 1);
  const path = join(legacy, 'sites/or-woodrat-mountain.json'), wrong = JSON.parse(readFileSync(path)); wrong.model = 'rrfs'; writeFileSync(path, JSON.stringify(wrong));
  assert.throws(() => mergeHistoryArchives(incoming, output, 'hrrr-conus'), /Invalid legacy history profile identity/);
});

test('bounded offline scorer selects original issued values and reports independent evidence', t => {
  const root = workspace(t), first = issue(root); archiveModelRun(root, 'hrrr-conus'); issue(root, { temperatureC: 50 }); archiveModelRun(root, 'hrrr-conus');
  mkdirSync(join(root, 'raob/sites'), { recursive: true });
  writeFileSync(join(root, 'raob/sites/or-woodrat-mountain.json'), JSON.stringify({ station: { id: 'KMFR', distanceKm: 18 }, soundings: [{ validAt: first.run.referenceTime, levels: first.hours[0].levels }] }));
  const opts = { dataRoot: root, models: ['hrrr-conus'], from: first.run.referenceTime, to: '2026-10-22T00:00:00Z', maxRuns: 1 };
  const report = scoreHistory(opts);
  assert.equal(report.evaluatorVersion, '3.0.0'); assert.equal(report.matchedCount, 1); assert.equal(report.independentStationDays, 1);
  assert.equal(report.comparisons[0].metrics.temperatureMaeC, 0); assert.equal(report.byMatchTier['exact-valid-time'].temperatureMaeC.comparisons, 1);
  assert.equal(report.byMatchTier['near-init-f01-60min'].comparisons, 0);
  assert.throws(() => scoreHistory({ ...opts, maxRuns: 121 }), /bounded history/);
  assert.throws(() => scoreHistory({ ...opts, to: '2027-10-22T00:00:00Z' }), /120 days/);
  assert.equal(scoreHistory({ ...opts, from: '2026-10-23T00:00:00Z', to: '2026-10-24T00:00:00Z' }).status, 'no-matched-observations');
});
