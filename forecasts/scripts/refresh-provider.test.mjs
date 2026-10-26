import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshCommands } from './refresh-provider.mjs';

test('NOAA refreshes keep point acquisition and RRFS validation without retired regional work', () => {
  for (const group of ['noaa-cloud', 'rrfs']) {
    const commands = refreshCommands(group, 'https://example.test/data');
    assert.deepEqual(commands.map(command => command.stage), group === 'rrfs' ? ['seed', 'acquire', 'validate'] : ['seed', 'acquire']);
    assert.equal(commands[0].args.includes('soaring'), false);
    assert.deepEqual(commands[1].args.slice(0, 7), ['scripts/run-provider.mjs', '--group', group, '--output', 'data', '--sites', 'sites.json']);
    if (group === 'rrfs') assert.equal(commands[2].args[0], 'scripts/validate-rrfs.mjs');
  }
});

test('DWD refreshes retain Armenian regional seeding and native validation', () => {
  const commands = refreshCommands('dwd', 'https://example.test/data');
  assert.equal(commands[0].args.includes('soaring'), true);
  assert.deepEqual(commands.map(command => command.stage), ['seed', 'acquire', 'validate']);
  assert.deepEqual(commands[2].args, ['scripts/build-icon.mjs', '--sites', 'sites.json', '--output', 'data', '--validate-only']);
});
