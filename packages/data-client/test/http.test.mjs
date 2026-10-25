import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from '@windgrams/data-client/http';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('cancellation interrupts retry backoff and releases the discarded response', async () => {
  const controller = new AbortController(), sleeping = deferred(), finishSleep = deferred();
  let attempts = 0, cancelled = 0;
  const request = fetchWithRetry('/busy', { signal: controller.signal }, {
    fetchImpl: async () => {
      attempts++;
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503, headers: { 'Retry-After': '30' } });
    },
    sleep: ms => { assert.equal(ms, 30_000); sleeping.resolve(); return finishSleep.promise; },
  });
  await sleeping.promise;
  const reason = new Error('page closed');
  controller.abort(reason);
  await assert.rejects(request, error => error === reason);
  assert.equal(attempts, 1);
  assert.equal(cancelled, 1);
  finishSleep.resolve();
  await Promise.resolve();
  assert.equal(attempts, 1, 'late backoff completion never starts another fetch');
});

test('only discarded retry responses are cancelled; callers retain the final body', async () => {
  let attempts = 0, cancelled = 0;
  const response = await fetchWithRetry('/busy', undefined, {
    fetchImpl: async () => {
      attempts++;
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 });
    },
    sleep: async () => {},
  });
  assert.equal(attempts, 3);
  assert.equal(cancelled, 2);
  assert.equal(response.bodyUsed, false);
  await response.body.cancel();
});
