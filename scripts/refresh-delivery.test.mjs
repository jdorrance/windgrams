import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trustedRuns, collectRefreshArtifacts } from './collect-refresh-artifacts.mjs';
import { dispatchRefresh } from './dispatch-refresh.mjs';
import { modelRefreshGroups, refreshGroups, refreshSelection } from './refresh-policy.mjs';
import { refreshCommands, refreshProvider } from '../forecasts/scripts/refresh-provider.mjs';
import { packRefresh } from '../forecasts/scripts/pack-refresh.mjs';
import { mergeArtifacts } from '../forecasts/scripts/merge-artifacts.mjs';
import { postprocessPointForecast } from '../forecasts/soaring/point-postprocess.mjs';
import { SOARING_CONTRACT_VERSION } from '../forecasts/soaring/science.mjs';

const repository = 'pilot/windgrams', sha = 'a'.repeat(40);
const run = (group, id, overrides = {}) => ({ id, status: 'completed', conclusion: 'success', head_branch: 'main', event: 'schedule',
  path: `.github/workflows/refresh-${group}.yml`, head_sha: sha, head_repository: { full_name: repository },
  created_at: `2026-10-25T${String(id).padStart(2, '0')}:00:00Z`, ...overrides });

test('collector trusts completed and in-progress repository/main provider workflows, ordered by run creation', () => {
  const valid = run('rrfs', 2);
  assert.deepEqual(trustedRuns([valid, run('rrfs', 1), run('rrfs', 3, { status: 'in_progress' }),
    run('rrfs', 4, { status: 'queued' }), run('rrfs', 5, { status: 'waiting' }),
    run('rrfs', 6, { event: 'push' }), run('rrfs', 7, { event: 'workflow_dispatch' }),
    { ...valid, event: 'pull_request' }, { ...valid, event: 'pull_request_target' }, { ...valid, event: 'repository_dispatch' },
    { ...valid, event: 'push', head_branch: 'trial' }, { ...valid, event: 'push', head_repository: { full_name: 'fork/windgrams' } },
    { ...valid, event: 'push', head_sha: 'invalid' }, { ...valid, event: 'push', path: '.github/workflows/check.yml' }], 'rrfs', repository).map(item => item.id), [7, 6, 3, 2, 1]);
});

test('collection publishes ready providers while others run and falls back from incompatible artifacts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'refresh-collection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const api = async path => {
    if (path.includes('refresh-rrfs.yml')) return { workflow_runs: [run('rrfs', 2), run('rrfs', 1)] };
    if (path.includes('refresh-eccc.yml')) return { workflow_runs: [run('eccc', 3, { status: 'in_progress' })] };
    if (path.includes('/workflows/')) return { workflow_runs: [] };
    return { artifacts: [{ name: 'data-rrfs', expired: false, workflow_run: { head_sha: sha } }] };
  };
  const report = await collectRefreshArtifacts(root, { repository, api, download: (id, name, directory) => {
    writeFileSync(join(directory, '.artifact.json'), JSON.stringify({ schemaVersion: 1, group: 'rrfs', sourceSha: id === 2 ? 'bad' : sha,
      soaringContractVersion: SOARING_CONTRACT_VERSION, createdAt: '2026-10-25T04:00:00Z' }));
    writeFileSync(join(directory, 'EMPTY'), 'empty');
  } });
  assert.deepEqual(report.collected.map(item => item.run), [1]);
  assert.equal(report.rejected.length, 1);
  assert.ok(report.retained.includes('eccc'));
  assert.ok(existsSync(join(root, 'data-rrfs--1/.artifact.json')));
  assert.equal(existsSync(join(root, 'data-eccc')), false);
});

