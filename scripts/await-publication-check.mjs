// Publication requires a successful Check run for the exact checked-out revision.
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { githubApi } from './github-actions.mjs';

export async function awaitPublicationCheck({ revision, repository = process.env.GITHUB_REPOSITORY,
  api = githubApi({ repository }), now = Date.now, sleep = delay, timeoutMs = 15 * 60_000,
}) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected a full publication commit SHA');
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const { workflow_runs = [] } = await api(`/actions/workflows/check.yml/runs?branch=main&head_sha=${revision}&per_page=100`);
    const [run] = workflow_runs.filter(run => run.head_sha === revision && run.head_branch === 'main'
      && run.head_repository?.full_name === repository && ['push', 'workflow_dispatch'].includes(run.event))
      .sort((a, b) => b.id - a.id);
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`Check ${run.id} ${run.conclusion}; publication stopped for ${revision}`);
      return { revision, checkRunId: run.id, checkRunAttempt: run.run_attempt, url: run.html_url };
    }
    await sleep(Math.min(10_000, Math.max(0, deadline - now())));
  }
  throw new Error(`No successful Check completed within ${timeoutMs / 60_000} minutes for ${revision}; publication stopped`);
}

if (import.meta.main) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(JSON.stringify(await awaitPublicationCheck({ revision })));
}
