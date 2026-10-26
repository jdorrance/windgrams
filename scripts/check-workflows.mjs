// Lightweight workflow validation: structure and credential hygiene without new dependencies.
// This owns syntax-adjacent and security invariants; semantic ordering assertions stay in
// forecasts/scripts/pages-workflow.test.mjs. A deliberately broken workflow must fail here
// before it can fail (or silently weaken credentials) on a runner.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
// Elevated write scopes are allowlisted per file. Adding one anywhere else is a
// deliberate review event: extend this list in the same change that needs it.
const WRITE_ALLOWLIST = {
  'pages.yml': ['actions', 'pages', 'id-token'],
  'refresh-provider.yml': ['actions'],
  'refresh-science.yml': ['actions'],
  'served-data.yml': ['issues'],
  'backup-history.yml': ['contents'],
};
for (const group of ['noaa-cloud', 'rrfs', 'dwd', 'eccc', 'observations', 'terrain']) WRITE_ALLOWLIST[`refresh-${group}.yml`] = ['actions'];

export function checkWorkflowText(name, text) {
  const errors = [];
  const lines = text.split('\n');
  if (/\t/.test(text)) errors.push(`${name}: tab character (YAML forbids tab indentation)`);
  if (!/^permissions:/m.test(text) && !/^\s{2,6}permissions:/m.test(text)) errors.push(`${name}: no permissions block declared`);
  // Basic mapping sanity: every non-empty, non-comment line is a key, a list item, or a scalar continuation.
  lines.forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('#') || /^\s*-/.test(line) || /^\s*[A-Za-z0-9_'"./${}-]+:/.test(line)
      || /^\s+(run|ref|path|key|restore-keys|name|with|env|if|uses|schedule|types|branches|paths|options|default|description|required|group|value):/.test(line)
      || /^\s{2,}\S/.test(line)) return;
    errors.push(`${name}:${i + 1}: unrecognised structure: ${line.trim().slice(0, 60)}`);
  });
  lines.forEach((line, i) => {
    const checkout = line.match(/uses:\s+actions\/checkout@(\S+)/);
    if (checkout) {
      if (!SHA.test(checkout[1].split(' ')[0])) errors.push(`${name}:${i + 1}: checkout is not pinned to a full SHA`);
      const block = lines.slice(i, i + 4).join('\n');
      if (!/persist-credentials:\s+false/.test(block)) errors.push(`${name}:${i + 1}: checkout must set persist-credentials: false`);
    }
    const uses = line.match(/^\s+-?\s*uses:\s+(?!actions\/checkout)([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@(\S+)/);
    if (uses && !SHA.test(uses[2].split(' ')[0])) errors.push(`${name}:${i + 1}: action ${uses[1]} is not pinned to a full SHA`);
    if (/secrets\.GITHUB_TOKEN/.test(line)) {
      const indent = line.match(/^\s*/)[0].length;
      // Job-level env keys sit at 6 spaces in this repository; step-level env at 8+.
      if (indent < 8) errors.push(`${name}:${i + 1}: GITHUB_TOKEN must be exposed only in step-level env (indent >= 8), not job/workflow env`);
      if (!/^\s+(GH_TOKEN|GITHUB_TOKEN):/.test(line)) errors.push(`${name}:${i + 1}: GITHUB_TOKEN must be assigned to GH_TOKEN/GITHUB_TOKEN in step env`);
    }
    const write = line.match(/^\s+(actions|contents|pages|id-token|issues):\s+write\s*$/);
    if (write && !(WRITE_ALLOWLIST[name] ?? []).includes(write[1])) {
      errors.push(`${name}:${i + 1}: ${write[1]}: write is not allowlisted for this workflow`);
    }
  });
  if (name === 'pages.yml') {
    const publish = text.split('\n  publish:')[1] ?? '';
    if (/^\s+actions:\s+write\s*$/m.test(publish)) errors.push('pages.yml: publish job must use actions: read (dispatch keeps its write scope)');
  }
  return errors;
}

export function checkWorkflows(directory) {
  const errors = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
      errors.push(...checkWorkflowText(entry.name, readFileSync(join(directory, entry.name), 'utf8')));
    }
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = new URL('../.github/workflows/', import.meta.url);
  const errors = checkWorkflows(fileURLToPath(root));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Workflow checks passed.');
}