test('uploaded unfinished or unsuccessful refreshes retain a validated fallback and the latest health', async t => {
  const root = mkdtempSync(join(tmpdir(), 'refresh-fallback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const issued = JSON.parse(readFileSync(new URL('../forecasts/soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
  const profile = JSON.parse(JSON.stringify(postprocessPointForecast(issued, { launchElevationM: issued.soaringMeta.launchElevationM })));
  const site = { slug: profile.site.id, name: profile.site.name, latitude: profile.site.latitude, longitude: profile.site.longitude, timeZone: profile.site.timeZone };
  const write = (path, document) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(document)); };
  for (const [mode, status, conclusion] of [['empty', 'completed', 'failure'], ['partial', 'completed', 'cancelled'],
    ['ready', 'in_progress', null], ['partial', 'in_progress', null]]) {
    const incoming = join(root, `${status}-${mode}`, 'incoming'), output = join(root, `${status}-${mode}`, 'data'), downloaded = [], inspected = [];
    const report = await collectRefreshArtifacts(incoming, { repository,
      api: async path => {
        assert.equal(path.includes('status=completed'), false, 'uploaded artifacts remain visible while providers finish cleanup');
        if (path.includes('/workflows/')) return { workflow_runs: path.includes('refresh-rrfs') ? [
          run('rrfs', 7, { status: 'queued', conclusion: null }), run('rrfs', 6, { status: 'in_progress', conclusion: null }),
          run('rrfs', 5, { status, conclusion }), run('rrfs', 4, { conclusion: 'failure' }), run('rrfs', 3), run('rrfs', 2), run('rrfs', 1),
        ] : [] };
        const id = Number(path.match(/\/runs\/(\d+)\//)?.[1]);
        inspected.push(id);
        if (id === 6) return { artifacts: [] };
        return { artifacts: [{ name: 'data-rrfs', expired: false, workflow_run: { head_sha: sha } }] };
      },
      download: (id, _name, directory) => {
        downloaded.push(id);
        write(join(directory, '.artifact.json'), { schemaVersion: 1, group: 'rrfs', sourceSha: id === 3 ? 'incompatible' : sha,
          soaringContractVersion: SOARING_CONTRACT_VERSION, createdAt: '2026-10-25T06:00:00Z' });
        const failed = id === 5 && mode !== 'ready', completedAt = `2026-10-25T0${id}:01:00Z`;
        write(join(directory, 'health/rrfs.json'), { schemaVersion: 1, group: 'rrfs', models: { rrfs: {
          attemptedAt: `2026-10-25T0${id}:00:00Z`, completedAt, lastSuccessfulRefreshAt: failed ? null : completedAt,
          outcome: failed ? 'retained' : 'updated', reason: failed ? 'upstream unavailable' : null,
        } } });
        if (failed && mode === 'empty') writeFileSync(join(directory, 'EMPTY'), 'empty');
        else {
          write(join(directory, 'rrfs/manifest.json'), { model: 'rrfs', referenceTime: profile.run.referenceTime,
            generatedAt: id === 5 ? '2026-10-24T13:00:00Z' : '2026-10-24T12:00:00Z', forecastHours: 84, firstForecastHour: 1, lastForecastHour: 84, sites: [{ slug: site.slug, name: site.name }] });
          write(join(directory, 'rrfs/sites', `${site.slug}.json`), failed ? { ...profile, hours: profile.hours.slice(0, -1) } : profile);
        }
      },
    });
    assert.deepEqual(inspected, [6, 5, 3, 2], 'skip queued runs and in-progress runs without uploaded artifacts');
    assert.deepEqual(downloaded, [5, 3, 2], 'skip intervening failures, reject incompatible success, stop after one valid fallback');
    assert.deepEqual(report.collected.map(item => item.run), [5, 2]);
    assert.equal(report.rejected.length, 1);
    const merged = mergeArtifacts(incoming, output, { sites: [site] });
    assert.ok(merged.accepted.includes('rrfs'));
    assert.equal(merged.rejected.length, mode === 'partial' ? 1 : 0);
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'rrfs/sites', `${site.slug}.json`))), profile);
    assert.equal(JSON.parse(readFileSync(join(output, 'rrfs/manifest.json'))).generatedAt,
      mode === 'ready' ? '2026-10-24T13:00:00Z' : '2026-10-24T12:00:00Z', 'only complete uploaded products replace the fallback');
    const health = JSON.parse(readFileSync(join(output, 'health/rrfs.json'))).models.rrfs;
    assert.equal(health.attemptedAt, '2026-10-25T05:00:00Z');
    assert.equal(health.reason, mode === 'ready' ? null : 'upstream unavailable');
    assert.equal(health.outcome, mode === 'ready' ? 'updated' : 'retained');
    assert.equal(health.lastSuccessfulRefreshAt, mode === 'ready' ? '2026-10-25T05:01:00Z' : '2026-10-25T02:01:00Z');
  }
});

test('collection accepts the explicitly compatible prior method and rejects unsupported methods', async t => {
  const root = mkdtempSync(join(tmpdir(), 'refresh-method-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = await collectRefreshArtifacts(root, { repository,
    api: async path => path.includes('/workflows/')
      ? { workflow_runs: path.includes('refresh-rrfs') ? [run('rrfs', 2), run('rrfs', 1)] : [] }
      : { artifacts: [{ name: 'data-rrfs', expired: false, workflow_run: { head_sha: sha } }] },
    download: (id, _name, directory) => {
      writeFileSync(join(directory, '.artifact.json'), JSON.stringify({ schemaVersion: 1, group: 'rrfs', sourceSha: sha,
        soaringContractVersion: id === 2 ? '2.1.0' : '2.2.0', createdAt: '2026-10-25T04:00:00Z' }));
      writeFileSync(join(directory, 'EMPTY'), 'empty');
    },
  });
  assert.deepEqual(report.collected.map(item => item.run), [1]);
  assert.deepEqual(report.rejected, [{ group: 'rrfs', run: 2, reason: 'Incompatible artifact provenance' }]);
  assert.equal(existsSync(join(root, 'data-rrfs--2')), false);
});

