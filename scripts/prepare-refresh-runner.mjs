// Reserve measured archive/acquisition headroom before extracting a shared forecast cache.
import { execFileSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshGroups } from './refresh-policy.mjs';

// Measured workload plus acquisition/staging headroom: forecasts/docs/operations.md#publication-and-retention.
export const MIN_FORECAST_FREE_BYTES = 28 * 1024 ** 3;
const freeBytes = () => { const { bavail, bsize } = statfsSync(process.cwd()); return bavail * bsize; };

export function prepareRefreshRunner(group, { githubActions = process.env.GITHUB_ACTIONS, platform = process.platform,
  runnerEnvironment = process.env.RUNNER_ENVIRONMENT, availableBytes = freeBytes, minimumFreeBytes = MIN_FORECAST_FREE_BYTES,
  run = (command, args) => execFileSync(command, args, { stdio: 'inherit' }) } = {}) {
  if (![...refreshGroups, 'pages'].includes(group) || githubActions !== 'true' || platform !== 'linux' || runnerEnvironment !== 'github-hosted') return false;
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes <= 0) throw new Error('Invalid forecast disk reservation');
  const before = availableBytes();
  if (!Number.isSafeInteger(before) || before < 0) throw new Error('Cannot measure forecast workspace free space');
  const cleaned = before < minimumFreeBytes;
  if (cleaned) run('sudo', ['rm', '-rf', '/usr/share/dotnet', '/usr/local/lib/android', '/opt/ghc', '/opt/hostedtoolcache/CodeQL', '/usr/local/share/boost']);
  const after = cleaned ? availableBytes() : before;
  if (!Number.isSafeInteger(after) || after < minimumFreeBytes) throw new Error(`Insufficient forecast workspace: ${after} bytes free; ${minimumFreeBytes} required before cache restore`);
  return { group, freeBytesBefore: before, freeBytes: after, minimumFreeBytes, cleaned };
}
// This runs before setup-node, so keep the CLI guard compatible with the runner's bootstrap Node.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(prepareRefreshRunner(process.argv[2])));
