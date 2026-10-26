import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitPublicationCheck } from './await-publication-check.mjs';

const revision = 'a'.repeat(40), repository = 'owner/weather';
const run = (overrides = {}) => ({ id: 1, run_attempt: 1, head_sha: revision, head_branch: 'main',
  head_repository: { full_name: repository }, event: 'push', status: 'completed', conclusion: 'success', ...overrides });

test('publication waits for its checkout, not another successful revision or repository', async () => {
  let calls = 0, waits = 0;
  const result = await awaitPublicationCheck({ revision, repository,
    api: async path => {
      assert.equal(path, `/actions/workflows/check.yml/runs?branch=main&head_sha=${revision}&per_page=100`);
      return { workflow_runs: ++calls === 1
        ? [run({ head_sha: 'b'.repeat(40) }), run({ head_repository: { full_name: 'fork/weather' } }), run({ status: 'in_progress' })]
        : [run({ id: 2 })] };
    },
    sleep: async () => { waits++; },
  });
  assert.equal(waits, 1);
  assert.equal(result.checkRunId, 2);
  assert.equal(result.checkRunAttempt, 1);
  assert.equal(result.revision, revision);
});

test('a pending rerun of the latest invocation waits for its current attempt', async () => {
  let waits = 0;
  const result = await awaitPublicationCheck({ revision, repository,
    api: async () => ({ workflow_runs: [run(), run({ id: 2, run_attempt: 2,
      status: waits ? 'completed' : 'queued', conclusion: waits ? 'success' : null })] }),
    sleep: async () => { waits++; },
  });
  assert.equal(waits, 1);
  assert.equal(result.checkRunId, 2);
  assert.equal(result.checkRunAttempt, 2);
});

test('the latest failed check blocks publication even after an earlier pass', async () => {
  await assert.rejects(awaitPublicationCheck({ revision, repository,
    api: async () => ({ workflow_runs: [run(), run({ id: 2, conclusion: 'failure' })] }),
  }), /Check 2 failure; publication stopped/);
});

test('a missing check times out without authorizing publication', async () => {
  let elapsed = 0;
  await assert.rejects(awaitPublicationCheck({ revision, repository, timeoutMs: 20,
    api: async () => ({ workflow_runs: [run({ event: 'pull_request' })] }),
    now: () => elapsed, sleep: async ms => { elapsed += ms; },
  }), /No successful Check completed/);
});