test('publication rejects malformed candidate run suffixes', t => {
  const root = mkdtempSync(join(tmpdir(), 'refresh-suffix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const incoming = join(root, 'incoming');
  for (const name of ['data-rrfs--0', 'data-rrfs--01', 'data-rrfs--1-extra']) {
    mkdirSync(join(incoming, name), { recursive: true });
    writeFileSync(join(incoming, name, '.artifact.json'), '{}');
  }
  const report = mergeArtifacts(incoming, join(root, 'data'), { sites: [] });
  assert.equal(report.rejected.length, 3);
  assert.ok(report.rejected.every(item => item.reason === 'Unknown provider artifact'));
});

test('observation fallback run 9 seeds retained payloads before failed run 10', async t => {
  const root = mkdtempSync(join(tmpdir(), 'refresh-observation-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const incoming = join(root, 'incoming'), output = join(root, 'data');
  const write = (path, document) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(document)); };
  const payload = { schemaVersion: 1, generatedAt: '2026-10-25T09:00:00Z', site: { slug: 'retained' }, hours: [] };
  const report = await collectRefreshArtifacts(incoming, { repository,
    api: async path => path.includes('/workflows/')
      ? { workflow_runs: path.includes('refresh-observations') ? [run('observations', 10, { conclusion: 'failure' }), run('observations', 9)] : [] }
      : { artifacts: [{ name: 'data-observations', expired: false, workflow_run: { head_sha: sha } }] },
    download: (id, _name, directory) => {
      write(join(directory, '.artifact.json'), { schemaVersion: 1, group: 'observations', sourceSha: sha,
        soaringContractVersion: SOARING_CONTRACT_VERSION, createdAt: '2026-10-25T11:00:00Z' });
      write(join(directory, 'ecmwf/manifest.json'), { schemaVersion: 1, generatedAt: id === 9 ? payload.generatedAt : '2026-10-25T10:00:00Z',
        sites: [{ slug: 'retained', ok: id === 9, ...(id === 10 ? { error: 'Source unavailable' } : {}) }] });
      if (id === 9) write(join(directory, 'ecmwf/sites/retained.json'), payload);
    },
  });
  assert.deepEqual(report.collected.map(item => item.run), [10, 9]);
  const merged = mergeArtifacts(incoming, output, { sites: [] });
  assert.deepEqual(merged.rejected, []);
  assert.deepEqual(merged.accepted, ['ecmwf', 'ecmwf']);
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'ecmwf/sites/retained.json'))), payload);
  const manifest = JSON.parse(readFileSync(join(output, 'ecmwf/manifest.json')));
  assert.equal(manifest.generatedAt, '2026-10-25T10:00:00Z');
  assert.deepEqual(manifest.sites, [{ slug: 'retained', ok: false, error: 'Source unavailable', retained: true }]);
});

test('all refresh dispatches are attempted independently and targeted aliases preserve behavior', async () => {
  assert.deepEqual(refreshSelection('icon-eu'), ['dwd']);
  assert.deepEqual(refreshSelection('rrfs'), ['rrfs']);
  assert.deepEqual(refreshSelection('models'), modelRefreshGroups);
  const models = [];
  await dispatchRefresh('models', async path => models.push(path));
  assert.deepEqual(models, modelRefreshGroups.map(group => `/actions/workflows/refresh-${group}.yml/dispatches`));
  assert.throws(() => refreshSelection('unknown'), /Unknown/);
  const calls = [];
  await assert.rejects(dispatchRefresh('all', async (path, body) => {
    calls.push(path); assert.deepEqual(body, { ref: 'main' });
    if (path.includes('eccc')) throw new Error('unavailable');
  }), /eccc: unavailable/);
  assert.equal(calls.length, refreshGroups.length);
});

test('point acquisition failure still validates retained RRFS forecasts without starting retired regional work', () => {
  const commands = refreshCommands('rrfs', 'https://example.test/data');
  assert.deepEqual(commands.map(item => item.stage), ['seed', 'acquire', 'validate']);
  const calls = [];
  const outcomes = refreshProvider('rrfs', 'https://example.test/data', args => {
    calls.push(args[0]); if (args[0].includes('run-provider')) throw new Error('upstream unavailable');
  });
  assert.equal(outcomes[1].ok, false);
  assert.equal(outcomes.at(-1).ok, true);
  assert.deepEqual(calls, ['scripts/seed-published.mjs', 'scripts/run-provider.mjs', 'scripts/validate-rrfs.mjs']);
  assert.throws(() => refreshCommands('unknown', 'url'), /Unknown/);
});

test('packing stamps exact workflow provenance and refuses an unknown owner', t => {
  const root = mkdtempSync(join(tmpdir(), 'refresh-pack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'data'), output = join(root, 'slice');
  mkdirSync(source);
  packRefresh('terrain', output, source, sha);
  assert.ok(existsSync(join(output, '.artifact.json')));
  assert.throws(() => packRefresh('unknown', output, source, sha), /Unknown/);
  assert.throws(() => packRefresh('terrain', output, source, 'bad'), /source commit SHA/);
});
