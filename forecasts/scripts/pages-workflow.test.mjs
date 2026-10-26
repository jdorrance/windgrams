import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pagesUrls } from '../../scripts/pages-config.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');
const groups = ['noaa-cloud', 'rrfs', 'dwd', 'eccc', 'observations', 'terrain'];
const refresh = readFileSync(new URL('../../.github/workflows/refresh-provider.yml', import.meta.url), 'utf8');

test('provider completions publish independently while preserving schedules', () => {
  for (const group of groups) {
    const source = readFileSync(new URL(`../../.github/workflows/refresh-${group}.yml`, import.meta.url), 'utf8');
    assert.ok(source.includes(`name: Refresh ${group}`));
    assert.ok(workflow.includes(`Refresh ${group}`));
    assert.ok(source.includes('uses: ./.github/workflows/refresh-provider.yml'));
    assert.ok(source.includes(`group: ${group}`));
    const schedule = group === 'rrfs' ? '55 3,9,15,21 * * *' : group === 'dwd' ? '55 4,10,16,22 * * *' : '55 1,7,13,19 * * *';
    assert.ok(source.includes(schedule));
    const push = source.match(/^  push:\n((?:    .*\n)+)/m)?.[1];
    if (['noaa-cloud', 'eccc'].includes(group)) assert.equal(push, '    branches: [main]\n    paths: [forecasts/sites.json]\n');
    else assert.equal(push, undefined, `${group} keeps its independent schedule`);
  }
  const publish = workflow.split('  publish:')[1];
  assert.equal(publish.includes('needs:'), false, 'publisher has no provider completion barrier');
  assert.match(publish, /timeout-minutes: 60/, 'allow the Check wait and complete retained-history validation');
  assert.match(publish, /concurrency:\n      group: pages/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /head_repository.full_name == github.repository/);
  assert.match(refresh, /group: refresh-\$\{\{ inputs.group \}\}/);
});

test('publication seeds, collects, validates, assembles and measures before deploying', () => {
  const publish = workflow.split('  publish:')[1];
  const commands = ['scripts/await-publication-check.mjs', 'scripts/seed-published.mjs', 'scripts/collect-refresh-artifacts.mjs',
    'scripts/prepare-publication.mjs', 'pnpm run build', 'scripts/prepare-pages.mjs', 'actions/upload-pages-artifact@', 'actions/deploy-pages@'];
  let previous = -1;
  for (const command of commands) { const index = publish.indexOf(command); assert.ok(index > previous, command); previous = index; }
  assert.match(publish, /--dry-run/);
  assert.match(publish, /Require successful checks for this checkout\n        if: \$\{\{ !inputs.dry_run \}\}\n        run: node scripts\/await-publication-check.mjs/);
  assert.match(publish, /if: inputs.dry_run\n        run: node forecasts\/scripts\/prepare-publication.mjs .* --dry-run/);
  assert.match(publish, /!inputs.dry_run/);
  assert.match(publish, /PUBLIC_WINDGRAMS_DATA_BASE:/);
  assert.match(publish, /ref: main/);
  for (const source of [publish, refresh]) {
    assert.ok(source.indexOf('scripts/prepare-refresh-runner.mjs') < source.indexOf('./.github/actions/setup-pnpm'));
    assert.ok(source.indexOf('scripts/prepare-refresh-runner.mjs') < source.indexOf('actions/cache/restore@'));
    assert.match(source, /key: issued-data-v2-\$\{\{ github.run_id \}\}/);
    assert.match(source, /restore-keys: \|\n            issued-data-v2-\n            forecast-data-/,
      'gzip readers prefer their cache format and can migrate legacy caches');
    assert.doesNotMatch(source, /key: forecast-data-/,
      'old readers must never restore new gzip archives through their legacy prefix');
  }
  assert.match(publish, /node scripts\/prepare-refresh-runner.mjs pages/);
  assert.match(refresh, /node scripts\/prepare-refresh-runner.mjs "\$REFRESH_GROUP"/);
});

test('refresh always packs retained products and preserves native decoder setup', () => {
  assert.match(refresh, /Pack validated and retained products\n        if: always\(\)/);
  assert.match(refresh, /include-hidden-files: true/);
  assert.match(refresh, /retention-days: 2/);
  assert.match(refresh, /python3.12 -m venv .venv-icon/);
  assert.match(refresh, /NODE_OPTIONS: --max-old-space-size=6144/);
  assert.match(refresh, /scripts\/refresh-provider.mjs/);
  const monitor = readFileSync(new URL('../../.github/workflows/served-data.yml', import.meta.url), 'utf8');
  assert.match(monitor, /17 \* \* \* \*/);
  assert.match(monitor, /scripts\/monitor-served.mjs/);
});

