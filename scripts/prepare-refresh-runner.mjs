// Free ECCC workspace before dependency/cache extraction on GitHub's disposable Linux runner.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareRefreshRunner(group, { githubActions = process.env.GITHUB_ACTIONS, platform = process.platform,
  run = (command, args) => execFileSync(command, args, { stdio: 'inherit' }) } = {}) {
  if (group !== 'eccc' || githubActions !== 'true' || platform !== 'linux') return false;
  run('sudo', ['rm', '-rf', '/usr/share/dotnet', '/usr/local/lib/android', '/opt/ghc', '/opt/hostedtoolcache/CodeQL', '/usr/local/share/boost']);
  return true;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareRefreshRunner(process.argv[2]);
