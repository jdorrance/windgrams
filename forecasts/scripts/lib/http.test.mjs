import { test } from "node:test";
import assert from "node:assert/strict";
import { cachingOpen, retryAfterMs, retryingFetch, withRetries } from "./http.mjs";

const noWait = async () => {};

test("withRetries retries a network error and then returns", async () => {
  let calls = 0;
  const value = await withRetries(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("socket hang up");
      return "ok";
    },
    { delayMs: 1, sleepImpl: noWait },
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3);
});

test("withRetries does not retry a 404", async () => {
  let calls = 0;
  const missing = Object.assign(new Error("GET answered 404"), { status: 404 });
  await assert.rejects(
    () =>
      withRetries(
        async () => {
          calls += 1;
          throw missing;
        },
        { delayMs: 1, sleepImpl: noWait },
      ),
    /404/,
  );
  assert.equal(calls, 1);
});

test("cachingOpen remembers a success and forgets a failure", async () => {
  const opens = [];
  let fail = true;
  const open = cachingOpen(
    async (url) => {
      opens.push(url);
      if (fail) throw new Error("timed out");
      return `tile:${url}`;
    },
    { attempts: 1, sleepImpl: noWait },
  );
  await assert.rejects(() => open("a"), /timed out/);
  await assert.rejects(() => open("a"), /timed out/);
  fail = false;
  assert.equal(await open("a"), "tile:a");
  assert.equal(await open("a"), "tile:a");
  assert.deepEqual(opens, ["a", "a", "a"]);
});

test("retryingFetch retries 503 and returns 404 immediately", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/missing")) return new Response("no", { status: 404 });
    if (calls.filter((item) => item.endsWith("/flaky")).length < 2) return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
    return Response.json({ ok: true });
  };
  const get = retryingFetch(fetchImpl, { delayMs: 1, sleepImpl: noWait });
  assert.equal((await get("https://example.test/missing")).status, 404);
  assert.equal(calls.length, 1);
  const ok = await get("https://example.test/flaky");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(calls.length, 3);
});

test("retryAfterMs caps a long wait", () => {
  assert.equal(retryAfterMs("120", 1000), 30_000);
  assert.equal(retryAfterMs(null, 1000), 1000);
  assert.equal(retryAfterMs("0", 1000), 0);
});