test('token-dispatched refreshes require a successful artifact upload, including retained data after acquisition failures', () => {
  const dispatch = refresh.split('- name: Request publication after token dispatch')[1];
  assert.ok(dispatch, 'token dispatches need an explicit replacement for suppressed workflow_run events');
  assert.ok(refresh.indexOf('Request publication after token dispatch') > refresh.indexOf('actions/upload-artifact@'));
  const condition = dispatch.match(/if: \$\{\{ (.*) \}\}/)?.[1];
  assert.equal(condition, "!cancelled() && steps.artifact.outcome == 'success' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && github.actor == 'github-actions[bot]'",
    'acquisition failure can publish retained uploads; a failed upload or early runner guard cannot request publication');
  assert.match(refresh, /actions\/upload-artifact@[^\n]+\n        id: artifact\n        if: always\(\)/);
  assert.match(dispatch, /GH_TOKEN: \$\{\{ secrets.GITHUB_TOKEN \}\}/);
  assert.match(dispatch, /gh workflow run pages\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f refresh=none\s*$/);
});

test('Pages resolves reader paths and rejects malformed publication configuration', () => {
  const run = (env = {}) => pagesUrls({ GITHUB_REPOSITORY: 'pilot/windgrams', ...env });
  assert.deepEqual(run(), { site: 'https://pilot.github.io/windgrams', base: '/windgrams', data: 'https://pilot.github.io/windgrams/data' });
  assert.equal(run({ WINDGRAMS_DATA_BASE: '/forecast/' }).data, 'https://pilot.github.io/forecast');
  assert.equal(run({ WINDGRAMS_DATA_BASE: '/' }).data, 'https://pilot.github.io');
  assert.equal(run({ WINDGRAMS_SITE: 'https://flying.example/apps/windgrams', WINDGRAMS_DATA_BASE: '/forecast' }).data, 'https://flying.example/forecast');
  assert.equal(run({ WINDGRAMS_DATA_BASE: 'https://weather.example/datasets/' }).data, 'https://weather.example/datasets');
  assert.deepEqual(run({ GITHUB_REPOSITORY: 'pilot/pilot.github.io' }), { site: 'https://pilot.github.io', base: '/', data: 'https://pilot.github.io/data' });
  assert.equal(run({ GITHUB_REPOSITORY: 'Pilot/pilot.github.io' }).base, '/');
  for (const value of ['/forecast?key=x', '/forecast#run', '//other.example/data', '/\\other.example/data', 'https://user:secret@other.example/data', 'https://other.example/data?key=x', 'https://other.example/data#run', 'javascript:alert(1)']) {
    assert.throws(() => run({ WINDGRAMS_DATA_BASE: value }), /Data origin/);
  }
  for (const value of ['javascript:alert(1)', 'https://user:secret@site.example', 'https://site.example/?x=1']) {
    assert.throws(() => run({ WINDGRAMS_SITE: value }), /Site/);
  }
  for (const value of ['relative', '//other.example', '/path?query', '/path\nextra']) {
    assert.throws(() => run({ WINDGRAMS_BASE: value }), /Base/);
  }
});

test('Pages configuration command writes the exact job outputs used by acquisition and build', t => {
  const directory = mkdtempSync(join(tmpdir(), 'windgrams-url-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'output');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/pages-config.mjs', import.meta.url))], {
    encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'pilot/windgrams', GITHUB_OUTPUT: output,
      WINDGRAMS_SITE: '', WINDGRAMS_BASE: '', WINDGRAMS_DATA_BASE: '/forecast' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'site=https://pilot.github.io/windgrams\nbase=/windgrams\ndata=https://pilot.github.io/forecast\n');
  assert.match(workflow, /run: node scripts\/pages-config\.mjs/);
});


test('science source pushes refresh model producers without publication feedback loops', () => {
  const source = readFileSync(new URL('../../.github/workflows/refresh-science.yml', import.meta.url), 'utf8');
  assert.match(source, /push:\n    branches: \[main\]/);
  for (const path of ['packages/soaring/src/**', 'packages/providers/src/**', 'packages/contracts/src/**', 'forecasts/soaring/**', 'forecasts/scripts/build-*.mjs', 'pnpm-lock.yaml']) assert.ok(source.includes(path), path);
  assert.match(source, /node scripts\/dispatch-refresh.mjs models/);
  for (const event of ['workflow_run:', 'workflow_dispatch:', 'schedule:']) assert.equal(source.includes(event), false);
  assert.equal(source.includes('web/**'), false, 'display-only changes do not redownload model source');
  assert.equal(source.includes('forecasts/sites.json'), false, 'catalogue pushes remain owned by provider-specific workflows');
});
