import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');
const providerJobs = ['noaa-cloud', 'rrfs', 'dwd', 'eccc', 'observations', 'terrain'];

function selectedProviders(eventName, { schedule, refresh = 'all' } = {}) {
  return providerJobs.filter(job => {
    const block = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/)[0];
    const condition = block?.match(/^    if: (.*)$/m)?.[1];
    assert.ok(condition, `${job} has an explicit scheduling condition`);
    return Function('github', 'inputs', `return (${condition});`)({ event_name: eventName, event: { schedule } }, { refresh });
  });
}

test('targeted manual RRFS refresh builds only RRFS while default manual refresh builds all providers', () => {
  assert.deepEqual(selectedProviders('workflow_dispatch', { refresh: 'rrfs' }), ['rrfs']);
  assert.deepEqual(selectedProviders('workflow_dispatch', { refresh: 'all' }), providerJobs);
  assert.deepEqual(selectedProviders('workflow_dispatch'), providerJobs);
});

test('scheduled provider windows and cache-only pushes remain unchanged', () => {
  assert.deepEqual(selectedProviders('schedule', { schedule: '55 1,7,13,19 * * *' }), providerJobs.filter(job => job !== 'rrfs' && job !== 'dwd'));
  assert.deepEqual(selectedProviders('schedule', { schedule: '55 3,9,15,21 * * *' }), ['rrfs']);
  assert.deepEqual(selectedProviders('push'), []);
});

test('targeted deployment preserves other datasets and requires a complete RRFS run', () => {
  const publish = workflow.split('\n  publish:\n')[1];
  const seed = publish.indexOf('for group in noaa-cloud rrfs dwd eccc observations terrain soaring; do');
  const merge = publish.indexOf('- name: Merge forecast documents');
  const validate = publish.indexOf('- name: Validate the requested RRFS forecast dataset before deployment');
  const deploy = publish.indexOf('uses: actions/deploy-pages@');
  assert.ok(seed > 0 && merge > seed && validate > merge && deploy > validate);
  assert.match(publish, /if: github.event_name == 'workflow_dispatch' && inputs.refresh == 'rrfs'\n        working-directory: forecasts\n        run: node scripts\/validate-rrfs\.mjs --data data --sites sites\.json/);
});

test('ICON has an independent scheduled and manual refresh window', () => {
  assert.deepEqual(selectedProviders('workflow_dispatch', { refresh: 'icon-eu' }), ['dwd']);
  assert.deepEqual(selectedProviders('schedule', { schedule: '55 4,10,16,22 * * *' }), ['dwd']);
  const dwd = workflow.split('\n  dwd:\n')[1].split('\n  eccc:\n')[0];
  assert.match(dwd, /scripts\/build-icon\.mjs --sites sites\.json --output data --validate-only/);
  const publish = workflow.split('\n  publish:\n')[1];
  assert.ok(publish.indexOf('Validate requested ICON profiles') < publish.indexOf('actions/deploy-pages@'));
});

test('ICON publication combines provider data and terrain before validating a requested deployment', () => {
  const publish = workflow.split('\n  publish:\n')[1];
  const seed = publish.indexOf('for group in noaa-cloud rrfs dwd eccc observations terrain soaring; do');
  const merge = publish.indexOf('- name: Merge forecast documents');
  const terrain = publish.indexOf('scripts/merge-armenia-terrain.mjs');
  const validate = publish.indexOf('- name: Validate requested ICON profiles');
  const deploy = publish.indexOf('uses: actions/deploy-pages@');
  assert.ok(seed > 0 && merge > seed && terrain > merge && validate > terrain && deploy > validate);
  assert.match(publish, /if: github.event_name == 'workflow_dispatch' && inputs.refresh == 'icon-eu'\n        working-directory: forecasts\n        run: node scripts\/build-icon\.mjs --sites sites\.json --output data --validate-only/);
  const dwd = workflow.split('\n  dwd:\n')[1].split('\n  eccc:\n')[0];
  assert.match(dwd, /runs-on: ubuntu-24\.04/);
  assert.match(dwd, /python3\.12 -m venv \.venv-icon/);
  assert.match(dwd, /ICON_PYTHON: \$\{\{ github.workspace \}\}\/forecasts\/\.venv-icon\/bin\/python/);
  assert.match(dwd, /NODE_OPTIONS: --max-old-space-size=6144/);
  assert.match(dwd, /- name: Pack\n        if: always\(\)/);
});

test('publication prunes merged rolling bundles and checks the finished Pages artifact before upload', () => {
  const publish = workflow.split('\n  publish:\n')[1];
  const overlay = publish.indexOf('- name: Merge forecast documents');
  const catalogue = publish.indexOf('scripts/merge-soaring-regions.mjs');
  const prune = publish.indexOf('scripts/pages-artifact.mjs --prune-data data');
  const build = publish.indexOf('pnpm run build');
  const copy = publish.indexOf('cp -a ../forecasts/data/. dist/data/');
  const check = publish.indexOf('scripts/pages-artifact.mjs --check-site dist');
  const upload = publish.indexOf('uses: actions/upload-pages-artifact@');
  assert.ok(overlay > 0 && catalogue > overlay && prune > catalogue && build > prune);
  assert.ok(copy > build && check > copy && upload > check);
});
