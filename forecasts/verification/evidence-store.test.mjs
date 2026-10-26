import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimCapture, createStore, readJsonResource } from './evidence-store.mjs';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'forecast-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('capture ownership is exclusive even after interruption; existing objects cannot hide corruption', async (t) => {
  const root = await workspace(t);
  await claimCapture(root);
  await assert.rejects(claimCapture(root), { code: 'EEXIST' });
  const store = await createStore(root),
    entry = await store.save('original', {});
  await writeFile(join(root, entry.file), 'changed');
  await assert.rejects(store.save('original', {}), /Corrupt existing evidence/);
});

test('shared requests deduplicate while malformed JSON remains hash-bound evidence', async (t) => {
  let calls = 0;
  const store = await createStore(await workspace(t), {
    fetchImpl: async () => {
      calls++;
      return new Response('<html>Unavailable</html>');
    },
  });
  const [first, second] = await Promise.all([
    readJsonResource(store, 'https://test.invalid'),
    readJsonResource(store, 'https://test.invalid'),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.value, null);
  assert.ok(first.error);
  assert.equal(first.entry.sha256, second.entry.sha256);
  assert.equal(store.resources.length, 1);
});

test('oversized response streams are cancelled and bounded retries retain a delivery failure', async (t) => {
  let calls = 0,
    cancelled = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const store = await createStore(await workspace(t), {
    fetchImpl: async () => {
      calls++;
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled++;
          },
        }),
      );
    },
  });
  const entry = await store.take('https://test.invalid/oversized');
  assert.equal(calls, 3);
  assert.equal(cancelled, 3);
  assert.equal(entry.status, 0);
  assert.match(entry.error, /64 MiB/);
  assert.equal(entry.file, undefined);
});
