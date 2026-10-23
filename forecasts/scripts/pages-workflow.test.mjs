import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');
const providerJobs = ['noaa-cloud', 'rrfs', 'eccc', 'observations', 'terrain'];

function selectedProviders(eventName, { schedule, refresh } = {}) {
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
  assert.deepEqual(selectedProviders('schedule', { schedule: '55 1,7,13,19 * * *' }), providerJobs.filter(job => job !== 'rrfs'));
  assert.deepEqual(selectedProviders('schedule', { schedule: '55 3,9,15,21 * * *' }), ['rrfs']);
  assert.deepEqual(selectedProviders('push'), []);
});

test('targeted deployment preserves other datasets and requires a complete RRFS run', () => {
  const publish = workflow.split('\n  publish:\n')[1];
  const seed = publish.indexOf('for group in noaa-cloud rrfs eccc observations terrain soaring; do');
  const merge = publish.indexOf('- name: Merge forecast documents');
  const validate = publish.indexOf('- name: Validate the requested RRFS forecast dataset before deployment');
  const deploy = publish.indexOf('uses: actions/deploy-pages@');
  assert.ok(seed > 0 && merge > seed && validate > merge && deploy > validate);
  assert.match(publish, /if: github.event_name == 'workflow_dispatch' && inputs.refresh == 'rrfs'\n        working-directory: forecasts\n        run: node scripts\/validate-rrfs\.mjs --data data --sites sites\.json/);
});
