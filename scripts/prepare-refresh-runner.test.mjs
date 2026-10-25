import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRefreshRunner } from './prepare-refresh-runner.mjs';
import { refreshCommands, refreshProvider } from '../forecasts/scripts/refresh-provider.mjs';

test('runner disk cleanup is confined to the ECCC disposable GitHub Linux runner', () => {
  const calls = [], run = (...args) => calls.push(args);
  assert.equal(prepareRefreshRunner('eccc', { platform: 'darwin', githubActions: 'true', run }), false);
  // undefined selects the process.env default, which is true inside Actions.
  for (const githubActions of [null, '', 'false']) {
    assert.equal(prepareRefreshRunner('eccc', { platform: 'linux', githubActions, run }), false);
  }
  assert.equal(prepareRefreshRunner('rrfs', { platform: 'linux', githubActions: 'true', run }), false);
  assert.equal(calls.length, 0);
  assert.equal(prepareRefreshRunner('eccc', { platform: 'linux', githubActions: 'true', run }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'sudo');
  assert.deepEqual(calls[0][1].slice(0, 2), ['rm', '-rf']);
  assert.ok(calls[0][1].slice(2).every(path => path.startsWith('/usr/') || path.startsWith('/opt/')));
});

test('RRFS keeps bounded readiness retries and a failed region does not skip downstream validation', () => {
  const commands = refreshCommands('rrfs', 'https://example.test/data');
  const acquire = commands.find(command => command.stage === 'acquire').args;
  assert.deepEqual(acquire.slice(-4), ['--readiness-attempts', '6', '--readiness-delay-ms', '60000']);
  const calls = [];
  const result = refreshProvider('rrfs', 'https://example.test/data', args => {
    calls.push(args[0]);
    if (args[0].includes('build-live-soaring')) throw new Error('regional failure');
  });
  assert.deepEqual(result.map(stage => [stage.stage, stage.ok]), [['seed', true], ['acquire', true], ['regional', false], ['validate', true]]);
  assert.equal(calls.at(-1), 'scripts/validate-rrfs.mjs');
});
