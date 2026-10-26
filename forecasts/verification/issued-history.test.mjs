import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveModelRun, archivedModelRuns, mergeHistoryArchives } from './history.mjs';
import { compressHistoryArchives, copyIssuedHistoryTree, readIssuedHistoryFile } from './issued-history.mjs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { scoreHistory } from './score-history.mjs';
import { calendarHistoryCoverage } from './history-coverage.mjs';

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
  const a = archiveModelRun(root, 'hrrr-conus'), run = join(root, 'history/hrrr-conus', a.runKey), path = join(run, 'revisions', a.revisionId, 'sites/or-woodrat-mountain.json.gz');
  const bytes = gunzipSync(readFileSync(path)), modified = statSync(path).mtimeMs;
  assert.equal(archiveModelRun(root, 'hrrr-conus').created, false);
  assert.equal(statSync(path).mtimeMs, modified);
  issue(root, { version: '2.0.0' }); const b = archiveModelRun(root, 'hrrr-conus');
  issue(root, { build: 'b' }); const c = archiveModelRun(root, 'hrrr-conus');
  assert.equal(new Set([a.revisionId, b.revisionId, c.revisionId]).size, 3);
  assert.deepEqual(gunzipSync(readFileSync(path)), bytes);
  issue(root); archiveModelRun(root, 'hrrr-conus');
  assert.equal(JSON.parse(readFileSync(join(run, 'index.json'))).latest, c.revisionId);
  assert.equal(archivedModelRuns(root, 'hrrr-conus')[0].revisionId, a.revisionId);
  const compact = JSON.parse(bytes); assert.deepEqual(compact.hours[0].levels.map(l => l.pressureHpa), [925, 850]);
  assert.throws(() => archiveModelRun(root, 'hrrr-conus', { retainFullColumns: true }), /explicitly pinned/);
  const full = archiveModelRun(root, 'hrrr-conus', { retainFullColumns: true, pinnedRunKeys: [a.runKey] });
  assert.deepEqual(readIssuedHistoryFile(join(run, 'revisions', full.revisionId), 'full-columns/sites/or-woodrat-mountain.json'), readFileSync(join(root, 'hrrr-conus/sites/or-woodrat-mountain.json')));
});

