import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubApi } from './github-actions.mjs';
import { refreshSelection, refreshWorkflow } from './refresh-policy.mjs';

export async function dispatchRefresh(selection, api = githubApi()) {
  const groups = refreshSelection(selection);
  const results = await Promise.allSettled(groups.map(group => api(`/actions/workflows/${refreshWorkflow(group)}/dispatches`, { ref: 'main' })));
  const failures = results.flatMap((result, index) => result.status === 'rejected' ? [`${groups[index]}: ${result.reason.message}`] : []);
  if (failures.length) throw new Error(failures.join('\n'));
  return groups;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await dispatchRefresh(process.argv[2]));
