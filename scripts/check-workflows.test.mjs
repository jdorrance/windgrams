import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWorkflowText, checkWorkflows } from './check-workflows.mjs';
import { fileURLToPath } from 'node:url';

const good = `name: Example
on: [push]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false
      - name: Uses the API
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: node scripts/example.mjs
`;

test('a hardened workflow passes', () => {
  assert.deepEqual(checkWorkflowText('check.yml', good), []);
});

test('checkout without persist-credentials: false fails', () => {
  const errors = checkWorkflowText('check.yml', good.replace('        with:\n          persist-credentials: false\n', ''));
  assert.ok(errors.some(e => /persist-credentials/.test(e)), errors.join('\n'));
});

test('a job-level token fails, a step-level token passes', () => {
  const jobLevel = good.replace('    steps:', '    env:\n      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n    steps:');
  assert.ok(checkWorkflowText('check.yml', jobLevel).some(e => /step-level env/.test(e)));
});

test('unallowlisted write scopes and unpinned actions fail', () => {
  assert.ok(checkWorkflowText('check.yml', good.replace('  contents: read', '  contents: write')).some(e => /not allowlisted/.test(e)));
  assert.ok(checkWorkflowText('check.yml', good.replace('@3d3c42e5aac5ba805825da76410c181273ba90b1', '@v7')).some(e => /full SHA/.test(e)));
  const publishWrite = `name: Pages\non: [push]\npermissions:\n  contents: read\njobs:\n  publish:\n    permissions:\n      contents: read\n      actions: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n`;
  assert.ok(checkWorkflowText('pages.yml', publishWrite).some(e => /publish job must use actions: read/.test(e)));
});

test('the repository workflows pass their own checks', () => {
  assert.deepEqual(checkWorkflows(fileURLToPath(new URL('../.github/workflows/', import.meta.url))), []);
});