test('selected full-column sites are saved with the first issue without broad archive duplication', t => {
  const root = workspace(t); issue(root);
  const live = join(root, 'hrrr-conus'), originalPath = join(live, 'sites/or-woodrat-mountain.json');
  const original = readFileSync(originalPath), other = JSON.parse(original); other.site.id = 'unselected-site';
  writeFileSync(join(live, 'sites/unselected-site.json'), JSON.stringify(other));
  const manifestPath = join(live, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestPath));
  manifest.sites.push({ slug: 'unselected-site' }); writeFileSync(manifestPath, JSON.stringify(manifest));
  const options = { retainFullColumnSites: ['or-woodrat-mountain', 'outside-this-model'], minimumCalendarDays: 30 };
  const first = archiveModelRun(root, 'hrrr-conus', options);
  assert.deepEqual(first.fullColumnSites, ['or-woodrat-mountain']);
  const selected = archivedModelRuns(root, 'hrrr-conus')[0];
  assert.equal(selected.revisionId, first.revisionId);
  assert.deepEqual(readIssuedHistoryFile(selected.directory, 'full-columns/sites/or-woodrat-mountain.json'), original);
  assert.deepEqual(readdirSync(join(selected.directory, 'full-columns/sites')), ['or-woodrat-mountain.json.gz']);
  assert.equal(JSON.parse(readIssuedHistoryFile(selected.directory, 'sites/or-woodrat-mountain.json')).hours[0].levels.length, 2);
  const repeat = archiveModelRun(root, 'hrrr-conus', options);
  assert.equal(repeat.created, false); assert.equal(repeat.revisionId, first.revisionId);
  const changed = JSON.parse(original); changed.hours[0].surface.temperatureC = 50;
  writeFileSync(originalPath, JSON.stringify(changed)); archiveModelRun(root, 'hrrr-conus', options);
  assert.equal(archivedModelRuns(root, 'hrrr-conus')[0].revisionId, first.revisionId);
  assert.deepEqual(readIssuedHistoryFile(selected.directory, 'full-columns/sites/or-woodrat-mountain.json'), original);
  assert.throws(() => archiveModelRun(root, 'hrrr-conus', { retainFullColumnSites: ['../outside'] }), /distinct site slugs/);
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
  const damaged = join(incoming, 'history/hrrr-conus', a.runKey, 'revisions', a.revisionId, 'sites/or-woodrat-mountain.json.gz'); writeFileSync(damaged, gzipSync('{}'));
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

test('optional calendar retention keeps whole UTC dates in addition to run count and pins', t => {
  const root = workspace(t);
  for (const referenceTime of ['2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z',
    '2026-10-22T23:00:00Z', '2026-10-23T00:00:00Z', '2026-10-23T01:00:00Z']) {
    issue(root, { referenceTime });
    archiveModelRun(root, 'hrrr-conus', { maxRollingRuns: 1, minimumCalendarDays: 2, pinnedRunKeys: ['20261020T000000Z'] });
  }
  assert.deepEqual(readdirSync(join(root, 'history/hrrr-conus')).sort(), ['20261020T000000Z', '20261022T000000Z',
    '20261022T230000Z', '20261023T000000Z', '20261023T010000Z']);
  const selected = archivedModelRuns(root, 'hrrr-conus', { maxRuns: 1 });
  const coverage = calendarHistoryCoverage({ dataRoot: root, models: ['hrrr-conus'], from: '2026-10-20T00:00:00Z',
    to: '2026-10-23T23:59:59Z', selectedRuns: selected }).byModel[0];
  assert.equal(coverage.retainedRunCount, 5); assert.equal(coverage.selectedFirstIssuedRunCount, 1);
  assert.equal(coverage.unselectedRunCount, 4); assert.deepEqual(coverage.missingInitializationDates, ['2026-10-21']);
  assert.deepEqual(coverage.days.map(value => value.retainedRuns), [1, 0, 2, 2]);
  assert.throws(() => archiveModelRun(root, 'hrrr-conus', { minimumCalendarDays: 121 }), /Calendar retention/);
  assert.throws(() => mergeHistoryArchives(root, workspace(t), 'hrrr-conus', { minimumCalendarDays: -1 }), /Calendar retention/);
});

test('calendar coverage uses UTC dates through daylight-saving transitions', t => {
  const root = workspace(t);
  const coverage = calendarHistoryCoverage({ dataRoot: root, models: ['hrrr-conus'], from: '2026-11-01T00:00:00-04:00', to: '2026-11-02T00:00:00-05:00' });
  assert.equal(coverage.requestedUtcDates, 2);
  assert.deepEqual(coverage.byModel[0].missingInitializationDates, ['2026-11-01', '2026-11-02']);
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
  assert.throws(() => scoreHistory({ ...opts, from: '2026-10-21T00:00:00' }), /UTC observation window/);
  assert.throws(() => scoreHistory({ ...opts, to: '2027-10-22T00:00:00Z' }), /120 days/);
  assert.equal(scoreHistory({ ...opts, from: '2026-10-23T00:00:00Z', to: '2026-10-24T00:00:00Z' }).status, 'no-matched-observations');
});


test('revision compression preserves exact bytes, IDs and first-issued scoring', t => {
  const root = workspace(t); issue(root);
  const first = archiveModelRun(root, 'hrrr-conus', { retainFullColumnSites: ['or-woodrat-mountain'] });
  issue(root, { temperatureC: 50 }); archiveModelRun(root, 'hrrr-conus');
  const run = join(root, 'history/hrrr-conus', first.runKey), revision = join(run, 'revisions', first.revisionId);
  const index = readFileSync(join(run, 'index.json')), receipt = readFileSync(join(revision, 'revision.json'));
  const original = readIssuedHistoryFile(revision, 'sites/or-woodrat-mountain.json');
  for (const file of ['sites/or-woodrat-mountain.json', 'full-columns/sites/or-woodrat-mountain.json']) {
    const path = join(revision, file); writeFileSync(path, readIssuedHistoryFile(revision, file)); rmSync(`${path}.gz`);
  }
  assert.deepEqual(compressHistoryArchives(root), { compressedFiles: 2, revisions: 2 });
  assert.deepEqual(compressHistoryArchives(root), { compressedFiles: 0, revisions: 0 });
  assert.deepEqual(readFileSync(join(run, 'index.json')), index);
  assert.deepEqual(readFileSync(join(revision, 'revision.json')), receipt);
  assert.deepEqual(readIssuedHistoryFile(revision, 'sites/or-woodrat-mountain.json'), original);
  assert.equal(archivedModelRuns(root, 'hrrr-conus')[0].revisionId, first.revisionId);
  // An old producer may upload plain history after cache migration has already run.
  const plain = join(revision, 'sites/or-woodrat-mountain.json');
  writeFileSync(plain, original); rmSync(`${plain}.gz`);
  const output = workspace(t); mergeHistoryArchives(root, output, 'hrrr-conus');
  const imported = archivedModelRuns(output, 'hrrr-conus')[0];
  assert.equal(imported.revisionId, first.revisionId);
  assert.deepEqual(readIssuedHistoryFile(imported.directory, 'sites/or-woodrat-mountain.json'), original);
  assert.deepEqual(readdirSync(join(imported.directory, 'sites')), ['or-woodrat-mountain.json.gz']);
  assert.deepEqual(readFileSync(plain), original);
  assert.deepEqual(readdirSync(join(revision, 'sites')), ['or-woodrat-mountain.json']);
  compressHistoryArchives(root);
  writeFileSync(join(revision, 'sites/or-woodrat-mountain.json'), original);
  assert.throws(() => readIssuedHistoryFile(revision, 'sites/or-woodrat-mountain.json'), /Ambiguous/);
  assert.throws(() => compressHistoryArchives(root), /Unexpected issued-history/);
  rmSync(join(revision, 'sites/or-woodrat-mountain.json'));
  writeFileSync(join(revision, 'sites/or-woodrat-mountain.json.gz'), gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1)));
  assert.throws(() => readIssuedHistoryFile(revision, 'sites/or-woodrat-mountain.json'), /larger than/);
});


test('publication copies share immutable revisions while indexes and legacy evidence stay isolated', t => {
  const source = workspace(t), output = workspace(t); issue(source);
  const first = archiveModelRun(source, 'hrrr-conus');
  const from = join(source, 'history'), to = join(output, 'history');
  copyIssuedHistoryTree(from, to);
  const file = `hrrr-conus/${first.runKey}/revisions/${first.revisionId}/sites/or-woodrat-mountain.json.gz`;
  const index = `hrrr-conus/${first.runKey}/index.json`;
  assert.equal(statSync(join(from, file)).ino, statSync(join(to, file)).ino);
  assert.notEqual(statSync(join(from, index)).ino, statSync(join(to, index)).ino);
  const original = readFileSync(join(from, index)); writeFileSync(join(to, index), '{}');
  assert.deepEqual(readFileSync(join(from, index)), original);
  rmSync(to, { recursive: true });
  assert.equal(archivedModelRuns(source, 'hrrr-conus')[0].revisionId, first.revisionId);
});
