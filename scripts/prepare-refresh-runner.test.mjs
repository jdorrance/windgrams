import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_FORECAST_FREE_BYTES, prepareRefreshRunner } from './prepare-refresh-runner.mjs';
import { refreshGroups } from './refresh-policy.mjs';
import { refreshCommands, refreshProvider } from '../forecasts/scripts/refresh-provider.mjs';

test('runner disk cleanup covers every shared-cache reader on disposable GitHub Linux jobs', () => {
  const calls = [], run = (...args) => calls.push(args);
  const options = { platform: 'linux', githubActions: 'true', runnerEnvironment: 'github-hosted', run,
    availableBytes: () => { throw new Error('Unexpected disk access'); } };
  for (const overrides of [{ platform: 'darwin' }, { githubActions: null }, { githubActions: '' }, { githubActions: 'false' },
    { runnerEnvironment: 'self-hosted' }, { runnerEnvironment: '' }]) {
    assert.equal(prepareRefreshRunner('eccc', { ...options, ...overrides }), false);
  }
  assert.equal(prepareRefreshRunner('unknown', options), false);
  assert.equal(calls.length, 0);
  for (const group of [...refreshGroups, 'pages']) {
    let samples = 0;
    const result = prepareRefreshRunner(group, { ...options, availableBytes: () => ++samples === 1 ? 1 : MIN_FORECAST_FREE_BYTES });
    assert.deepEqual(result, { group, freeBytesBefore: 1, freeBytes: MIN_FORECAST_FREE_BYTES, minimumFreeBytes: MIN_FORECAST_FREE_BYTES, cleaned: true });
  }
  assert.equal(calls.length, refreshGroups.length + 1);
  for (const [command, args] of calls) {
    assert.equal(command, 'sudo');
    assert.deepEqual(args, ['rm', '-rf', '/usr/share/dotnet', '/usr/local/lib/android', '/opt/ghc', '/opt/hostedtoolcache/CodeQL', '/usr/local/share/boost']);
  }
});

test('runner reservation measures headroom and stops before cache extraction if cleanup is insufficient', () => {
  const options = { platform: 'linux', githubActions: 'true', runnerEnvironment: 'github-hosted' };
  const enough = prepareRefreshRunner('pages', { ...options, availableBytes: () => MIN_FORECAST_FREE_BYTES,
    run: () => { throw new Error('Cleanup is unnecessary'); } });
  assert.equal(enough.cleaned, false);
  let cleanups = 0;
  for (const group of ['dwd', 'observations', 'terrain']) {
    assert.throws(() => prepareRefreshRunner(group, { ...options, availableBytes: () => MIN_FORECAST_FREE_BYTES - 1,
      run: () => { cleanups++; } }), /Insufficient forecast workspace.*before cache restore/);
  }
  assert.equal(cleanups, 3);
  assert.throws(() => prepareRefreshRunner('rrfs', { ...options, availableBytes: () => NaN }), /Cannot measure/);
});

test('RRFS keeps bounded readiness retries and validates retained points after acquisition failure', () => {
  const commands = refreshCommands('rrfs', 'https://example.test/data');
  const acquire = commands.find(command => command.stage === 'acquire').args;
  assert.deepEqual(acquire.slice(-4), ['--readiness-attempts', '6', '--readiness-delay-ms', '60000']);
  const calls = [];
  const result = refreshProvider('rrfs', 'https://example.test/data', args => {
    calls.push(args[0]);
    if (args[0].includes('run-provider')) throw new Error('upstream failure');
  });
  assert.deepEqual(result.map(stage => [stage.stage, stage.ok]), [['seed', true], ['acquire', false], ['validate', true]]);
  assert.deepEqual(calls, ['scripts/seed-published.mjs', 'scripts/run-provider.mjs', 'scripts/validate-rrfs.mjs']);
});
