// Collect uploaded provider slices and keep a successful fallback until each source run succeeds.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SOARING_CONTRACT_VERSION } from '../forecasts/soaring/science.mjs';
import { githubApi } from './github-actions.mjs';
import { refreshGroups, refreshWorkflow } from './refresh-policy.mjs';
import { validateFileTree } from '../forecasts/scripts/lib/artifact-products.mjs';

export function trustedRuns(runs, group, repository) {
  return runs.filter(run => ['completed', 'in_progress'].includes(run.status) && run.head_branch === 'main'
    && run.head_repository?.full_name === repository && ['schedule', 'workflow_dispatch', 'push'].includes(run.event)
    && run.path === `.github/workflows/${refreshWorkflow(group)}` && /^[a-f0-9]{40}$/.test(run.head_sha)
    && Number.isSafeInteger(run.id) && run.id > 0 && Number.isFinite(Date.parse(run.created_at)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
}

export async function collectRefreshArtifacts(output, { repository = process.env.GITHUB_REPOSITORY, api = githubApi({ repository }),
  download = (run, name, destination) => execFileSync('gh', ['run', 'download', String(run), '--repo', repository, '--name', name, '--dir', destination], { stdio: 'inherit' }) } = {}) {
  mkdirSync(output, { recursive: true });
  const report = { collected: [], retained: [], rejected: [] };
  for (const group of refreshGroups) {
    let found = false;
    try {
      const response = await api(`/actions/workflows/${refreshWorkflow(group)}/runs?branch=main&per_page=20`);
      for (const run of trustedRuns(response.workflow_runs ?? [], group, repository)) {
        const succeeded = run.status === 'completed' && run.conclusion === 'success';
        if (found && !succeeded) continue;
        const result = await api(`/actions/runs/${run.id}/artifacts?per_page=100`);
        // v4 uploads are immutable and available before post-job cleanup finishes.
        // Collect ready uploads even when another provider's Pages request supersedes theirs.
        const artifact = result.artifacts?.find(item => item.name === `data-${group}` && !item.expired && item.workflow_run?.head_sha === run.head_sha);
        if (!artifact) continue;
        const temporary = mkdtempSync(join(output, '.download-'));
        try {
          await download(run.id, artifact.name, temporary);
          validateFileTree(temporary);
          const metadata = JSON.parse(readFileSync(join(temporary, '.artifact.json'), 'utf8'));
          if (metadata.schemaVersion !== 1 || metadata.group !== group || metadata.sourceSha !== run.head_sha
            || metadata.soaringContractVersion !== SOARING_CONTRACT_VERSION || !Number.isFinite(Date.parse(metadata.createdAt))) throw new Error('Incompatible artifact provenance');
          const destination = join(output, `data-${group}--${run.id}`);
          if (existsSync(destination)) throw new Error(`Artifact output already exists: ${destination}`);
          renameSync(temporary, destination);
          report.collected.push({ group, run: run.id, sourceSha: run.head_sha });
          found = true;
          if (succeeded) break;
        } catch (error) { report.rejected.push({ group, run: run.id, reason: error.message }); }
        finally { rmSync(temporary, { recursive: true, force: true }); }
      }
    } catch (error) { report.rejected.push({ group, reason: error.message }); }
    if (!found) report.retained.push(group);
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await collectRefreshArtifacts(resolve(process.argv[2] ?? 'incoming')), null, 2));
