// Provider refresh orchestration. Failures finish independently; packing is a separate workflow step.
import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { PROVIDER_GROUPS } from '@windgrams/providers/registry';
import { finishProviderStages } from './lib/provider-health.mjs';

export function refreshCommands(group, from) {
  if (!Object.hasOwn(PROVIDER_GROUPS, group) && !['observations', 'terrain'].includes(group)) throw new Error(`Unknown refresh group: ${group}`);
  const seed = ['scripts/seed-published.mjs', '--output', 'data', '--from', from, '--group', group, '--best-effort'];
  if (Object.hasOwn(PROVIDER_GROUPS, group)) seed.push('--group', 'terrain');
  if (['noaa-cloud', 'rrfs', 'dwd'].includes(group)) seed.push('--group', 'soaring');
  const commands = [{ stage: 'seed', args: seed }];
  if (Object.hasOwn(PROVIDER_GROUPS, group)) commands.push({ stage: 'acquire', args: ['scripts/run-provider.mjs', '--group', group, '--output', 'data', '--sites', 'sites.json'] });
  else if (group === 'observations') commands.push({ stage: 'acquire', args: ['scripts/run-observations.mjs', '--output', 'data'] });
  else commands.push({ stage: 'acquire', args: ['scripts/terrain.mjs', '--sync'] });
  if (group === 'rrfs') commands.find(command => command.stage === 'acquire').args.push('--readiness-attempts', '6', '--readiness-delay-ms', '60000');
  if (group === 'noaa-cloud' || group === 'rrfs') commands.push({ stage: 'regional', args: ['scripts/build-live-soaring.mjs', '--model', group === 'rrfs' ? 'rrfs' : 'hrrr-conus', '--output', 'data'] });
  if (group === 'rrfs') commands.push({ stage: 'validate', args: ['scripts/validate-rrfs.mjs', '--data', 'data', '--sites', 'sites.json'] });
  if (group === 'dwd') commands.push({ stage: 'validate', args: ['scripts/build-icon.mjs', '--sites', 'sites.json', '--output', 'data', '--validate-only'] });
  return commands;
}

export function refreshProvider(group, from, run = args => execFileSync(process.execPath, args, { stdio: 'inherit' })) {
  const outcomes = [];
  for (const command of refreshCommands(group, from)) {
    const start = Date.now();
    try { run(command.args); outcomes.push({ stage: command.stage, ok: true, durationMs: Date.now() - start }); }
    catch (error) { outcomes.push({ stage: command.stage, ok: false, durationMs: Date.now() - start, reason: error.message }); }
  }
  return outcomes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { group: { type: 'string' } } });
  refreshCommands(values.group, process.env.METEO_DATA_BASE);
  mkdirSync('data', { recursive: true });
  copyFileSync('sites.json', 'data/sites.json');
  const outcomes = refreshProvider(values.group, process.env.METEO_DATA_BASE);
  finishProviderStages(resolve('data'), values.group, outcomes);
  console.log(JSON.stringify(outcomes, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Refresh stages\n\n${outcomes.map(result => `- ${result.stage}: ${result.ok ? 'complete' : 'failed'} (${(result.durationMs / 1000).toFixed(1)} s)`).join('\n')}\n`);
  if (outcomes.some(result => !result.ok)) process.exitCode = 1;
}
